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
    next(err);
  };
}
