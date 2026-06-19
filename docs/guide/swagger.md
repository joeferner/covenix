# OpenAPI / Swagger

Name your top-level schemas with Zod 4's native `.meta({ id })` so they become
reusable components:

```typescript
const UserSchema = z
  .object({
    /* ... */
  })
  .meta({ id: 'User' });
//   → referenced as #/components/schemas/User in swagger
```

Anonymous inline schemas are allowed but produce inlined swagger (no `$ref`).

## From a running instance

The same [`Zodec`](/api/classes/Zodec) instance you registered controllers on
generates the spec — no need to list controllers a second time:

```typescript
app.get('/swagger.json', (_req, res) => res.json(api.swagger()));
```

[`api.swagger()`](/api/classes/Zodec#swagger) builds the OpenAPI 3.1 document
from the registered controllers' metadata. It doesn't depend on routes being
mounted.

## Static generation — no instances required

Swagger is derived entirely from class-level metadata, so if you only need the
spec you don't have to construct controllers (or their dependencies) at all.
[`generateSwagger`](/api/functions/generateSwagger) takes the controller
**classes** directly:

```typescript
import { writeFile } from 'node:fs/promises';
import { generateSwagger } from 'zodec';

const swagger = generateSwagger([UsersController, HealthController]);
await writeFile('swagger.json', JSON.stringify(swagger, null, 2));
```

This is the lightest path for CI spec checks and client codegen: no `Zodec`
instance, no service wiring, no Express — just the classes and their decorators.
