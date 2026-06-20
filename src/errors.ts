import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler } from 'express';
import type { ZodError } from 'zod';

/**
 * Base class for the errors zodec raises. Carries the HTTP `status`; subclasses
 * add detail. zodec never sends a response itself — it calls `next(err)`, so
 * these travel the normal Express error pipeline (Express's default handler
 * honors `status`, and callers can match on `ZodecError` in their own middleware).
 */
export class ZodecError extends Error {
  /** HTTP status to associate with the failure. */
  public readonly status: number;

  /**
   * @param status - HTTP status to associate with the failure.
   * @param message - Human-readable message.
   */
  public constructor(status: number, message: string) {
    super(message);
    this.name = 'ZodecError';
    this.status = status;
  }
}

/**
 * Raised when a request (or response) fails its Zod schema. `400` for
 * params/query, `422` for body, `500` for a response that violates its `@Returns`
 * schema.
 */
export class ValidationError extends ZodecError {
  /** The Zod issues describing what failed validation. */
  public readonly issues: ZodError['issues'];

  /**
   * @param status - HTTP status to associate with the failure.
   * @param issues - The Zod issues from the failed `safeParse`.
   */
  public constructor(status: number, issues: ZodError['issues']) {
    super(status, 'Validation failed');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * Raised when a request fails authentication/authorization (`@Security`). zodec
 * throws this with `401` when a security handler returns `null`/`undefined`; a
 * handler can throw it directly (e.g. `new SecurityError(403, 'Forbidden')`) for
 * authenticated-but-not-authorized.
 */
export class SecurityError extends ZodecError {
  /**
   * @param status - HTTP status to associate with the failure (defaults to `401`).
   * @param message - Human-readable message (defaults to `'Unauthorized'`).
   */
  public constructor(status = 401, message = 'Unauthorized') {
    super(status, message);
    this.name = 'SecurityError';
  }
}

/**
 * An [RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457) Problem Details
 * object — the default error body zodec emits (`application/problem+json`).
 */
export interface ProblemDetails {
  /** A URI identifying the problem type; `'about:blank'` means "see `title`". */
  type: string;
  /** Short, human-readable summary — the HTTP status reason phrase by default. */
  title: string;
  /** HTTP status code. */
  status: number;
  /** Human-readable explanation, when it adds information beyond `title`. */
  detail?: string;
  /**
   * Field-level validation errors (an RFC 9457 extension member). Present for
   * {@link ValidationError}.
   */
  errors?: { path: PropertyKey[]; message: string }[];
}

/** Options for {@link zodecErrorHandler}. */
export interface ZodecErrorHandlerOptions {
  /**
   * Overrides the response body for a {@link ZodecError}. When provided, the
   * response is sent as `application/json` (rather than the default
   * `application/problem+json`), since the body is no longer Problem-shaped.
   */
  formatError?: (error: ZodecError) => unknown;
}

/** Builds the default RFC 9457 Problem Details body for a {@link ZodecError}. */
function defaultProblem(error: ZodecError): ProblemDetails {
  const title = STATUS_CODES[error.status] ?? 'Error';
  const problem: ProblemDetails = { type: 'about:blank', title, status: error.status };
  if (error instanceof ValidationError) {
    problem.errors = error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
  } else if (error.message && error.message !== title) {
    problem.detail = error.message;
  }
  return problem;
}

/**
 * Optional convenience Express error middleware. Renders a {@link ZodecError}
 * (`ValidationError`/`SecurityError`) as an [RFC 9457](https://datatracker.ietf.org/doc/html/rfc9457)
 * Problem Details object with `Content-Type: application/problem+json`, and
 * passes every other error through untouched so it composes with a caller's own
 * handlers. You are never required to use it — match on `ZodecError` yourself for
 * full control.
 *
 * @param options - Optional `formatError` override (switches the body to
 *   `application/json`).
 * @returns An Express error-handling middleware.
 */
export function zodecErrorHandler(options: ZodecErrorHandlerOptions = {}): ErrorRequestHandler {
  const { formatError } = options;
  return (err, _req, res, next) => {
    if (!(err instanceof ZodecError)) {
      next(err);
      return;
    }
    if (formatError) {
      // Caller-defined shape — not necessarily Problem-shaped, so plain JSON.
      res.status(err.status).json(formatError(err));
      return;
    }
    res.status(err.status).type('application/problem+json').json(defaultProblem(err));
  };
}
