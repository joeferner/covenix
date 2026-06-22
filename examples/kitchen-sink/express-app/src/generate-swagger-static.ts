import { writeFile } from 'node:fs/promises';
import { generateSwagger } from 'covenix';
import { apiInfo } from './api-info.js';
import { additionalSchemas } from './api-schemas.js';
import { securitySchemes } from './api-security.js';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';

// Static: pass the controller classes directly — no Covenix instance, no service
// construction. The @Security requirements come off the classes; the scheme
// *definitions* and standalone `schemas` are instance config, so we hand in the
// same values the running server uses (api-security.ts / api.ts) — keeping this
// output identical to api.swagger() without constructing any services.
// Mirror the instance's `/v1` group (api.ts) by wrapping each class with its
// registration prefix — keeping this static output identical to api.swagger().
const swagger = generateSwagger(
  [
    { controller: HealthController, prefix: '/v1' },
    { controller: UsersController, prefix: '/v1' },
    { controller: AuthController, prefix: '/v1' },
  ],
  apiInfo,
  { securitySchemes, schemas: additionalSchemas },
);
const out = process.argv[2] ?? 'swagger.json';
await writeFile(out, JSON.stringify(swagger, null, 2));
console.log(`Wrote ${out}`);
