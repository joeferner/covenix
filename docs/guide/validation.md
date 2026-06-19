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

## Errors flow through Express

zodec never sends an error response itself. A failed validation calls
`next(err)` with a `ValidationError` carrying the Zod issues and a status, so it
travels the **same** Express error pipeline as anything your handlers throw. You
stay in control of the response shape via your own error middleware:

```typescript
import { ValidationError } from 'zodec';

app.use((err, req, res, next) => {
  if (err instanceof ValidationError) {
    return res.status(err.status).json({ status: err.status, errors: err.issues });
  }
  next(err);
});
```

## Convenience handler

If you don't want to write that, zodec ships an optional
[`zodecErrorHandler`](/api/functions/zodecErrorHandler) that renders the standard
shape — and accepts a `formatError` override:

```typescript
import { zodecErrorHandler } from 'zodec';

app.use(zodecErrorHandler()); // → { status, errors: [{ path, message }] }

// or customize the body:
app.use(zodecErrorHandler({ formatError: (err) => ({ ok: false, issues: err.issues }) }));
```

Handlers themselves should throw standard
[`http-errors`](https://www.npmjs.com/package/http-errors) (e.g.
`throw new createError.NotFound()`); those pass straight through to Express.
