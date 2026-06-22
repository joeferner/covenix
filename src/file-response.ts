import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { ResponseBase, type ResponseBaseOptions } from './response.js';

/**
 * Options for a {@link FileResponse}. Inherits `status`/`headers`/`cookies` from
 * {@link ResponseBaseOptions}; the inherited `headers` are applied last, so they
 * override the headers covenix derives from `contentType`/`filename`/`disposition`.
 */
export interface FileResponseOptions extends ResponseBaseOptions {
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
}

/**
 * A non-JSON response: a binary body (a `Uint8Array`/`Buffer` or a `Readable`
 * stream) that covenix streams to the client, setting `Content-Type` and
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
export class FileResponse extends ResponseBase {
  /** The response body — raw bytes or a readable stream. */
  public readonly body: Uint8Array | Readable;
  /** `Content-Type` for the response, if set. */
  public readonly contentType: string | undefined;
  /** Download filename for `Content-Disposition`, if set. */
  public readonly filename: string | undefined;
  /** `Content-Disposition` type (`'inline'`/`'attachment'`), if set. */
  public readonly disposition: 'inline' | 'attachment' | undefined;

  public constructor(body: Uint8Array | Readable, options: FileResponseOptions = {}) {
    super(options);
    this.body = body;
    this.contentType = options.contentType;
    this.filename = options.filename;
    this.disposition = options.disposition;
  }

  /** Builds a FileResponse that streams the file at `path` from disk. */
  public static fromPath(path: string, options?: FileResponseOptions): FileResponse {
    return new FileResponse(createReadStream(path), options);
  }
}
