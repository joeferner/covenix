import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';

/** Options for a {@link FileResponse}. */
export interface FileResponseOptions {
  /** `Content-Type` for the response (e.g. `'application/pdf'`). */
  contentType?: string;
  /** Filename for `Content-Disposition` (RFC 5987 / UTF-8 encoded). */
  filename?: string;
  /**
   * `Content-Disposition` type. Defaults to `'attachment'` when a `filename` is
   * set (a download), otherwise unset. Use `'inline'` to render in the browser
   * (e.g. images, PDFs) while still suggesting `filename`.
   */
  disposition?: 'inline' | 'attachment';
  /** HTTP status; defaults to the route's declared success status (or 200). */
  status?: number;
  /**
   * Extra response headers (e.g. `Cache-Control`, or `Content-Length` for a
   * stream). Applied last, so they override the headers zodec derives from
   * `contentType`/`filename`/`disposition`. Values may be strings or numbers.
   */
  headers?: Record<string, string | number>;
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
  /** `Content-Disposition` type (`'inline'`/`'attachment'`), if set. */
  public readonly disposition: 'inline' | 'attachment' | undefined;
  /** Explicit HTTP status, if set. */
  public readonly status: number | undefined;
  /** Extra response headers, applied last (override the derived ones). */
  public readonly headers: Record<string, string | number> | undefined;

  public constructor(body: Uint8Array | Readable, options: FileResponseOptions = {}) {
    this.body = body;
    this.contentType = options.contentType;
    this.filename = options.filename;
    this.disposition = options.disposition;
    this.status = options.status;
    this.headers = options.headers;
  }

  /** Builds a FileResponse that streams the file at `path` from disk. */
  public static fromPath(path: string, options?: FileResponseOptions): FileResponse {
    return new FileResponse(createReadStream(path), options);
  }
}
