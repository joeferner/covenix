# Migrating from tsoa

[tsoa](https://github.com/lukeautry/tsoa) and zodec solve the same problem —
typed Express routes with an OpenAPI document — but from opposite directions:

- **tsoa is build-time.** It reads your TypeScript **types** (plus JSDoc tags)
  and runs a code generator (`tsoa routes`, `tsoa spec`) that emits a routes file
  and a `swagger.json`. Your types are the source of truth, and a compile step
  turns them into validation + spec.
- **zodec is runtime.** You describe each endpoint with **Zod schemas**. There is
  no code generation and no `tsoa.json`: `api.mount(app)` wires the routes and
  `api.swagger()` produces the document, both at startup, from the same schemas.

If you're coming from tsoa, the mental shift is: **move the contract out of
TypeScript types + JSDoc and into Zod schemas.** Everything else maps closely —
the routing and parameter decorators are nearly identical.

## At a glance

| tsoa                                              | zodec                                           | Notes                                                             |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `class C extends Controller`                      | `class C` (plain)                               | No base class.                                                    |
| `@Route('users')` / `@Tags('Users')`              | `@Route('users')` / `@Tags('Users')`            | Identical.                                                        |
| `@Get('{id}')`, `@Post()`, …                      | `@Get('{id}')`, `@Post()`, …                    | Identical, including `{id}` path syntax.                          |
| `@Path() id: number`                              | `@Params(Schema)` + `@Param('id') id`           | Validation schema is separate from injection.                     |
| `@Query() q: string`                              | `@Query(Schema)` + `@QueryParam('q') q`         | Same split.                                                       |
| `@Body() body: T`                                 | `@Body(Schema)` + `@BodyParam() body`           | Same split.                                                       |
| `@BodyProp() x`                                   | `@Body(Schema)` + `@BodyParam('x') x`           | Inject one field.                                                 |
| `@Header('x-id') id`                              | `@Header('x-id') id`                            | Identical.                                                        |
| `@Request() req`                                  | `@Req() req` / `@Res() res`                     | Escape hatch.                                                     |
| `@SuccessResponse('201')` + `this.setStatus()`    | `@Returns(201, Schema)`                         | The first declared 2xx is the success status — no manual call.    |
| `@Response<E>(422, '…')`                          | `@Returns(422, ErrorSchema)`                    | Stackable, one per status.                                        |
| `this.setHeader(…)` (JSON)                        | `@Returns(200, S, { headers })` + `@Res` to set | Header is documented in the spec.                                 |
| `this.setHeader(…)` (downloads)                   | `FileResponse({ headers, disposition })`        | Cache-Control/inline without `@Res`.                              |
| `@Example(…)`                                     | `@Example(value, status?)`                      | Similar.                                                          |
| `@UploadedFile() f: Express.Multer.File`          | `z.file()` in `@Body` + `@File('f') f: File`    | Auto-detected multipart; web-standard `File`.                     |
| `@UploadedFiles() fs`                             | `z.array(z.file())` + `@Files('fs') fs: File[]` |                                                                   |
| `@FormField() title`                              | text field in the `@Body` schema + `@BodyParam` |                                                                   |
| `@Produces(…)` + return `Readable`/`Buffer`       | `@ReturnsFile(…)` + return `FileResponse`       |                                                                   |
| Manual `req.range` / `206` / `416`                | return a `RangeFileResponse`                    | Range negotiation is automatic.                                   |
| Validation from TS types + `@isInt`/`@minLength`  | Zod schema (`z.number().int()`, `.min()`)       | Runtime, explicit.                                                |
| Models are interfaces/classes                     | `z.object({…}).meta({ id: 'User' })`            | `.meta({ id })` names the component.                              |
| `ValidateError` (422), handle it yourself         | `ValidationError` + `zodecErrorHandler()`       | Optional ready-made handler.                                      |
| `tsoa routes && tsoa spec`, `RegisterRoutes(app)` | `api.mount(app)`, `api.swagger()`               | No generated files.                                               |
| IoC container (`iocModule`)                       | `api.register(new C(deps))`                     | Explicit construction.                                            |
| `@Security('jwt', scopes)`                        | `@Security('jwt', scopes)` + `bearer()` handler | Schemes registered on the instance; principal via `@Principal()`. |
| `@OperationId('x')`                               | `@OperationId('x')`                             | Both default the id to the method name.                           |
| JSDoc summary / description on the method         | `@Summary('…')` / `@Description('…')`           | zodec uses decorators, not doc comments.                          |
| JSDoc `@deprecated` tag                           | `@Deprecated()`                                 | Marks the operation deprecated in the spec.                       |

## A controller, side by side

**tsoa** — types carry the contract, `@Path`/`@Query`/`@Body` read the parameter
name from the variable:

```typescript
import { Body, Controller, Get, Path, Post, Query, Route, SuccessResponse, Tags } from 'tsoa';

@Route('users')
@Tags('Users')
export class UsersController extends Controller {
  @Get('{userId}')
  public async get(@Path() userId: number, @Query() verbose?: boolean): Promise<User> {
    return service.get(userId, verbose);
  }

  @Post()
  @SuccessResponse('201', 'Created')
  public async create(@Body() body: CreateUser): Promise<User> {
    this.setStatus(201);
    return service.create(body);
  }
}
```

**zodec** — Zod schemas carry the contract. The method-level `@Params`/`@Query`/
`@Body` decorators validate; the parameter-level `@Param`/`@QueryParam`/
`@BodyParam` inject:

```typescript
import { z } from 'zod';
import {
  Route,
  Tags,
  Get,
  Post,
  Params,
  Query,
  Body,
  Returns,
  Param,
  QueryParam,
  BodyParam,
} from 'zodec';

@Route('users')
@Tags('Users')
export class UsersController {
  @Get('{userId}')
  @Params(z.object({ userId: z.coerce.number().int() }))
  @Query(z.object({ verbose: z.coerce.boolean().optional() }))
  @Returns(200, UserSchema)
  public async get(
    @Param('userId') userId: number,
    @QueryParam('verbose') verbose: boolean | undefined,
  ): Promise<User> {
    return service.get(userId, verbose);
  }

  @Post()
  @Body(CreateUserSchema)
  @Returns(201, UserSchema) // 201 is the success status — no this.setStatus()
  public async create(@BodyParam() body: CreateUser): Promise<User> {
    return service.create(body);
  }
}
```

Two things to internalize:

1. **The schema lives on the method, the injection on the parameter.** tsoa packs
   both into one decorator because it reads your types. zodec keeps them separate:
   `@Query(schema)` validates the whole query object once; `@QueryParam('verbose')`
   pulls one parsed field out.
2. **No `extends Controller`, no `this.setStatus()`.** The success status is just
   the first declared 2xx `@Returns`.

## Validation: JSDoc tags → Zod

This is the heart of the migration. tsoa constraints are JSDoc tags on interface
members:

```typescript
// tsoa
export interface CreateUser {
  /**
   * @minLength 3
   * @maxLength 20
   * @pattern ^[a-zA-Z0-9_]+$
   */
  username: string;
  /** @format email */
  email: string;
  /**
   * @isInt
   * @minimum 0
   * @maximum 120
   */
  age: number;
}
```

The same contract as a Zod schema — and this object both validates requests and
becomes the `CreateUser` component in your OpenAPI document:

```typescript
// zodec
export const CreateUserSchema = z
  .object({
    username: z
      .string()
      .min(3)
      .max(20)
      .regex(/^[a-zA-Z0-9_]+$/),
    email: z.email(),
    age: z.number().int().min(0).max(120),
  })
  .meta({ id: 'CreateUser' });

export type CreateUser = z.infer<typeof CreateUserSchema>;
```

Common tag translations:

| tsoa JSDoc                | Zod                                 |
| ------------------------- | ----------------------------------- |
| `@isInt`                  | `z.number().int()`                  |
| `@isFloat`                | `z.number()`                        |
| `@minLength n`            | `.min(n)` (on a string)             |
| `@maxLength n`            | `.max(n)` (on a string)             |
| `@minimum n` / `@maximum` | `.min(n)` / `.max(n)` (on a number) |
| `@minItems` / `@maxItems` | `.min(n)` / `.max(n)` (on an array) |
| `@pattern re`             | `.regex(/re/)`                      |
| `@format email`           | `z.email()`                         |
| `@format uuid`            | `z.uuid()`                          |
| `@format date-time`       | `z.iso.datetime()`                  |

Use `z.infer<typeof Schema>` for the static type, so you still get a single
named type to pass around — the Zod schema replaces the interface.

## Status codes, responses, and headers

tsoa documents responses with `@SuccessResponse` / `@Response` and sets the
runtime status/headers imperatively via the `Controller` base class:

```typescript
// tsoa
@Get()
@SuccessResponse('200')
@Response<ErrorBody>(404, 'Not found')
public async list(): Promise<User[]> {
  this.setHeader('X-Total-Count', String(total));
  return users;
}
```

zodec declares each response with a stackable `@Returns`, declares headers as part
of the success response, and sets the header value through the `@Res` escape
hatch:

```typescript
// zodec
@Get()
@Returns(200, UserListSchema, { headers: { 'X-Total-Count': z.number().int() } })
@Returns(404, ErrorSchema)
public async list(@Res() res: Response): Promise<UserList> {
  res.set('X-Total-Count', String(total));
  return list;
}
```

## Errors

tsoa throws `ValidateError` (422) and leaves you to write the error middleware.
zodec throws `ValidationError` (400 for params/query, 422 for body, 500 for a
response that violates its `@Returns` schema) and ships an optional handler:

```typescript
// tsoa — hand-rolled
import { ValidateError } from 'tsoa';
app.use((err, req, res, next) => {
  if (err instanceof ValidateError) {
    return res.status(422).json({ message: 'Validation Failed', details: err.fields });
  }
  next(err);
});

// zodec — ready-made (or handle ValidationError yourself)
import { zodecErrorHandler } from 'zodec';
app.use(zodecErrorHandler());
```

See [Validation & Errors](/guide/validation) for the error shape and how to
customize it.

## File uploads

tsoa injects multer's file objects directly:

```typescript
// tsoa
@Post('avatar')
public async upload(
  @UploadedFile() avatar: Express.Multer.File,
  @FormField() caption?: string,
): Promise<void> {}
```

zodec models the whole form as a `@Body` schema. A `z.file()` field auto-detects
the route as `multipart/form-data`; the file is injected as a **web-standard
`File`**, and constraints live in the schema:

```typescript
// zodec
const AvatarUpload = z.object({
  avatar: z.file().max(2_000_000).mime(['image/png', 'image/jpeg']),
  caption: z.string().max(140).optional(),
});

@Post('avatar')
@Body(AvatarUpload)
@Returns(200, UploadResultSchema)
public async upload(
  @File('avatar') avatar: File,
  @BodyParam('caption') caption?: string,
): Promise<UploadResult> {
  const bytes = new Uint8Array(await avatar.arrayBuffer());
  // ...
}
```

zodec also uses multer under the hood — configure it via `new Zodec({ multipart })`.
See [File uploads](/guide/file-uploads).

## File downloads

tsoa returns a `Readable`/`Buffer` and sets headers imperatively, with `@Produces`
for the spec:

```typescript
// tsoa
@Get('export')
@Produces('text/csv')
public async export(): Promise<Readable> {
  this.setHeader('Content-Disposition', 'attachment; filename=users.csv');
  return createReadStream('users.csv');
}
```

zodec returns a `FileResponse` and declares the binary body with `@ReturnsFile`;
the `Content-Disposition` (including RFC 5987 UTF-8 filenames) is handled for you:

```typescript
// zodec
@Get('export')
@ReturnsFile(200, { contentType: 'text/csv' })
public async export(): Promise<FileResponse> {
  return new FileResponse(Buffer.from(csv), { contentType: 'text/csv', filename: 'users.csv' });
}
```

The other imperative bits map onto `FileResponse` options instead of
`this.setHeader`:

- **`inline` vs `attachment`** (tsoa's `contentDisposition(name, { type })`) →
  `disposition: 'inline' | 'attachment'`.
- **`Cache-Control`, `Content-Length`, other headers** → the `headers` bag (no
  `@Res()` needed). `Content-Length` is automatic for a `Uint8Array`/`Buffer`.

```typescript
return new FileResponse(bytes, {
  contentType: artifact.mimeType,
  filename: artifact.filename,
  disposition: artifact.mimeType.startsWith('image/') ? 'inline' : 'attachment',
  headers: { 'Cache-Control': 'private, no-store' },
});
```

### Range / partial downloads

tsoa has no built-in Range support — you read `req.range(size)` and set `206`/
`416`, `Content-Range`, and `Accept-Ranges` by hand. zodec packages that into
`RangeFileResponse`: return one and the `206`/`416`/full-`200` negotiation is
automatic.

```typescript
// tsoa — manual range handling on the raw response (abridged)
const ranges = req.range(file.size);
if (ranges === -1) {
  this.setStatus(416);
  res.setHeader('Content-Range', `bytes */${file.size}`);
} else if (Array.isArray(ranges) && ranges.length === 1) {
  const { start, end } = ranges[0];
  this.setStatus(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
  return file.getStream({ start, end });
}

// zodec — return a RangeFileResponse; zodec negotiates the range
return new RangeFileResponse(
  { size: file.size, stream: (range) => file.getStream(range) },
  { contentType: file.contentType, filename: file.filename, disposition: 'inline' },
);
// or, for a disk file (adds conditional GET): RangeFileResponse.fromPath(path)
```

See [File downloads](/guide/file-downloads).

## Bootstrapping & swagger — no build step

tsoa generates a routes file and a spec, then you register the generated routes:

```typescript
// tsoa — after `tsoa routes && tsoa spec`
import { RegisterRoutes } from './build/routes';
const app = express();
app.use(express.json());
RegisterRoutes(app);
// swagger.json is the generated file, served statically
```

zodec wires routes and produces the document at runtime — no `tsoa.json`, no
generated files, nothing to keep in sync:

```typescript
import 'reflect-metadata';
import express from 'express';
import { Zodec } from 'zodec';

const app = express();
app.use(express.json());

const api = new Zodec({ info: { title: 'My API', version: '1.0.0' } });
api.register(new UsersController(service)); // you own construction (DI)
api.mount(app);

app.get('/swagger.json', (_req, res) => res.json(api.swagger()));
app.listen(3000);
```

For CI spec checks or client codegen without booting a server, use the
instance-free [`generateSwagger([UsersController])`](/guide/swagger).

## Dependency injection

tsoa constructs controllers with a no-arg constructor by default, or via an IoC
container configured in `tsoa.json` (inversify/tsyringe/typedi). zodec has no
container: you construct each controller and `register` the instance, injecting
dependencies through its constructor.

```typescript
api.register(new UsersController(new UserService(db)));
```

This is usually less setup than wiring an IoC module, and it keeps construction
explicit and type-checked.

## Authentication

tsoa's `@Security('jwt', scopes)` names a scheme defined in `tsoa.json`, and a
single exported `expressAuthentication(req, name, scopes)` function does the work
for every scheme, attaching the result to `req.user`:

```typescript
// tsoa — securityDefinitions in tsoa.json + one global function
export function expressAuthentication(req: Request, name: string, scopes?: string[]) {
  if (name === 'jwt') {
    const user = verifyJwt(req.headers.authorization);
    if (!user) return Promise.reject(new Error('unauthorized'));
    return Promise.resolve(user);
  }
}

@Get('me')
@Security('jwt', ['users:read'])
public async me(@Request() req: ExRequest): Promise<User> {
  return req.user as User;
}
```

zodec registers each scheme on the instance (definition **and** handler together,
via a builder) and injects the principal with `@Principal()`:

```typescript
import { Zodec, Security, Principal, bearer } from 'zodec';

const api = new Zodec({
  info,
  security: {
    jwt: bearer((req, scopes) => {
      const user = verifyJwt(req.headers.authorization);
      if (!user) return null;                       // → 401
      if (!scopes.every((s) => user.scopes.includes(s))) {
        throw new SecurityError(403, 'Forbidden');  // handler owns the scope check
      }
      return user;                                  // → @Principal()
    }),
  },
});

@Get('me')
@Security('jwt', ['users:read'])
public me(@Principal() user: User): User {
  return user;
}
```

Mapping notes:

- **Per-scheme handlers, not one global switch.** Each named scheme carries its
  own handler, so there's no `securityName` dispatch.
- **`req.user` → `@Principal()`.** The handler's return value is injected directly.
- **Scopes are handler-decided** (same as tsoa) — zodec passes them in.
- **Reject semantics:** return `null`/`undefined` for `401`; throw (e.g.
  `new SecurityError(403)`) for `403`.
- **OR** of schemes: stack `@Security` decorators (the request passes if any one
  succeeds) — the OpenAPI equivalent of multiple requirement objects.

See [Authentication](/guide/authentication) for the full picture.

If you hit a tsoa feature without an obvious zodec equivalent, please
[open an issue](https://github.com/joeferner/zodec/issues).
