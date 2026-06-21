import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import {
  getParams,
  getPrefix,
  getRoutes,
  type ParamMetadata,
  type RouteMetadata,
  type SecurityRequirement,
  type SseResponseDecl,
} from './metadata.js';
import { ZODEC_PRINCIPAL } from './parameters.js';
import { Readable } from 'node:stream';
import { Blob, File } from 'node:buffer';
import { openAsBlob } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import multer, { MulterError, type Multer, type Options } from 'multer';
import contentDisposition from 'content-disposition';
import { SecurityError, ValidationError } from './errors.js';
import { FileResponse } from './file-response.js';
import { RangeFileResponse, type RangeBody, type RangePathBody } from './range-file-response.js';
import { HttpResponse } from './http-response.js';
import type { HeaderValue, ResponseCookie } from './response.js';
import { SseEvent } from './sse.js';
import { getMultipartFields, type MultipartFileField } from './multipart.js';
import { mountDocs, type ServeDocsOptions } from './serve-docs.js';
import type { SecurityConfig } from './security.js';
import type { OpenAPIV3_1 } from 'openapi-types';
import {
  generateOpenApiDocument,
  type OpenApiDocument,
  type OpenApiInfo,
  type SpecVersion,
} from './swagger.js';
import { generateContractDocument, type ContractOptions, type ZodecContract } from './contract.js';

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

/**
 * OpenAPI `info` block for the generated document — the full OpenAPI Info Object
 * (`title` + `version` required; `description`/`contact`/`license`/… optional).
 */
export type ZodecInfo = OpenApiInfo;

/** Options for constructing a {@link Zodec} instance. */
export interface ZodecOptions {
  /** OpenAPI `info` block (`title` + `version` required; rest optional). */
  info: ZodecInfo;
  /** `servers` array for the generated document (base URLs). */
  servers?: OpenAPIV3_1.ServerObject[];
  /** Top-level `externalDocs` for the generated document. */
  externalDocs?: OpenAPIV3_1.ExternalDocumentationObject;
  /** Top-level `tags` definitions (descriptions for the names used by `@Tags`). */
  tags?: OpenAPIV3_1.TagObject[];
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

/** Options for {@link Zodec.register} / {@link ControllerGroup.register}. */
export interface RegisterOptions {
  /**
   * Base path prepended to this controller's `@Route` prefix — e.g. `'/v1'` for
   * versioning. Reflected in both the mounted Express routes and the generated
   * `paths`. Composes with any enclosing {@link Zodec.group}.
   */
  prefix?: string | undefined;
}

/** A registered controller plus the registration-time base path it sits under. */
interface RegisteredController {
  instance: object;
  prefix: string;
}

/** Joins a base path and a sub-path into one prefix; empty segments drop out. */
function joinPrefix(base: string, extra?: string): string {
  return [base, extra].filter((s): s is string => Boolean(s)).join('/');
}

/**
 * A registration scope created by {@link Zodec.group}: registers controllers
 * under a shared base path (e.g. a `/v1` version segment). Groups nest — a
 * nested {@link ControllerGroup.group} appends its prefix to the enclosing one.
 *
 * @example
 * ```ts
 * api.group('/v1', (v1) => {
 *   v1.register(new UsersController(svc));
 *   v1.register(new AuthController(auth));
 * });
 * ```
 */
export class ControllerGroup {
  /** @internal — constructed by {@link Zodec.group}. */
  public constructor(
    private readonly add: (instance: object, prefix: string) => void,
    private readonly basePrefix: string,
  ) {}

  /**
   * Registers a controller under this group's base path. An optional `prefix`
   * is appended to the group's.
   *
   * @returns This group, for chaining.
   */
  public register(instance: object, options: RegisterOptions = {}): this {
    this.add(instance, joinPrefix(this.basePrefix, options.prefix));
    return this;
  }

  /**
   * Opens a nested group whose prefix is appended to this group's.
   *
   * @returns This group, for chaining.
   */
  public group(prefix: string, fn: (group: ControllerGroup) => void): this {
    fn(new ControllerGroup(this.add, joinPrefix(this.basePrefix, prefix)));
    return this;
  }
}

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
  // The Promise arm documents that custom resolvers may be async (buildArgs awaits).
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
): unknown | Promise<unknown> {
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
    case 'custom':
      // A createParamDecorator resolver; may be sync or async (awaited by buildArgs).
      return param.resolve?.({ req, res });
  }
}

/** The Content-Disposition/Content-Type/headers shared by both file responses. */
interface FileHeaderFields {
  contentType: string | undefined;
  filename: string | undefined;
  disposition: 'inline' | 'attachment' | undefined;
  headers: Record<string, HeaderValue> | undefined;
}

/** Converts a {@link HeaderValue} to what `res.setHeader` accepts (numbers stringified). */
function toHeaderValue(value: HeaderValue): string | string[] {
  return Array.isArray(value) ? value.map(String) : String(value);
}

/** Sets each cookie via Express (which formats and appends a `Set-Cookie` per call). */
function applyCookies(res: Response, cookies: ResponseCookie[] | undefined): void {
  if (!cookies) {
    return;
  }
  for (const cookie of cookies) {
    res.cookie(cookie.name, cookie.value, cookie.options ?? {});
  }
}

/**
 * Applies Content-Disposition, Content-Type, and any extra headers to the
 * response. Extra `headers` are applied last, so they override the derived ones.
 */
function applyFileHeaders(res: Response, file: FileHeaderFields): void {
  // Default to `attachment` when a filename is given (a download), else nothing.
  const disposition = file.disposition ?? (file.filename ? 'attachment' : undefined);
  if (disposition === 'attachment' && file.filename) {
    // res.attachment() encodes the filename per RFC 5987/6266 (UTF-8 safe, with
    // an ASCII fallback) and escapes it.
    res.attachment(file.filename);
  } else if (disposition) {
    // inline (or attachment with no filename) — content-disposition encodes the
    // optional filename the same RFC 5987 way Express does internally.
    res.setHeader(
      'Content-Disposition',
      file.filename ? contentDisposition(file.filename, { type: disposition }) : disposition,
    );
  }
  // Explicit contentType wins over res.attachment()'s extension guess.
  if (file.contentType) {
    res.type(file.contentType);
  }
  if (file.headers) {
    for (const [name, value] of Object.entries(file.headers)) {
      res.setHeader(name, toHeaderValue(value));
    }
  }
}

/**
 * Streams a {@link FileResponse} to the client: sets Content-Disposition and
 * Content-Type, applies any extra headers, then sends the buffer or pipes the
 * stream. `fallbackStatus` is the route's success status, used when the
 * FileResponse doesn't set its own.
 */
function sendFile(res: Response, file: FileResponse, fallbackStatus: number): void {
  res.status(file.status ?? fallbackStatus);
  applyFileHeaders(res, file);
  applyCookies(res, file.cookies);
  if (file.body instanceof Readable) {
    file.body.pipe(res);
  } else {
    res.end(file.body);
  }
}

/** Whether a range body is the disk-path kind (served via Express sendFile). */
function isPathBody(body: RangeBody): body is RangePathBody {
  return !(body instanceof Uint8Array) && 'path' in body;
}

/**
 * Serves a {@link RangeFileResponse}, honoring HTTP `Range`. A single satisfiable
 * range yields `206` with `Content-Range`; an unsatisfiable one yields `416`;
 * multi-range / malformed / no range yields a full `200`. Path-backed bodies are
 * delegated to Express `res.sendFile` (Range + conditional GET). The body is
 * resolved before any header is written, so a source error becomes a clean error
 * response instead of arriving mid-status.
 */
async function sendRangeFile(
  req: Request,
  res: Response,
  file: RangeFileResponse,
  fallbackStatus: number,
): Promise<void> {
  if (isPathBody(file.body)) {
    const headers: Record<string, string | string[]> = {};
    const disposition = file.disposition ?? (file.filename ? 'attachment' : undefined);
    if (disposition) {
      headers['Content-Disposition'] = file.filename
        ? contentDisposition(file.filename, { type: disposition })
        : disposition;
    }
    if (file.contentType) {
      headers['Content-Type'] = file.contentType;
    }
    if (file.headers) {
      for (const [name, value] of Object.entries(file.headers)) {
        headers[name] = toHeaderValue(value);
      }
    }
    // Cookies queue a Set-Cookie header before sendFile writes the response.
    applyCookies(res, file.cookies);
    const absolute = resolvePath(file.body.path);
    await new Promise<void>((resolve, reject) => {
      res.sendFile(absolute, { headers }, (err?: Error) => (err ? reject(err) : resolve()));
    });
    return;
  }

  const body = file.body;
  const size = body instanceof Uint8Array ? body.byteLength : body.size;
  res.setHeader('Accept-Ranges', 'bytes');
  const ranges = req.range(size);

  if (ranges === -1) {
    // Unsatisfiable — 416 with Content-Range: bytes */<size>.
    res.status(416).setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }

  const single =
    Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1 ? ranges[0] : undefined;

  if (single) {
    const { start, end } = single;
    // Resolve the slice first; a stream source may throw before headers are sent.
    const chunk =
      body instanceof Uint8Array
        ? body.subarray(start, end + 1)
        : await body.stream({ start, end });
    res.status(206);
    applyFileHeaders(res, file);
    applyCookies(res, file.cookies);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    sendBinary(res, chunk);
    return;
  }

  // No range, multi-range, or malformed: full body.
  const chunk = body instanceof Uint8Array ? body : await body.stream();
  res.status(file.status ?? fallbackStatus);
  applyFileHeaders(res, file);
  applyCookies(res, file.cookies);
  res.setHeader('Content-Length', String(size));
  sendBinary(res, chunk);
}

/** Sends bytes (via `res.end`) or pipes a stream. */
function sendBinary(res: Response, chunk: Uint8Array | Readable): void {
  if (chunk instanceof Readable) {
    chunk.pipe(res);
  } else {
    res.end(Buffer.from(chunk));
  }
}

/**
 * Coerces an {@link HttpResponse} header to the wire form. A header that matches a
 * declared `@Returns(..., { headers })` schema is validated/parsed against it (a
 * mismatch is a `500` — a server bug); numbers are stringified. Undeclared headers
 * pass through (numbers still stringified). Throws {@link ValidationError} on a
 * declared-schema mismatch.
 */
function coerceHeaderValue(value: HeaderValue, schema: ZodType | undefined): string | string[] {
  const one = (v: string | number): string => {
    if (schema) {
      const result = schema.safeParse(v);
      if (!result.success) {
        throw new ValidationError(500, result.error.issues);
      }
      return String(result.data);
    }
    return String(v);
  };
  // Array.isArray doesn't narrow a ReadonlyArray out of the else branch, so the
  // scalar case is asserted (it can only be string | number here).
  return Array.isArray(value) ? value.map(one) : one(value as string | number);
}

/**
 * Sends an {@link HttpResponse}: picks the status (which must be a declared
 * `@Returns`), validates/serializes the body against that status's schema, coerces
 * headers, sets cookies, and writes the JSON. All validation runs before `res` is
 * touched, so a failure surfaces cleanly through `next` without a half-written
 * response.
 */
function sendHttpResponse(
  res: Response,
  response: HttpResponse,
  route: RouteMetadata,
  fallbackStatus: number,
  next: NextFunction,
): void {
  const responseStatus = response.status ?? fallbackStatus;
  const decl = route.responses[responseStatus];
  // An explicit status must correspond to a declared @Returns (catches typos).
  if (response.status !== undefined && !decl) {
    next(
      new Error(
        `zodec: HttpResponse status ${response.status} has no matching @Returns on ` +
          `${route.method.toUpperCase()} /${route.path}`,
      ),
    );
    return;
  }
  // Validate the body and headers up front; only mutate res once all checks pass.
  let output: unknown = response.body;
  if (decl?.schema) {
    const result = decl.schema.safeParse(response.body);
    if (!result.success) {
      next(new ValidationError(500, result.error.issues));
      return;
    }
    output = result.data;
  }
  let headerEntries: [string, string | string[]][];
  try {
    headerEntries = Object.entries(response.headers ?? {}).map(
      ([name, value]) =>
        [name, coerceHeaderValue(value, decl?.headers?.[name])] as [string, string | string[]],
    );
  } catch (err) {
    next(err);
    return;
  }
  for (const [name, value] of headerEntries) {
    res.setHeader(name, value);
  }
  applyCookies(res, response.cookies);
  res.status(responseStatus).json(output);
}

/**
 * Serializes one SSE event to its wire frame. A {@link SseEvent} sets the
 * `event`/`id`/`retry` lines; the data is validated/parsed against `eventSchema`
 * (a mismatch is a server bug → `500`), then emitted as one `data:` line per line
 * of the payload (string as-is, otherwise JSON).
 */
function frameSseEvent(value: unknown, eventSchema: ZodType | undefined): string {
  let data: unknown = value;
  let frame = '';
  if (value instanceof SseEvent) {
    data = value.data;
    if (value.event !== undefined) {
      frame += `event: ${value.event}\n`;
    }
    if (value.id !== undefined) {
      frame += `id: ${String(value.id)}\n`;
    }
    if (value.retry !== undefined) {
      frame += `retry: ${value.retry}\n`;
    }
  }
  if (eventSchema) {
    const result = eventSchema.safeParse(data);
    if (!result.success) {
      throw new ValidationError(500, result.error.issues);
    }
    data = result.data;
  }
  const payload = typeof data === 'string' ? data : (JSON.stringify(data) ?? 'null');
  for (const line of payload.split('\n')) {
    frame += `data: ${line}\n`;
  }
  return `${frame}\n`;
}

/**
 * Streams a `text/event-stream` (SSE) response from an async-iterable of events.
 * Sets the SSE headers, frames each event, and — crucially for long-lived
 * streams — on client disconnect calls the iterator's `return()` so an async
 * generator's `finally` runs (e.g. aborting an upstream call). An optional
 * heartbeat keeps idle connections alive.
 */
async function streamSse(
  res: Response,
  value: unknown,
  decl: SseResponseDecl,
  status: number,
): Promise<void> {
  const iterable = value as AsyncIterable<unknown> | null | undefined;
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
    throw new Error('zodec: an @Sse handler must return an AsyncIterable of events');
  }

  res.status(status);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy (nginx) buffering
  res.flushHeaders();

  const iterator = iterable[Symbol.asyncIterator]();
  let ended = false;
  const stop = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    // Run the generator's finally (cleanup/abort) once the in-flight await settles.
    void iterator.return?.(undefined);
  };
  res.on('close', stop);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (decl.keepAlive && decl.keepAlive > 0) {
    heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keep-alive\n\n');
      }
    }, decl.keepAlive);
    heartbeat.unref?.();
  }

  try {
    while (!ended) {
      const result = await iterator.next();
      if (ended || result.done) {
        break;
      }
      res.write(frameSseEvent(result.value, decl.eventSchema));
    }
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    res.removeListener('close', stop);
    stop();
    if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * Builds the handler argument array, placing each injected value at its own
 * parameter index. Indexes without a decorator stay `undefined`. Custom
 * (`createParamDecorator`) resolvers may be async, so values are awaited — all
 * concurrently, since injected parameters are independent.
 */
async function buildArgs(
  params: ParamMetadata[],
  values: RequestValues,
  req: Request,
  res: Response,
): Promise<unknown[]> {
  const args: unknown[] = [];
  await Promise.all(
    params.map(async (param) => {
      args[param.index] = await resolveParam(param, values, req, res);
    }),
  );
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
  private readonly controllers: RegisteredController[] = [];
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

  /** Records a controller under a base path. Shared by `register`/`group`. */
  private addController(instance: object, prefix: string): void {
    this.controllers.push({ instance, prefix });
  }

  /**
   * Records a pre-constructed controller instance. The caller owns construction
   * and dependency injection; {@link Zodec.mount} does the wiring later.
   *
   * @param instance - A controller instance (not a class).
   * @param options - Registration options, e.g. a `prefix` base path.
   * @returns This instance, for chaining.
   */
  public register(instance: object, options: RegisterOptions = {}): this {
    this.addController(instance, joinPrefix('', options.prefix));
    return this;
  }

  /**
   * Registers a set of controllers under a shared base path — typically an API
   * version segment. The callback receives a {@link ControllerGroup} scoped to
   * `prefix`; groups nest. Reflected in both the routes and the generated spec.
   *
   * @param prefix - Base path for the group (e.g. `'/v1'`).
   * @param fn - Receives the scoped group to register controllers on.
   * @returns This instance, for chaining.
   *
   * @example
   * ```ts
   * api.group('/v1', (v1) => {
   *   v1.register(new UsersController(svc));
   *   v1.register(new AuthController(auth));
   * });
   * ```
   */
  public group(prefix: string, fn: (group: ControllerGroup) => void): this {
    fn(new ControllerGroup(this.addController.bind(this), joinPrefix('', prefix)));
    return this;
  }

  /**
   * Builds the OpenAPI document from the registered controllers' metadata.
   * Independent of {@link Zodec.mount} — does not require routes to be wired.
   *
   * @param options - Generation options. `specVersion` defaults to `'3.1'`.
   *   `schemas` adds standalone (route-less) named schemas to
   *   `components.schemas` — pass the same list to {@link generateSwagger} to keep
   *   instance and static output identical.
   * @returns The assembled OpenAPI document.
   */
  public swagger(
    options: { specVersion?: SpecVersion; schemas?: ZodType[] } = {},
  ): OpenApiDocument {
    const sources = this.controllers.map(({ instance, prefix }) => ({
      prototype: Object.getPrototypeOf(instance) as object,
      basePrefix: prefix,
    }));
    // The scheme definitions for components.securitySchemes come from the
    // instance's security config (each entry's `.scheme`).
    const security = this.options.security;
    const securitySchemes = security
      ? Object.fromEntries(Object.entries(security).map(([name, s]) => [name, s.scheme]))
      : undefined;
    return generateOpenApiDocument(sources, this.options.info, {
      securitySchemes,
      specVersion: options.specVersion,
      servers: this.options.servers,
      externalDocs: this.options.externalDocs,
      tags: this.options.tags,
      schemas: options.schemas,
    });
  }

  /**
   * Builds the high-fidelity {@link ZodecContract} (the codegen IR) from the
   * registered controllers' metadata — the contract sibling of {@link Zodec.swagger}.
   * Independent of {@link Zodec.mount}; serialize it to `contract.json` for a
   * client generator.
   *
   * @param options - Extra inputs, e.g. route-less `schemas` (named via `.meta({ id })`).
   * @returns The validated contract document.
   */
  public contract(options: ContractOptions = {}): ZodecContract {
    const sources = this.controllers.map(({ instance, prefix }) => ({
      prototype: Object.getPrototypeOf(instance) as object,
      basePrefix: prefix,
    }));
    return generateContractDocument(sources, this.options.info, options);
  }

  /**
   * Mounts a documentation UI (and the spec it renders) onto an Express app. The
   * UI HTML is served at `path` and the spec at `${path}/openapi.json`.
   *
   * By default the assets are self-hosted from the chosen UI's package (an
   * optional peer dependency: `@scalar/api-reference` for `'scalar'`,
   * `swagger-ui-dist` for `'swagger-ui'`, `redoc` for `'redoc'`) — install the
   * one you use, or pass `{ cdn: true }` to load it from a CDN instead.
   *
   * @param app - The Express application to mount onto.
   * @param path - Mount path for the UI. Defaults to `'/docs'`.
   * @param options - UI choice, `cdn`, `specVersion`, `title`.
   * @returns This instance, for chaining.
   *
   * @example
   * ```ts
   * api.serveDocs(app);                          // Scalar at /docs
   * api.serveDocs(app, '/docs', { ui: 'swagger-ui' });
   * ```
   */
  public serveDocs(app: Express, path = '/docs', options: ServeDocsOptions = {}): this {
    const specOptions: { specVersion?: SpecVersion; schemas?: ZodType[] } = {};
    if (options.specVersion) {
      specOptions.specVersion = options.specVersion;
    }
    if (options.schemas) {
      specOptions.schemas = options.schemas;
    }
    mountDocs(app, path, () => this.swagger(specOptions), options);
    return this;
  }

  /**
   * Walks every registered controller's metadata and binds its routes (with
   * validation middleware) onto the Express app.
   *
   * @param app - The Express application to register routes on.
   * @returns This instance, for chaining.
   */
  public mount(app: Express): this {
    for (const { instance, prefix: basePrefix } of this.controllers) {
      const proto = Object.getPrototypeOf(instance) as object;
      // Registration base path (e.g. `/v1`) in front of the controller's @Route.
      const prefix = joinPrefix(basePrefix, getPrefix(proto));
      for (const route of getRoutes(proto)) {
        const path = toExpressPath(prefix, route.path);
        const middlewares: RequestHandler[] = [];
        // Chain order: security → @Use → multipart → handler.
        // Authenticate first — reject unauthorized requests before anything else.
        if (route.security && route.security.length > 0) {
          middlewares.push(this.securityMiddleware(route.security));
        }
        // User middleware (@Use) — auth has run, body not yet parsed.
        if (route.middleware && route.middleware.length > 0) {
          middlewares.push(...route.middleware);
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
      let values: RequestValues;
      try {
        values = validate(route, req);
      } catch (err) {
        next(err);
        return;
      }
      buildArgs(params, values, req, res)
        .then((args) => fn.apply(instance, args))
        .then((value: unknown) => {
          // A handler using @Res() writes the response itself — don't double-send.
          if (res.headersSent) {
            return;
          }
          // A FileResponse streams a binary body; skip JSON + response validation.
          if (value instanceof FileResponse) {
            sendFile(res, value, status);
            return;
          }
          // A RangeFileResponse additionally honors HTTP Range (async-capable).
          if (value instanceof RangeFileResponse) {
            sendRangeFile(req, res, value, status).catch(next);
            return;
          }
          // An HttpResponse carries status/headers/cookies alongside a validated
          // JSON body — status-selected, body parsed by the matched @Returns.
          if (value instanceof HttpResponse) {
            sendHttpResponse(res, value, route, status, next);
            return;
          }
          // An @Sse route streams the returned async-iterable as text/event-stream.
          const sse = route.responses[status]?.sse;
          if (sse) {
            streamSse(res, value, sse, status).catch(next);
            return;
          }
          // Always-on response validation: the return value must match its
          // declared @Returns schema. A mismatch is a server bug, so it throws
          // a 500 ValidationError through the same error pipeline as everything
          // else — zodec never decides what to do with it. The *parsed* value is
          // what's sent, so the schema also serializes the response: unknown keys
          // are stripped and transforms/defaults applied (use `.loose()` to keep
          // extra keys). Without a schema, the value is sent as-is.
          const schema = route.responses[status]?.schema;
          let output: unknown = value;
          if (schema) {
            const result = schema.safeParse(value);
            if (!result.success) {
              next(new ValidationError(500, result.error.issues));
              return;
            }
            output = result.data;
          }
          res.status(status).json(output);
        })
        .catch(next);
    };
  }
}
