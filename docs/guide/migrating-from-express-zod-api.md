# Migrating from express-zod-api

[express-zod-api](https://github.com/RobinTail/express-zod-api) and zodec are the
closest things to each other in this list: **both are Express + Zod + automatic
OpenAPI**, on Node, with a generated typed client. If you're on express-zod-api,
you're already living zodec's core thesis — the migration is about **shape**, not
philosophy.

The two differences that matter:

- **Declaration shape.** express-zod-api defines each endpoint as a **value** built
  by a factory — `defaultEndpointsFactory.build({ method, input, output, handler })`
  — and wires them into a nested `Routing` tree. zodec uses **class decorators**,
  with the schemas sitting on the method.
- **The response envelope.** express-zod-api's default result handler wraps every
  success in `{ status: "success", data: … }` (and errors in
  `{ status: "error", error: … }`). zodec returns the **bare** value. This is the
  one behavioral change your clients will feel — read that section carefully.

Because both are Express + Node + Zod, there's **no runtime caveat** (unlike the
Hono migration) and the schemas copy over unchanged.

## Should you migrate? (the honest version)

These are genuinely similar tools, so this is more "is the trade worth it" than
"can zodec even do this."

**Stay on express-zod-api if** you like the factory/value model and its built-in
result-handler envelope, or you depend on its specific niceties (the `EndpointsFactory`
middleware-composition model, its logger integration, `createServer` doing the
Express bootstrap for you). It's a mature, focused library that does the same job.

**zodec is the better fit if** you want:

- **Decorators with the contract _on_ the handler.** One class, one method, the
  schemas right there — versus a factory value plus a separate `Routing` tree that
  maps paths to endpoints. If you've felt the routing tree drift from your
  endpoints, decorators keep them together.
- **Split, explicit request schemas.** express-zod-api merges path params, query,
  and body into a **single `input` schema**; zodec keeps `@Params` / `@Query` /
  `@Body` separate, which maps 1:1 onto the OpenAPI parameter locations and avoids
  collisions between a query field and a body field of the same name.
- **Bare response bodies by default** (no envelope) — closer to what most REST
  consumers and codegen expect — with response validation/serialization on by
  default.
- **First-class files, range, and SSE in the spec** via dedicated decorators.

Both emit OpenAPI from Zod and both **generate** a typed client, so neither side
wins on those — it's the model that differs.

## The shape shift: endpoint factory → decorators

express-zod-api builds an endpoint as a value and registers it in a routing tree:

```typescript
// express-zod-api
import { defaultEndpointsFactory } from 'express-zod-api';
import { z } from 'zod';

const getUser = defaultEndpointsFactory.build({
  method: 'get',
  input: z.object({ id: z.string().uuid() }), // path + query + body, merged
  output: z.object({ id: z.string(), name: z.string() }), // the `data` payload
  handler: async ({ input: { id } }) => {
    const user = await service.get(id);
    if (!user) throw createHttpError(404, 'Not found');
    return user; // wrapped as { status: "success", data: user }
  },
});

// routing.ts
const routing: Routing = {
  v1: { user: { ':id': getUser } },
};

// index.ts
await createServer(config, routing);
```

zodec puts the same endpoint on a class, with the schemas as decorators:

```typescript
// zodec — UsersController.ts
import { z } from 'zod';
import { Route, Tags, Get, Params, Returns, Param } from 'zodec';
import createError from 'http-errors';

@Route('user')
@Tags('Users')
export class UsersController {
  constructor(private readonly service: UserService) {}

  @Get('{id}')
  @Params(z.object({ id: z.uuid() }))
  @Returns(200, UserSchema)
  async getUser(@Param('id') id: string): Promise<User> {
    const user = await this.service.get(id);
    if (!user) throw new createError.NotFound();
    return user; // the bare body — no { status, data } wrapper
  }
}
```

Differences to internalize:

1. **`input` (merged) → `@Params` / `@Query` / `@Body` (split).** Put path params
   in `@Params`, query in `@Query`, and request body in `@Body`. Each maps to its
   own OpenAPI location.
2. **`output` → `@Returns(200, schema)`.** And it's stackable — declare `404`,
   `422`, etc. as their own `@Returns`.
3. **`Routing` tree → `@Route` + `@Get`.** The path is `@Route('user')` +
   `@Get('{id}')`; the version prefix (`v1`) moves to
   [`api.group('/v1', …)`](/guide/versioning).
4. **`createServer(config, routing)` → `serve(api, { port })`** (or build the app
   yourself and call `api.mount(app)`).

## At a glance

| express-zod-api                                          | zodec                                                        | Notes                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `factory.build({ method, input, output, handler })`      | decorated method on a controller class                       | Endpoint is a method, not a value.                    |
| `method: 'get'` + routing key                            | `@Get('{id}')` + `@Route('user')`                            | Prefix on the class; `:id` → `{id}`.                  |
| `input: z.object({...})` (params+query+body merged)      | `@Params(S)` / `@Query(S)` / `@Body(S)` (split)              | One location per decorator.                           |
| destructure `input` in `handler`                         | `@Param` / `@QueryParam` / `@BodyParam`                      | Injection by parameter decorator.                     |
| `output: z.object({...})`                                | `@Returns(200, Schema)`                                      | Stackable, one per status.                            |
| `return data` → `{ status: "success", data }`            | `return body` (bare)                                         | **No envelope** — see below.                          |
| `createHttpError(404)` → error envelope                  | `throw createError.NotFound()` + `zodecErrorHandler()`       | Express error pipeline.                               |
| `factory.addMiddleware(...)` / `.use(mw)`                | `@Use(...)` (class or method)                                | Express middleware.                                   |
| auth middleware returning `options`                      | `@Security('jwt', scopes)` + `bearer()` + `@Principal()`     | First-class scheme + spec.                            |
| `Routing` nesting / `v1: {...}`                          | `api.group('/v1', …)` / `register(c, { prefix })`            | See [Grouping & Versioning](/guide/versioning).       |
| `new Documentation({ routing, config }).getSpecAsYaml()` | `api.swagger()` / `generateSwagger([...])`                   | Native; JSON (down-convert to 3.0 available).         |
| `new Integration({ routing }).print()` (client gen)      | `generateTypeScriptClient(api.contract())`                   | Both generate; zodec's is standalone + open-contract. |
| `ez.upload()` in `input`                                 | `z.file()` in `@Body` + `@File`/`@Files`                     | Auto-detected multipart; web-standard `File`.         |
| `ez.file()` / raw output for downloads                   | `@ReturnsFile(...)` + `FileResponse`/`RangeFileResponse`     | Disposition + range negotiation handled.              |
| `EventStreamFactory` (SSE)                               | [`@Sse(schema?)`](/guide/server-sent-events)                 | Validated + documented `text/event-stream`.           |
| `createServer(config, routing)`                          | `serve(api, { port })` / `toExpress(api)` / `api.mount(app)` | One-call bootstrap, or own the app.                   |

## The response envelope — the one real gotcha

express-zod-api's **default result handler** wraps every successful response:

```jsonc
// express-zod-api default success shape
{ "status": "success", "data": { "id": "…", "name": "…" } }
// and errors:
{ "status": "error", "error": { "message": "Not found" } }
```

zodec returns the **bare** value (`{ "id": "…", "name": "…" }`) and maps thrown
errors through `zodecErrorHandler()` to a [Problem Details](/guide/validation)
body. You have two options when migrating:

1. **Drop the envelope (recommended).** Return bare bodies and update front-end
   consumers to stop reading `.data`. If you use zodec's generated client, this is
   automatic — it types and returns the bare body. Cleaner, and what most external
   consumers/codegen expect.
2. **Keep the envelope explicitly.** Model it as a Zod schema so it's still in the
   contract and validated:

   ```typescript
   const Envelope = <T extends z.ZodTypeAny>(data: T) =>
     z.object({ status: z.literal('success'), data });

   @Returns(200, Envelope(UserSchema))
   async getUser(@Param('id') id: string) {
     return { status: 'success' as const, data: await this.service.get(id) };
   }
   ```

   Now the envelope is documented and validated rather than applied invisibly by a
   result handler. Most teams take option 1.

## Request schemas: split the merged `input`

express-zod-api uses one `input` schema and reads from params, query, and body
together. Split it across the decorators by location:

```typescript
// express-zod-api — one input schema
input: z.object({
  id: z.string().uuid(), // path param (from the routing key)
  verbose: z.coerce.boolean().optional(), // query
}),

// zodec — split by location
@Params(z.object({ id: z.uuid() }))
@Query(z.object({ verbose: z.coerce.boolean().optional() }))
getUser(@Param('id') id: string, @QueryParam('verbose') verbose?: boolean) { /* ... */ }
```

For a `POST`, the parts of `input` that were the request body move to `@Body`. The
schemas themselves don't change — only where they're attached. Behavioral note:
zodec returns `400` for params/query validation failures and **`422`** for body;
adjust client expectations.

## Files, downloads, and SSE

express-zod-api models these with `ez.upload()` / `ez.file()` helpers and an
`EventStreamFactory`. zodec has decorators and response types that document
themselves:

- **Upload:** a `z.file()` field in a `@Body` schema auto-detects
  `multipart/form-data` and injects a web-standard `File` via `@File`/`@Files`.
  See [File uploads](/guide/file-uploads).
- **Download:** `@ReturnsFile(...)` + return a `FileResponse` (handles
  `Content-Disposition`, RFC 5987 filenames).
- **Range / partial content:** return a `RangeFileResponse` — `206`/`416`/full
  negotiation is automatic. See [File downloads](/guide/file-downloads).
- **Server-Sent Events:** [`@Sse(schema?, options?)`](/guide/server-sent-events) —
  return an async iterable; zodec frames, validates, and documents it.

## Authentication

express-zod-api does auth with a middleware that reads credentials and contributes
typed `options` to the handler (and you describe the security scheme separately for
the docs). zodec registers a named scheme once — definition **and** handler
together — and injects the principal:

```typescript
import { Zodec, Security, Principal, bearer, SecurityError } from 'zodec';

const api = new Zodec({
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
requirement automatically. See [Authentication](/guide/authentication).

## OpenAPI & the typed client

This is where the two are most alike — both derive the spec from Zod and both
**generate** a client (neither infers it like ts-rest/Hono):

```typescript
// express-zod-api
const yaml = new Documentation({ routing, config, version: '1.0.0', title: 'API' }).getSpecAsYaml();
const client = new Integration({ routing }).printFormatted();

// zodec
api.swagger(); // OpenAPI 3.1 (api.swagger({ specVersion: '3.0' }) to down-convert)
generateSwagger([UsersController]); // instance-free, for CI / codegen
await writeFile('api.gen.ts', generateTypeScriptClient(api.contract()));
api.serveDocs(app); // browsable UI
```

The difference is the client's coupling: express-zod-api's `Integration` client is
generated from its routing object; zodec's is generated from the
[contract](/guide/typed-client) — an open artifact any generator (or any language)
can target, and the emitted client is fully standalone (no zodec runtime
dependency). See [Typed Client](/guide/typed-client).

## Bootstrapping

`createServer(config, routing)` maps onto zodec's [`serve`](/guide/getting-started#wire-it-up),
which does the same one-call bootstrap (body parser, mounted routes, docs, error
handler, listen):

```typescript
// express-zod-api
import { createConfig, createServer } from 'express-zod-api';
const config = createConfig({ http: { listen: 3000 }, cors: true });
await createServer(config, routing);

// zodec — one call, returns the http.Server
import 'reflect-metadata';
import { Zodec, serve } from 'zodec';

const api = new Zodec({ info: { title: 'My API', version: '1.0.0' } });
api.register(new UsersController(service));
await serve(api, { port: 3000, configure: (app) => app.use(cors()) });
```

`configure` runs pre-route middleware (cors/helmet/logging), `after` runs a
post-route fallback, and `app:` hands in your own Express instance — or use
`toExpress(api, …)` to get the built app without listening (e.g. for tests). When
you'd rather wire Express by hand, `api.mount(app)` is still there.

## Gaps: what express-zod-api does that zodec doesn't

- **Built-in result-handler envelope.** zodec returns bare bodies; replicate the
  `{ status, data }` shape with a Zod wrapper schema if you need it (above).
- **Integrated logger / config object.** express-zod-api ships a config + logger
  abstraction; zodec leaves logging and config to you.
- **The `EndpointsFactory` middleware-composition model.** zodec uses plain Express
  middleware via `@Use` and first-class `@Security` instead of factory-composed,
  option-contributing middleware. For the common case — middleware that contributes
  a typed value the handler consumes (a tenant, a request-scoped lookup) — use
  [`createParamDecorator`](/guide/route-handlers#custom-injectors-createparamdecorator):
  its resolver runs per request (sync or async) and injects the value as a handler
  argument.

If you hit an express-zod-api feature without an obvious zodec equivalent, please
[open an issue](https://github.com/joeferner/zodec/issues).
