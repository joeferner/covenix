# Server-Sent Events

To stream events to the client over a long-lived connection — token-by-token LLM
output, progress updates, live notifications — mark the route with
[`@Sse`](/api/functions/Sse) and return an **async iterable** (typically an async
generator). avero sets the `text/event-stream` headers, frames each yielded value
as an SSE event, validates it against the schema, and cleans up on disconnect.

```typescript
import { z } from 'zod';
import { Route, Get, Param, Sse, SseEvent } from 'avero';

const Token = z.object({ text: z.string() });

@Route('chat')
class ChatController {
  @Get('{id}/stream')
  @Sse(Token, { keepAlive: 15000 })
  async *stream(@Param('id') id: string): AsyncGenerator<z.infer<typeof Token>> {
    try {
      for await (const text of llm.stream(id)) {
        yield { text }; // → data: {"text":"…"}
      }
      yield new SseEvent({ text: '' }, { event: 'done' }); // → event: done
    } finally {
      // Runs when the client disconnects — abort the upstream call here.
    }
  }
}
```

## How it works

A `@Sse` route doesn't JSON-respond. avero:

- sets `Content-Type: text/event-stream` (plus `Cache-Control: no-cache` and
  `X-Accel-Buffering: no` to defeat proxy buffering) and keeps the socket open,
- pulls from the returned async iterable and writes one SSE frame per event,
- **validates and serializes each event** against the `@Sse` schema — the _parsed_
  value is sent, so undeclared fields are stripped just like a normal response,
- on client disconnect, calls the iterator's `return()` so an async generator's
  `finally` runs (the place to abort an upstream call),
- ends the stream when the iterable completes.

## Framing: plain values vs `SseEvent`

Yield a **plain value** and avero frames it as a `data:` line (dispatched to the
browser's `onmessage`). Yield an [`SseEvent`](/api/classes/SseEvent) to set the
other SSE fields:

```typescript
yield { text: 'hi' }; // data: {"text":"hi"}

yield new SseEvent(payload, {
  event: 'done', // → addEventListener('done', …) on the client
  id: '42', // → echoed as Last-Event-ID on reconnect (resumable streams)
  retry: 3000, // → client reconnect delay (ms)
});
```

The `data` is what's validated against the schema; the framing fields are
metadata. A `@Sse()` with no schema frames raw values (strings as-is, others as
JSON).

## Keep-alive

Set `{ keepAlive: ms }` to send a comment frame (`: \n\n`) on that interval,
keeping idle connections from being closed by proxies/load balancers:

```typescript
@Sse(Token, { keepAlive: 15000 })
```

## Disconnect handling

Because the handler is an async iterable, cleanup is just a `try/finally` (or a
generator's natural teardown). When the client goes away, avero calls the
iterator's `return()`, which resumes the generator at its suspension point with a
return — running `finally`.

::: warning
`return()` runs the generator's `finally` once the **in-flight `await` settles**.
If your source can block indefinitely (e.g. a network read with no timeout), pass
it an `AbortSignal` you trigger on disconnect so it unblocks promptly, rather than
relying on `finally` alone.
:::

## Validation mid-stream

Each event is validated, but once the first frame is sent the response status is
already committed — so an event that fails its schema **can't** become a `500`.
avero terminates the stream and surfaces the error through `next(err)` (logged by
your error handler; it can't change the status). Treat a mid-stream validation
failure as the server bug it is.

## OpenAPI

An `@Sse` route is documented as a `text/event-stream` response whose media schema
is the event schema, so the per-event shape still shows up for tooling:

```jsonc
"responses": {
  "200": {
    "content": {
      "text/event-stream": { "schema": { "$ref": "#/components/schemas/Token" } }
    }
  }
}
```

OpenAPI has no native model for SSE channels/streaming semantics, so this
documents the event payload shape only.
