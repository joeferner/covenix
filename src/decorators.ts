import type { ZodObject, ZodType } from 'zod';
import type { RequestHandler } from 'express';
import {
  addExample,
  addFileResponse,
  addMiddleware,
  addResponseHeaders,
  addResponseDescription,
  addReturnSchema,
  addSecurity,
  addSseResponse,
  setBodySchema,
  setCookiesSchema,
  setDeprecated,
  setDescription,
  setHeadersSchema,
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
 * Validates `req.headers` against the given Zod object before the handler runs,
 * and documents each property as an `in: header` OpenAPI parameter. The parsed
 * (coerced) values are what `@HeaderParam` injects. A failure responds `400`.
 *
 * Header names are case-insensitive and Node lower-cases them, so the schema's
 * keys must be lower-case (e.g. `'x-request-id'`). The reserved `authorization`,
 * `accept`, and `content-type` headers are still validated but omitted from the
 * generated OpenAPI parameters (the spec handles those elsewhere).
 *
 * @param schema - Zod object schema describing the request headers.
 */
export function Headers(schema: ZodObject): MethodDecorator {
  return (target, propertyKey) => {
    setHeadersSchema(target, String(propertyKey), schema);
  };
}

/**
 * Validates `req.cookies` against the given Zod object before the handler runs,
 * and documents each property as an `in: cookie` OpenAPI parameter. The parsed
 * (coerced) values are what `@CookieParam` injects. A failure responds `400`.
 *
 * avero reads `req.cookies`, so a cookie parser (e.g. `cookie-parser`) must be
 * installed as middleware ahead of the route; without it `req.cookies` is empty
 * and validation sees no cookies.
 *
 * @param schema - Zod object schema describing the request cookies.
 */
export function Cookies(schema: ZodObject): MethodDecorator {
  return (target, propertyKey) => {
    setCookiesSchema(target, String(propertyKey), schema);
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
 * Usable on a method or on the **controller class**, where it declares a *shared*
 * response merged into every route in the class (e.g. a common `401`/`422` error
 * shape) — a route's own `@Returns` for the same status overrides the shared one.
 *
 * @param status - HTTP status code, e.g. `200`.
 * @param schema - Zod schema for the response body; omit for no body.
 * @param options - Extra response metadata, e.g. `headers` or `description`.
 *
 * @example
 * ```ts
 * @Route('users')
 * @Returns(401, ErrorSchema)   // shared by every route in the controller
 * @Returns(422, ErrorSchema)
 * class UsersController {
 *   @Get('{id}')
 *   @Returns(200, UserSchema)
 *   @Returns(404, NotFoundSchema) // route-specific, on top of the shared ones
 *   get() {}
 * }
 * ```
 */
export function Returns(
  status: number,
  schema?: ZodType,
  options?: ReturnsOptions,
): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    // Class-level (no propertyKey) writes to the controller's shared responses;
    // the metadata setters branch on a `undefined` handler name.
    const handlerName = propertyKey === undefined ? undefined : String(propertyKey);
    const proto = propertyKey === undefined ? (target as { prototype: object }).prototype : target;
    addReturnSchema(proto, handlerName, status, schema);
    if (options?.headers) {
      addResponseHeaders(proto, handlerName, status, options.headers);
    }
    if (options?.description !== undefined) {
      addResponseDescription(proto, handlerName, status, options.description);
    }
  };
}

/**
 * Declares a binary/file response for a status code. Stackable. The handler
 * should return a `FileResponse` for this status (avero streams it); this
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

/** Options for {@link Sse}. */
export interface SseOptions {
  /** HTTP status for the stream response. Defaults to `200`. */
  status?: number;
  /**
   * Heartbeat interval in milliseconds. When set, avero sends a comment frame
   * (`: \n\n`) this often to keep idle connections alive through proxies.
   */
  keepAlive?: number;
}

/**
 * Declares the route as a **Server-Sent Events** (`text/event-stream`) stream.
 * The handler returns an `AsyncIterable` of events (typically an async
 * generator); avero sets the SSE headers, frames each yielded value as an event,
 * and on client disconnect calls the iterator's `return()` so the generator's
 * `finally` runs (cleanup/abort). Yield a plain value to emit a `data:` frame, or
 * a {@link import('./sse.js').SseEvent} to set `event`/`id`/`retry`.
 *
 * @param schema - Zod schema each event's data is validated against (and emitted
 *   in the OpenAPI `text/event-stream` response); omit for raw/string events.
 * @param options - Stream options (`status`, `keepAlive`).
 *
 * @example
 * ```ts
 * @Get('chat/{id}/stream')
 * @Sse(TokenSchema, { keepAlive: 15000 })
 * async *stream(@Param('id') id: string): AsyncGenerator<Token> {
 *   try { for await (const t of llm.stream(id)) yield t; }
 *   finally { /* runs on disconnect *\/ }
 * }
 * ```
 */
export function Sse(schema?: ZodType, options: SseOptions = {}): MethodDecorator {
  return (target, propertyKey) => {
    addSseResponse(target, String(propertyKey), options.status ?? 200, {
      eventSchema: schema,
      keepAlive: options.keepAlive,
    });
  };
}

/**
 * Declares a security requirement for the operation, matching a named scheme in
 * the `Avero` instance's `security` map. Before the handler runs, avero invokes
 * that scheme's handler; on success the principal is available via `@Principal()`.
 *
 * Usable on a method or on the controller class (applies to every route that
 * doesn't declare its own). **Stackable** — multiple `@Security` decorators are
 * alternatives (OR): the request is allowed if any one is satisfied.
 *
 * @param scheme - The security scheme name (a key in `new Avero({ security })`).
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
 * Attaches Express middleware to run before the handler — auth beyond
 * `@Security`, rate limiting, caching, logging, etc. Plain `RequestHandler`s, so
 * the whole Express ecosystem composes.
 *
 * Usable on a method or on the controller class (applies to every route).
 * Class-level runs first, then method-level, in source order. In the full chain
 * avero builds, `@Use` runs **after** `@Security` and **before** multipart parsing
 * (`security → @Use → multipart → handler`). Middleware that sends a response
 * (or doesn't call `next`) short-circuits — the handler won't run.
 *
 * @param middleware - One or more Express `RequestHandler`s.
 *
 * @example
 * ```ts
 * @Route('admin')
 * @Use(rateLimit({ max: 100 }))   // every route in the controller
 * class AdminController {
 *   @Delete('{id}')
 *   @Use(auditLog())              // just this route
 *   remove() {}
 * }
 * ```
 */
export function Use(...middleware: RequestHandler[]): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      addMiddleware((target as { prototype: object }).prototype, undefined, middleware);
    } else {
      addMiddleware(target, String(propertyKey), middleware);
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
