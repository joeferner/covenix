# Migrating from ts-rest

[ts-rest](https://ts-rest.com) and covenix both give you typed routes and runtime
validation from schemas, but they optimize for **opposite ends of the wire**:

- **ts-rest is contract-first and client-first.** You declare a **contract** —
  a plain object (`c.router({...})`) — that both the server and a **fully typed
  client** import. The headline feature is the client: `initClient(contract)`
  gives end-to-end type safety with no code generation. OpenAPI is a secondary,
  opt-in output.
- **covenix is decorator-first and spec-first.** You describe each endpoint with
  decorators on a controller class, and the accurate **OpenAPI document** is the
  primary artifact — the thing other teams, languages, and codegen tools consume.

The migration is mostly mechanical (Zod stays Zod; the route fields line up with
the decorators). The main thing that works differently is the **typed client** —
read the honesty section first.

## Should you migrate? (the honest version)

covenix **does** ship a typed client — a generated, standalone
[TypeScript client](/guide/typed-client) — but it gets there differently than
ts-rest. ts-rest's contract is a _value_ the client infers from directly (zero
codegen); covenix's contract comes from _decorators_ (erased at the type level), so
its client is a **generated file** you regenerate when the API changes. In return,
covenix's client is fully standalone (no runtime dependency) and the contract it's
built from is an open artifact any generator can target.

**Stay on ts-rest if** your main win is the _zero-codegen_ inferred client in a
monorepo where the front end imports the contract directly — that one-import,
nothing-to-regenerate DX is ts-rest's edge, and covenix's codegen step is a small
tax against it (though far lighter than the `openapi-generator-cli` route).

**covenix is the better fit if** any of these dominate:

- **The OpenAPI document is the product** — a public API, partner integrations,
  or polyglot/non-TS consumers generating clients. covenix emits accurate **3.1**
  (and down-converts to 3.0) natively from Zod 4; in ts-rest, OpenAPI is a
  bolt-on (`@ts-rest/open-api`) whose built-in Zod support is **Zod 3** and is
  [being removed in v4](https://ts-rest.com/docs/openapi) — Zod 4 requires you to
  wire up your own async schema transformer.
- **You want validation that can't silently drift.** covenix validates **and
  serializes** every response by default (extra fields stripped). ts-rest's
  `responseValidation` is **off by default** on both server and client.
- **You need first-class auth, file, range, or SSE responses in the spec** (see
  below) — all built into covenix, all DIY in ts-rest.

You get both worlds: covenix's [generated client](/guide/typed-client) for
first-party TS consumers, **and** an accurate OpenAPI document for everyone else
(other teams, languages, or any standard codegen) — from the one source.

## The fundamental shift: contract object → decorators

ts-rest puts the whole contract in one value and implements it separately:

```typescript
// ts-rest — contract.ts (shared by server + client)
import { initContract } from '@ts-rest/core';
import { z } from 'zod';

const c = initContract();

export const contract = c.router({
  getUser: {
    method: 'GET',
    path: '/users/:id',
    pathParams: z.object({ id: z.uuid() }),
    responses: { 200: UserSchema, 404: ErrorSchema },
    summary: 'Get a user',
  },
  createUser: {
    method: 'POST',
    path: '/users',
    body: CreateUserSchema,
    responses: { 201: UserSchema },
  },
});

// ts-rest — server.ts
import { initServer, createExpressEndpoints } from '@ts-rest/express';
const s = initServer();
const router = s.router(contract, {
  getUser: async ({ params: { id } }) => {
    const user = await service.get(id);
    return user ? { status: 200, body: user } : { status: 404, body: { message: 'Not found' } };
  },
  createUser: async ({ body }) => ({ status: 201, body: await service.create(body) }),
});
createExpressEndpoints(contract, router, app);
```

covenix folds the contract and the implementation back together on a class — each
route's schemas sit on the method as decorators:

```typescript
// covenix — UsersController.ts
import { z } from 'zod';
import { Route, Tags, Get, Post, Params, Body, Returns, Summary, Param, BodyParam } from 'covenix';
import createError from 'http-errors';

@Route('users')
@Tags('Users')
export class UsersController {
  constructor(private readonly service: UserService) {}

  @Get('{id}')
  @Params(z.object({ id: z.uuid() }))
  @Returns(200, UserSchema)
  @Returns(404, ErrorSchema)
  @Summary('Get a user')
  async getUser(@Param('id') id: string) {
    const user = await this.service.get(id);
    if (!user) throw new createError.NotFound();
    return user; // the return value IS the 200 body
  }

  @Post()
  @Body(CreateUserSchema)
  @Returns(201, UserSchema)
  async createUser(@BodyParam() body: z.infer<typeof CreateUserSchema>) {
    return this.service.create(body); // 201 is the first declared 2xx
  }
}
```

Three differences to internalize:

1. **`path: '/users/:id'` → `@Route('users')` + `@Get('{id}')`.** The prefix moves
   to the class; path params switch from `:id` to `{id}`.
2. **`responses` map → stacked `@Returns(status, schema)`.** One decorator per
   status; the first 2xx is the success status.
3. **`return { status, body }` → `return body`.** covenix infers the status from
   the matched `@Returns`; for a non-success status you `throw` (e.g. an
   `http-errors` `NotFound`) and let your error middleware map it.

## At a glance

| ts-rest                                                | covenix                                                               | Notes                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `initContract()` + `c.router({...})`                   | decorators on a controller class                                      | Contract is metadata on methods, not a standalone value.       |
| `method: 'GET'`, `path: '/users/:id'`                  | `@Get('{id}')` + `@Route('users')`                                    | Prefix on the class; `:id` → `{id}`.                           |
| `pathParams: z.object({...})`                          | `@Params(z.object({...}))` + `@Param('id')`                           | Schema on the method, injection on the parameter.              |
| `query: z.object({...})`                               | `@Query(z.object({...}))` + `@QueryParam('q')`                        | Same split.                                                    |
| `body: Schema`                                         | `@Body(Schema)` + `@BodyParam()`                                      | Same split.                                                    |
| `headers: { 'x-id': z.string() }`                      | `@Headers(z.object({ 'x-id': z.string() }))` + `@HeaderParam('x-id')` | Both validate request headers; covenix also documents them.    |
| `responses: { 200: S, 404: E }`                        | `@Returns(200, S)` `@Returns(404, E)`                                 | Stackable, one per status.                                     |
| `c.otherResponse({ contentType, body })`               | `@ReturnsFile(...)` / `@Sse(...)` / content via spec                  | covenix has dedicated decorators for binary/stream.            |
| `c.noBody()` (e.g. `204`)                              | `@Returns(204)` (omit the schema)                                     | No-content response.                                           |
| `return { status, body }`                              | `return body` (status from `@Returns`; `throw` to err)                | No status/body envelope.                                       |
| `contentType: 'multipart/form-data'` + `body`          | `z.file()` in `@Body` + `@File`/`@Files`                              | Auto-detected multipart; web-standard `File`.                  |
| `summary` / `metadata`                                 | `@Summary` / `@Description` / `@OperationId`                          | First-class decorators.                                        |
| `strictStatusCodes`                                    | always validates the matched `@Returns`                               | covenix validates the response you actually send.              |
| `pathPrefix: '/v1'` (router option)                    | `api.group('/v1', …)` / `register(c, { prefix })`                     | See [Grouping & Versioning](/guide/versioning).                |
| `commonResponses` / `baseHeaders`                      | class-level `@Returns(status, Schema, { headers })`                   | Shared responses merged into every route; route-level wins.    |
| `initServer().router(contract, {...})`                 | `new C(deps)` + `api.register(c)`                                     | Implementation lives on the class; explicit construction.      |
| `createExpressEndpoints(contract, router, app)`        | `api.mount(app)`                                                      | Wires routes + validation.                                     |
| `globalMiddleware` / per-route middleware              | `@Use(...)` (class or method)                                         | Express middleware.                                            |
| `requestValidationErrorHandler`                        | `ValidationError` → `covenixErrorHandler()`                           | 400 params/query, 422 body, 500 bad response.                  |
| `generateOpenApi(contract, ...)` (`@ts-rest/open-api`) | `api.swagger()` / `generateSwagger([...])`                            | Native, no extra package or transformer.                       |
| `initClient(contract)` (typed client)                  | `generateTypeScriptClient(contract)` (generated)                      | Standalone client; codegen step vs ts-rest's inference.        |
| `@ts-rest/react-query`                                 | **no equivalent** (yet)                                               | The contract is open for a hooks generator; or keep ts-rest's. |
| Express / Fastify / Nest / Next / serverless adapters  | **Express only**                                                      | covenix targets Express 5.                                     |
| Zod / Valibot / Arktype / Effect (Standard Schema)     | **Zod only**                                                          | covenix is Zod-4-native.                                       |

## Validation: mostly a copy-paste

Both use Zod, so request schemas move over unchanged — just relocate them from
the contract fields to the decorators.

```typescript
// ts-rest
getUser: {
  method: 'GET',
  path: '/users/:id',
  pathParams: z.object({ id: z.uuid() }),
  query: z.object({ verbose: z.coerce.boolean().optional() }),
  responses: { 200: UserSchema },
}

// covenix
@Get('{id}')
@Params(z.object({ id: z.uuid() }))
@Query(z.object({ verbose: z.coerce.boolean().optional() }))
@Returns(200, UserSchema)
getUser(@Param('id') id: string, @QueryParam('verbose') verbose?: boolean) { /* ... */ }
```

Two behavioral notes:

- **Failure statuses.** ts-rest returns `400` for any request validation failure.
  covenix uses `400` for params/query and **`422`** for body — adjust client
  expectations. See [Validation & Errors](/guide/validation).
- **Multiple schema libraries.** ts-rest accepts any
  [Standard Schema](https://standardschema.dev/) library (Zod, Valibot, Arktype,
  Effect). covenix is **Zod-only** — Valibot/Arktype contracts must be rewritten as
  Zod schemas.

## Responses, status codes, and response validation

In ts-rest a handler returns a `{ status, body }` discriminated union, and
**response validation is off by default** — you opt in with `responseValidation:
true` on the server (and `validateResponse: true` on the client).

covenix inverts the default: every response is validated against its `@Returns`
schema **and serialized through it** (unknown keys stripped, transforms/defaults
applied). A mismatch throws a `500` `ValidationError` through your error pipeline,
in every environment — so a handler can't silently over-share fields the contract
didn't declare.

```typescript
// ts-rest — drift ships unless you opt in
createExpressEndpoints(contract, router, app, { responseValidation: true });

// covenix — always on; the return value is parsed by the @Returns schema
@Returns(200, UserSchema) // extra fields on the returned object are stripped
async getUser(@Param('id') id: string) { return this.service.get(id); }
```

`commonResponses` maps onto a **class-level `@Returns`**: declare the shared error
shape once on the controller and it's merged into every route (a route's own
`@Returns` for the same status overrides it). See
[Shared responses](/guide/route-handlers#shared-responses).

```typescript
@Route('users')
@Returns(401, ErrorSchema) // shared across every route, like commonResponses
@Returns(422, ErrorSchema)
class UsersController {}
```

## Files, downloads, range, and SSE

ts-rest models non-JSON with `c.otherResponse({ contentType, body })` and leaves
the streaming/headers to you on the raw `res`. covenix has dedicated decorators and
response objects that also document themselves in the spec:

- **Upload:** put a `z.file()` field in a `@Body` schema — covenix auto-detects
  `multipart/form-data`, parses it with multer, and injects a web-standard `File`
  via `@File`/`@Files`. See [File uploads](/guide/file-uploads).
- **Download:** `@ReturnsFile(...)` + return a `FileResponse` (handles
  `Content-Disposition`, RFC 5987 filenames).
- **Range / partial content:** return a `RangeFileResponse` — `206`/`416`/full
  negotiation is automatic. See [File downloads](/guide/file-downloads).
- **Server-Sent Events:** [`@Sse(schema?, options?)`](/guide/server-sent-events)
  - return an async iterable; covenix frames, validates, and documents it as
    `text/event-stream`.

## The typed client

ts-rest's `initClient(contract)` and `@ts-rest/react-query` are its crown jewel:
import the contract, get a typed `client.getUser({ params: { id } })` returning a
status-discriminated union, with **zero codegen**.

covenix's answer is a **generated** [standalone TypeScript client](/guide/typed-client) —
the same ergonomics, reached by a build step instead of inference:

```typescript
import { generateTypeScriptClient } from 'covenix';
await writeFile('api.gen.ts', generateTypeScriptClient(api.contract()));
```

```typescript
import { createClient } from './api.gen'; // standalone — no covenix/runtime dep

const api = createClient({ baseUrl: 'https://api.example.com' });
const user = await api.users.get({ params: { id } }); // → User; throws on non-2xx
const res = await api.users.get.raw({ params: { id } }); // → { status, body } union
```

The honest difference: ts-rest infers the client from a contract _value_ (nothing
to regenerate); covenix generates the client from _decorator_ metadata (regenerate
on change). In exchange, covenix's client is fully standalone, and the contract it's
built from is an open artifact any generator can target. The client is types-only
by default; pass `{ validate: 'zod' }` for opt-in runtime request/response
validation (and `Date` revival). There are no React-Query hooks yet. See
[Typed Client](/guide/typed-client) for the full picture.

## OpenAPI generation

This is where the relationship flips. In ts-rest, OpenAPI is a separate package
with sharp edges:

- The built-in schema transformer is **Zod 3**, deprecated and
  [removed in v4](https://ts-rest.com/docs/openapi) — Zod 4 needs a custom async
  transformer (`z.toJSONSchema` + a JSON-Schema→OpenAPI converter).
- **Security has no first-party support** — you inject it via `operationMapper` +
  `metadata`.
- `operationId`s are off unless you pass `setOperationId`.

In covenix the spec is the native artifact and needs none of that wiring:

```typescript
api.swagger(); // OpenAPI 3.1 from Zod 4, no transformer
api.swagger({ specVersion: '3.0' }); // down-convert for partial-3.1 tooling
generateSwagger([UsersController]); // instance-free, for CI / codegen
api.serveDocs(app); // browsable UI in one line
```

`@Security`, `@OperationId` (defaulted to the method name), `@Tags`, `@Example`,
`@Deprecated`, and file/SSE responses all flow into the document automatically.
See [OpenAPI / Swagger](/guide/swagger).

## Authentication

ts-rest has no auth concept — you add Express middleware and, for the spec, hand
security objects to `operationMapper`. covenix makes it first-class: register a
named scheme on the instance (definition **and** handler together) and mark
routes with `@Security`, injecting the result via `@Principal()`:

```typescript
import { Covenix, Security, Principal, bearer, SecurityError } from 'covenix';

const api = new Covenix({
  info,
  security: {
    jwt: bearer((req, scopes) => {
      const user = verifyJwt(req.headers.authorization);
      if (!user) return null; // → 401
      if (!scopes.every((s) => user.scopes.includes(s))) throw new SecurityError(403);
      return user; // → @Principal()
    }),
  },
});

@Get('me')
@Security('jwt', ['users:read'])
me(@Principal() user: User): User {
  return user;
}
```

The scheme is emitted under `components.securitySchemes` and the per-operation
requirement onto the spec — no `operationMapper`. See
[Authentication](/guide/authentication).

## Versioning

ts-rest's `pathPrefix` (a router option, combinable across nested routers) maps
directly to covenix's [grouping](/guide/versioning):

```typescript
// ts-rest
const v1 = c.router({ users: usersContract }, { pathPrefix: '/v1' });

// covenix
api.group('/v1', (v1) => v1.register(new UsersController(svc)));
```

## Bootstrapping

```typescript
// ts-rest
const s = initServer();
const router = s.router(contract, {
  /* handlers */
});
createExpressEndpoints(contract, router, app, { responseValidation: true });

// covenix
import 'reflect-metadata';
const api = new Covenix({ info: { title: 'My API', version: '1.0.0' } });
api.register(new UsersController(service)); // you own construction (DI)
api.mount(app);
app.get('/swagger.json', (_req, res) => res.json(api.swagger()));
```

## What you lose, what you gain

| Leaving ts-rest you give up…                            | …and you gain in covenix                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Zero-codegen** client inference + React Query hooks   | A generated standalone client **and** accurate **OpenAPI 3.1/3.0** from one source |
| Multiple validation libs (Valibot/Arktype/Effect)       | Zod-4-native conversion with first-class `.meta({ id })` components                |
| Multiple server adapters (Fastify/Nest/Next/serverless) | Deep Express integration + middleware via `@Use`                                   |
| Contract-as-a-value sharing/combining                   | Controllers with constructor DI; `@Security`/`@Principal` auth                     |
| —                                                       | **Response validation on by default** (no silent drift)                            |
| —                                                       | Built-in `FileResponse`, `RangeFileResponse`, `@Sse`, Problem Details, `serveDocs` |

The first row is now a _difference in approach_, not a missing feature: ts-rest
infers the client with no build step; covenix generates one. If the zero-codegen,
nothing-to-regenerate loop is your core value, ts-rest keeps its edge — otherwise
the rest of the table is why covenix exists.

If you hit a ts-rest feature without an obvious covenix equivalent, please
[open an issue](https://github.com/joeferner/covenix/issues).
