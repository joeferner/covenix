import express from 'express';
import { zodecErrorHandler } from 'zodec';
import { api } from './api.js';
import { additionalSchemas } from './api-schemas.js';

const app = express();
app.use(express.json());

// Wire every registered controller's routes + validation middleware onto Express.
api.mount(app);

// Same instance generates the spec from the controllers it already holds.
// `schemas` adds route-less types (see api-schemas.ts) to the document.
app.get('/swagger.json', (_req, res) => res.json(api.swagger({ schemas: additionalSchemas })));

// Serve a docs UI (Scalar) at /docs, with the spec at /docs/openapi.json. Using
// `cdn: true` keeps this example dependency-free; drop it to self-host the UI
// from node_modules (the default — install @scalar/api-reference for that).
api.serveDocs(app, '/docs', { cdn: true });

// zodec never sends an error response itself — failed validation and thrown
// http-errors flow through Express. This convenience handler renders the
// standard { status, errors } shape; swap it for your own to control the output.
app.use(zodecErrorHandler());

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Kitchen Sink API listening on http://localhost:${port}`);
});
