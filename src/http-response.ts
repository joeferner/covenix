import { ResponseBase, type ResponseBaseOptions } from './response.js';

/** Options for an {@link HttpResponse}. */
export type HttpResponseOptions = ResponseBaseOptions;

/**
 * A JSON response that carries HTTP metadata — status, headers, cookies —
 * alongside the body, so a handler can set them by **returning a value** instead
 * of reaching for the raw Express `res` via `@Res()`. The body is still validated
 * and serialized against the matched `@Returns` schema, exactly like a bare
 * return; this only adds the surrounding metadata.
 *
 * Returning one is opt-in: a handler may return `T` **or** `HttpResponse<T>`.
 *
 * - **`status`** selects which declared `@Returns` to send (must be one of them);
 *   defaults to the route's success status.
 * - **`headers`** are set on the response; a header matching a declared
 *   `@Returns(..., { headers })` schema is validated against it, and numbers are
 *   stringified. Undeclared headers are allowed.
 * - **`cookies`** are emitted as `Set-Cookie` (Express does the formatting).
 *
 * @example
 * ```ts
 * @Get('me')
 * @Returns(200, UserSchema, { headers: { 'X-RateLimit-Remaining': z.number().int() } })
 * me(@Principal() user: User): HttpResponse<User> {
 *   return new HttpResponse(user, {
 *     headers: { 'X-RateLimit-Remaining': 42 }, // → "42"
 *     cookies: [{ name: 'sid', value: token, options: { httpOnly: true, sameSite: 'lax' } }],
 *   });
 * }
 * ```
 */
export class HttpResponse<T = unknown> extends ResponseBase {
  /** The response body — validated/serialized against the matched `@Returns` schema. */
  public readonly body: T;

  public constructor(body: T, options: HttpResponseOptions = {}) {
    super(options);
    this.body = body;
  }
}
