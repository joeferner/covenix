import { writeFile } from 'node:fs/promises';
import { api } from './api.js';
import { additionalSchemas } from './api-schemas.js';

// Headless: emit the avero contract IR (the codegen-oriented sibling of
// swagger.json) from the same configured instance — no mount(), no server.
// `schemas` adds route-less types (see api-schemas.ts) so generators emit them
// too. Feed contract.json to a client generator.
const out = process.argv[2] ?? 'contract.json';
await writeFile(out, JSON.stringify(api.contract({ schemas: additionalSchemas }), null, 2));
console.log(`Wrote ${out}`);
