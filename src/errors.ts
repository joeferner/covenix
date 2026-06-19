import type { ErrorRequestHandler } from 'express';
import type { ZodError } from 'zod';

// Raised when a request (or response) fails its Zod schema. zodec never sends a
// response itself — it calls next(err) with this, so it travels the normal
// Express error pipeline. Express's default error handler honors `status`, and
// callers can match on it in their own middleware.
export class ValidationError extends Error {
  public readonly status: number;
  public readonly issues: ZodError['issues'];

  public constructor(status: number, issues: ZodError['issues']) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.status = status;
    this.issues = issues;
  }
}

export interface ZodecErrorHandlerOptions {
  // Maps a ValidationError to the response body. Defaults to the standard
  // `{ status, errors: [{ path, message }] }` shape.
  formatError?: (error: ValidationError) => unknown;
}

// The default response body for a ValidationError.
function defaultFormat(error: ValidationError): unknown {
  return {
    status: error.status,
    errors: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  };
}

// Optional convenience error middleware. Renders a zodec ValidationError (by
// default as `{ status, errors: [{ path, message }] }`, or via a custom
// `formatError`) and passes everything else through untouched, so it composes
// with a caller's own handlers. You are never required to use it — handle
// ValidationError yourself if you want full control.
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
