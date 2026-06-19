import { writeFile } from 'node:fs/promises';
import { generateSwagger } from 'zodec';
import { apiInfo } from './api-info.js';
import { securitySchemes } from './api-security.js';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';

// Static: pass the controller classes directly — no Zodec instance, no service
// construction. The @Security requirements come off the classes; the scheme
// *definitions* are instance config, so we hand in the same shared
// `securitySchemes` the running server uses (api-security.ts) — keeping this
// output identical to api.swagger() without constructing any services.
const swagger = generateSwagger([HealthController, UsersController, AuthController], apiInfo, {
  securitySchemes,
});
const out = process.argv[2] ?? 'swagger.json';
await writeFile(out, JSON.stringify(swagger, null, 2));
console.log(`Wrote ${out}`);
