import { addParam, type ParamContext } from './metadata.js';

/**
 * Where the resolved `@Security` principal is stashed on the request (set by
 * zodec's security middleware, read by {@link Principal}). Exported for internal
 * use across modules.
 *
 * @internal
 */
export const ZODEC_PRINCIPAL = Symbol('zodec:principal');

/**
 * Builds a custom parameter decorator from a resolver. The resolver runs at
 * request time with the {@link ParamContext} (`{ req, res }`) plus any `data`
 * passed where the decorator is applied, and may be **sync or async** — its
 * resolved value is injected as the handler argument. This is the extension point
 * for injecting values the built-in decorators don't cover (a cookie, `req.ip`, a
 * tenant resolved from a header, an awaited per-request value). A resolver that
 * throws is routed through the normal error pipeline (so `throw createError.X()`
 * picks the status).
 *
 * Type safety note: TypeScript's legacy parameter decorators can't constrain the
 * annotated parameter type, so (as with `@Principal()`) the handler's parameter
 * type is developer-asserted — keep it in sync with the resolver's return type.
 *
 * @param resolve - Computes the value from `{ req, res }` and the decorator `data`.
 * @returns A decorator factory; call it (optionally with `data`) on a parameter.
 *
 * @example
 * ```ts
 * const ClientIp = createParamDecorator(({ req }) => req.ip);
 * const Cookie = createParamDecorator(({ req }, name: string) => req.cookies?.[name]);
 *
 * @Get()
 * handler(@ClientIp() ip: string | undefined, @Cookie('sid') sid: string | undefined) {}
 * ```
 */
export function createParamDecorator<T, D = undefined>(
  resolve: (ctx: ParamContext, data: D) => T | Promise<T>,
): (data?: D) => ParameterDecorator {
  return (data?: D) => (target, propertyKey, index) => {
    addParam(target, String(propertyKey), {
      index,
      source: 'custom',
      resolve: (ctx) => resolve(ctx, data as D),
    });
  };
}

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
 * unguarded route it resolves to `undefined`. Built on {@link createParamDecorator}
 * — it's the canonical example of a custom injected value.
 */
export const Principal = createParamDecorator(
  ({ req }) => (req as unknown as Record<symbol, unknown>)[ZODEC_PRINCIPAL],
);

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
