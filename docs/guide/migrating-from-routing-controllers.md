# Migrating from routing-controllers

[routing-controllers](https://github.com/typestack/routing-controllers) (with
[`routing-controllers-openapi`](https://github.com/epiphone/routing-controllers-openapi)
and class-validator) is the closest decorator-for-decorator analog to covenix: both
describe Express routes with class decorators and generate OpenAPI. If you're
coming from it, the routing maps almost 1:1 — the real shift is the same one as
the NestJS migration: **class-validator DTOs → Zod schemas**, with the spec
derived from that one schema instead of a separate documentation layer.

- **routing-controllers is decorators + class-validator + a bolt-on spec.**
  Controllers carry `@JsonController`/`@Get`/`@Param`/`@Body`; validation comes
  from class-validator decorators on DTO classes; the OpenAPI document is produced
  by `routing-controllers-openapi` (which runs `class-validator-jsonschema` to turn
  those classes into schemas), often supplemented by `@OpenAPI()`/`@ResponseSchema()`.
- **covenix is decorators + Zod, one source.** The Zod schema validates the request,
  serializes the response, **and** becomes the OpenAPI component — no
  class-validator, no `class-validator-jsonschema`, no separate
  `@ResponseSchema`/`@OpenAPI` declarations to keep in sync.

Both run on Express and Node, so there's **no runtime caveat** and the routing
decorators line up closely.

## Should you migrate? (the honest version)

These are close cousins; the decision is mostly about validation source-of-truth
and how you wire dependencies.

**Stay on routing-controllers if** you're invested in class-validator/class-transformer
across the codebase, or you lean on its tight IoC integration (`useContainer` with
typedi/typeorm), the Koa adapter, or the action-based extras and don't want to
rewrite DTOs.

**covenix is the better fit if** you want:

- **One schema instead of three declarations.** In routing-controllers a field's
  truth is split across class-validator (`@IsEmail`), class-transformer (`@Type`),
  and the doc layer (`@ResponseSchema`, `@OpenAPI`, or `class-validator-jsonschema`
  inference). covenix collapses that to a single Zod schema. No drift.
- **Response validation on by default.** `routing-controllers-openapi` documents
  responses via `@ResponseSchema`, but nothing validates that the returned object
  matches it. covenix parses every response through its `@Returns` schema (extra
  fields stripped; a mismatch throws `500`).
- **No reflection-fragility around generics/optionals.** `class-validator-jsonschema`
  inference can miss nested generics, `Record`s, and unions; Zod models all of
  them explicitly and `z.toJSONSchema` is exact.
- **First-class files, range, SSE, and auth in the spec** via dedicated decorators.

## The fundamental shift: class-validator DTOs → Zod

A routing-controllers DTO is a class with class-validator decorators (runtime) and,
for the spec, either `class-validator-jsonschema` inference or `@JSONSchema`:

```typescript
// routing-controllers — CreateUser.ts
import { IsEmail, IsString, Length, IsEnum, IsOptional } from 'class-validator';

export class CreateUser {
  @IsString()
  @Length(3, 32)
  username: string;

  @IsEmail()
  email: string;

  @IsEnum(['admin', 'user'])
  @IsOptional()
  role?: 'admin' | 'user';
}
```

The same contract as a single Zod schema — validates the request, serializes the
response, **and** becomes the `CreateUser` component:

```typescript
// covenix
import { z } from 'zod';

export const CreateUserSchema = z
  .object({
    username: z.string().min(3).max(32),
    email: z.email(),
    role: z.enum(['admin', 'user']).optional(),
  })
  .meta({ id: 'CreateUser' });

export type CreateUser = z.infer<typeof CreateUserSchema>;
```

The class-validator → Zod translations are the same as the
[NestJS guide's cookbook](/guide/migrating-from-nestjs#validation-class-validator-zod-cookbook)
— `@Length(3,32)` → `.min(3).max(32)`, `@IsEmail()` → `z.email()`,
`@ValidateNested()` + `@Type(() => X)` → a nested `XSchema`, and so on.

## At a glance

| routing-controllers (+ openapi)                         | covenix                                                         | Notes                                               |
| ------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| `@JsonController('/users')` / `@Controller`             | `@Route('users')`                                             | Nearly identical (drop the leading slash).          |
| `@Get('/:id')`, `@Post()`, …                            | `@Get('{id}')`, `@Post()`, …                                  | `:id` → `{id}`.                                     |
| `@Param('id') id: string`                               | `@Params(Schema)` + `@Param('id') id`                         | Schema validates on the method; param injects.      |
| `@QueryParam('q') q` / `@QueryParams() q`               | `@Query(Schema)` + `@QueryParam('q')`                         | Schema + injection split.                           |
| `@Body() body: CreateUser`                              | `@Body(Schema)` + `@BodyParam() body`                         | Same split.                                         |
| `@HeaderParam('x-id')`                                  | `@Header('x-id')`                                             | Injection.                                          |
| `@Req() req` / `@Res() res`                             | `@Req() req` / `@Res() res`                                   | Escape hatch.                                       |
| class-validator on a DTO class                          | `z.object({…}).meta({ id })` + `z.infer`                      | Runtime types move to Zod.                          |
| `@ResponseSchema(User, { statusCode: 200 })`            | `@Returns(200, UserSchema)`                                   | Stackable; and **validated**, not just documented.  |
| `@OpenAPI({ summary, description })`                    | `@Summary` / `@Description` / `@OperationId`                  | First-class decorators.                             |
| `@HttpCode(201)`                                        | `@Returns(201, Schema)` (first 2xx)                           | Success status from `@Returns`.                     |
| `@OnUndefined(204)`                                     | `@Returns(204)` (omit schema)                                 | No-content response.                                |
| `@Authorized('role')` + `authorizationChecker`          | `@Security('jwt', scopes)` + `bearer()` handler               | Scheme + spec from one place.                       |
| `@CurrentUser() user`                                   | `@Principal() user`                                           | Injected principal.                                 |
| `@UseBefore(mw)` / `@UseAfter` / `@Middleware`          | `@Use(...)` (class or method)                                 | Express middleware.                                 |
| `@UploadedFile()` / `@UploadedFiles()`                  | `z.file()` in `@Body` + `@File`/`@Files`                      | Auto-detected multipart; web-standard `File`.       |
| return a stream / set headers for downloads             | `@ReturnsFile(...)` + `FileResponse`/`RangeFileResponse`      | Disposition + range negotiation handled.            |
| (no built-in SSE)                                       | [`@Sse(schema?)`](/guide/server-sent-events)                  | Validated + documented `text/event-stream`.         |
| `useContainer(Container)` (container owns construction) | `api.register(new C(deps))` — or register a resolved instance | Container-agnostic; you hand covenix the instance.    |
| `routingControllersToSpec(storage, options)`            | `api.swagger()` / `generateSwagger([...])`                    | Native, Zod-derived; no class-validator-jsonschema. |
| `useExpressServer(app, { controllers })`                | `api.mount(app)`                                              | Wires routes + validation.                          |
| Express **or Koa** driver                               | **Express only**                                              | covenix targets Express 5.                            |

## A controller, side by side

**routing-controllers** — DTO classes + `@ResponseSchema` describe the contract;
the container constructs the controller:

```typescript
import { JsonController, Get, Post, Param, Body, NotFoundError } from 'routing-controllers';
import { ResponseSchema, OpenAPI } from 'routing-controllers-openapi';
import { Service } from 'typedi';

@Service()
@JsonController('/users')
export class UsersController {
  constructor(private service: UserService) {} // resolved by typedi

  @Get('/:id')
  @ResponseSchema(User)
  @OpenAPI({ summary: 'Get a user' })
  async getUser(@Param('id') id: string): Promise<User> {
    const user = await this.service.get(id);
    if (!user) throw new NotFoundError();
    return user;
  }

  @Post()
  @ResponseSchema(User, { statusCode: 201 })
  async createUser(@Body() body: CreateUser): Promise<User> {
    return this.service.create(body);
  }
}
```

**covenix** — Zod schemas + `@Returns` (which also validates); you hand `register` a
constructed instance:

```typescript
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
  @Summary('Get a user')
  async getUser(@Param('id') id: string): Promise<User> {
    const user = await this.service.get(id);
    if (!user) throw new createError.NotFound();
    return user; // validated against UserSchema
  }

  @Post()
  @Body(CreateUserSchema)
  @Returns(201, UserSchema) // 201 is the success status
  async createUser(@BodyParam() body: CreateUser): Promise<User> {
    return this.service.create(body);
  }
}
```

Differences to internalize:

1. **`@ResponseSchema(User)` → `@Returns(200, UserSchema)`** — and it's not just
   documentation; the return value is parsed through it.
2. **`@HttpCode`/`@OnUndefined` aren't needed.** The success status is the first
   declared 2xx `@Returns`; for errors you `throw` and let the error middleware map
   it (routing-controllers' `NotFoundError` → `createError.NotFound()`).
3. **`@Service()`/`useContainer` aren't required.** You pass `register` an instance
   — `new` it, or resolve it from your container (see below).

## Dependency injection: keep your container, or drop it

routing-controllers **owns** the container: you call `useContainer(Container)` and
it resolves every controller (and its dependencies) for you, which couples your app
to that specific IoC setup.

covenix is **container-agnostic**. `api.register()` takes an already-constructed
instance, so where that instance comes from is entirely up to you:

```typescript
// Plain construction — no DI library at all:
api.register(new UsersController(new UserService(db)));

// Or keep using typedi (or tsyringe / awilix / inversify) — just resolve and register:
import { Container } from 'typedi';
api.register(Container.get(UsersController));
```

So this isn't "you must give up DI" — it's the opposite of `useContainer`: covenix
doesn't take over construction, it accepts whatever you hand it. The practical
effects:

- **You're decoupled from the container.** covenix never reaches into typedi's global
  state; it has no `useContainer` to register. Swap DI libraries, or use none,
  without touching covenix.
- **Construction is explicit at the registration site.** Whether that's `new C(...)`
  or `Container.get(C)`, it's plain, type-checked code — no boot-time
  token-resolution surprises.
- **Testing is just construction.** `new UsersController(fakeService)` (or a test
  container) is the fixture; there's no framework testing module to spin up.

If you have a large dependency graph and already use a container, keep it — point
its resolved instances at `api.register()`. If you don't, you don't need to adopt
one.

## Authentication

routing-controllers splits auth across `@Authorized(roles)` + a global
`authorizationChecker`, with `@CurrentUser()` + a `currentUserChecker`:

```typescript
// routing-controllers
useExpressServer(app, {
  authorizationChecker: async (action, roles) => {
    const user = verifyJwt(action.request.headers.authorization);
    return !!user && roles.every((r) => user.roles.includes(r));
  },
  currentUserChecker: (action) => getUser(action.request),
});

@Authorized(['users:read'])
@Get('/me')
me(@CurrentUser() user: User) { return user; }
```

covenix registers each named scheme once — definition **and** handler together — and
injects the principal with `@Principal()`:

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

The big win over `authorizationChecker`: the scheme lands in
`components.securitySchemes` and the per-operation requirement on the spec
automatically — no separate documentation of the security scheme. See
[Authentication](/guide/authentication).

## Files, downloads, and SSE

routing-controllers injects multer files with `@UploadedFile()`/`@UploadedFiles()`
and leaves downloads to raw stream returns. covenix models the form as a `@Body`
schema and has dedicated response types:

- **Upload:** `z.file()` in a `@Body` schema → auto-detected `multipart/form-data`,
  injected as a web-standard `File` via `@File`/`@Files`. See [File uploads](/guide/file-uploads).
- **Download / range:** `@ReturnsFile(...)` + `FileResponse` / `RangeFileResponse`
  (automatic `Content-Disposition`, `206`/`416` negotiation). See [File downloads](/guide/file-downloads).
- **SSE:** [`@Sse(schema?)`](/guide/server-sent-events) — routing-controllers has no
  built-in SSE; covenix validates and documents it.

## OpenAPI & the typed client

routing-controllers builds the spec with `routingControllersToSpec(...)`, feeding
it schemas from `class-validator-jsonschema`. covenix derives the document directly
from Zod — no second conversion step:

```typescript
api.swagger(); // OpenAPI 3.1 from Zod 4 (api.swagger({ specVersion: '3.0' }) to down-convert)
generateSwagger([UsersController]); // instance-free, for CI / codegen
api.serveDocs(app); // browsable UI
await writeFile('api.gen.ts', generateTypeScriptClient(api.contract())); // standalone client
```

routing-controllers has no first-party typed client; covenix generates one from the
same contract. See [Typed Client](/guide/typed-client).

## Bootstrapping

```typescript
// routing-controllers
import 'reflect-metadata';
import { useExpressServer } from 'routing-controllers';
const app = express();
useExpressServer(app, { controllers: [UsersController] });

// covenix
import 'reflect-metadata';
import express from 'express';
import { Covenix, covenixErrorHandler } from 'covenix';

const app = express();
app.use(express.json());
const api = new Covenix({ info: { title: 'My API', version: '1.0.0' } });
api.register(new UsersController(service)); // new it, or Container.get(UsersController)
api.mount(app);
api.serveDocs(app);
app.use(covenixErrorHandler());
app.listen(3000);
```

## Gaps: what routing-controllers does that covenix doesn't

- **Built-in container ownership** (`useContainer` auto-resolving controllers).
  covenix is container-agnostic — you can still use any DI library, you just resolve
  and `register` the instance yourself rather than handing covenix the container (see
  [above](#dependency-injection-keep-your-container-or-drop-it)).
- **Koa driver.** routing-controllers runs on Express **or** Koa; covenix is
  **Express 5 only** (see [#2](https://github.com/joeferner/covenix/issues/2)).
- **Action-based middleware extras** — `@Middleware`, global interceptors
  (`@Interceptor`), `@UseBefore`/`@UseAfter` ordering nuances. covenix uses plain
  Express middleware via `@Use`.
- **class-validator/class-transformer ecosystem** — covenix is **Zod-only**; DTOs
  must be rewritten as Zod schemas (the [NestJS cookbook](/guide/migrating-from-nestjs#validation-class-validator-zod-cookbook)
  applies directly).

If you hit a routing-controllers feature without an obvious covenix equivalent,
please [open an issue](https://github.com/joeferner/covenix/issues).
