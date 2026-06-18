// reflect-metadata must load before any controller's decorators evaluate, so
// import it here — this module is the single place controllers get registered.
import 'reflect-metadata';
import { Zodec } from 'zodec';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';
import { UserService } from './services/UserService.js';
import { AuthService } from './services/AuthService.js';

// You own construction and dependency injection — plain TypeScript, no container.
const userService = new UserService();
const authService = new AuthService(userService);

// One configured Zodec instance, shared by the server (main.ts) and the headless
// swagger generator (generate-swagger.ts). register() just records the instances;
// the consumer decides whether to mount() routes or only call swagger().
export const api = new Zodec({
  info: { title: 'Kitchen Sink API', version: '1.0.0' },
});

api.register(new HealthController());
api.register(new UsersController(userService));
api.register(new AuthController(authService));
