import type { ErrorRequestHandler } from 'express';
import type { ZodError } from 'zod';

/**
 * Raised when a request (or response) fails its Zod schema. zodec never sends a
 * response itself — it calls `next(err)` with this, so it travels the normal
 * Express error pipeline. Express's default error handler honors `status`, and
 * callers can match on it in their own middleware.
 */
export class ValidationError extends Error {
  /** HTTP status: `400` (params/query), `422` (body), or `500` (response). */
  public readonly status: number;
  /** The Zod issues describing what failed validation. */
  public readonly issues: ZodError['issues'];

  /**
   * @param status - HTTP status to associate with the failure.
   * @param issues - The Zod issues from the failed `safeParse`.
   */
  public constructor(status: number, issues: ZodError['issues']) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.status = status;
    this.issues = issues;
  }
}

/**
 * Raised when a request fails authentication/authorization (`@Security`). zodec
 * throws this with `401` when a security handler returns `null`/`undefined`; a
 * handler can throw it directly (e.g. `new SecurityError(403, 'Forbidden')`) for
 * authenticated-but-not-authorized. Like {@link ValidationError}, it travels the
 * normal Express error pipeline.
 */
export class SecurityError extends Error {
  /** HTTP status: `401` (unauthenticated) or `403` (forbidden). */
  public readonly status: number;

  /**
   * @param status - HTTP status to associate with the failure (defaults to `401`).
   * @param message - Human-readable message (defaults to `'Unauthorized'`).
   */
  public constructor(status = 401, message = 'Unauthorized') {
    super(message);
    this.name = 'SecurityError';
    this.status = status;
  }
}

/** Options for {@link zodecErrorHandler}. */
export interface ZodecErrorHandlerOptions {
  /**
   * Maps a {@link ValidationError} to the response body. Defaults to the
   * standard `{ status, errors: [{ path, message }] }` shape.
   */
  formatError?: (error: ValidationError) => unknown;
}

/** The default response body for a {@link ValidationError}. */
function defaultFormat(error: ValidationError): unknown {
  return {
    status: error.status,
    errors: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  };
}

/**
 * Optional convenience Express error middleware. Renders a {@link ValidationError}
 * (by default as `{ status, errors: [{ path, message }] }`, or via a custom
 * `formatError`) and passes every other error through untouched, so it composes
 * with a caller's own handlers. You are never required to use it — handle
 * `ValidationError` yourself if you want full control.
 *
 * @param options - Optional `formatError` override.
 * @returns An Express error-handling middleware.
 */
export function zodecErrorHandler(options: ZodecErrorHandlerOptions = {}): ErrorRequestHandler {
  const format = options.formatError ?? defaultFormat;
  return (err, _req, res, next) => {
    if (err instanceof ValidationError) {
      res.status(err.status).json(format(err));
      return;
    }
    if (err instanceof SecurityError) {
      res.status(err.status).json({ status: err.status, message: err.message });
      return;
    }
    next(err);
  };
}
