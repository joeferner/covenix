import { writeFile } from 'node:fs/promises';
import { api } from './api.js';
import { additionalSchemas } from './api-schemas.js';

// Headless: emit the OpenAPI document with no mount() and no running server —
// the same configured instance the server uses. Handy for CI and client codegen.
const out = process.argv[2] ?? 'swagger.json';
await writeFile(out, JSON.stringify(api.swagger({ schemas: additionalSchemas }), null, 2));
console.log(`Wrote ${out}`);
