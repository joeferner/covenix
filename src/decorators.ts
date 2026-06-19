import type { ZodObject, ZodType } from 'zod';
import {
  addReturnSchema,
  setBodySchema,
  setHttpMethod,
  setParamsSchema,
  setPrefix,
  setQuerySchema,
  setSummary,
  setTags,
  type HttpMethod,
} from './metadata.js';

function httpMethodDecorator(method: HttpMethod, path = ''): MethodDecorator {
  return (target, propertyKey) => {
    setHttpMethod(target, String(propertyKey), method, path);
  };
}

/**
 * Class decorator that sets the path prefix prepended to every route in the
 * controller.
 *
 * @param prefix - Path segment for the controller, e.g. `'users'`.
 *
 * @example
 * ```ts
 * @Route('users')
 * class UsersController {}
 * ```
 */
export function Route(prefix: string): ClassDecorator {
  return (target) => {
    setPrefix(target.prototype as object, prefix);
  };
}

/**
 * Class decorator that assigns OpenAPI tags to every operation in the
 * controller.
 *
 * @param tags - One or more tag names for grouping operations in swagger.
 */
export function Tags(...tags: string[]): ClassDecorator {
  return (target) => {
    setTags(target.prototype as object, tags);
  };
}

/**
 * Maps the decorated method to an HTTP `GET` route.
 *
 * @param path - Sub-path appended to the controller prefix. Use `{name}` for
 *   path parameters (e.g. `'{id}'`). Defaults to the prefix itself.
 */
export const Get = (path = ''): MethodDecorator => httpMethodDecorator('get', path);
/** Maps the decorated method to an HTTP `POST` route. See {@link Get}. */
export const Post = (path = ''): MethodDecorator => httpMethodDecorator('post', path);
/** Maps the decorated method to an HTTP `PUT` route. See {@link Get}. */
export const Put = (path = ''): MethodDecorator => httpMethodDecorator('put', path);
/** Maps the decorated method to an HTTP `PATCH` route. See {@link Get}. */
export const Patch = (path = ''): MethodDecorator => httpMethodDecorator('patch', path);
/** Maps the decorated method to an HTTP `DELETE` route. See {@link Get}. */
export const Delete = (path = ''): MethodDecorator => httpMethodDecorator('delete', path);

/**
 * Validates `req.params` against the given Zod object before the handler runs.
 * Parsed (coerced) values are what `@Param` injects. A failure responds `400`.
 *
 * @param schema - Zod object schema describing the path parameters.
 */
export function Params(schema: ZodObject): MethodDecorator {
  return (target, propertyKey) => {
    setParamsSchema(target, String(propertyKey), schema);
  };
}

/**
 * Validates `req.query` against the given Zod object before the handler runs.
 * Parsed (coerced) values are what `@QueryParam` injects. A failure responds `400`.
 *
 * @param schema - Zod object schema describing the query string.
 */
export function Query(schema: ZodObject): MethodDecorator {
  return (target, propertyKey) => {
    setQuerySchema(target, String(propertyKey), schema);
  };
}

/**
 * Validates `req.body` against the given Zod schema before the handler runs.
 * The parsed value is what `@BodyParam` injects. A failure responds `422`.
 *
 * @param schema - Zod schema describing the request body.
 */
export function Body(schema: ZodType): MethodDecorator {
  return (target, propertyKey) => {
    setBodySchema(target, String(propertyKey), schema);
  };
}

/**
 * Declares a response for a status code. Stackable — apply once per status. The
 * handler's return value is validated against the matching schema (a mismatch
 * responds `500`), and the schema is emitted in the generated OpenAPI document.
 *
 * @param status - HTTP status code, e.g. `200`.
 * @param schema - Zod schema describing the response body for that status.
 */
export function Returns(status: number, schema: ZodType): MethodDecorator {
  return (target, propertyKey) => {
    addReturnSchema(target, String(propertyKey), status, schema);
  };
}

/**
 * Sets the operation's `summary` in the generated OpenAPI document.
 *
 * @param text - Human-readable one-line summary of the operation.
 */
export function Summary(text: string): MethodDecorator {
  return (target, propertyKey) => {
    setSummary(target, String(propertyKey), text);
  };
}
