# File Uploads

To **receive** files, declare them in your [`@Body`](/api/functions/Body) schema
as [`z.file()`](https://zod.dev) fields. avero auto-detects the route as
`multipart/form-data` (there is no `@Multipart` marker), parses it with
[multer](https://github.com/expressjs/multer), and injects each uploaded file as
a web-standard [`File`](https://developer.mozilla.org/docs/Web/API/File) via
[`@File`](/api/functions/File) / [`@Files`](/api/functions/Files).

```typescript
import { z } from 'zod';
import { Route, Post, Params, Body, Returns, Param, File, BodyParam } from 'avero';

const AvatarUpload = z.object({
  // The z.file() field is what makes this route multipart. Size/mime
  // constraints live in the schema — the single source of truth.
  avatar: z.file().max(2_000_000).mime(['image/png', 'image/jpeg']),
  caption: z.string().max(140).optional(),
});

@Route('users')
class UsersController {
  @Post('{id}/avatar')
  @Params(z.object({ id: z.string().uuid() }))
  @Body(AvatarUpload)
  @Returns(200, UploadResultSchema)
  async uploadAvatar(
    @Param('id') id: string,
    @File('avatar') avatar: File,
    @BodyParam('caption') caption?: string,
  ): Promise<UploadResult> {
    const bytes = new Uint8Array(await avatar.arrayBuffer());
    await db.users.setAvatar(id, { bytes, contentType: avatar.type });
    return { filename: avatar.name, contentType: avatar.type, size: avatar.size, caption };
  }
}
```

## How it works

A `@Body` schema is normally validated as JSON. The moment it contains a file
field, avero switches the route to `multipart/form-data` and:

- runs **multer** before the handler, so text fields land on `req.body` and files
  on `req.files`,
- adapts each uploaded file to a web-standard **`File`** (so `file.name`,
  `file.type`, `file.size`, `file.arrayBuffer()`, and `file.stream()` all work),
- assembles those into the body object and validates it against your schema with
  the **same `safeParse`** as any other body — file `.max()`/`.mime()`
  constraints included,
- and injects the result: `@File(name)` gives a single `File`, `@Files(name)`
  gives `File[]`, and `@BodyParam(name)` gives a text field.

A validation failure (oversized file, wrong mime type, missing required file,
too many files) responds **`422`**, just like any other body failure — including
multer's own limit errors.

## Single vs. multiple files

The schema decides the shape. A single `z.file()` injects one `File`; wrap it in
`z.array(z.file())` to accept several and inject a `File[]`:

```typescript
const GalleryUpload = z.object({
  photos: z.array(z.file().max(5_000_000).mime(['image/png', 'image/jpeg'])).max(8),
});

@Post('{id}/photos')
@Body(GalleryUpload)
@Returns(200, z.object({ uploaded: z.number().int() }))
async uploadPhotos(@Files('photos') photos: File[]): Promise<{ uploaded: number }> {
  return { uploaded: photos.length };
}
```

## Constraints live in the schema

Because file fields go through the same validation path as everything else,
their constraints belong in the Zod schema — not in the decorator:

- **size** — `z.file().max(bytes)` / `.min(bytes)`
- **mime type** — `z.file().mime(['image/png', 'image/jpeg'])`
- **required** — a plain `z.file()` is required; `.optional()` makes it not
- **count** — `z.array(z.file()).max(n)`

These same constraints are reflected in the generated OpenAPI document, so the
spec and the runtime check never drift.

## Storage and limits

By default uploads are buffered **in memory**, so each handler receives a `File`
backed by the bytes. Configure multer through the `Avero` constructor — the
`multipart` option is passed straight to multer:

```typescript
import multer from 'multer';

const api = new Avero({
  info: { title: 'My API', version: '1.0.0' },
  multipart: {
    // Disk storage for large uploads — avero still hands the handler a `File`,
    // backed lazily by the file on disk (it isn't read into memory until you
    // read the File).
    storage: multer.diskStorage({ destination: '/tmp/uploads' }),
    // Reject oversized uploads *before* they're fully buffered. A per-field
    // `z.file().max()` only runs once the bytes are in hand, so a global
    // `fileSize` limit is the cheaper first line of defense.
    limits: { fileSize: 10 * 1024 * 1024 },
  },
});
```

::: tip
With in-memory storage, `z.file().max()` runs only after the whole file has been
buffered. For untrusted clients, set a multer `limits.fileSize` so the upload is
rejected before it can fill memory.
:::

## OpenAPI

A multipart `@Body` is documented as a `multipart/form-data` request body, with
file fields rendered as binary:

```jsonc
"requestBody": {
  "required": true,
  "content": {
    "multipart/form-data": {
      "schema": {
        "type": "object",
        "properties": {
          "avatar": { "type": "string", "format": "binary" },
          "caption": { "type": "string" }
        },
        "required": ["avatar"]
      }
    }
  }
}
```

This is the upload counterpart to [File downloads](/guide/file-downloads), which
covers sending binary responses with `@ReturnsFile`, `FileResponse`, and `RangeFileResponse`.
