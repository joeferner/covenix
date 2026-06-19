# Getting Started

`zodec` lets you describe each endpoint with explicit [Zod](https://zod.dev)
schemas and ergonomic decorators. From that one description it wires Express
routes, validates every request, and generates a `swagger.json` that always
matches what the code actually does.

## Installation

```bash
npm install zodec zod reflect-metadata express
```

zodec requires **Zod 4+** and **TypeScript 5+** with experimental decorators.

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
- `emitDecoratorMetadata` is **not** required — zodec uses explicit parameter
  decorators, so it never needs runtime type metadata.
- Import `reflect-metadata` once at your app's entry point.

## Define a controller

```typescript
import { z } from 'zod';
import createError from 'http-errors';
import { Route, Tags, Get, Post, Params, Body, Returns, Param, BodyParam } from 'zodec';

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
import express from 'express';
import { Zodec } from 'zodec';
import { UsersController } from './users.controller.js';

const app = express();
app.use(express.json());

const api = new Zodec({ info: { title: 'My API', version: '1.0.0' } });

// You own construction — inject dependencies explicitly.
api.register(new UsersController(db));

api.mount(app);

app.listen(3000);
```

A single [`Zodec`](/api/classes/Zodec) instance owns your controllers;
[`mount`](/api/classes/Zodec#mount) wires the Express routes and validation
middleware, and the same instance generates swagger. Next: see
[Validation & Errors](./validation), [OpenAPI / Swagger](./swagger), and the
full [API Reference](/api/).
