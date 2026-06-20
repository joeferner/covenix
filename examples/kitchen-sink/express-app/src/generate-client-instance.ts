import { writeFile } from 'node:fs/promises';
import { generateTypeScriptClient } from 'zodec';
import { api } from './api.js';
import { additionalSchemas } from './api-schemas.js';

// Generate a standalone, dependency-free TypeScript client from the contract —
// types reconstructed from the schemas plus an inlined fetch runtime. A frontend
// imports this one file (no `zodec` dependency) and calls e.g.
//   const user = await client.users.get({ params: { id } });
const out = process.argv[2] ?? 'api.gen.ts';
await writeFile(out, generateTypeScriptClient(api.contract({ schemas: additionalSchemas })));
console.log(`Wrote ${out}`);
