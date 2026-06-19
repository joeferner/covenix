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
 * Injects the whole request body as a handler argument — the value parsed by
 * `@Body` when present, otherwise the raw `req.body`.
 */
export function BodyParam(): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'body' });
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
