import { writeFile } from 'node:fs/promises';
import { generateContract } from 'zodec';
import { apiInfo } from './api-info.js';
import { additionalSchemas } from './api-schemas.js';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';

// Static: build the contract from the controller classes directly — no Zodec
// instance, no service construction. Unlike swagger, the contract needs no
// security *definitions* (it records scheme names + scopes off the routes), so
// this is purely the classes. Mirror the instance's `/v1` group with `prefix`
// and the same route-less `schemas` so the output matches api.contract().
const contract = generateContract(
  [
    { controller: HealthController, prefix: '/v1' },
    { controller: UsersController, prefix: '/v1' },
    { controller: AuthController, prefix: '/v1' },
  ],
  apiInfo,
  { schemas: additionalSchemas },
);
const out = process.argv[2] ?? 'contract.json';
await writeFile(out, JSON.stringify(contract, null, 2));
console.log(`Wrote ${out}`);
