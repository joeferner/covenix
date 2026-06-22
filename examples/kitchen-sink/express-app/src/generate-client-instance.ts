import { writeFile } from 'node:fs/promises';
import { generateTypeScriptClient } from 'zodec';
import { api } from './api.js';
import { additionalSchemas } from './api-schemas.js';

// Generate a standalone TypeScript client from the contract — types reconstructed
// from the schemas plus an inlined fetch runtime. A frontend imports this one file
// and calls e.g. `const user = await client.users.get({ params: { id } });`.
//
// Pass `--validate` for the opt-in validating variant: it `import`s `zod`, parses
// requests/responses against regenerated schemas at runtime, and revives dates.
const out = process.argv[2] ?? 'api.gen.ts';
const validate = process.argv.includes('--validate');
await writeFile(
  out,
  generateTypeScriptClient(api.contract({ schemas: additionalSchemas }), {
    validate: validate ? 'zod' : false,
  }),
);
console.log(`Wrote ${out}${validate ? ' (validating)' : ''}`);
