import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import express, { type Express } from 'express';
import type { OpenApiDocument, SpecVersion } from './swagger.js';

const require = createRequire(import.meta.url);

/** Documentation UI `serveDocs` can render. */
export type DocsUi = 'scalar' | 'swagger-ui' | 'redoc';

/** Options for {@link import('./zodec.js').Zodec.serveDocs}. */
export interface ServeDocsOptions {
  /** Which UI to render. Defaults to `'scalar'`. */
  ui?: DocsUi;
  /**
   * Serve the UI assets from a CDN instead of the installed package. `false`
   * (default) self-hosts from `node_modules` — works offline / under strict CSP,
   * but requires the UI's package to be installed. `true` needs no install but
   * fetches the bundle from jsDelivr at runtime.
   */
  cdn?: boolean;
  /** OpenAPI spec version to serve. Defaults to `'3.1'`. */
  specVersion?: SpecVersion;
  /** Page `<title>`. Defaults to `'API Reference'`. */
  title?: string;
}

/** The optional peer package each self-hosted UI needs. */
const UI_PACKAGE: Record<DocsUi, string> = {
  scalar: '@scalar/api-reference',
  'swagger-ui': 'swagger-ui-dist',
  redoc: 'redoc',
};

/** Escapes a string for safe interpolation into HTML text/attributes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Finds the on-disk root directory of an installed package. */
function packageDir(name: string): string {
  let dir = dirname(require.resolve(name));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (pkg.name === name) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate the root of "${name}"`);
    }
    dir = parent;
  }
}

/** Friendly error when a self-hosted UI's package isn't installed. */
function missing(ui: DocsUi): Error {
  return new Error(
    `zodec: serveDocs({ ui: '${ui}' }) needs "${UI_PACKAGE[ui]}" installed ` +
      `(npm i ${UI_PACKAGE[ui]}), or pass { cdn: true } to load it from a CDN.`,
  );
}

const HEAD = (title: string): string =>
  `<meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">`;

/**
 * Mounts a documentation UI and the spec it renders onto an Express app. The
 * spec is served at `${mountPath}/openapi.json` (regenerated per request via
 * `getSpec`); the UI's HTML is served at `mountPath`. Self-hosted assets are
 * resolved from the installed UI package and served under `mountPath`.
 */
export function mountDocs(
  app: Express,
  mountPath: string,
  getSpec: () => OpenApiDocument,
  options: ServeDocsOptions = {},
): void {
  const ui = options.ui ?? 'scalar';
  const base = mountPath.replace(/\/+$/, '');
  const root = base === '' ? '/' : base;
  const specPath = `${base}/openapi.json`;
  const title = options.title ?? 'API Reference';

  app.get(specPath, (_req, res) => {
    res.json(getSpec());
  });

  const sendHtml = (html: string): express.RequestHandler => {
    return (_req, res) => {
      res
        .type('html')
        .send(`<!doctype html><html><head>${HEAD(title)}</head><body>${html}</body></html>`);
    };
  };

  if (ui === 'swagger-ui') {
    const cssUrl = options.cdn
      ? 'https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css'
      : `${base}/assets/swagger-ui.css`;
    const jsUrl = options.cdn
      ? 'https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js'
      : `${base}/assets/swagger-ui-bundle.js`;
    if (!options.cdn) {
      let dir: string;
      try {
        dir = dirname(require.resolve('swagger-ui-dist/swagger-ui-bundle.js'));
      } catch {
        throw missing('swagger-ui');
      }
      app.use(`${base}/assets`, express.static(dir));
    }
    app.get(
      root,
      sendHtml(
        `<link rel="stylesheet" href="${cssUrl}"><div id="app"></div>` +
          `<script src="${jsUrl}"></script>` +
          `<script>window.ui=SwaggerUIBundle({url:${JSON.stringify(specPath)},dom_id:'#app'})</script>`,
      ),
    );
    return;
  }

  if (ui === 'redoc') {
    const jsUrl = options.cdn
      ? 'https://cdn.jsdelivr.net/npm/redoc/bundles/redoc.standalone.js'
      : `${base}/redoc.standalone.js`;
    if (!options.cdn) {
      let file: string;
      try {
        file = require.resolve('redoc/bundles/redoc.standalone.js');
      } catch {
        throw missing('redoc');
      }
      app.get(`${base}/redoc.standalone.js`, (_req, res) => {
        res.sendFile(file);
      });
    }
    app.get(
      root,
      sendHtml(`<redoc spec-url="${specPath}"></redoc><script src="${jsUrl}"></script>`),
    );
    return;
  }

  // scalar (default)
  const jsUrl = options.cdn
    ? 'https://cdn.jsdelivr.net/npm/@scalar/api-reference'
    : `${base}/scalar.js`;
  if (!options.cdn) {
    let file: string;
    try {
      file = join(packageDir('@scalar/api-reference'), 'dist', 'browser', 'standalone.js');
    } catch {
      throw missing('scalar');
    }
    app.get(`${base}/scalar.js`, (_req, res) => {
      res.sendFile(file);
    });
  }
  app.get(
    root,
    sendHtml(
      `<script id="api-reference" data-url="${specPath}"></script><script src="${jsUrl}"></script>`,
    ),
  );
}
