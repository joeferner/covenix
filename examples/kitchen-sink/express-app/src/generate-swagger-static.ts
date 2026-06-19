import { writeFile } from 'node:fs/promises';
import { generateSwagger } from 'zodec';
import { apiInfo } from './api-info.js';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';

// Static: pass the controller classes directly — no Zodec instance, no service
// construction. Uses the same shared info + controller order as the instance
// generator, so the two produce identical output.
const swagger = generateSwagger([HealthController, UsersController, AuthController], apiInfo);
const out = process.argv[2] ?? 'swagger.json';
await writeFile(out, JSON.stringify(swagger, null, 2));
console.log(`Wrote ${out}`);
