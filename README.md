# avero

**Zod-powered decorators for Express APIs — typed routes, runtime validation, and accurate OpenAPI from a single source of truth.**

**[Documentation](https://joeferner.github.io/avero/guide/getting-started)** · [API Reference](https://joeferner.github.io/avero/api/)

`avero` lets you describe each endpoint with explicit [Zod](https://zod.dev)
schemas and ergonomic decorators. From that one description it wires Express
routes, validates every request, and generates a `swagger.json` that always
matches what the code actually does — no separate build step, no config file, no
code generation.

```typescript
import { z } from 'zod';
import createError from 'http-errors';
import { Route, Tags, Get, Post, Params, Body, Returns, Param, BodyParam } from 'avero';

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

## Why avero

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
- **A typed client, generated.** The same metadata produces a standalone,
  dependency-free TypeScript client — replacing a `tsoa → swagger → openapi-generator`
  pipeline with one accurate hop.

---

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

Notes:

- `"type": "module"` is required in `package.json` (ESM) to coexist with
  `verbatimModuleSyntax` + `module: nodenext`.
- `emitDecoratorMetadata` is **not** required — avero uses explicit parameter
  decorators and explicit instance registration, so it never needs runtime type
  metadata.
- Import `reflect-metadata` once at your app's entry point.

---

## Getting started

```typescript
// app.ts
import 'reflect-metadata';
import express from 'express';
import { Avero } from 'avero';
import { UsersController } from './users.controller.js';

const app = express();
app.use(express.json());

const api = new Avero({ info: { title: 'My API', version: '1.0.0' } });

// You own construction — inject dependencies explicitly.
api.register(new UsersController(db));

api.mount(app);

app.listen(3000);
```

That's it. A single `Avero` instance owns your controllers; `mount` wires the
Express routes and validation middleware, and the same instance generates
swagger (see below). Request data is parsed by Zod before each handler runs.

### Grouping & versioning

Give a set of controllers a shared base path — typically an API version segment —
with a registration `prefix` or a `group`. It composes with each controller's own
`@Route` prefix and shows up in both the routes and the spec:

```typescript
api.register(new UsersController(svc), { prefix: '/v1' }); // → /v1/users

api.group('/v1', (v1) => {
  v1.register(new UsersController(svc)); // → /v1/users
  v1.register(new AuthController(auth)); // → /v1/auth/...
});
```

Groups nest, and the same controller can be mounted under more than one version.
See [Grouping & Versioning](https://joeferner.github.io/avero/guide/versioning).

---

## Decorator reference

### Class decorators

| Decorator        | Purpose                                             |
| ---------------- | --------------------------------------------------- |
| `@Route(prefix)` | Path prefix for every route in the controller       |
| `@Tags(...tags)` | OpenAPI tags applied to the controller's operations |

### Method decorators

| Decorator                                                                   | Purpose                                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `@Get(path?)` `@Post(path?)` `@Put(path?)` `@Patch(path?)` `@Delete(path?)` | HTTP method + path (use `{id}` for path params)                        |
| `@Params(schema)`                                                           | Validate `req.params` against a Zod object                             |
| `@Query(schema)`                                                            | Validate `req.query`                                                   |
| `@Body(schema)`                                                             | Validate `req.body`                                                    |
| `@Returns(status, schema?)`                                                 | Declare a response — stackable; omit `schema` for no body (e.g. `204`) |
| `@ReturnsFile(status, options?)`                                            | Declare a binary/file response (return a `FileResponse`)               |
| `@Sse(schema?, options?)`                                                   | Stream a Server-Sent Events (`text/event-stream`) response             |
| `@Security(scheme, scopes?)`                                                | Require a named auth scheme — class or method, stackable = OR          |
| `@Use(...middleware)`                                                       | Run Express middleware before the handler — class or method            |
| `@Summary(text)`                                                            | Operation summary in swagger                                           |
| `@Description(text)`                                                        | Operation description (longer prose) in swagger                        |
| `@OperationId(id)`                                                          | Operation id (defaults to the handler method name)                     |
| `@Deprecated()`                                                             | Marks the operation `deprecated` in swagger                            |
| `@Example(value, status?)`                                                  | Example for the request body, or a response (`status`) — stackable     |

### Parameter decorators

| Decorator           | Injects                                           |
| ------------------- | ------------------------------------------------- |
| `@Param(name)`      | `req.params[name]`                                |
| `@QueryParam(name)` | `req.query[name]`                                 |
| `@BodyParam(name?)` | the whole validated body, or one field of it      |
| `@File(name)`       | an uploaded file as a web `File` (multipart)      |
| `@Files(name)`      | uploaded files as `File[]` (multipart)            |
| `@Header(name)`     | `req.headers[name]`                               |
| `@Principal()`      | the principal from the `@Security` handler        |
| `@Req()` / `@Res()` | raw Express `Request` / `Response` (escape hatch) |

To return a file or binary stream instead of JSON, pair `@ReturnsFile` with a
**`FileResponse`** return value — avero streams the body and sets
`Content-Type`/`Content-Disposition` (plus optional `disposition`/`headers`). For
HTTP `Range` / partial content, return a **`RangeFileResponse`** instead. See
[File downloads](https://joeferner.github.io/avero/guide/file-downloads).

To **receive** files, put a `z.file()` (or `z.array(z.file())`) field in a
`@Body` schema: avero auto-detects the route as `multipart/form-data`, parses it
with multer, and injects each file via `@File` / `@Files`. See
[File uploads](https://joeferner.github.io/avero/guide/file-uploads).

To **protect** a route, register named schemes on the instance (`new Avero({
security: { bearerAuth: bearer(handler) } })`) and mark routes with
`@Security('bearerAuth', scopes?)`; the handler's result is injected via
`@Principal()`. See
[Authentication](https://joeferner.github.io/avero/guide/authentication).

For arbitrary Express middleware (rate limiting, caching, logging, custom auth),
use `@Use(...middleware)` on a method or controller. avero runs the chain
`@Security → @Use → multipart → handler`; class-level `@Use` runs before
method-level, and middleware that sends a response short-circuits the handler.

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
`next(err)` — exactly like a request failure, in every environment. avero never
decides what to do about it; your error middleware does (log it and respond
`500`, swallow it, or surface the drift however you like).

### Errors flow through Express

avero never sends an error response itself. A failed validation calls
`next(err)` with a `ValidationError` that carries the Zod issues and a status
(`400` for params/query, `422` for body, `500` for a response that doesn't match
its `@Returns` schema), so it travels the **same** Express error pipeline as
anything your handlers throw. `ValidationError` and `SecurityError` both extend
`AveroError` (carrying `.status`), so you stay in control of the response shape
via your own error middleware:

```typescript
import { AveroError } from 'avero';

app.use((err, req, res, next) => {
  if (err instanceof AveroError) {
    return res.status(err.status).json({ status: err.status, message: err.message });
  }
  next(err); // your http-errors / fallback handling
});
```

If you don't want to write that, avero ships an optional `averoErrorHandler` that
renders errors as **RFC 9457 Problem Details** (`application/problem+json`) — the
standard error shape, overridable via `formatError`:

```typescript
import { averoErrorHandler } from 'avero';

app.use(averoErrorHandler());
// 422 → { type: 'about:blank', title: 'Unprocessable Entity', status: 422,
//         errors: [{ path: ['name'], message: '...' }] }
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

The same `Avero` instance you registered controllers on generates the spec — no
need to list controllers a second time:

```typescript
app.get('/swagger.json', (_req, res) => res.json(api.swagger()));
```

Or mount a browsable docs UI in one line with `api.serveDocs(app)` (Scalar by
default; `{ ui: 'swagger-ui' | 'redoc' }`). The UI is self-hosted from an optional
peer dependency, or `{ cdn: true }` for no install. See
[OpenAPI / Swagger](https://joeferner.github.io/avero/guide/swagger).

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
import { generateSwagger } from 'avero';
import { HealthController } from './controllers/HealthController.js';
import { UsersController } from './controllers/UsersController.js';
import { AuthController } from './controllers/AuthController.js';

const swagger = generateSwagger([HealthController, UsersController, AuthController]);
await writeFile('swagger.json', JSON.stringify(swagger, null, 2));
```

This is the lightest path for CI spec checks and client codegen: no `Avero`
instance, no service wiring, no Express — just the classes and their decorators.
Use `api.swagger()` instead when you already have a configured instance on hand
(e.g. serving the spec from the running app).

### Spec version: 3.1 by default

avero emits **OpenAPI 3.1.0** — its native form, since Zod 4's `z.toJSONSchema()`
is JSON Schema draft 2020-12 (what 3.1 uses). For tooling with only partial 3.1
support (e.g. `openapi-generator`'s `typescript-fetch`), pass `specVersion: '3.0'`
to down-convert nullables, exclusive bounds, `const`, and binary annotations:

```typescript
api.swagger({ specVersion: '3.0' });
generateSwagger([UsersController], info, { specVersion: '3.0' });
```

See [OpenAPI / Swagger](https://joeferner.github.io/avero/guide/swagger) for the
full conversion table.

---

## Typed client

avero can generate a **standalone, fully-typed TypeScript client** — the modern
replacement for a `tsoa → swagger → openapi-generator-cli` pipeline. The generated
file has **no runtime dependency**, so a front end imports it and calls your API
with full types:

```typescript
import { generateContract, generateTypeScriptClient } from 'avero';

// controllers → contract (a codegen-oriented IR) → standalone client
const contract = generateContract([UsersController, AuthController]); // or api.contract()
await writeFile('api.gen.ts', generateTypeScriptClient(contract));
```

```typescript
import { createClient, AveroClientError } from './api.gen'; // no avero import

const api = createClient({ baseUrl: 'https://api.example.com' });

const user = await api.users.get({ params: { id } }); // → User (throws on non-2xx)
const res = await api.users.get.raw({ params: { id } }); // → { status, body } union
for await (const event of await api.health.events()) {
  /* @Sse → AsyncIterable */
}
```

Operations are grouped by tag; methods return the success body and throw a typed
`AveroClientError` on non-2xx (use `.raw()` for the status-discriminated union).
File responses come back as `Blob` (with HTTP `Range`), SSE as an
`AsyncIterable`. See [Typed Client](https://joeferner.github.io/avero/guide/typed-client).

---

## Migrating

Coming from another tool? See the migration guides:

- **[Migrating from tsoa](https://joeferner.github.io/avero/guide/migrating-from-tsoa)** —
  decorator/concept mapping, JSDoc-tags → Zod, and how avero drops the build step.
- **[Migrating from NestJS](https://joeferner.github.io/avero/guide/migrating-from-nestjs)** —
  class-validator DTOs → Zod, dropping `@ApiProperty` drift and the DI container, and an honest gaps list.
- **[Migrating from routing-controllers](https://joeferner.github.io/avero/guide/migrating-from-routing-controllers)** —
  near 1:1 decorator mapping, class-validator → Zod, and staying container-agnostic.
- **[Migrating from express-zod-api](https://joeferner.github.io/avero/guide/migrating-from-express-zod-api)** —
  endpoint-factory → decorators, splitting the merged `input` schema, and dropping the response envelope.
- **[Migrating from ts-rest](https://joeferner.github.io/avero/guide/migrating-from-ts-rest)** —
  contract-object → decorators, the response-validation defaults, and an honest take on the typed-client gap.
- **[Migrating from Hono OpenAPI](https://joeferner.github.io/avero/guide/migrating-from-hono)** —
  `createRoute` → decorators, response-validation defaults, and the multi-runtime (edge vs Node-only) stance.
- **[Migrating from a hand-written OpenAPI doc](https://joeferner.github.io/avero/guide/migrating-from-openapi)** —
  every OpenAPI feature mapped to its avero/Zod equivalent, plus the post-process escape hatch.

---

## License

MIT © Joe Ferner
