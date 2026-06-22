# File Downloads

Handlers normally return a value that avero serializes to JSON. To send a **file
or binary stream** instead — a download, an export, a generated PDF — return a
[`FileResponse`](/api/classes/FileResponse) and declare the response with
[`@ReturnsFile`](/api/functions/ReturnsFile).

```typescript
import { Route, Get, Params, ReturnsFile, Returns, Param, FileResponse } from 'avero';

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

When a handler returns a `FileResponse`, avero:

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
- **`options.disposition`** — `'attachment'` (the default when a `filename` is
  set) forces a download; `'inline'` lets the browser render it (images, PDFs,
  audio) while still suggesting `filename`.
- **`options.headers`** — extra response headers (e.g. `Cache-Control`, or
  `Content-Length` for a stream). Values may be strings or numbers, and they are
  applied **last**, so they override the headers derived from
  `contentType`/`filename`/`disposition`.
- **`options.status`** — overrides the HTTP status.

```typescript
return new FileResponse(pngBytes, {
  contentType: 'image/png',
  filename: 'avatar.png',
  disposition: 'inline', // render in the browser instead of downloading
  headers: { 'Cache-Control': 'private, no-store' },
});
```

For a `Uint8Array`/`Buffer` body, `Content-Length` is set automatically; you only
need it in `headers` for a stream.

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

## Partial downloads — `RangeFileResponse`

For large or seekable content (video, audio, big files), return a
[`RangeFileResponse`](/api/classes/RangeFileResponse) instead. It **guarantees
HTTP `Range` support**: its body type is narrowed to sources avero can serve a
byte slice from, so returning one is the opt-in. avero advertises
`Accept-Ranges: bytes` and emits `206 Partial Content` for a single satisfiable
range, `416 Range Not Satisfiable` for an unsatisfiable one, and a full `200` for
a multi-range or malformed request. It takes the same options as `FileResponse`.

Three body kinds:

```typescript
// 1. Bytes — size is intrinsic; avero slices.
return new RangeFileResponse(buffer, { contentType: 'image/png', disposition: 'inline' });

// 2. A range-aware stream source — for large/remote content (object storage, a
//    big file). avero calls stream(range) for just the requested slice.
return new RangeFileResponse(
  { size: object.size, stream: (range) => store.getStream(key, range) },
  { contentType: 'video/mp4', filename: 'clip.mp4' },
);

// 3. A file on disk — served via Express, so Range AND conditional GET
//    (ETag / If-Modified-Since / If-Range) are handled for you.
return RangeFileResponse.fromPath('/var/media/clip.mp4', { contentType: 'video/mp4' });
```

The stream source receives `{ start, end }` (inclusive) for a range request, or
no argument for a full response. avero resolves the slice **before** writing any
header, so a source that throws (e.g. not found) still produces a clean error
response. Conditional GET is handled only on the `fromPath` path; the byte
sources support `Range` only.

Pair it with `@ReturnsFile` exactly like `FileResponse`.
