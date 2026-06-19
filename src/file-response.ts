import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';

/** Options for a {@link FileResponse}. */
export interface FileResponseOptions {
  /** `Content-Type` for the response (e.g. `'application/pdf'`). */
  contentType?: string;
  /** Filename for `Content-Disposition: attachment`; omit for inline. */
  filename?: string;
  /** HTTP status; defaults to the route's declared success status (or 200). */
  status?: number;
}

/**
 * A non-JSON response: a binary body (a `Uint8Array`/`Buffer` or a `Readable`
 * stream) that zodec streams to the client, setting `Content-Type` and
 * `Content-Disposition` and skipping JSON serialization and response validation.
 * Return one from a handler (typically alongside `@ReturnsFile`).
 *
 * @example
 * ```ts
 * @Get('{id}/export')
 * @ReturnsFile(200, { contentType: 'text/csv' })
 * export(@Param('id') id: string): FileResponse {
 *   return new FileResponse(Buffer.from(csv), {
 *     contentType: 'text/csv',
 *     filename: `user-${id}.csv`,
 *   });
 * }
 * ```
 */
export class FileResponse {
  /** The response body — raw bytes or a readable stream. */
  public readonly body: Uint8Array | Readable;
  /** `Content-Type` for the response, if set. */
  public readonly contentType: string | undefined;
  /** Download filename for `Content-Disposition`, if set. */
  public readonly filename: string | undefined;
  /** Explicit HTTP status, if set. */
  public readonly status: number | undefined;

  public constructor(body: Uint8Array | Readable, options: FileResponseOptions = {}) {
    this.body = body;
    this.contentType = options.contentType;
    this.filename = options.filename;
    this.status = options.status;
  }

  /** Builds a FileResponse that streams the file at `path` from disk. */
  public static fromPath(path: string, options?: FileResponseOptions): FileResponse {
    return new FileResponse(createReadStream(path), options);
  }
}
