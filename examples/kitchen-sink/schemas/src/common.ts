import { z } from 'zod';

/**
 * Shape covenix's ValidationError serializes to via `covenixErrorHandler()`.
 * Named so it shows up as `#/components/schemas/Error` in swagger.
 */
export const ErrorSchema = z
  .object({
    status: z.number().int(),
    errors: z.array(
      z.object({
        path: z.array(z.string()),
        message: z.string(),
      }),
    ),
  })
  .meta({ id: 'Error' });

/**
 * Reusable pagination query. `z.coerce` turns the raw string query params into
 * numbers, and `.default(...)` fills them in — exactly the coercion/defaulting
 * covenix applies before the handler runs.
 */
export const PaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .meta({ id: 'PaginationQuery' });

export type ErrorBody = z.infer<typeof ErrorSchema>;
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
