import type { Express, Request, RequestHandler, Response } from 'express';
import {
  getParams,
  getPrefix,
  getRoutes,
  type ParamMetadata,
  type RouteMetadata,
} from './metadata.js';
import { ValidationError } from './errors.js';

// Per-request values the handler's injected parameters resolve from. Each source
// starts as the raw request value and is replaced by the parsed (coerced,
// defaulted) output once its schema validates. Kept separate from `req` because
// Express 5 exposes `req.query` as a getter only — it cannot be reassigned.
interface RequestValues {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
}

export interface ZodecInfo {
  title: string;
  version: string;
}

export interface ZodecOptions {
  info: ZodecInfo;
}

type HandlerFn = (...args: unknown[]) => unknown;

// Joins the controller prefix and route path into a single Express path,
// collapsing duplicate slashes and translating `{id}` placeholders to `:id`.
function toExpressPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  const normalized = joined === '' ? '/' : joined;
  return normalized.replace(/\{([^}]+)\}/g, ':$1');
}

// The status sent on success: the first declared 2xx response, or 200.
function successStatus(responses: Record<number, unknown>): number {
  const codes = Object.keys(responses).map(Number);
  return codes.find((code) => code >= 200 && code < 300) ?? 200;
}

// Validates the request sources that have schemas, returning the parsed values
// (raw values for sources without a schema). Throws ValidationError on the first
// failure — 400 for params/query, 422 for body.
function validate(route: RouteMetadata, req: Request): RequestValues {
  const values: RequestValues = {
    params: req.params,
    query: req.query,
    body: req.body as unknown,
  };
  if (route.params) {
    const result = route.params.safeParse(req.params);
    if (!result.success) throw new ValidationError(400, result.error.issues);
    values.params = result.data as Record<string, unknown>;
  }
  if (route.query) {
    const result = route.query.safeParse(req.query);
    if (!result.success) throw new ValidationError(400, result.error.issues);
    values.query = result.data as Record<string, unknown>;
  }
  if (route.body) {
    const result = route.body.safeParse(req.body);
    if (!result.success) throw new ValidationError(422, result.error.issues);
    values.body = result.data;
  }
  return values;
}

// Resolves a single injected parameter. A decorator with no `name` injects the
// whole bag (e.g. `@Param()` → all params).
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
      return values.body;
    case 'header':
      return param.name ? req.headers[param.name.toLowerCase()] : req.headers;
    case 'req':
      return req;
    case 'res':
      return res;
  }
}

// Builds the handler argument array, placing each injected value at its own
// parameter index. Indexes without a decorator stay `undefined`.
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

export class Zodec {
  private readonly controllers: object[] = [];

  public constructor(private readonly options: ZodecOptions) {}

  public get info(): ZodecInfo {
    return this.options.info;
  }

  // Records a pre-constructed controller instance. The caller owns construction
  // and dependency injection; mount() does the wiring later.
  public register(instance: object): this {
    this.controllers.push(instance);
    return this;
  }

  // Walks every registered controller's metadata and binds its routes onto the
  // Express app.
  public mount(app: Express): this {
    for (const instance of this.controllers) {
      const proto = Object.getPrototypeOf(instance) as object;
      const prefix = getPrefix(proto);
      for (const route of getRoutes(proto)) {
        app[route.method](
          toExpressPath(prefix, route.path),
          this.makeHandler(instance, proto, route),
        );
      }
    }
    return this;
  }

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
          if (res.headersSent) return;
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
