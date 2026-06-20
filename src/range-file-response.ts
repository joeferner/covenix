import type { Readable } from 'node:stream';
import type { FileResponseOptions } from './file-response.js';
import { ResponseBase } from './response.js';

/** An inclusive byte range, as requested by an HTTP `Range` header. */
export interface ByteRange {
  /** First byte index (inclusive). */
  start: number;
  /** Last byte index (inclusive). */
  end: number;
}

/**
 * Produces the response body as a stream: the whole body when called with no
 * argument, or just `range` when given one. Used for large/remote sources (e.g.
 * object storage, a big file) that can serve a byte slice on demand.
 */
export type RangeStreamSource = (range?: ByteRange) => Readable | Promise<Readable>;

/** A streamed, range-capable body: its total `size` plus a range-aware source. */
export interface RangeStreamBody {
  /** Total size of the body in bytes (needed to compute `Content-Range`). */
  size: number;
  /** Returns a stream of the full body, or of `range` when one is given. */
  stream: RangeStreamSource;
}

/** A disk-backed body served via Express `res.sendFile` (built by {@link RangeFileResponse.fromPath}). */
export interface RangePathBody {
  /** Path to the file on disk (resolved to absolute before sending). */
  path: string;
}

/** The bodies a {@link RangeFileResponse} can carry — all range-capable by construction. */
export type RangeBody = Uint8Array | RangeStreamBody | RangePathBody;

/**
 * A range-capable binary response. Where {@link FileResponse} sends a body
 * whole, `RangeFileResponse` **guarantees HTTP `Range` support**: its body type
 * is narrowed to sources zodec can serve a byte slice from, so a non-seekable
 * stream simply isn't assignable. Returning one is the opt-in — zodec advertises
 * `Accept-Ranges: bytes` and emits `206 Partial Content` for a single satisfiable
 * range, `416 Range Not Satisfiable` for an unsatisfiable one, and a full `200`
 * for a multi-range or malformed request.
 *
 * - **`Uint8Array`** — size is intrinsic; zodec slices the bytes.
 * - **`{ size, stream }`** — a range-aware source; zodec calls `stream(range)`.
 * - **`fromPath(path)`** — a disk file served via Express, which additionally
 *   honors conditional GET (`ETag` / `If-Modified-Since` / `If-Range`).
 *
 * Shares the {@link FileResponseOptions} of `FileResponse` (`contentType`,
 * `filename`, `disposition`, `headers`, `status`).
 *
 * @example
 * ```ts
 * @Get('{id}/avatar/raw')
 * @ReturnsFile(200)
 * async avatar(@Param('id') id: string): Promise<RangeFileResponse> {
 *   const { bytes, contentType } = await store.get(id);
 *   return new RangeFileResponse(bytes, { contentType, disposition: 'inline' });
 * }
 * ```
 */
export class RangeFileResponse extends ResponseBase {
  /** The range-capable body (bytes, a stream source, or a disk path). */
  public readonly body: RangeBody;
  /** `Content-Type` for the response, if set. */
  public readonly contentType: string | undefined;
  /** Download filename for `Content-Disposition`, if set. */
  public readonly filename: string | undefined;
  /** `Content-Disposition` type (`'inline'`/`'attachment'`), if set. */
  public readonly disposition: 'inline' | 'attachment' | undefined;

  public constructor(body: Uint8Array | RangeStreamBody, options: FileResponseOptions = {}) {
    super(options);
    this.body = body;
    this.contentType = options.contentType;
    this.filename = options.filename;
    this.disposition = options.disposition;
  }

  /**
   * Builds a range response backed by a file on disk, served via Express
   * `res.sendFile` — so it honors `Range` **and** conditional GET (`ETag` /
   * `If-Modified-Since` / `If-Range`) automatically.
   *
   * @param path - Path to the file (resolved to absolute before sending).
   * @param options - Content type / disposition / headers / status overrides.
   */
  public static fromPath(path: string, options: FileResponseOptions = {}): RangeFileResponse {
    const instance = new RangeFileResponse(new Uint8Array(), options);
    // The public constructor only admits buffer/stream bodies; assign the path
    // body internally (this is the one sanctioned way to create one).
    (instance as { body: RangeBody }).body = { path };
    return instance;
  }
}
