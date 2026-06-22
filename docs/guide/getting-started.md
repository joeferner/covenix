# Getting Started

`avero` lets you describe each endpoint with explicit [Zod](https://zod.dev)
schemas and ergonomic decorators. From that one description it wires Express
routes, validates every request, and generates a `swagger.json` that always
matches what the code actually does.

## Installation

```bash
npm install avero zod reflect-metadata express
```

avero requires **Zod 4+** and **TypeScript 5+** with experimental decorators.

### TypeScript configuration

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "module": "nodenext",
    "types": ["reflect-metadata"],
  },
}
```

- `"type": "module"` is required in `package.json` (ESM).
- `emitDecoratorMetadata` is **not** required — avero uses explicit parameter
  decorators, so it never needs runtime type metadata.
- Import `reflect-metadata` once at your app's entry point.

## Define a controller

```typescript
import { z } from 'zod';
import createError from 'http-errors';
import { Route, Tags, Get, Post, Params, Body, Returns, Param, BodyParam } from 'avero';

const UserSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string(),
  })
  .meta({ id: 'User' });

const CreateUserSchema = z
  .object({
    username: z.string(),
  })
  .meta({ id: 'CreateUser' });

@Route('users')
@Tags('Users')
export class UsersController {
  @Get('{id}')
  @Params(z.object({ id: z.string().uuid() }))
  @Returns(200, UserSchema)
  async getUser(@Param('id') id: string) {
    const user = await db.users.findById(id);
    if (!user) throw new createError.NotFound();
    return user;
  }

  @Post()
  @Body(CreateUserSchema)
  @Returns(201, UserSchema)
  async createUser(@BodyParam() body: z.infer<typeof CreateUserSchema>) {
    return db.users.create(body);
  }
}
```

## Wire it up

```typescript
// app.ts
import 'reflect-metadata';
import { Avero, serve } from 'avero';
import { UsersController } from './users.controller.js';

const api = new Avero({ info: { title: 'My API', version: '1.0.0' } });

// You own construction — inject dependencies explicitly.
api.register(new UsersController(db));

// One call: builds an Express app (json body parser, mounted routes, docs,
// error handler) and starts listening. Returns the http.Server.
await serve(api, { port: 3000 });
```

A single [`Avero`](/api/classes/Avero) instance owns your controllers;
[`serve`](/api/functions/serve) is opt-in convenience that assembles a ready Express
app and listens. The same instance also generates swagger.

### Or own the Express app yourself

`serve`/[`toExpress`](/api/functions/toExpress) are sugar, not a requirement. When
you need full control, build the app and call
[`mount`](/api/classes/Avero#mount) directly:

```typescript
import express from 'express';
import { Avero, averoErrorHandler } from 'avero';

const app = express();
app.use(express.json());

const api = new Avero({ info: { title: 'My API', version: '1.0.0' } });
api.register(new UsersController(db));
api.mount(app); // wires routes + validation
api.serveDocs(app); // optional docs UI
app.use(averoErrorHandler());
app.listen(3000);
```

`toExpress` returns the built app **without** listening — handy for supertest.
See [Route Handlers](./route-handlers) for what goes in a controller, then
[Validation & Errors](./validation), [OpenAPI / Swagger](./swagger), and the full
[API Reference](/api/).
