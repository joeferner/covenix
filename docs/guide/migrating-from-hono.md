# Migrating from Hono OpenAPI

[Hono](https://hono.dev) with [`@hono/zod-openapi`](https://hono.dev/examples/zod-openapi)
and covenix both give you Zod-validated routes and an OpenAPI document — but they
sit at different layers and target different deployment worlds:

- **Hono is a small, multi-runtime web framework.** Its headline feature is
  reach: the same app runs on Cloudflare Workers, Deno, Bun, Node, and Lambda /
  edge. `@hono/zod-openapi` adds an OpenAPI layer where each route is a **value** —
  `createRoute({ method, path, request, responses })` — registered on an
  `OpenAPIHono` app, with the spec emitted from the same Zod schemas.
- **covenix is an Express + Node OpenAPI layer.** Routes are **class decorators**;
  the accurate OpenAPI document and a generated typed client are the primary
  artifacts. It's deliberately Node/Express-only and leans on `reflect-metadata` +
  decorators.

Both are Zod-native, so the schemas move over almost unchanged. The two real
differences are the **declaration shape** (`createRoute` value → decorators) and
the **runtime model** (Hono's `Context` on any runtime → Express `Request`/
`Response` on Node). Read the honesty section first — the multi-runtime story is
the deciding factor.

## Should you migrate? (the honest version)

The single biggest difference isn't the API — it's **where your code runs**.

**Stay on Hono if** you deploy to the edge or a non-Node runtime — Cloudflare
Workers, Deno Deploy, Bun, Lambda@Edge — or you care about cold-start and bundle
size on those platforms. covenix is **Express + Node only** and uses
`reflect-metadata` + legacy decorators, which is a poor fit for Workers-style
edge bundles. This is a hard stop, not a soft preference:
[multi-runtime is an explicit covenix non-goal](#runtime-deployment-the-big-gap).
If Hono's portability is why you chose it, keep it.

**covenix is the better fit if** you're on Node/Express anyway and want:

- **Decorator-first ergonomics with the contract _on_ the handler.** Hono splits
  the route definition (`createRoute(...)`) from its implementation
  (`app.openapi(route, handler)`); covenix keeps the schemas as decorators on the
  method they validate, so there's one place to read.
- **Response validation on by default.** `@hono/zod-openapi` validates the
  **request** against the route's Zod schemas, but **does not validate the
  response** against `responses[status]` — that schema is documentation only.
  covenix parses every response through its `@Returns` schema (extra fields
  stripped, a mismatch throws a `500`), so the documented shape and the sent
  shape can't drift.
- **First-class auth, files, range, and SSE in the spec** — all built into covenix
  with dedicated decorators/response types; in Hono you wire middleware and
  `registerComponent` yourself and stream on the raw `Context`.
- **A generated standalone OpenAPI client _and_ an accurate 3.1 spec** for
  polyglot consumers — see [the client section](#openapi-the-typed-client).

If you need both edge portability **and** covenix's model, you can't have them today.
Pick based on the runtime.

## The shape shift: `createRoute` value → decorators

Hono defines a route as a value, then implements it separately on the app:

```typescript
// Hono — @hono/zod-openapi
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

const ParamsSchema = z.object({ id: z.string().uuid() });

const getUser = createRoute({
  method: 'get',
  path: '/users/{id}',
  request: { params: ParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: UserSchema } }, description: 'A user' },
    404: { content: { 'application/json': { schema: ErrorSchema } }, description: 'Not found' },
  },
  summary: 'Get a user',
});

const app = new OpenAPIHono();

app.openapi(getUser, (c) => {
  const { id } = c.req.valid('param');
  const user = service.get(id);
  if (!user) return c.json({ message: 'Not found' }, 404);
  return c.json(user, 200);
});
```

covenix folds the definition and implementation back together on a class — each
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
  async getUser(@Param('id') id: string): Promise<User> {
    const user = await this.service.get(id);
    if (!user) throw new createError.NotFound();
    return user; // the return value IS the 200 body, validated against UserSchema
  }
}
```

Three differences to internalize:

1. **`path: '/users/{id}'` → `@Route('users')` + `@Get('{id}')`.** The prefix
   moves to the class. (Both use `{id}` brace syntax in the OpenAPI path — Hono's
   `createRoute` path matches covenix's here.)
2. **`responses` map → stacked `@Returns(status, schema)`.** One decorator per
   status instead of a nested `content['application/json'].schema` object; the
   first 2xx is the success status.
3. **`return c.json(body, status)` → `return body`.** covenix infers the status
   from the matched `@Returns`; `c.req.valid('param')` becomes the injected
   `@Param('id')`. For a non-success status you `throw` and let error middleware
   map it.

## At a glance

| Hono (`@hono/zod-openapi`)                                           | covenix                                                       | Notes                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `createRoute({ method, path, ... })` (a value)                       | decorators on a controller method                             | Contract is metadata on the method, not a standalone value. |
| `method: 'get'`, `path: '/users/{id}'`                               | `@Get('{id}')` + `@Route('users')`                            | Prefix on the class.                                        |
| `request: { params: Schema }`                                        | `@Params(Schema)` + `@Param('id')`                            | Schema on the method; injection on the parameter.           |
| `request: { query: Schema }`                                         | `@Query(Schema)` + `@QueryParam('q')`                         | Same split.                                                 |
| `request: { body: { content: { 'application/json': { schema } } } }` | `@Body(Schema)` + `@BodyParam()`                              | Far less nesting.                                           |
| `request: { headers: Schema }`                                       | `@Headers(Schema)` + `@HeaderParam('x-id')`                   | Both validate the header schema; covenix also documents it. |
| `responses: { 200: { content: {...}, description } }`                | `@Returns(200, Schema)`                                       | Stackable, one per status.                                  |
| `c.req.valid('param' \| 'query' \| 'json' \| 'form')`                | `@Param` / `@QueryParam` / `@BodyParam` / `@File`             | Injection by parameter decorator.                           |
| `app.openapi(route, handler)`                                        | implementation is the decorated method                        | Definition and handler are one unit.                        |
| `return c.json(body, status)`                                        | `return body` (status from `@Returns`; `throw` to err)        | No `Context` envelope.                                      |
| `Schema.openapi('User')` (component name)                            | `Schema.meta({ id: 'User' })`                                 | Names the reusable component.                               |
| `Schema.openapi({ example, description })`                           | `Schema.meta({ example, description })` / `.describe()`       | Field/schema metadata.                                      |
| **request validation only** (response is doc-only)                   | request **and** response validated + serialized               | covenix parses the response through `@Returns`.             |
| `z.object(...).openapi(...)` + multipart `form`                      | `z.file()` in `@Body` + `@File`/`@Files`                      | Auto-detected multipart; web-standard `File`.               |
| stream on raw `Context` (`streamSSE`)                                | [`@Sse(schema?)`](/guide/server-sent-events) + async iterable | Validated + documented `text/event-stream`.                 |
| `c.body(stream)` / manual headers for downloads                      | `@ReturnsFile(...)` + `FileResponse`/`RangeFileResponse`      | Disposition + range negotiation handled.                    |
| `app.use(middleware)` / per-route middleware                         | `@Use(...)` (class or method)                                 | Express middleware.                                         |
| `bearerAuth()` mw + `registerComponent(...)`                         | `@Security('jwt', scopes)` + `bearer()` handler               | Scheme + spec from one place; `@Principal()`.               |
| `app.getOpenAPIDocument({...})` / `app.doc(...)`                     | `api.swagger()` / `generateSwagger([...])`                    | Native, Zod-derived.                                        |
| `hc<AppType>()` (typed RPC client, inferred)                         | `generateTypeScriptClient(api.contract())` (generated)        | Inference vs codegen — see below.                           |
| Multi-runtime (Workers/Deno/Bun/Node/Lambda)                         | **Express + Node only**                                       | The biggest gap — see below.                                |
| Zod / Valibot / others (Standard Schema validators)                  | **Zod only**                                                  | covenix is Zod-4-native.                                    |

## Validation: mostly a copy-paste

Both use Zod, so request schemas move over unchanged — relocate them from the
`createRoute` `request` object to the decorators, and from `c.req.valid(...)` to
injected parameters:

```typescript
// Hono
const route = createRoute({
  method: 'get',
  path: '/users/{id}',
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({ verbose: z.coerce.boolean().optional() }),
  },
  responses: { 200: { content: { 'application/json': { schema: UserSchema } }, description: 'ok' } },
});
app.openapi(route, (c) => {
  const { id } = c.req.valid('param');
  const { verbose } = c.req.valid('query');
  return c.json(service.get(id, verbose), 200);
});

// covenix
@Get('{id}')
@Params(z.object({ id: z.uuid() }))
@Query(z.object({ verbose: z.coerce.boolean().optional() }))
@Returns(200, UserSchema)
getUser(@Param('id') id: string, @QueryParam('verbose') verbose?: boolean): User {
  return service.get(id, verbose);
}
```

Two behavioral notes:

- **Response validation.** Hono validates the request but treats
  `responses[status].schema` as **documentation only** — the handler's `c.json`
  payload isn't checked against it. covenix validates **and serializes** every
  response against its `@Returns` schema, so the documented and actual shapes
  can't diverge. See [Validation & Errors](/guide/validation).
- **Failure statuses.** covenix uses `400` for params/query validation failures and
  **`422`** for body, surfaced as a `ValidationError` through your error pipeline.
  Hono's default validation hook returns `400`; adjust client expectations.

## Naming components: `.openapi('Name')` → `.meta({ id })`

`@hono/zod-openapi` registers a reusable component when you call `.openapi('Name')`
on a schema (and attaches example/description metadata the same way). covenix uses
Zod's native `.meta()`:

```typescript
// Hono
const UserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email().openapi({ description: 'Login email' }),
  })
  .openapi('User');

// covenix
const UserSchema = z
  .object({ id: z.uuid(), email: z.email().describe('Login email') })
  .meta({ id: 'User' });
```

`.meta({ id })` hoists the schema into `components.schemas` and emits `$ref`s; field
`.describe()` / `.meta({ description })` flow into both the spec and the generated
client's JSDoc.

## Responses, files, range, and SSE

Hono streams and sets headers on the raw `Context` (`stream`, `streamSSE`,
`c.body(...)`); the spec side is whatever you put in `responses`. covenix has
dedicated decorators and response types that document themselves:

- **Upload:** a `z.file()` field in a `@Body` schema auto-detects
  `multipart/form-data` and injects a web-standard `File` via `@File`/`@Files`.
  See [File uploads](/guide/file-uploads).
- **Download:** `@ReturnsFile(...)` + return a `FileResponse` (handles
  `Content-Disposition`, RFC 5987 filenames).
- **Range / partial content:** return a `RangeFileResponse` — `206`/`416`/full
  negotiation is automatic. See [File downloads](/guide/file-downloads).
- **Server-Sent Events:** [`@Sse(schema?, options?)`](/guide/server-sent-events) —
  return an async iterable; covenix frames, validates, and documents it as
  `text/event-stream` (vs Hono's `streamSSE` on the raw context, undocumented).

## Authentication

Hono composes auth from middleware (`bearerAuth()`, custom) plus a
`app.openAPIRegistry.registerComponent('securitySchemes', ...)` call and a
`security` field on the route to make it appear in the spec — two places. covenix
registers a scheme once (definition **and** handler together) and marks routes
with `@Security`, injecting the principal via `@Principal()`:

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

The scheme lands under `components.securitySchemes` and the per-operation
requirement on the spec automatically. See [Authentication](/guide/authentication).

## OpenAPI & the typed client {#openapi-the-typed-client}

Both emit the document from Zod, so this is close. The differences:

- **Spec version.** covenix emits **OpenAPI 3.1** natively and can down-convert to
  3.0 (`api.swagger({ specVersion: '3.0' })`); confirm the version your tooling
  expects.
- **Document call.** `app.getOpenAPIDocument(...)` / `app.doc('/doc', ...)` →
  `api.swagger()` (or instance-free `generateSwagger([UsersController])` for CI /
  codegen), and `api.serveDocs(app)` for a browsable UI.

On the **client**, the two take opposite routes — mirroring the [ts-rest decision](/guide/migrating-from-ts-rest):

- **Hono's `hc<AppType>()`** is an inferred, zero-codegen RPC client: import the
  app's type, get `client.users[':id'].$get(...)`. Like ts-rest, its edge is that
  there's nothing to regenerate — but it's TypeScript-only and couples the client
  to the server's types.
- **covenix generates a standalone client** from the contract:

  ```typescript
  import { generateTypeScriptClient } from 'covenix';
  await writeFile('api.gen.ts', generateTypeScriptClient(api.contract()));
  ```

  ```typescript
  import { createClient } from './api.gen'; // standalone — no covenix/runtime dep
  const client = createClient({ baseUrl: 'https://api.example.com' });
  const user = await client.users.get({ params: { id } }); // → User; throws on non-2xx
  ```

  It's a build step instead of inference, but the client is fully standalone and
  the contract it's built from is an open artifact any generator (or any language)
  can target. See [Typed Client](/guide/typed-client).

## Bootstrapping

```typescript
// Hono
import { OpenAPIHono } from '@hono/zod-openapi';
const app = new OpenAPIHono();
app.openapi(getUser, getUserHandler);
app.doc('/doc', { openapi: '3.1.0', info: { title: 'My API', version: '1.0.0' } });
export default app; // runtime adapter (Workers/Node/Bun/…) takes it from here

// covenix
import 'reflect-metadata';
import express from 'express';
import { Covenix, covenixErrorHandler } from 'covenix';

const app = express();
app.use(express.json());

const api = new Covenix({ info: { title: 'My API', version: '1.0.0' } });
api.register(new UsersController(service)); // you own construction
api.mount(app);
api.serveDocs(app);
app.use(covenixErrorHandler());
app.listen(3000);
```

## Runtime & deployment: the big gap {#runtime-deployment-the-big-gap}

This is the deciding factor, and covenix is on the losing side of it.

**Hono is multi-runtime by design** — the same app runs on Cloudflare Workers,
Deno, Bun, Node, and Lambda / edge, with tiny bundles and fast cold starts. That
portability is the main reason teams pick Hono.

**covenix is Express + Node only, and this is a stated non-goal — not a roadmap
item.** The reasoning:

- covenix is built on **legacy decorators + `reflect-metadata`**, which depend on a
  Node-style module/runtime environment and don't fit Workers-style edge bundles
  (no `reflect-metadata`, aggressive tree-shaking, small-bundle constraints).
- It targets **Express 5** specifically — `api.mount(app)` wires Express routes,
  middleware (`@Use`), file handling (multer), and the error pipeline
  (`covenixErrorHandler`) directly onto Express primitives. There is no `Context`
  abstraction to port across runtimes.
- The project's focus is **accurate OpenAPI + typed clients from decorators on
  Node**, not runtime portability. Adding a runtime-agnostic core would be a
  fundamentally different architecture.

So: if you deploy to the edge or a non-Node runtime, **stay on Hono** — covenix
cannot run there and isn't planning to. If you're committed to Node/Express, the
rest of this guide is why covenix's decorator model, default response validation,
and first-class files/SSE/auth-in-spec may be worth the move.

## Gaps: what Hono does that covenix doesn't

- **Multi-runtime / edge deployment** — Workers, Deno, Bun, Lambda@Edge. covenix is
  Node/Express only (see [above](#runtime-deployment-the-big-gap)). _Stated
  non-goal._
- **Tiny bundle size / fast cold start** — Hono is optimized for edge; covenix's
  `reflect-metadata` + decorator model is Node-oriented and heavier.
- **Inferred zero-codegen RPC client** (`hc<AppType>()`) — covenix generates a
  client instead of inferring it (the standalone/open-artifact tradeoff above).
- **Multiple validation libraries** — Hono's validator middleware accepts various
  Standard Schema libraries; covenix is **Zod-only**.
- **`hono/jsx` / full web-framework features** — Hono is a general web framework
  (JSX rendering, etc.); covenix is purely an API/OpenAPI layer.

If you hit a Hono feature without an obvious covenix equivalent and you're on Node,
please [open an issue](https://github.com/joeferner/covenix/issues).
