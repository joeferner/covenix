import { writeFile } from 'node:fs/promises';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';
import { generateSwagger } from 'zodec';

const swagger = generateSwagger([HealthController, UsersController, AuthController]);
await writeFile('swagger.json', JSON.stringify(swagger, null, 2));
console.log('Wrote swagger.json');
