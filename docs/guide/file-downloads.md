# File Downloads

Handlers normally return a value that zodec serializes to JSON. To send a **file
or binary stream** instead — a download, an export, a generated PDF — return a
[`FileResponse`](/api/classes/FileResponse) and declare the response with
[`@ReturnsFile`](/api/functions/ReturnsFile).

```typescript
import { Route, Get, Params, ReturnsFile, Returns, Param, FileResponse } from 'zodec';

@Route('users')
class UsersController {
  @Get('{id}/export')
  @Params(z.object({ id: z.string().uuid() }))
  @ReturnsFile(200, { contentType: 'text/csv' })
  @Returns(404, ErrorSchema)
  async export(@Param('id') id: string): Promise<FileResponse> {
    const user = await db.users.findById(id);
    if (!user) throw new createError.NotFound();
    const csv = `id,username,email\n${user.id},${user.username},${user.email}\n`;
    return new FileResponse(Buffer.from(csv), {
      contentType: 'text/csv',
      filename: `user-${user.id}.csv`,
    });
  }
}
```

## How it works

When a handler returns a `FileResponse`, zodec:

- sets the **status** (`FileResponse.status`, else the route's declared success
  status, else `200`),
- sets **`Content-Type`** from `contentType` (if given),
- sets **`Content-Disposition: attachment`** with the `filename` (if given),
- streams the body (a `Buffer`/`Uint8Array` is sent directly; a `Readable` is
  piped),
- and **skips JSON serialization and response validation** entirely.

A handler can still throw `http-errors` (or fail `@Params`/`@Query` validation)
on the same route — those flow through the normal error pipeline, so a `404`
declared with `@Returns` and a `200` file declared with `@ReturnsFile` coexist.

## `FileResponse`

```typescript
new FileResponse(body, options?);
FileResponse.fromPath(path, options?); // streams a file from disk
```

- **`body`** — `Uint8Array` / `Buffer`, or a `Readable` stream.
- **`options.contentType`** — the runtime `Content-Type` header.
- **`options.filename`** — download filename. Encoded per **RFC 5987/6266**
  (a UTF-8 `filename*` plus an ASCII `filename` fallback), so non-ASCII names
  like `résumé.pdf` work and are safely escaped.
- **`options.status`** — overrides the HTTP status.

```typescript
// Stream a file straight from disk:
return FileResponse.fromPath('/var/reports/2026-q2.pdf', {
  contentType: 'application/pdf',
  filename: 'Q2 report.pdf',
});
```

## `@ReturnsFile` and OpenAPI

`@ReturnsFile(status, options?)` advertises the response as a binary body in the
generated OpenAPI document:

```jsonc
"200": {
  "content": {
    "application/octet-stream": { "schema": { "type": "string", "format": "binary" } }
  }
}
```

- **`options.contentType`** — the media type key in the spec. Defaults to
  `application/octet-stream` when you don't know it ahead of time; the runtime
  `Content-Type` (from the `FileResponse`) can differ.
- **`options.description`** — the response description in the spec.

It's stackable with `@Returns`, so one route can declare both a binary success
response and JSON error responses.
