# Validation & Errors

Each route gets validation middleware generated from its schemas:

| Source         | Validated against | Failure status |
| -------------- | ----------------- | -------------- |
| `req.params`   | `@Params` schema  | `400`          |
| `req.query`    | `@Query` schema   | `400`          |
| `req.body`     | `@Body` schema    | `422`          |
| handler return | `@Returns` schema | `500`          |

On success, the parsed (coerced, defaulted) output is what the matching
parameter decorators (`@Param`, `@QueryParam`, `@BodyParam`) inject — so handlers
always receive clean data. Responses are validated the same way: the handler's
return value is checked against the matching `@Returns` schema, and a mismatch
**always throws** a [`ValidationError`](/api/classes/ValidationError) — in every
environment.

### The response schema also serializes the response

avero sends the **parsed** result, not the raw return value, so the `@Returns`
schema doubles as a response serializer:

- **Undeclared fields are stripped.** Return `{ id, passwordHash }` from a handler
  whose schema is `z.object({ id: z.string() })` and only `{ id }` goes out — a
  built-in guard against leaking internal fields.
- **Transforms and defaults apply** on the way out, exactly like request parsing.
- **Opt out with `.loose()`** (`z.object({ … }).loose()`) to pass extra keys
  through unchanged.

A route with no `@Returns` schema sends the value untouched.

## Errors flow through Express

avero never sends an error response itself. A failed validation calls
`next(err)` with a `ValidationError` carrying the Zod issues and a status, so it
travels the **same** Express error pipeline as anything your handlers throw.
`ValidationError` and `SecurityError` both extend [`AveroError`](/api/classes/AveroError)
(which carries `.status`), so you can match on that in your own middleware:

```typescript
import { AveroError } from 'avero';

app.use((err, req, res, next) => {
  if (err instanceof AveroError) {
    return res.status(err.status).json({ status: err.status, message: err.message });
  }
  next(err);
});
```

## Convenience handler

If you don't want to write that, avero ships an optional
[`averoErrorHandler`](/api/functions/averoErrorHandler) that renders errors as
[RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457) **Problem Details**
(`application/problem+json`) — the standard, interoperable error shape:

```typescript
import { averoErrorHandler } from 'avero';

app.use(averoErrorHandler());
// 422 → application/problem+json
// {
//   "type": "about:blank",          // a doc URI when you have one
//   "title": "Unprocessable Entity", // the HTTP status reason phrase
//   "status": 422,
//   "errors": [{ "path": ["name"], "message": "Too short" }]
// }
```

`type` defaults to `about:blank` (meaning "the title is just the status phrase");
the `errors` array (RFC 9457 extension) is present for validation failures.
`SecurityError` renders the same way without `errors`.

Override the body with `formatError` — which switches the response back to
`application/json`, since your shape isn't Problem Details:

```typescript
app.use(averoErrorHandler({ formatError: (err) => ({ ok: false, message: err.message }) }));
```

Handlers themselves should throw standard
[`http-errors`](https://www.npmjs.com/package/http-errors) (e.g.
`throw new createError.NotFound()`); those pass straight through to Express.
