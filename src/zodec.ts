import type { Express, Request, RequestHandler, Response } from 'express';
import {
  getParams,
  getPrefix,
  getRoutes,
  type ParamMetadata,
  type RouteMetadata,
} from './metadata.js';

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

// Resolves a single injected parameter from the request. A decorator with no
// `name` injects the whole bag (e.g. `@Param()` → all params).
function resolveParam(param: ParamMetadata, req: Request, res: Response): unknown {
  switch (param.source) {
    case 'param':
      return param.name ? req.params[param.name] : req.params;
    case 'query':
      return param.name ? req.query[param.name] : req.query;
    case 'body':
      return req.body as unknown;
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
function buildArgs(params: ParamMetadata[], req: Request, res: Response): unknown[] {
  const args: unknown[] = [];
  for (const param of params) {
    args[param.index] = resolveParam(param, req, res);
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
        const args = buildArgs(params, req, res);
        Promise.resolve(fn.apply(instance, args)).then((value: unknown) => {
          // A handler using @Res() writes the response itself — don't double-send.
          if (!res.headersSent) {
            res.status(status).json(value);
          }
        }, next);
      } catch (err) {
        next(err);
      }
    };
  }
}
