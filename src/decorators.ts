import type { ZodObject, ZodType } from 'zod';
import {
  addExample,
  addFileResponse,
  addResponseHeaders,
  addResponseDescription,
  addReturnSchema,
  addSecurity,
  setBodySchema,
  setDeprecated,
  setDescription,
  setHttpMethod,
  setOperationId,
  setParamsSchema,
  setPrefix,
  setQuerySchema,
  setSummary,
  setTags,
  type HttpMethod,
} from './metadata.js';

/** Options for {@link Returns}. */
export interface ReturnsOptions {
  /**
   * Response headers, keyed by header name → Zod schema. Documented in the
   * OpenAPI `responses[status].headers` (not validated at runtime).
   */
  headers?: Record<string, ZodType>;
  /** Response description for the OpenAPI `responses[status].description`. */
  description?: string;
}

/** Options for {@link ReturnsFile}. */
export interface ReturnsFileOptions {
  /**
   * Media type advertised in the OpenAPI document. Defaults to
   * `application/octet-stream`; the runtime `Content-Type` (from the returned
   * `FileResponse`) can differ.
   */
  contentType?: string;
  /** Response description for the OpenAPI document. */
  description?: string;
}

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
 * Omit `schema` for a no-body response (e.g. `@Returns(204)`).
 *
 * @param status - HTTP status code, e.g. `200`.
 * @param schema - Zod schema for the response body; omit for no body.
 * @param options - Extra response metadata, e.g. `headers` or `description`.
 *
 * @example
 * ```ts
 * @Returns(200, UserListSchema, {
 *   description: 'A page of users',
 *   headers: { 'X-Total-Count': z.number().int() },
 * })
 * ```
 */
export function Returns(
  status: number,
  schema?: ZodType,
  options?: ReturnsOptions,
): MethodDecorator {
  return (target, propertyKey) => {
    addReturnSchema(target, String(propertyKey), status, schema);
    if (options?.headers) {
      addResponseHeaders(target, String(propertyKey), status, options.headers);
    }
    if (options?.description !== undefined) {
      addResponseDescription(target, String(propertyKey), status, options.description);
    }
  };
}

/**
 * Declares a binary/file response for a status code. Stackable. The handler
 * should return a `FileResponse` for this status (zodec streams it); this
 * decorator only advertises the binary body in the generated OpenAPI document
 * (`{ type: 'string', format: 'binary' }`).
 *
 * @param status - HTTP status code, e.g. `200`.
 * @param options - Media type / description for the OpenAPI document.
 */
export function ReturnsFile(status: number, options: ReturnsFileOptions = {}): MethodDecorator {
  return (target, propertyKey) => {
    addFileResponse(target, String(propertyKey), status, {
      contentType: options.contentType ?? 'application/octet-stream',
      description: options.description,
    });
  };
}

/**
 * Declares a security requirement for the operation, matching a named scheme in
 * the `Zodec` instance's `security` map. Before the handler runs, zodec invokes
 * that scheme's handler; on success the principal is available via `@Principal()`.
 *
 * Usable on a method or on the controller class (applies to every route that
 * doesn't declare its own). **Stackable** — multiple `@Security` decorators are
 * alternatives (OR): the request is allowed if any one is satisfied.
 *
 * @param scheme - The security scheme name (a key in `new Zodec({ security })`).
 * @param scopes - Scopes the route requires for this scheme (passed to the handler).
 *
 * @example
 * ```ts
 * @Security('bearerAuth', ['users:write'])
 * @Security('apiKey')            // OR: either satisfies the route
 * deleteUser() {}
 * ```
 */
export function Security(scheme: string, scopes: string[] = []): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      // Class decorator: store on the prototype, where getRoutes reads it.
      addSecurity((target as { prototype: object }).prototype, undefined, { scheme, scopes });
    } else {
      addSecurity(target, String(propertyKey), { scheme, scopes });
    }
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

/**
 * Sets the operation's `description` in the generated OpenAPI document — the
 * longer prose shown beneath the summary (CommonMark is allowed).
 *
 * @param text - Description of the operation.
 */
export function Description(text: string): MethodDecorator {
  return (target, propertyKey) => {
    setDescription(target, String(propertyKey), text);
  };
}

/**
 * Sets the operation's `operationId` — a unique identifier used by client/code
 * generators to name the generated method.
 *
 * @param id - Unique operation id (must be unique across the whole document).
 */
export function OperationId(id: string): MethodDecorator {
  return (target, propertyKey) => {
    setOperationId(target, String(propertyKey), id);
  };
}

/**
 * Marks the operation as `deprecated` in the generated OpenAPI document. The
 * route still works; tools render it struck through.
 */
export function Deprecated(): MethodDecorator {
  return (target, propertyKey) => {
    setDeprecated(target, String(propertyKey));
  };
}

/**
 * Attaches an example value to the operation's OpenAPI media type. Stackable.
 * With no `status` the example illustrates the request body (pairs with
 * `@Body`); with a `status` it illustrates that response (pairs with
 * `@Returns`).
 *
 * @param value - The example value (not validated against the schema).
 * @param status - Response status to attach to; omit for the request body.
 *
 * @example
 * ```ts
 * @Body(CreateUserSchema)
 * @Example({ username: 'ada' })
 * @Returns(201, UserSchema)
 * @Example({ id: '...', username: 'ada' }, 201)
 * createUser() {}
 * ```
 */
export function Example(value: unknown, status?: number): MethodDecorator {
  return (target, propertyKey) => {
    addExample(target, String(propertyKey), status === undefined ? { value } : { status, value });
  };
}
