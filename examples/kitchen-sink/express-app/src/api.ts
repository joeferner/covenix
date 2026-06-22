// reflect-metadata must load before any controller's decorators evaluate, so
// import it here — this module is the single place controllers get registered.
import 'reflect-metadata';
import { Avero } from 'avero';
import { apiInfo } from './api-info.js';
import { buildSecurity } from './api-security.js';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';
import { UserService } from './services/UserService.js';
import { AuthService } from './services/AuthService.js';

// You own construction and dependency injection — plain TypeScript, no container.
const userService = new UserService();
const authService = new AuthService(userService);

// One configured Avero instance, shared by the server (main.ts) and the headless
// swagger generator (generate-swagger.ts). register() just records the instances;
// the consumer decides whether to mount() routes or only call swagger().
// `security` names the auth schemes that @Security('bearer') routes reference.
export const api = new Avero({ info: apiInfo, security: buildSecurity(authService) });

// Group registration: every controller is mounted under a shared `/v1` base
// path, so the routes and the generated spec read `/v1/users`, `/v1/health`, …
// To stand up a `/v2`, open another group with the next versions of the
// controllers — the `/v1` group keeps serving unchanged.
api.group('/v1', (v1) => {
  v1.register(new HealthController());
  v1.register(new UsersController(userService));
  v1.register(new AuthController(authService));
});
