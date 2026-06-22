# Migrating from NestJS

[NestJS](https://nestjs.com) and covenix overlap on the part you see every day —
decorated controllers that turn into Express routes with an OpenAPI document —
but they are very different sizes of thing:

- **NestJS is a full application framework.** It owns the application lifecycle:
  a dependency-injection container, modules/providers, guards, pipes,
  interceptors, exception filters, and pluggable transports (HTTP, WebSockets,
  microservices, GraphQL). The HTTP/OpenAPI layer (`@nestjs/swagger`) is one
  feature among many, and the spec is described by a **second set of decorators**
  (`@ApiProperty`, `@ApiResponse`, …) layered on top of your class-validator DTOs.
- **covenix is a focused Express + OpenAPI layer.** It does routing, runtime
  validation, and an accurate spec — and deliberately nothing else. There is no
  container and no transport abstraction; you bring your own Express app and
  construct your controllers yourself. The spec is **derived from the same Zod
  schema** you validate with, so there is no parallel `@ApiProperty` layer to
  drift.

The routing/parameter decorators map almost 1:1. The two real shifts are
**class-validator DTOs → Zod schemas** (the source of truth moves) and **dropping
the DI container** (you construct controllers directly). Read the honesty section
first — covenix does **less** than Nest on purpose.

## Should you migrate? (the honest version)

covenix is **not** a NestJS replacement. Nest is an application framework; covenix is
a library you mount onto an Express app. If you use Nest for more than HTTP
controllers + Swagger, migrating means giving up framework features covenix has no
intention of providing (see [Gaps](#gaps-what-covenix-doesn-t-do) below).

**Stay on NestJS if** you rely on any of: the DI container and module system,
WebSocket/microservice/GraphQL transports, guards/interceptors/pipes as a
cross-cutting middleware system, the Fastify adapter, or the broader ecosystem
(`@nestjs/config`, `@nestjs/typeorm`, testing utilities, etc.). covenix replaces
exactly one slice of Nest — the HTTP controller + OpenAPI slice — and nothing
around it.

**covenix is the better fit if** that one slice is most of what you use Nest for,
and these resonate:

- **You're tired of the `@ApiProperty` ↔ DTO drift.** In Nest the runtime
  contract (class-validator decorators) and the documented contract
  (`@ApiProperty`) are two separate declarations that can — and do — diverge,
  unless you run the [`@nestjs/swagger` CLI plugin](https://docs.nestjs.com/openapi/cli-plugin)
  to reverse-engineer them from TypeScript types. covenix has **one** declaration:
  the Zod schema validates the request, serializes the response, **and** becomes
  the OpenAPI component. There is nothing to keep in sync.
- **You want response validation on by default.** Nest's `ClassSerializerInterceptor`
  is opt-in and shapes output via `@Exclude`/`@Expose`; nothing validates that a
  handler's return value matches what the spec promises. covenix parses **every**
  response through its `@Returns` schema (extra fields stripped, a mismatch throws
  a `500`), so a handler can't silently over-share.
- **You want a smaller, explicit surface.** No container, no module graph, no
  decorator metadata magic beyond what TypeScript already emits. You construct
  controllers with `new`, which is also all the "testing module" you need.

You keep an accurate **OpenAPI 3.1** document (down-convertible to 3.0) from Zod 4
natively, plus a generated [typed client](/guide/typed-client) from the same
source — the two things most teams actually used `@nestjs/swagger` to produce.

## The fundamental shift: class-validator DTOs → Zod

This is the heart of the migration. In Nest a DTO is a **class** whose properties
carry class-validator decorators (runtime validation) and, separately,
`@ApiProperty` decorators (documentation):

```typescript
// NestJS — create-user.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length, IsEnum, IsOptional } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ minLength: 3, maxLength: 32 })
  @IsString()
  @Length(3, 32)
  username: string;

  @ApiProperty({ description: 'Primary contact email; also the login identifier.' })
  @IsEmail()
  email: string;

  @ApiProperty({ enum: ['admin', 'user'], required: false })
  @IsEnum(['admin', 'user'])
  @IsOptional()
  role?: 'admin' | 'user';
}
```

The same contract as a single Zod schema — this one object validates the request,
serializes the response, **and** becomes the `CreateUser` component in the spec:

```typescript
// covenix
import { z } from 'zod';

export const CreateUserSchema = z
  .object({
    username: z.string().min(3).max(32),
    email: z.email().describe('Primary contact email; also the login identifier.'),
    role: z.enum(['admin', 'user']).optional(),
  })
  .meta({ id: 'CreateUser' });

export type CreateUser = z.infer<typeof CreateUserSchema>;
```

Three things collapse into one:

1. **class-validator decorators → Zod methods** (`@Length(3, 32)` → `.min(3).max(32)`).
2. **`@ApiProperty` disappears.** Descriptions, formats, enums, and optionality
   are read straight off the Zod schema. No second declaration, no CLI plugin, no
   drift. `.describe()` / `.meta({ description })` flow into both the spec and the
   generated client's JSDoc.
3. **`class C { … }` + `class-transformer` → `z.infer<typeof Schema>`.** You still
   get one named type to pass around; it's inferred from the schema instead of
   being the schema.

## At a glance

| NestJS                                                      | covenix                                                         | Notes                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `@Controller('users')` / `@ApiTags('Users')`                | `@Route('users')` / `@Tags('Users')`                          | Nearly identical.                                           |
| `@Get(':id')`, `@Post()`, …                                 | `@Get('{id}')`, `@Post()`, …                                  | Path params switch from `:id` to `{id}`.                    |
| `@Param('id') id: string`                                   | `@Params(Schema)` + `@Param('id') id`                         | Schema validates on the method; param injects.              |
| `@Query() q: ListDto`                                       | `@Query(Schema)` + `@QueryParam('q') q`                       | Same split.                                                 |
| `@Body() body: CreateUserDto`                               | `@Body(Schema)` + `@BodyParam() body`                         | Same split.                                                 |
| `@Headers('x-id') id`                                       | `@Header('x-id') id`                                          | Injection; validate in a schema if needed.                  |
| `@Req() req` / `@Res() res`                                 | `@Req() req` / `@Res() res`                                   | Escape hatch.                                               |
| `createParamDecorator((data, ctx) => …)`                    | `createParamDecorator(({ req, res }, data) => …)`             | Custom injectors; sync or async resolver.                   |
| class-validator (`@IsString`, `@Length`, …)                 | Zod (`z.string().min().max()`)                                | Runtime types move to schemas.                              |
| `class XDto` + `class-transformer`                          | `z.object({…}).meta({ id: 'X' })` + `z.infer`                 | `.meta({ id })` names the component.                        |
| `@ApiProperty({ … })`                                       | **removed** — read from the Zod schema                        | The no-drift win; no CLI plugin needed.                     |
| `@ApiResponse({ status, type })`                            | `@Returns(status, Schema)`                                    | Stackable, one per status.                                  |
| `@HttpCode(201)` + `return body`                            | `@Returns(201, Schema)` + `return body`                       | First declared 2xx is the success status.                   |
| `ValidationPipe({ whitelist: true })`                       | always strips unknown keys + validates                        | Whitelist behaviour is the default.                         |
| `ClassSerializerInterceptor` / `@Exclude`/`@Expose`         | response parsed through `@Returns` schema                     | Output serialization is on by default.                      |
| `@UseGuards(JwtGuard)` + `@ApiBearerAuth()`                 | `@Security('jwt', scopes)` + `bearer()` handler               | Scheme + spec from one place; principal via `@Principal()`. |
| Pipe (`ParseIntPipe`, custom transform)                     | `z.coerce.number()` / Zod transform in the schema             | Coercion lives in the schema.                               |
| Interceptor (logging, wrap, timing)                         | `@Use(middleware)` (class or method)                          | Express middleware; no rxjs.                                |
| Exception filter (`@Catch`, `HttpException`)                | `throw createError.NotFound()` + `covenixErrorHandler()`        | Express error pipeline.                                     |
| `@UploadedFile()` (multer interceptor)                      | `z.file()` in `@Body` + `@File('f') f: File`                  | Auto-detected multipart; web-standard `File`.               |
| `StreamableFile` + `res.set(...)`                           | `@ReturnsFile(...)` + `FileResponse` / `RangeFileResponse`    | Disposition + range negotiation handled.                    |
| `@Sse()` (`Observable<MessageEvent>`)                       | [`@Sse(schema?)`](/guide/server-sent-events) (async iterable) | Validated + documented as `text/event-stream`; no rxjs.     |
| `@ApiOperation({ summary, operationId })`                   | `@Summary` / `@Description` / `@OperationId`                  | First-class decorators.                                     |
| Module + DI container (`@Module`, `@Injectable`, providers) | `new C(deps)` + `api.register(c)`                             | No container — explicit construction. **(big change)**      |
| Feature modules / `RouterModule` prefixes                   | `api.group('/v1', …)` / `register(c, { prefix })`             | See [Grouping & Versioning](/guide/versioning).             |
| `SwaggerModule.createDocument(app, config)`                 | `api.swagger()` / `generateSwagger([...])`                    | Native, derived from Zod.                                   |
| `SwaggerModule.setup('docs', app, doc)`                     | `api.serveDocs(app)`                                          | Browsable UI in one line.                                   |
| `Test.createTestingModule({...})`                           | `new C(fakeDeps)`                                             | Construct it; that's the test fixture.                      |
| Fastify adapter / WebSockets / microservices / GraphQL      | **not supported** (by design)                                 | Express HTTP only. See [Gaps](#gaps-what-covenix-doesn-t-do). |

## A controller, side by side

**NestJS** — DTO classes carry the contract; `@ApiResponse`/`@ApiTags` describe
the spec; the constructor is wired by the DI container:

```typescript
import { Controller, Get, Post, Param, Body, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly service: UserService) {} // injected by Nest

  @Get(':id')
  @ApiResponse({ status: 200, type: UserDto })
  @ApiResponse({ status: 404 })
  async getUser(@Param('id') id: string): Promise<UserDto> {
    const user = await this.service.get(id);
    if (!user) throw new NotFoundException();
    return user;
  }

  @Post()
  @ApiResponse({ status: 201, type: UserDto })
  async createUser(@Body() body: CreateUserDto): Promise<UserDto> {
    return this.service.create(body);
  }
}
```

**covenix** — Zod schemas carry the contract; `@Returns` describes the spec _and_
validates the response; you construct the controller yourself:

```typescript
import { z } from 'zod';
import { Route, Tags, Get, Post, Params, Body, Returns, Param, BodyParam } from 'covenix';
import createError from 'http-errors';

@Route('users')
@Tags('Users')
export class UsersController {
  constructor(private readonly service: UserService) {} // you pass it in

  @Get('{id}')
  @Params(z.object({ id: z.uuid() }))
  @Returns(200, UserSchema)
  @Returns(404, ErrorSchema)
  async getUser(@Param('id') id: string): Promise<User> {
    const user = await this.service.get(id);
    if (!user) throw new createError.NotFound();
    return user; // the return value IS the 200 body, validated against UserSchema
  }

  @Post()
  @Body(CreateUserSchema)
  @Returns(201, UserSchema)
  async createUser(@BodyParam() body: CreateUser): Promise<User> {
    return this.service.create(body); // 201 is the first declared 2xx
  }
}
```

Differences to internalize:

1. **`@Param('id')` validation moves to `@Params(schema)`.** Nest packs name +
   pipe into the param decorator; covenix validates the whole params object once
   with `@Params`, then `@Param('id')` injects one parsed field.
2. **`@ApiResponse({ type })` → `@Returns(status, schema)`** — and it's not just
   documentation. The return value is parsed through that schema.
3. **`@HttpCode` / `this.setStatus` aren't needed.** The success status is the
   first declared 2xx `@Returns`; for errors you `throw` and let the error
   middleware map it.

## Validation: class-validator → Zod cookbook

Property decorators become Zod methods on a field. Common translations:

| class-validator                                                        | Zod                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| `@IsString()`                                                          | `z.string()`                                       |
| `@IsInt()` / `@IsNumber()`                                             | `z.number().int()` / `z.number()`                  |
| `@IsBoolean()`                                                         | `z.boolean()`                                      |
| `@IsEmail()`                                                           | `z.email()`                                        |
| `@IsUUID()`                                                            | `z.uuid()`                                         |
| `@IsEnum(Role)`                                                        | `z.enum(['admin', 'user'])` / `z.nativeEnum(Role)` |
| `@Length(3, 32)` / `@MinLength`/`@MaxLength`                           | `.min(3).max(32)`                                  |
| `@Min(n)` / `@Max(n)`                                                  | `.min(n)` / `.max(n)` (on a number)                |
| `@Matches(/re/)`                                                       | `.regex(/re/)`                                     |
| `@IsOptional()`                                                        | `.optional()`                                      |
| `@IsArray()` + `@ValidateNested({ each: true })` + `@Type(() => Item)` | `z.array(ItemSchema)`                              |
| `@ValidateNested()` + `@Type(() => Addr)`                              | nested `AddrSchema` (just reference it)            |
| `@IsObject()`                                                          | `z.object({...})`                                  |
| `@IsDateString()`                                                      | `z.iso.datetime()`                                 |
| `class-transformer` `@Type(() => Number)` on a query param             | `z.coerce.number()`                                |
| `ValidationPipe({ whitelist: true })`                                  | default (unknown keys stripped)                    |
| `ValidationPipe({ transform: true })`                                  | Zod coercion / `.transform()` per field            |

Nested DTOs (`@ValidateNested` + `@Type`) become nested schemas — far less
ceremony than class-transformer's `@Type(() => X)` chains:

```typescript
// NestJS
export class OrderDto {
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  items: LineItemDto[];
}

// covenix
const OrderSchema = z.object({ items: z.array(LineItemSchema) }).meta({ id: 'Order' });
```

## `@ApiProperty` → nothing (read from the schema)

`@nestjs/swagger` needs `@ApiProperty` (or the CLI plugin's type inference)
because class-validator decorators don't describe everything the spec needs —
descriptions, examples, enums, formats. In covenix all of that is already on the
Zod schema:

| `@ApiProperty` option            | covenix / Zod                                         |
| -------------------------------- | --------------------------------------------------- |
| `description: '…'`               | `.describe('…')` or `.meta({ description })`        |
| `example: …`                     | `.meta({ example })` / `@Example(value)`            |
| `enum: [...]`                    | `z.enum([...])`                                     |
| `required: false`                | `.optional()`                                       |
| `default: …`                     | `.default(…)`                                       |
| `format: 'uuid'` / `'email'`     | `z.uuid()` / `z.email()`                            |
| `minimum`/`maximum`/`minLength`… | `.min()` / `.max()`                                 |
| `type: () => OtherDto`           | reference `OtherSchema` (named via `.meta({ id })`) |
| `@ApiPropertyOptional()`         | `.optional()`                                       |
| `@ApiHideProperty()`             | omit it from the schema                             |

The payoff: there is no longer a documentation declaration that can disagree with
the validation declaration. Deleting `@ApiProperty` is the point of the migration,
not a loss.

## Guards, pipes, interceptors, exception filters

Nest's cross-cutting constructs map onto plainer Express/Zod equivalents:

- **Guards (`@UseGuards`)** — auth guards become covenix [security schemes](/guide/authentication):
  `@Security('jwt', scopes)` plus a `bearer()`/`apiKey()` handler registered on
  the instance. The handler returns the principal (injected via `@Principal()`)
  or `null` for a `401`; throw `new SecurityError(403)` for forbidden. Non-auth
  guards become ordinary `@Use(middleware)`.
- **Pipes (`ParseIntPipe`, `ValidationPipe`, custom transform pipes)** — fold into
  the Zod schema. `ParseIntPipe` → `z.coerce.number().int()`; a transform pipe →
  `.transform(...)` on the field; `ValidationPipe` is just how covenix always works.
- **Interceptors** — there's no rxjs pipeline. Request/response side effects
  (logging, timing, wrapping) become `@Use(middleware)` at the class or method
  level. The one interceptor with a direct upgrade is `ClassSerializerInterceptor`:
  covenix serializes responses through the `@Returns` schema **by default**, so you
  don't need it.
- **Exception filters (`@Catch`, `HttpException`)** — become the Express error
  pipeline. `throw new NotFoundException()` → `throw new createError.NotFound()`
  (or any error); `covenixErrorHandler()` maps `ValidationError`/`SecurityError` and
  `http-errors` to responses. For a custom shape, write your own Express error
  middleware (the analog of a global filter). See [Validation & Errors](/guide/validation).

```typescript
// NestJS — guard + pipe + filter
@UseGuards(JwtAuthGuard)
@Get(':id')
getUser(@Param('id', ParseIntPipe) id: number) { /* throws HttpException, caught by a filter */ }

// covenix — security scheme + coercion in the schema + thrown http-error
@Get('{id}')
@Security('jwt')
@Params(z.object({ id: z.coerce.number().int() }))
@Returns(200, UserSchema)
getUser(@Param('id') id: number, @Principal() user: User) { /* throw createError.NotFound() */ }
```

## Drop the DI container

This is the biggest structural change. NestJS resolves your controllers and their
dependencies from a container described by `@Module({ providers, controllers })`
and `@Injectable()`:

```typescript
// NestJS
@Module({
  controllers: [UsersController],
  providers: [UserService, { provide: DB, useValue: db }],
})
export class UsersModule {}
```

covenix has **no container**. You construct each controller, passing its
dependencies through the constructor, and register the instance:

```typescript
// covenix
const db = makeDb();
const service = new UserService(db);
api.register(new UsersController(service));
```

The tradeoff, stated plainly:

- **You lose** automatic dependency resolution, provider scopes
  (request/transient), `useFactory`/`useClass`/`useExisting` wiring, circular-dep
  resolution, and `@Inject(TOKEN)` injection. If your app leans on these, that
  wiring becomes your responsibility (a composition-root file, or a small DI
  library like [tsyringe](https://github.com/microsoft/tsyringe)/`awilix` if you
  want one — covenix doesn't care how a controller was constructed).
- **You gain** explicitness: construction is plain TypeScript, fully type-checked,
  with no metadata reflection or token-resolution errors at boot. It's also all
  the "testing module" you need — `new UsersController(fakeService)` replaces
  `Test.createTestingModule({...}).compile()`.

For most controller-and-a-service apps this is less code than a module file. For
large graphs, centralize construction in one composition root.

## Modules → grouping & versioning

Nest organizes routes with feature modules and `RouterModule` path prefixes.
covenix has no module system, but [grouping](/guide/versioning) covers the routing
side — prefixes and versioned mounts:

```typescript
// NestJS
RouterModule.register([{ path: 'v1', module: V1Module }]);

// covenix
api.group('/v1', (v1) => {
  v1.register(new UsersController(service));
  v1.register(new OrdersController(orders));
});
// or per-controller: api.register(new UsersController(service), { prefix: '/v1' });
```

For code organization beyond routing (the "feature module" concept), use ordinary
files/folders — covenix doesn't impose a structure.

## Authentication

Nest splits auth across a guard (runtime) and `@ApiBearerAuth()` + `DocumentBuilder.addBearerAuth()`
(spec). covenix registers a scheme once — definition **and** handler together — and
both the runtime check and the spec come from it:

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
requirement on the spec automatically — no `@ApiBearerAuth()`, no `DocumentBuilder`
calls. See [Authentication](/guide/authentication).

## OpenAPI & the typed client

`@nestjs/swagger` builds the document at boot from `DocumentBuilder` + the
`@Api*` decorators (and optionally the CLI plugin). covenix derives it from the Zod
schemas with no parallel decorators and no plugin:

```typescript
api.swagger(); // OpenAPI 3.1 from Zod 4
api.swagger({ specVersion: '3.0' }); // down-convert for partial-3.1 tooling
generateSwagger([UsersController]); // instance-free, for CI / codegen
api.serveDocs(app); // browsable UI (replaces SwaggerModule.setup)
```

Where Nest teams reached for `@nestjs/swagger` + `openapi-generator-cli` to
produce a TypeScript client, covenix generates a standalone one from the same
contract:

```typescript
import { generateTypeScriptClient } from 'covenix';
await writeFile('api.gen.ts', generateTypeScriptClient(api.contract()));
```

```typescript
import { createClient } from './api.gen'; // standalone — no covenix runtime dep
const client = createClient({ baseUrl: 'https://api.example.com' });
const user = await client.users.get({ params: { id } }); // → User; throws on non-2xx
```

See [Typed Client](/guide/typed-client).

## Bootstrapping

```typescript
// NestJS
const app = await NestFactory.create(AppModule);
const config = new DocumentBuilder().setTitle('My API').setVersion('1.0.0').build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
await app.listen(3000);

// covenix
import 'reflect-metadata';
import express from 'express';
import { Covenix, covenixErrorHandler } from 'covenix';

const app = express();
app.use(express.json());

const api = new Covenix({ info: { title: 'My API', version: '1.0.0' } });
api.register(new UsersController(new UserService(db))); // you own construction
api.mount(app);
api.serveDocs(app);
app.use(covenixErrorHandler());
app.listen(3000);
```

## Gaps: what covenix doesn't do {#gaps-what-covenix-doesn-t-do}

These are real NestJS features with **no covenix equivalent**. Most are intentional
non-goals — covenix is an Express HTTP layer, not a framework — but be honest with
yourself about which you depend on before migrating:

- **Dependency-injection container.** No providers, scopes, `@Injectable`,
  `@Inject`, `useFactory`, or auto-resolution. You construct controllers yourself
  (see [Drop the DI container](#drop-the-di-container)). _Rationale: explicit
  construction; bring your own DI lib if you want one._
- **Module system.** No `@Module`, feature modules, or `forRoot()`/`forFeature()`
  dynamic-module patterns. Routing prefixes are covered by `group()`; code
  organization is just files. _Rationale: out of scope for a routing layer._
- **Non-HTTP transports.** No WebSocket gateways, microservices (TCP/Redis/NATS/
  Kafka), or GraphQL. _Rationale: explicit non-goals — see closed
  [#16](https://github.com/joeferner/covenix/issues/16). covenix is REST/OpenAPI-focused._
- **Platform adapters.** **Express only** — no Fastify adapter. _Rationale: deep
  Express 5 integration over breadth._
- **The interceptor pipeline.** No rxjs `Observable` request/response stream,
  no `CacheInterceptor`, `TimeoutInterceptor`, or response-mapping interceptors.
  Use Express middleware via `@Use`; response serialization is built in.
- **Lifecycle hooks.** No `OnModuleInit`/`OnApplicationBootstrap`/`OnModuleDestroy`.
  Do setup/teardown in your own bootstrap code.
- **The ecosystem.** `@nestjs/config`, `@nestjs/typeorm`, `@nestjs/schedule`,
  `@nestjs/testing`, CLI scaffolding, etc. — none of it applies. covenix is a single
  library; you wire config/ORM/scheduling yourself.
- **Validation-library choice.** Nest accepts any class-validator setup (and
  others via custom pipes); covenix is **Zod-only**. DTOs must be rewritten as Zod
  schemas.

If a Nest feature you rely on has no obvious covenix equivalent and you think it
should, please [open an issue](https://github.com/joeferner/covenix/issues).
