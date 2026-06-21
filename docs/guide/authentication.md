# Authentication

Protect a route with [`@Security`](/api/functions/Security). It names a scheme
you register on the `Zodec` instance; before the handler runs, zodec invokes that
scheme's handler, and the principal it returns is injected with
[`@Principal()`](/api/variables/Principal). The same registration drives the
OpenAPI `securitySchemes` + per-operation `security`, so the spec always matches
what's enforced.

```typescript
import { Zodec, Route, Get, Security, Principal, Returns, bearer, SecurityError } from 'zodec';

const api = new Zodec({
  info: { title: 'My API', version: '1.0.0' },
  security: {
    bearerAuth: bearer((req, scopes) => {
      const user = verifyJwt(req.headers.authorization);
      if (!user) {
        return null; // → 401
      }
      if (!scopes.every((s) => user.scopes.includes(s))) {
        throw new SecurityError(403, 'Forbidden'); // → 403
      }
      return user; // becomes the @Principal()
    }),
  },
});

@Route('users')
class UsersController {
  @Get('me')
  @Security('bearerAuth')
  @Returns(200, UserSchema)
  me(@Principal() user: User): User {
    return user;
  }
}
```

## The handler

A security handler is `(req, scopes) => principal`:

- **Returns a principal** (any value) — authentication succeeded; the value is
  injected via `@Principal()`.
- **Returns `null`/`undefined`** — zodec rejects with **`401`**.
- **Throws** — the thrown error propagates (e.g. `new SecurityError(403)` for
  authenticated-but-not-authorized). It can be `async`; zodec awaits it.

`scopes` is the array passed to `@Security(scheme, scopes)` for this route. **The
handler owns the scope check** — zodec doesn't prescribe a principal shape, so
whether a "scope" is an OAuth scope, a role, or a permission is up to you.

Authentication runs **before** request validation, so an unauthenticated request
gets `401` before any `400`/`422` body checks.

## Scheme builders

The `security` map pairs an OpenAPI scheme definition with a handler. Builders
produce both at once:

```typescript
import { bearer, basic, apiKey, oauth2 } from 'zodec';

security: {
  bearerAuth: bearer(handler, { bearerFormat: 'JWT' }), // { type: 'http', scheme: 'bearer' }
  basicAuth: basic(handler),                            // { type: 'http', scheme: 'basic' }
  apiKey: apiKey({ in: 'header', name: 'X-API-Key' }, handler),
  oauth: oauth2({ authorizationCode: { /* ... */ } }, handler),
}
```

For anything the builders don't cover, pass a raw `{ scheme, handler }` — `scheme`
is any OpenAPI [Security Scheme Object](https://spec.openapis.org/oas/v3.1.0#security-scheme-object).

## Injecting the principal

`@Principal()` injects whatever the matching handler returned. Type it at the call
site:

```typescript
@Get('me')
@Security('bearerAuth')
me(@Principal() user: User): User {
  return user;
}
```

On an unguarded route `@Principal()` resolves to `undefined`. (zodec doesn't carry
runtime type info, so the annotation is yours to get right — same as `@Param`/
`@Body` injections.)

## Multiple schemes (OR)

Stack `@Security` decorators to accept **any** of several schemes — the request
passes if one succeeds (left to right). This is OpenAPI's array-of-requirements
(OR) semantics.

```typescript
@Get('data')
@Security('bearerAuth')
@Security('apiKey')   // a valid bearer token OR a valid API key gets in
getData(@Principal() who: Principal) { ... }
```

zodec runs each in order and injects the first success. If none succeed, the
first failure is reported (a `null` return → `401`; a thrown `403` is preserved).

## Class-wide and per-route

`@Security` on the controller class applies to every route; a method-level
`@Security` overrides it for that route:

```typescript
@Route('admin')
@Security('bearerAuth') // default for the whole controller
class AdminController {
  @Get('stats')
  stats() {} // inherits bearerAuth

  @Delete('{id}')
  @Security('bearerAuth', ['admin']) // overrides with a stricter scope
  remove(@Param('id') id: string) {}
}
```

## Errors

zodec throws [`SecurityError`](/api/classes/SecurityError) (`401`, or `403` when
a handler throws it) through the normal error pipeline. The optional
[`zodecErrorHandler()`](/guide/validation) renders it as an RFC 9457
`application/problem+json` body (`{ type, title, status }`); handlers that throw
`http-errors` (or any error with a `status`) compose with your own Express error
middleware.

## OpenAPI

The registered schemes are emitted under `components.securitySchemes`, and each
guarded operation gets a `security` requirement:

```jsonc
"/users/me": {
  "get": {
    "security": [{ "bearerAuth": [] }],
    // ...
  }
}
// components.securitySchemes.bearerAuth = { "type": "http", "scheme": "bearer" }
```

### Static generation

Per-operation `security` comes off the decorators, so it's available without an
instance. The scheme **definitions**, though, live in the instance's `security`
config — so the instance-free [`generateSwagger`](/guide/swagger) takes them as an
option:

```typescript
generateSwagger([UsersController], info, {
  securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
});
```

Sharing one `securitySchemes` constant between `new Zodec({ security })` and
`generateSwagger(...)` keeps the running server and the static spec identical.
