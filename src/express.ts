import express from 'express';
import type { Express, RequestHandler } from 'express';
import { createServer, type Server } from 'node:http';
import { covenixErrorHandler } from './errors.js';
import type { ServeDocsOptions } from './serve-docs.js';
import type { Covenix } from './covenix.js';

/** Options for {@link express.json} (the body-parser JSON options). */
type JsonOptions = Parameters<typeof express.json>[0];
/** Options for {@link express.urlencoded} (the body-parser urlencoded options). */
type UrlencodedOptions = Parameters<typeof express.urlencoded>[0];

/**
 * Options for {@link toExpress} / {@link serve}. Each step can be opted out
 * (`false`) or customized; the build order is fixed (see {@link toExpress}):
 * `configure` → body parsers → routes → docs → `after` → error handler.
 */
export interface ToExpressOptions {
  /**
   * An existing Express app to build onto. Defaults to a fresh `express()`. Use
   * this to layer covenix onto an app you've already partly configured.
   */
  app?: Express;
  /**
   * Mount `express.json()`. `true` (default) uses defaults; an object passes
   * body-parser options (e.g. `{ limit: '1mb' }`); `false` skips it.
   */
  json?: boolean | JsonOptions;
  /**
   * Mount `express.urlencoded()`. `false` (default) skips it; `true` uses
   * `{ extended: true }`; an object passes body-parser options.
   */
  urlencoded?: boolean | UrlencodedOptions;
  /**
   * Serve the docs UI via {@link Covenix.serveDocs}. `true` (default) mounts at
   * `/docs`; an object customizes `path` and the UI options; `false` skips it.
   */
  docs?: boolean | (ServeDocsOptions & { path?: string });
  /**
   * Install an error handler **last**. `true` (default) uses
   * {@link covenixErrorHandler}; a function installs your own; `false` skips it.
   */
  errorHandler?: boolean | RequestHandler;
  /**
   * Runs **before** routes (and before the body parsers) — the place for
   * pre-route middleware: CORS, helmet, logging, static files, header-based auth.
   * Note: fires before body parsing, so middleware needing a parsed body must add
   * its own parser here.
   */
  configure?: (app: Express) => void;
  /**
   * Runs **after** routes but **before** the error handler — e.g. a SPA fallback
   * (`app.get('{*path}', …)`) that must sit after the API routes.
   */
  after?: (app: Express) => void;
}

/** Options for {@link serve} — {@link ToExpressOptions} plus where to listen. */
export interface ServeOptions extends ToExpressOptions {
  /** Port to listen on. Defaults to `3000`. */
  port?: number;
  /** Host/interface to bind. Defaults to all interfaces. */
  host?: string;
}

/**
 * Convenience builder that assembles a ready-to-listen Express app for a
 * {@link Covenix} instance, collapsing the usual boilerplate
 * (`express()` + `express.json()` + `mount` + `serveDocs` + `covenixErrorHandler`)
 * into one call — with the middleware order fixed by construction:
 *
 * `configure` → body parsers (json / urlencoded) → routes → docs → `after`
 * → error handler.
 *
 * This is **opt-in sugar**, not the only way in: you can still build the app
 * yourself and call {@link Covenix.mount} / {@link Covenix.serveDocs} directly. Each
 * step here can be disabled (`false`) or customized via {@link ToExpressOptions}.
 * Returns the app **without listening** — ideal for supertest-style tests; use
 * {@link serve} to also listen.
 *
 * @example
 * ```ts
 * const app = toExpress(api, {
 *   configure: (app) => app.use(cors()),   // before routes
 *   json: { limit: '1mb' },
 * });
 * ```
 */
export function toExpress(api: Covenix, options: ToExpressOptions = {}): Express {
  const app = options.app ?? express();

  // Pre-route middleware (cors/helmet/logging/static/header-auth).
  options.configure?.(app);

  // Body parsers — json on by default, urlencoded opt-in.
  if (options.json !== false) {
    app.use(express.json(typeof options.json === 'object' ? options.json : undefined));
  }
  if (options.urlencoded) {
    app.use(
      express.urlencoded(
        typeof options.urlencoded === 'object' ? options.urlencoded : { extended: true },
      ),
    );
  }

  // Routes.
  api.mount(app);

  // Docs UI (+ its spec), on by default.
  if (options.docs !== false) {
    const { path, ...docsOptions } = typeof options.docs === 'object' ? options.docs : {};
    api.serveDocs(app, path ?? '/docs', docsOptions);
  }

  // Post-route, pre-error-handler (e.g. SPA fallback).
  options.after?.(app);

  // Error handler, last.
  if (options.errorHandler !== false) {
    app.use(
      typeof options.errorHandler === 'function' ? options.errorHandler : covenixErrorHandler(),
    );
  }

  return app;
}

/**
 * Builds the app with {@link toExpress} and starts listening, resolving once the
 * server is up (or rejecting on a bind error). Returns the Node `http.Server` —
 * so you can attach a `WebSocketServer({ server })`, close it for graceful
 * shutdown, etc. Like {@link toExpress}, this is opt-in convenience.
 *
 * @example
 * ```ts
 * const server = await serve(api, { port: 3000, configure: (a) => a.use(cors()) });
 * // server is a http.Server — attach websockets, close on shutdown, …
 * ```
 */
export async function serve(api: Covenix, options: ServeOptions = {}): Promise<Server> {
  const app = toExpress(api, options);
  const server = createServer(app);
  const port = options.port ?? 3000;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, options.host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  return server;
}
