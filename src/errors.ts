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

// Optional convenience error middleware. Renders a zodec ValidationError as
// `{ status, errors: [{ path, message }] }` and passes everything else through
// untouched, so it composes with a caller's own handlers. You are never required
// to use it — handle ValidationError yourself if you want a different shape.
export function zodecErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (err instanceof ValidationError) {
      res.status(err.status).json({
        status: err.status,
        errors: err.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
      return;
    }
    next(err);
  };
}
