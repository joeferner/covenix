import { addParam } from './metadata.js';

/**
 * Injects `req.params[name]` as a handler argument. Resolves to the value parsed
 * by `@Params` when present, otherwise the raw string from Express.
 *
 * @param name - Path parameter name (must match the `{name}` in the route path).
 */
export function Param(name: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'param', name });
  };
}

/**
 * Injects `req.query[name]` as a handler argument. Resolves to the value parsed
 * by `@Query` when present, otherwise the raw (uncoerced) query value.
 *
 * @param name - Query string key.
 */
export function QueryParam(name: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'query', name });
  };
}

/**
 * Injects the request body (the value parsed by `@Body` when present, otherwise
 * the raw `req.body`). With a `name`, injects that single field of the parsed
 * body; with no `name`, the whole body.
 *
 * @param name - Optional body field to inject; omit for the whole body.
 */
export function BodyParam(name?: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'body', name });
  };
}

/**
 * Injects a single uploaded file from a `multipart/form-data` request as a
 * web-standard `File`. Pairs with a `z.file()` field in the `@Body` schema (its
 * presence is what makes the route multipart); the file is validated against
 * that schema's constraints before the handler runs.
 *
 * @param name - The form field name (an object key in the `@Body` schema).
 *
 * @example
 * ```ts
 * @Body(z.object({ avatar: z.file().max(2_000_000) }))
 * upload(@File('avatar') avatar: File) {}
 * ```
 */
export function File(name: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'body', name });
  };
}

/**
 * Injects multiple uploaded files from a `multipart/form-data` request as an
 * array of web-standard `File`s. Pairs with a `z.array(z.file())` field in the
 * `@Body` schema.
 *
 * @param name - The form field name (an object key in the `@Body` schema).
 */
export function Files(name: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'body', name });
  };
}

/**
 * Injects a request header value (`req.headers[name]`, case-insensitive) as a
 * handler argument.
 *
 * @param name - Header name, e.g. `'authorization'`.
 */
export function Header(name: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'header', name });
  };
}

/**
 * Injects the principal returned by the route's `@Security` handler (e.g. the
 * authenticated user). Only meaningful on a route guarded by `@Security`; on an
 * unguarded route it resolves to `undefined`.
 */
export function Principal(): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'principal' });
  };
}

/**
 * Escape hatch: injects the raw Express `Request` object as a handler argument.
 */
export function Req(): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'req' });
  };
}

/**
 * Escape hatch: injects the raw Express `Response` object. When a handler writes
 * to it, zodec skips its automatic JSON response.
 */
export function Res(): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'res' });
  };
}
