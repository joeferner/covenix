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

`@Security` and `@Use` also work at the method level (below).

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

| Decorator         | Validates    | Failure status |
| ----------------- | ------------ | -------------- |
| `@Params(schema)` | `req.params` | `400`          |
| `@Query(schema)`  | `req.query`  | `400`          |
| `@Body(schema)`   | `req.body`   | `422`          |

A `@Body` schema containing a `z.file()` field auto-detects the route as
`multipart/form-data`. See [File uploads](/guide/file-uploads).

## Parameter injection decorators

Placed on handler parameters to inject a value. A name-less injector (e.g.
`@BodyParam()`) injects the whole parsed object.

| Decorator           | Injects                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| `@Param('id')`      | One parsed path param (or all, with no name).                                       |
| `@QueryParam('q')`  | One parsed query field (or the whole query object).                                 |
| `@BodyParam('x')`   | One body field (or the whole parsed body, with no name).                            |
| `@Header('x-id')`   | One request header.                                                                 |
| `@File('avatar')`   | An uploaded file as a web-standard `File`. See [File uploads](/guide/file-uploads). |
| `@Files('photos')`  | Multiple uploaded files (`File[]`).                                                 |
| `@Principal()`      | The authenticated principal. See [Authentication](/guide/authentication).           |
| `@Req()` / `@Res()` | The raw Express `Request` / `Response` — the escape hatch.                          |

::: tip Prefer return values over `@Res()`
Reaching for `@Res()` opts a handler out of response validation and serialization.
For status, headers, and cookies, return an [`HttpResponse`](#httpresponse-headers-status-cookies)
instead — you keep validation and a documented contract.
:::

### Custom injectors (`createParamDecorator`)

The built-ins don't cover everything — a cookie, `req.ip`, a value derived from a
header, or an awaited per-request lookup. `createParamDecorator` builds your own
from a resolver that receives `{ req, res }` (plus any `data` you pass) and returns
the value — **sync or async**:

```typescript
import { createParamDecorator } from 'zodec';

const ClientIp = createParamDecorator(({ req }) => req.ip);
const Cookie = createParamDecorator(({ req }, name: string) => req.cookies?.[name]);

@Get()
handler(@ClientIp() ip: string | undefined, @Cookie('sid') sid: string | undefined) {}
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
