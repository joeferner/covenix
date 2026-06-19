import type { Express, RequestHandler } from 'express';
import { getPrefix, getRoutes, type RouteMetadata } from './metadata.js';

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
        app[route.method](toExpressPath(prefix, route.path), this.makeHandler(instance, route));
      }
    }
    return this;
  }

  private makeHandler(instance: object, route: RouteMetadata): RequestHandler {
    const status = successStatus(route.responses);
    const fn = (instance as Record<string, HandlerFn>)[route.handlerName];
    return (_req, res, next) => {
      try {
        Promise.resolve(fn.call(instance)).then((value: unknown) => {
          res.status(status).json(value);
        }, next);
      } catch (err) {
        next(err);
      }
    };
  }
}
