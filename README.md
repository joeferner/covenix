# zodec

**Zod-powered decorators for Express APIs — typed routes, runtime validation, and accurate OpenAPI from a single source of truth.**

`zodec` lets you describe each endpoint with explicit [Zod](https://zod.dev)
schemas and ergonomic decorators. From that one description it wires Express
routes, validates every request, and generates a `swagger.json` that always
matches what the code actually does — no separate build step, no config file, no
code generation.

```typescript
import { z } from 'zod';
import createError from 'http-errors';
import { Route, Tags, Get, Post, Params, Body, Returns, Param, BodyParam } from 'zodec';

const UserSchema = z.object({ id: z.string().uuid(), username: z.string() }).meta({ id: 'User' });
const CreateUserSchema = z.object({ username: z.string() }).meta({ id: 'CreateUser' });

@Route('users')
@Tags('Users')
export class UsersController {
  @Get('{id}')
  @Params(z.object({ id: z.string().uuid() }))
  @Returns(200, UserSchema)
  @Returns(404, ErrorSchema)
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

---

## Why zodec

The **Zod schema is the contract**. The same schema that validates a request
also produces its OpenAPI definition, so the two can never drift.

- **One source of truth.** Request validation and the generated spec come from
  the same schemas.
- **Runtime validation included.** Zod parses, coerces, and defaults every
  request before your handler runs. Handlers receive clean, typed data.
- **No build magic.** Just `tsc`. Decorators run at class-definition time and
  store metadata via `reflect-metadata`; swagger is generated at startup.
- **Zero extra deps for schema conversion.** Zod 4 ships `z.toJSONSchema()`
  natively, so schema → JSON Schema needs no helper library.

---

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

Notes:

- `"type": "module"` is required in `package.json` (ESM) to coexist with
  `verbatimModuleSyntax` + `module: nodenext`.
- `emitDecoratorMetadata` is **not** required — zodec uses explicit parameter
  decorators and explicit instance registration, so it never needs runtime type
  metadata.
- Import `reflect-metadata` once at your app's entry point.

---

## Getting started

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

That's it. A single `Zodec` instance owns your controllers; `mount` wires the
Express routes and validation middleware, and the same instance generates
swagger (see below). Request data is parsed by Zod before each handler runs.

---

## Decorator reference

### Class decorators

| Decorator        | Purpose                                             |
| ---------------- | --------------------------------------------------- |
| `@Route(prefix)` | Path prefix for every route in the controller       |
| `@Tags(...tags)` | OpenAPI tags applied to the controller's operations |

### Method decorators

| Decorator                                                                   | Purpose                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| `@Get(path?)` `@Post(path?)` `@Put(path?)` `@Patch(path?)` `@Delete(path?)` | HTTP method + path (use `{id}` for path params)      |
| `@Params(schema)`                                                           | Validate `req.params` against a Zod object           |
| `@Query(schema)`                                                            | Validate `req.query`                                 |
| `@Body(schema)`                                                             | Validate `req.body`                                  |
| `@Returns(status, schema)`                                                  | Declare a response — stackable for multiple statuses |
| `@Summary(text)`                                                            | Operation summary in swagger                         |

### Parameter decorators

| Decorator           | Injects                                           |
| ------------------- | ------------------------------------------------- |
| `@Param(name)`      | `req.params[name]`                                |
| `@QueryParam(name)` | `req.query[name]`                                 |
| `@BodyParam()`      | the whole validated body                          |
| `@Header(name)`     | `req.headers[name]`                               |
| `@Req()` / `@Res()` | raw Express `Request` / `Response` (escape hatch) |

---

## Validation

Each route gets validation middleware generated from its schemas:

| Source         | Validated against | Failure status |
| -------------- | ----------------- | -------------- |
| `req.params`   | `@Params` schema  | `400`          |
| `req.query`    | `@Query` schema   | `400`          |
| `req.body`     | `@Body` schema    | `422`          |
| handler return | `@Returns` schema | `500`          |

On success, the original request values are replaced with the parsed (coerced,
defaulted) output so handlers always receive clean data. Responses are validated
the same way: the handler's return value is checked against the matching
`@Returns` schema, and a mismatch **always throws** a `ValidationError` through
`next(err)` — exactly like a request failure, in every environment. zodec never
decides what to do about it; your error middleware does (log it and respond
`500`, swallow it, or surface the drift however you like).

### Errors flow through Express

zodec never sends an error response itself. A failed validation calls
`next(err)` with a `ValidationError` that carries the Zod issues and a status
(`400` for params/query, `422` for body, `500` for a response that doesn't match
its `@Returns` schema), so it travels the **same** Express error pipeline as
anything your handlers throw. You stay in control of the
response shape via your own error middleware:

```typescript
import { ValidationError } from 'zodec';

app.use((err, req, res, next) => {
  if (err instanceof ValidationError) {
    return res.status(err.status).json({ status: err.status, errors: err.issues });
  }
  next(err); // your http-errors / fallback handling
});
```

If you don't want to write that, zodec ships an optional `zodecErrorHandler`
convenience that renders the standard shape — but you're never tied to it:

```typescript
import { zodecErrorHandler } from 'zodec';

app.use(zodecErrorHandler()); // → { status, errors: [{ path, message }] }
```

---

## OpenAPI / Swagger

Name your top-level schemas so they become reusable components:

```typescript
const UserSchema = z
  .object({
    /* ... */
  })
  .meta({ id: 'User' });
//   → referenced as #/components/schemas/User in swagger
```

Anonymous inline schemas are allowed but produce inlined swagger (no `$ref`).

The same `Zodec` instance you registered controllers on generates the spec — no
need to list controllers a second time:

```typescript
app.get('/swagger.json', (_req, res) => res.json(api.swagger()));
```

`api.swagger()` builds the OpenAPI document from the registered controllers'
metadata. It doesn't depend on routes being mounted, so for CI or frontend
client generation a `generate-swagger` script can register controllers and call
`api.swagger()` headlessly, writing `swagger.json` to disk without starting the
server.

### Static generation — no instances required

Swagger is derived entirely from class-level metadata, so if you only need the
spec you don't have to construct controllers (or their dependencies) at all.
`generateSwagger(controllers)` takes the controller **classes** directly and
returns the OpenAPI document:

```typescript
// generate-swagger-static.ts
import { writeFile } from 'node:fs/promises';
import { generateSwagger } from 'zodec';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';

const swagger = generateSwagger([HealthController, UsersController, AuthController]);
await writeFile('swagger.json', JSON.stringify(swagger, null, 2));
```

This is the lightest path for CI spec checks and client codegen: no `Zodec`
instance, no service wiring, no Express — just the classes and their decorators.
Use `api.swagger()` instead when you already have a configured instance on hand
(e.g. serving the spec from the running app).

---

## License

MIT © Joe Ferner
