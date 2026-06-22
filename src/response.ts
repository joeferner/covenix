import type { CookieOptions } from 'express';

/**
 * A response header value: a string or number, or an **array** of them for a
 * header that may legitimately appear more than once (e.g. `Set-Cookie`, `Link`,
 * `Vary`). Numbers are stringified; an array emits the header once per element.
 * For cookies, prefer the `cookies` option, which formats them for you.
 */
export type HeaderValue = string | number | ReadonlyArray<string | number>;

/**
 * A cookie to set on the response. Each cookie becomes its own `Set-Cookie`
 * header, so multiple cookies coexist. Express handles the formatting.
 */
export interface ResponseCookie {
  /** Cookie name. */
  name: string;
  /** Cookie value (Express URL-encodes it). */
  value: string;
  /** Express cookie options (`maxAge`, `httpOnly`, `secure`, `sameSite`, `signed`, …). */
  options?: CookieOptions;
}

/** Options common to every covenix response envelope ({@link ResponseBase}). */
export interface ResponseBaseOptions {
  /**
   * Explicit HTTP status. Defaults to the route's declared success status (the
   * first 2xx `@Returns`, or 200). When set, it must match one of the route's
   * declared `@Returns` statuses.
   */
  status?: number;
  /**
   * Extra response headers. Values may be strings, numbers, or arrays of them
   * (an array repeats the header). A header that matches a
   * `@Returns(..., { headers })` schema is validated against it; undeclared
   * headers are allowed.
   */
  headers?: Record<string, HeaderValue>;
  /**
   * Cookies to set, each emitted as its own `Set-Cookie` header. Express formats
   * them (encoding, `Max-Age`, `SameSite`, signing, …) — so you don't build the
   * header string yourself.
   */
  cookies?: ResponseCookie[];
}

/**
 * Base class for covenix's value-style responses — return one from a handler to
 * describe the response declaratively (status, headers, cookies, …) instead of
 * mutating the raw Express `res`. The concrete subclasses are {@link HttpResponse}
 * (a JSON/validated body), and `FileResponse` / `RangeFileResponse` (binary
 * bodies).
 *
 * covenix detects these by `instanceof`, so returning one is always opt-in — a bare
 * return value is sent (and validated) exactly as before.
 */
export abstract class ResponseBase {
  /** Explicit HTTP status, if set. */
  public readonly status: number | undefined;
  /** Extra response headers, if set. */
  public readonly headers: Record<string, HeaderValue> | undefined;
  /** Cookies to set (each its own `Set-Cookie`), if any. */
  public readonly cookies: ResponseCookie[] | undefined;

  protected constructor(options: ResponseBaseOptions = {}) {
    this.status = options.status;
    this.headers = options.headers;
    this.cookies = options.cookies;
  }
}
