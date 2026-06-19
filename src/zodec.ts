import type { Express, Request, RequestHandler, Response } from 'express';
import {
  getParams,
  getPrefix,
  getRoutes,
  type ParamMetadata,
  type RouteMetadata,
  type SecurityRequirement,
} from './metadata.js';
import { Readable } from 'node:stream';
import { Blob, File } from 'node:buffer';
import { openAsBlob } from 'node:fs';
import multer, { MulterError, type Multer, type Options } from 'multer';
import { SecurityError, ValidationError } from './errors.js';
import { FileResponse } from './file-response.js';
import { getMultipartFields, type MultipartFileField } from './multipart.js';
import type { SecurityConfig } from './security.js';
import { generateOpenApiDocument, type OpenApiDocument } from './swagger.js';

/**
 * Per-request values the handler's injected parameters resolve from. Each source
 * starts as the raw request value and is replaced by the parsed (coerced,
 * defaulted) output once its schema validates. Kept separate from `req` because
 * Express 5 exposes `req.query` as a getter only — it cannot be reassigned.
 */
interface RequestValues {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
}

/** OpenAPI `info` block for the generated document. */
export interface ZodecInfo {
  /** API title shown in the OpenAPI document. */
  title: string;
  /** API version string shown in the OpenAPI document. */
  version: string;
}

/** Options for constructing a {@link Zodec} instance. */
export interface ZodecOptions {
  /** OpenAPI `info` block (title + version). */
  info: ZodecInfo;
  /**
   * multer options for `multipart/form-data` (file-upload) routes, passed
   * straight through to multer. Defaults to in-memory storage, so handlers
   * receive a `File` backed by the uploaded bytes. Set `storage` for disk/custom
   * storage and `limits.fileSize` to reject oversized uploads before buffering
   * (a per-field `z.file().max()` only runs once the bytes are in hand).
   */
  multipart?: Options;
  /**
   * Named security schemes referenced by `@Security`. Each entry pairs an OpenAPI
   * scheme definition with a runtime handler (use the `bearer`/`apiKey`/… builders).
   * The scheme definitions are emitted under `components.securitySchemes`.
   */
  security?: SecurityConfig;
}

/** A controller handler method, called with the assembled argument list. */
type HandlerFn = (...args: unknown[]) => unknown;

/**
 * Joins the controller prefix and route path into a single Express path,
 * collapsing duplicate slashes and translating `{id}` placeholders to `:id`.
 */
function toExpressPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  const normalized = joined === '' ? '/' : joined;
  return normalized.replace(/\{([^}]+)\}/g, ':$1');
}

/** The status sent on success: the first declared 2xx response, or 200. */
function successStatus(responses: Record<number, unknown>): number {
  const codes = Object.keys(responses).map(Number);
  return codes.find((code) => code >= 200 && code < 300) ?? 200;
}

/**
 * Validates the request sources that have schemas, returning the parsed values
 * (raw values for sources without a schema). Throws {@link ValidationError} on
 * the first failure — 400 for params/query, 422 for body.
 */
function validate(route: RouteMetadata, req: Request): RequestValues {
  const values: RequestValues = {
    params: req.params,
    query: req.query,
    body: req.body as unknown,
  };
  if (route.params) {
    const result = route.params.safeParse(req.params);
    if (!result.success) {
      throw new ValidationError(400, result.error.issues);
    }
    values.params = result.data as Record<string, unknown>;
  }
  if (route.query) {
    const result = route.query.safeParse(req.query);
    if (!result.success) {
      throw new ValidationError(400, result.error.issues);
    }
    values.query = result.data as Record<string, unknown>;
  }
  if (route.body) {
    const fileFields = getMultipartFields(route.body);
    const input =
      fileFields.length > 0 ? assembleMultipartBody(req, fileFields) : (req.body as unknown);
    const result = route.body.safeParse(input);
    if (!result.success) {
      throw new ValidationError(422, result.error.issues);
    }
    values.body = result.data;
  }
  return values;
}

/**
 * The fields zodec reads off a multer file. Modeled structurally so the source
 * doesn't depend on multer's (Express-augmenting) types. Memory storage provides
 * `buffer`; disk (and custom) storage provides `path`.
 */
interface RawMultipartFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Uint8Array;
  path?: string;
}

/** Where the adapted `File`s are stashed on the request, keyed by field name. */
const ZODEC_FILES = Symbol('zodec:files');

/** Where the resolved `@Security` principal is stashed on the request. */
const ZODEC_PRINCIPAL = Symbol('zodec:principal');

/** Adapts a multer file into a web-standard `File` the handler can consume. */
async function toWebFile(file: RawMultipartFile): Promise<File> {
  if (file.buffer) {
    // Memory storage (the default): wrap the bytes directly. The copy gives a
    // plain ArrayBuffer-backed view, which is what the `File` ctor accepts.
    return new File([new Uint8Array(file.buffer)], file.originalname, { type: file.mimetype });
  }
  // Disk/custom storage: back the File by the file on disk. `openAsBlob` reads
  // nothing up front — size/type are known from stat, and bytes are streamed
  // only when the handler reads them — so large uploads aren't buffered in RAM.
  // `openAsBlob` is typed with the global `Blob`, which is nominally distinct
  // from `node:buffer`'s `Blob` that this `File` ctor expects — bridge the two.
  const blob = (await openAsBlob(file.path ?? '', { type: file.mimetype })) as unknown as Blob;
  return new File([blob], file.originalname, { type: file.mimetype });
}

/**
 * Adapts every uploaded file to a `File` and stashes the result on the request,
 * keyed by field name. Run from the multipart middleware (which is already async)
 * so disk-backed files can be wrapped lazily without blocking.
 */
async function adaptMultipartFiles(req: Request, fileFields: MultipartFileField[]): Promise<void> {
  const raw =
    (req as unknown as { files?: Record<string, RawMultipartFile[] | undefined> }).files ?? {};
  const adapted: Record<string, File[]> = {};
  for (const field of fileFields) {
    adapted[field.name] = await Promise.all((raw[field.name] ?? []).map(toWebFile));
  }
  (req as unknown as Record<symbol, unknown>)[ZODEC_FILES] = adapted;
}

/**
 * Builds the object validated against a multipart `@Body` schema: multer puts
 * text fields on `req.body`; the adapted files were stashed by
 * {@link adaptMultipartFiles}. Merge them, unwrapping single-file fields.
 */
function assembleMultipartBody(
  req: Request,
  fileFields: MultipartFileField[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...((req.body as Record<string, unknown> | undefined) ?? {}),
  };
  const files = ((req as unknown as Record<symbol, unknown>)[ZODEC_FILES] ?? {}) as Record<
    string,
    File[] | undefined
  >;
  for (const field of fileFields) {
    const uploaded = files[field.name] ?? [];
    body[field.name] = field.multiple ? uploaded : uploaded[0];
  }
  return body;
}

/**
 * Maps a multer error (oversized file, too many files, unexpected field) to a
 * `422` {@link ValidationError} so it travels the same pipeline as schema
 * failures.
 */
function multipartError(err: MulterError): ValidationError {
  return new ValidationError(422, [
    { code: 'custom', path: err.field ? [err.field] : [], message: err.message },
  ] as unknown as ValidationError['issues']);
}

/**
 * Resolves a single injected parameter. A decorator with no `name` injects the
 * whole bag (e.g. `@Param()` → all params).
 */
function resolveParam(
  param: ParamMetadata,
  values: RequestValues,
  req: Request,
  res: Response,
): unknown {
  switch (param.source) {
    case 'param':
      return param.name ? values.params[param.name] : values.params;
    case 'query':
      return param.name ? values.query[param.name] : values.query;
    case 'body':
      return param.name
        ? (values.body as Record<string, unknown> | undefined)?.[param.name]
        : values.body;
    case 'header':
      return param.name ? req.headers[param.name.toLowerCase()] : req.headers;
    case 'req':
      return req;
    case 'res':
      return res;
    case 'principal':
      return (req as unknown as Record<symbol, unknown>)[ZODEC_PRINCIPAL];
  }
}

/**
 * Streams a {@link FileResponse} to the client: sets Content-Disposition and
 * Content-Type, then sends the buffer or pipes the stream. `fallbackStatus` is
 * the route's success status, used when the FileResponse doesn't set its own.
 */
function sendFile(res: Response, file: FileResponse, fallbackStatus: number): void {
  res.status(file.status ?? fallbackStatus);
  // res.attachment() encodes the filename per RFC 5987/6266 (UTF-8 safe, with an
  // ASCII fallback) and escapes it — it also guesses Content-Type from the
  // extension, so set the explicit contentType afterward to let it win.
  if (file.filename) {
    res.attachment(file.filename);
  }
  if (file.contentType) {
    res.type(file.contentType);
  }
  if (file.body instanceof Readable) {
    file.body.pipe(res);
  } else {
    res.end(file.body);
  }
}

/**
 * Builds the handler argument array, placing each injected value at its own
 * parameter index. Indexes without a decorator stay `undefined`.
 */
function buildArgs(
  params: ParamMetadata[],
  values: RequestValues,
  req: Request,
  res: Response,
): unknown[] {
  const args: unknown[] = [];
  for (const param of params) {
    args[param.index] = resolveParam(param, values, req, res);
  }
  return args;
}

/**
 * Owns a set of controllers and wires them to Express and OpenAPI. Construct
 * one instance, `register` your controllers, then `mount` an Express app and/or
 * call `swagger`.
 *
 * @example
 * ```ts
 * const api = new Zodec({ info: { title: 'My API', version: '1.0.0' } });
 * api.register(new UsersController(db));
 * api.mount(app);
 * app.get('/swagger.json', (_req, res) => res.json(api.swagger()));
 * ```
 */
export class Zodec {
  private readonly controllers: object[] = [];
  /** Lazily-built multer instance, shared across all multipart routes. */
  private uploader: Multer | undefined;

  /**
   * @param options - Instance options, including the OpenAPI `info` block.
   */
  public constructor(private readonly options: ZodecOptions) {}

  /** The OpenAPI `info` block this instance was constructed with. */
  public get info(): ZodecInfo {
    return this.options.info;
  }

  /**
   * Records a pre-constructed controller instance. The caller owns construction
   * and dependency injection; {@link Zodec.mount} does the wiring later.
   *
   * @param instance - A controller instance (not a class).
   * @returns This instance, for chaining.
   */
  public register(instance: object): this {
    this.controllers.push(instance);
    return this;
  }

  /**
   * Builds the OpenAPI document from the registered controllers' metadata.
   * Independent of {@link Zodec.mount} — does not require routes to be wired.
   *
   * @returns The assembled OpenAPI 3.1 document.
   */
  public swagger(): OpenApiDocument {
    const prototypes = this.controllers.map(
      (instance) => Object.getPrototypeOf(instance) as object,
    );
    // The scheme definitions for components.securitySchemes come from the
    // instance's security config (each entry's `.scheme`).
    const security = this.options.security;
    const securitySchemes = security
      ? Object.fromEntries(Object.entries(security).map(([name, s]) => [name, s.scheme]))
      : undefined;
    return generateOpenApiDocument(prototypes, this.options.info, { securitySchemes });
  }

  /**
   * Walks every registered controller's metadata and binds its routes (with
   * validation middleware) onto the Express app.
   *
   * @param app - The Express application to register routes on.
   * @returns This instance, for chaining.
   */
  public mount(app: Express): this {
    for (const instance of this.controllers) {
      const proto = Object.getPrototypeOf(instance) as object;
      const prefix = getPrefix(proto);
      for (const route of getRoutes(proto)) {
        const path = toExpressPath(prefix, route.path);
        const middlewares: RequestHandler[] = [];
        // Authenticate first — reject unauthorized requests before parsing a body.
        if (route.security && route.security.length > 0) {
          middlewares.push(this.securityMiddleware(route.security));
        }
        // A route whose @Body has a file field is multipart: parse it with multer
        // before the handler runs, so req.body/req.files are populated.
        const fileFields = getMultipartFields(route.body);
        if (fileFields.length > 0) {
          middlewares.push(this.multipartMiddleware(fileFields));
        }
        app[route.method](path, ...middlewares, this.makeHandler(instance, proto, route));
      }
    }
    return this;
  }

  /**
   * Builds middleware that authenticates a route. Runs each requirement (stacked
   * `@Security` = OR) until one succeeds, stashes the principal on the request,
   * and rejects otherwise.
   */
  private securityMiddleware(requirements: SecurityRequirement[]): RequestHandler {
    return (req, _res, next) => {
      this.authenticate(requirements, req).then((principal) => {
        (req as unknown as Record<symbol, unknown>)[ZODEC_PRINCIPAL] = principal;
        next();
      }, next);
    };
  }

  /**
   * Runs the route's security requirements in order, returning the first
   * successful principal. With multiple requirements (OR), the first failure is
   * reported if none succeed — a `null`/`undefined` return is a `401`, a thrown
   * error (e.g. a `403`) is preserved.
   */
  private async authenticate(requirements: SecurityRequirement[], req: Request): Promise<unknown> {
    const config = this.options.security ?? {};
    let firstFailure: Error | undefined;
    for (const requirement of requirements) {
      const scheme = config[requirement.scheme];
      if (!scheme) {
        throw new Error(`zodec: no security handler registered for "${requirement.scheme}"`);
      }
      try {
        const principal = await scheme.handler(req, requirement.scopes);
        if (principal !== null && principal !== undefined) {
          return principal;
        }
        firstFailure ??= new SecurityError(401);
      } catch (err) {
        // Preserve a thrown error (e.g. http-errors / SecurityError with a status).
        firstFailure ??= err instanceof Error ? err : new Error(String(err));
      }
    }
    throw firstFailure ?? new SecurityError(401);
  }

  /** The shared multer instance, built from `options.multipart` on first use. */
  private getUploader(): Multer {
    if (!this.uploader) {
      const multipart = this.options.multipart ?? {};
      // Default to in-memory storage so handlers get a File backed by the bytes,
      // but only when the caller hasn't configured `storage` or `dest` (either of
      // which selects multer's own storage) — otherwise pass options through.
      this.uploader =
        multipart.storage || multipart.dest
          ? multer(multipart)
          : multer({ ...multipart, storage: multer.memoryStorage() });
    }
    return this.uploader;
  }

  /**
   * Builds the middleware that parses a multipart request: multer populates
   * `req.body`/`req.files`, then each file is adapted to a web-standard `File`.
   * multer's own errors (oversized, too many, unexpected field) become `422`s.
   */
  private multipartMiddleware(fileFields: MultipartFileField[]): RequestHandler {
    const upload = this.getUploader().fields(
      fileFields.map((field) =>
        field.multiple ? { name: field.name } : { name: field.name, maxCount: 1 },
      ),
    );
    return (req, res, next) => {
      upload(req, res, (err: unknown) => {
        if (err) {
          next(err instanceof MulterError ? multipartError(err) : err);
          return;
        }
        adaptMultipartFiles(req, fileFields).then(() => next(), next);
      });
    };
  }

  /**
   * Builds the Express request handler for one route: validate the request,
   * assemble the handler arguments, invoke it, then validate and send the
   * response (unless the handler used `@Res()`).
   */
  private makeHandler(instance: object, proto: object, route: RouteMetadata): RequestHandler {
    const status = successStatus(route.responses);
    const fn = (instance as Record<string, HandlerFn | undefined>)[route.handlerName];
    if (typeof fn !== 'function') {
      throw new Error(`zodec: handler "${route.handlerName}" is not a function`);
    }
    const params = getParams(proto, route.handlerName);
    return (req, res, next) => {
      try {
        const values = validate(route, req);
        const args = buildArgs(params, values, req, res);
        Promise.resolve(fn.apply(instance, args)).then((value: unknown) => {
          // A handler using @Res() writes the response itself — don't double-send.
          if (res.headersSent) {
            return;
          }
          // A FileResponse streams a binary body; skip JSON + response validation.
          if (value instanceof FileResponse) {
            sendFile(res, value, status);
            return;
          }
          // Always-on response validation: the return value must match its
          // declared @Returns schema. A mismatch is a server bug, so it throws
          // a 500 ValidationError through the same error pipeline as everything
          // else — zodec never decides what to do with it.
          const schema = route.responses[status];
          if (schema) {
            const result = schema.safeParse(value);
            if (!result.success) {
              next(new ValidationError(500, result.error.issues));
              return;
            }
          }
          res.status(status).json(value);
        }, next);
      } catch (err) {
        next(err);
      }
    };
  }
}
