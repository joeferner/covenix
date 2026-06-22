import cookieParser from 'cookie-parser';
import { serve } from 'covenix';
import { api } from './api.js';
import { additionalSchemas } from './api-schemas.js';

const port = Number(process.env.PORT ?? 3000);

// One-call bootstrap: `serve` builds the Express app (json body parser, mounted
// routes, Scalar docs at /docs, and the covenix error handler) and starts listening.
// The docs `schemas` option adds route-less named types (see api-schemas.ts) to the
// served spec, so /docs/openapi.json is complete — no separate /swagger.json needed.
await serve(api, {
  port,
  // `configure` runs before the routes — mount cookie-parser so `req.cookies` is
  // populated for @Cookies/@CookieParam (see AuthController.session).
  configure: (app) => app.use(cookieParser()),
  // `cdn: true` keeps this example dependency-free; drop it to self-host the UI.
  docs: { cdn: true, schemas: additionalSchemas },
});

console.log(`Kitchen Sink API listening on http://localhost:${port}`);
