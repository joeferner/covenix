# Route Handlers

A zodec API is a set of **controller classes**. Each public method decorated with
an HTTP verb becomes a route; decorators on the method and its parameters describe
the request, the response, and everything the OpenAPI document needs. This page is
the catalog of those decorators and of what a handler may return.

```typescript
import { z } from 'zod';
import { Route, Tags, Get, Post, Params, Body, Returns, Param, BodyParam } from 'zodec';
import createError from 'http-errors';

@Route('users') // path prefix for every route in the class
@Tags('Users') // OpenAPI tag (groups operations, names the client namespace)
export class UsersController {
  constructor(private readonly service: UserService) {} // you own construction

  @Get('{id}') // GET /users/{id}
  @Params(z.object({ id: z.uuid() })) // validates req.params
  @Returns(200, UserSchema) // success body schema (also validates the response)
  @Returns(404, ErrorSchema) // additional documented status
  async getUser(@Param('id') id: string): Promise<User> {
    const user = await this.service.get(id);
    if (!user) throw new createError.NotFound();
    return user; // the return value IS the 200 body
  }
}
```

Two rules underpin everything below:

1. **Method-level decorators carry schemas; parameter-level decorators inject.**
   `@Query(schema)` validates the whole query object once; `@QueryParam('q')` pulls
   one parsed field into an argument.
2. **The return value is the response.** zodec infers the status from `@Returns`
   and validates/serializes the body through its schema. For an error status you
   `throw`; for response metadata (headers/cookies/status) you return an
   [`HttpResponse`](#httpresponse-headers-status-cookies).

## Class decorators

| Decorator                  | Purpose                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@Route(prefix)`           | Path prefix prepended to every route in the class (e.g. `@Route('users')`).                                   |
| `@Tags(...names)`          | OpenAPI tags for the class's operations; the first tag names the generated client group.                      |
| `@Security(name, scopes?)` | Require a named security scheme for **all** routes in the class. See [Authentication](/guide/authentication). |
| `@Use(...middleware)`      | Express middleware applied to every route in the class. See [middleware](#middleware-use).                    |
| `@Returns(status, …)`      | A **shared response** merged into every route in the class (see [below](#shared-responses)).                  |

`@Security`, `@Use`, and `@Returns` work at both the class and method level.

### Shared responses {#shared-responses}

Applying `@Returns` to the **controller class** declares a response shared by every
route in it — handy for common error shapes you'd otherwise repeat on each method:

```typescript
@Route('users')
@Returns(401, ErrorSchema) // every route documents 401…
@Returns(422, ErrorSchema) // …and 422
export class UsersController {
  @Get('{id}')
  @Returns(200, UserSchema)
  @Returns(422, NotFoundSchema) // route-specific — overrides the shared 422 here
  get(@Param('id') id: string) {}
}
```

The shared responses are merged into each operation's OpenAPI `responses` (and the
generated client's `.raw()` union); a route's own `@Returns` for the **same status**
takes precedence. `headers` and `description` on a shared `@Returns` carry through
too. (Shared responses are per-controller; declare them on each controller that
needs them.)

## HTTP method decorators

`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete` map a method to a verb. Each takes an
optional path appended to the class prefix; path parameters use **`{brace}`**
syntax (not Express's `:colon`).

```typescript
@Get()            // GET    /users
@Get('{id}')      // GET    /users/{id}
@Post()           // POST   /users
@Patch('{id}')    // PATCH  /users/{id}
@Delete('{id}')   // DELETE /users/{id}
```

## Request schema decorators (method level)

Each validates one request source against a Zod schema. The parsed (coerced,
defaulted) result is what the matching parameter decorators inject — so handlers
always receive clean data. See [Validation & Errors](/guide/validation).

| Decorator          | Validates     | Failure status |
| ------------------ | ------------- | -------------- |
| `@Params(schema)`  | `req.params`  | `400`          |
| `@Query(schema)`   | `req.query`   | `400`          |
| `@Headers(schema)` | `req.headers` | `400`          |
| `@Cookies(schema)` | `req.cookies` | `400`          |
| `@Body(schema)`    | `req.body`    | `422`          |

`@Params`/`@Query`/`@Headers`/`@Cookies` also **document** each property as an
OpenAPI parameter (`in: path` / `query` / `header` / `cookie`). A `@Body` schema
containing a `z.file()` field auto-detects the route as `multipart/form-data`.
See [File uploads](/guide/file-uploads).

::: tip Headers & cookies
Header names are case-insensitive — Node lower-cases them, so `@Headers` schema
keys must be lower-case (`'x-request-id'`). The reserved `authorization`,
`accept`, and `content-type` headers are still validated but omitted from the
generated OpenAPI parameters. `@Cookies` reads `req.cookies`, so a cookie parser
(e.g. [`cookie-parser`](https://github.com/expressjs/cookie-parser)) must run as
middleware ahead of the route.
:::

## Parameter injection decorators

Placed on handler parameters to inject a value. A name-less injector (e.g.
`@BodyParam()`) injects the whole parsed object.

| Decorator              | Injects                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@Param('id')`         | One parsed path param (or all, with no name).                                                                 |
| `@QueryParam('q')`     | One parsed query field (or the whole query object).                                                           |
| `@BodyParam('x')`      | One body field; `@BodyParam()` the whole body; `@BodyParam(schema)` the whole body + declares `@Body` inline. |
| `@HeaderParam('x-id')` | One request header (parsed by `@Headers` when present, else the raw value).                                   |
| `@CookieParam('sid')`  | One request cookie (parsed by `@Cookies` when present, else the raw value).                                   |
| `@File('avatar')`      | An uploaded file as a web-standard `File`. See [File uploads](/guide/file-uploads).                           |
| `@Files('photos')`     | Multiple uploaded files (`File[]`).                                                                           |
| `@Principal()`         | The authenticated principal. See [Authentication](/guide/authentication).                                     |
| `@Req()` / `@Res()`    | The raw Express `Request` / `Response` — the escape hatch.                                                    |

::: tip Prefer return values over `@Res()`
Reaching for `@Res()` opts a handler out of response validation and serialization.
For status, headers, and cookies, return an [`HttpResponse`](#httpresponse-headers-status-cookies)
instead — you keep validation and a documented contract.
:::

### Schemas, parameter types, and mismatches

A method-level schema (`@Body(UserSchema)`) and the **type annotation** on the
parameter that receives it (`@BodyParam() user: User`) are declared separately,
and TypeScript's legacy parameter decorators **can't** tie them together — a
decorator never sees the parameter's type. So this compiles without complaint:

```typescript
@Body(UserSchema)
create(@BodyParam() user: Item) {} // ⚠️ runtime hands you a User; the compiler believes Item
```

At runtime `user` is the parsed `User` (validated against `UserSchema`); the
`: Item` annotation is erased and never checked. Nothing flags the lie — it just
poisons the handler body. Two things keep you honest:

1. **Derive the type from the schema.** Annotate with `z.infer<typeof Schema>`
   instead of an independently-written type, so the schema is the single source
   of truth and the two can't drift:

   ```typescript
   @Body(CreateUserSchema)
   create(@BodyParam() user: z.infer<typeof CreateUserSchema>) {}
   ```

   `@BodyParam(CreateUserSchema)` goes one step further — the schema sits right on
   the parameter (no separate `@Body`), so there's only one thing to keep in sync:

   ```typescript
   create(@BodyParam(CreateUserSchema) user: z.infer<typeof CreateUserSchema>) {}
   ```

2. **zodec checks what it can at registration.** Types are erased, but names and
   schema shape aren't — so when you `mount` (or `toExpress`/`serve`) zodec throws
   on the **structural** mismatches it can see:
   - `@BodyParam('field')` naming a field absent from the `@Body` schema;
   - any body/file injector when the handler declares no `@Body` schema;
   - `@File('x')` whose field isn't a single `z.file()`, or `@Files('x')` whose
     field isn't a `z.array(z.file())`.

### Custom injectors (`createParamDecorator`)

The built-ins don't cover everything — `req.ip`, a value derived from a header, a
tenant resolved from the host, or an awaited per-request lookup. `createParamDecorator`
builds your own from a resolver that receives `{ req, res }` (plus any `data` you
pass) and returns the value — **sync or async**:

```typescript
import { createParamDecorator } from 'zodec';

const ClientIp = createParamDecorator(({ req }) => req.ip);
const Tenant = createParamDecorator(({ req }) => req.hostname.split('.')[0]);

@Get()
handler(@ClientIp() ip: string | undefined, @Tenant() tenant: string) {}
```

A resolver may return a promise — it's awaited before the handler runs — and a
throw is routed through the [error pipeline](/guide/validation#errors-flow-through-express),
so `throw createError.Forbidden()` yields a `403`. `@Principal()` is itself built on
`createParamDecorator`.

Type note: TypeScript's legacy parameter decorators can't constrain the parameter's
type, so the annotation (`ip: string | undefined`) is developer-asserted — keep it
in sync with the resolver's return type (exactly like `@Principal() user: User`).

## Response decorators

| Decorator                          | Declares                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@Returns(status, schema?, opts?)` | A response for a status (stackable). Omit `schema` for no body (e.g. `@Returns(204)`). `opts` carries `headers` and `description`. |
| `@ReturnsFile(status, opts?)`      | A binary body — return a `FileResponse`/`RangeFileResponse`. See [File downloads](/guide/file-downloads).                          |
| `@Sse(schema?, opts?)`             | A `text/event-stream` — return an async iterable. See [Server-Sent Events](/guide/server-sent-events).                             |

The **first declared 2xx** is the success status; there's no `setStatus` call.

## Dates

A JavaScript `Date` has no JSON form — it travels as an **ISO string** over the
wire. zodec keeps the schema honest about which side holds a real `Date`:

- **Responses → `z.date()`.** Your handler returns a `Date`; zodec validates it
  and serializes it to an ISO string. Documented in OpenAPI as
  `{ type: 'string', format: 'date-time' }`.
- **Requests → `z.coerce.date()`.** The incoming JSON value is a string, so
  `z.coerce.date()` parses it into a `Date` before your handler runs. (Plain
  `z.date()` on a request body would reject the string.)

```typescript
const CreateEvent = z.object({
  title: z.string(),
  startsAt: z.coerce.date(), // request: ISO string → Date
});
const Event = z.object({
  id: z.uuid(),
  startsAt: z.date(), // response: Date → ISO string on the wire
});

@Post()
@Body(CreateEvent)
@Returns(201, Event)
create(@BodyParam() body: z.infer<typeof CreateEvent>): z.infer<typeof Event> {
  return this.events.create(body); // body.startsAt is a Date; the returned Date is serialized
}
```

On the client side, dates depend on whether you generate a validating client:

- The **default (types-only) [client](/guide/typed-client)** types a date field as
  `string` — the honest wire type, since it does no parsing.
- A **validating client** (`generateTypeScriptClient(contract, { validate: 'zod' })`)
  types it as `Date` and **revives** the ISO string into a real `Date` on receipt.

## Documentation decorators

These enrich the OpenAPI operation and the generated client's JSDoc.

| Decorator                  | Effect                                                 |
| -------------------------- | ------------------------------------------------------ |
| `@Summary(text)`           | Operation `summary`.                                   |
| `@Description(text)`       | Operation `description`.                               |
| `@OperationId(id)`         | Operation `operationId` (defaults to the method name). |
| `@Deprecated()`            | Marks the operation deprecated.                        |
| `@Example(value, status?)` | An example for the request body or a response status.  |

## Security & middleware

### `@Security(name, scopes?)`

Requires a named scheme (registered on the `Zodec` instance) and injects the
result via `@Principal()`. Stack it for an OR of schemes. Full details in
[Authentication](/guide/authentication).

### `@Use(...middleware)` {#middleware-use}

Attaches plain Express middleware, at the class or method level. Runs after
authentication and before the body is parsed.

```typescript
@Use(rateLimit({ windowMs: 60_000, max: 100 }))
@Get()
list() { /* ... */ }
```

## What a handler can return

zodec inspects the returned value and dispatches accordingly:

| Return value                            | Behaviour                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------- |
| A plain value (`T`)                     | Validated/serialized by the matched `@Returns` schema, sent as JSON.       |
| `HttpResponse<T>`                       | JSON body **plus** status/headers/cookies (below). Body still validated.   |
| `FileResponse`                          | A binary body streamed whole. See [File downloads](/guide/file-downloads). |
| `RangeFileResponse`                     | A binary body with HTTP `Range` support.                                   |
| An `AsyncIterable` (on an `@Sse` route) | Streamed as Server-Sent Events.                                            |

For a non-success status, **`throw`** (e.g. an `http-errors` error) and let the
[error pipeline](/guide/validation#errors-flow-through-express) map it.

`FileResponse`, `RangeFileResponse`, and `HttpResponse` all extend `ResponseBase`,
so they share `status`, `headers`, and `cookies`.

## `HttpResponse`: headers, status & cookies {#httpresponse-headers-status-cookies}

Return an [`HttpResponse<T>`](/api/classes/HttpResponse) to set response metadata
without dropping to the raw `res`. It's opt-in — a handler may return `T` **or**
`HttpResponse<T>` — and the body is still validated/serialized by `@Returns`
exactly like a bare return.

```typescript
@Get('me')
@Returns(200, UserSchema, { headers: { 'X-RateLimit-Remaining': z.number().int() } })
me(@Principal() user: User): HttpResponse<User> {
  return new HttpResponse(user, {
    headers: { 'X-RateLimit-Remaining': 42 }, // declared header → coerced to "42"
    cookies: [{ name: 'sid', value: token, options: { httpOnly: true, sameSite: 'lax' } }],
  });
}
```

- **`status`** picks which declared `@Returns` to send (it must be one of them — an
  undeclared status is a `500`); defaults to the route's success status.
- **`headers`** are set as given; a header matching a `@Returns(..., { headers })`
  schema is validated against it (a mismatch is a `500`), numbers are stringified,
  and an array value (e.g. `Link: ['<a>', '<b>']`) repeats the header. Undeclared
  headers are allowed.
- **`cookies`** are emitted as `Set-Cookie` — Express does the formatting
  (`Max-Age` / `SameSite` / encoding / signing).

Because the shared options live on `ResponseBase`, a `FileResponse` download can
set a cookie or custom header the same way.
