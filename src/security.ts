import type { Request } from 'express';
import type { OpenAPIV3_1 } from 'openapi-types';

/** An OpenAPI security scheme definition (the `components.securitySchemes` value). */
export type SecuritySchemeObject = OpenAPIV3_1.SecuritySchemeObject;

/** A map of named OpenAPI security scheme definitions. */
export type SecuritySchemes = Record<string, SecuritySchemeObject>;

/**
 * Runtime authentication for a scheme. Receives the request and the scopes the
 * route requires for this scheme, and resolves to the **principal** (any value —
 * injected via `@Principal()`). Returning `null`/`undefined` rejects the request
 * as `401`; throwing rejects with that error (e.g. a `403` for insufficient
 * scope). The handler owns the scope check.
 */
export type SecurityHandler = (req: Request, scopes: string[]) => unknown | Promise<unknown>; // eslint-disable-line @typescript-eslint/no-redundant-type-constituents -- keep `Promise<unknown>` visible to document that async handlers are supported (covenix awaits the result)

/** A named security scheme: its OpenAPI definition plus the runtime handler. */
export interface SecurityScheme {
  /** The OpenAPI scheme definition, emitted under `components.securitySchemes`. */
  scheme: SecuritySchemeObject;
  /** The runtime authentication handler. */
  handler: SecurityHandler;
}

/** The `security` map passed to `new Covenix({ security })`, keyed by scheme name. */
export type SecurityConfig = Record<string, SecurityScheme>;

/** Options for the {@link bearer} builder. */
export interface BearerOptions {
  /** OpenAPI `bearerFormat` hint (e.g. `'JWT'`). */
  bearerFormat?: string;
}

/**
 * Builds an HTTP **bearer** security scheme (`Authorization: Bearer <token>`).
 *
 * @param handler - Resolves the request to a principal, or `null` for `401`.
 * @param options - Optional `bearerFormat` hint for the OpenAPI document.
 *
 * @example
 * ```ts
 * new Covenix({ info, security: { bearerAuth: bearer((req) => verifyJwt(req)) } });
 * ```
 */
export function bearer(handler: SecurityHandler, options: BearerOptions = {}): SecurityScheme {
  return {
    scheme: {
      type: 'http',
      scheme: 'bearer',
      ...(options.bearerFormat ? { bearerFormat: options.bearerFormat } : {}),
    },
    handler,
  };
}

/**
 * Builds an HTTP **basic** security scheme (`Authorization: Basic <base64>`).
 *
 * @param handler - Resolves the request to a principal, or `null` for `401`.
 */
export function basic(handler: SecurityHandler): SecurityScheme {
  return { scheme: { type: 'http', scheme: 'basic' }, handler };
}

/**
 * Builds an **API key** security scheme read from a header, query param, or cookie.
 *
 * @param location - Where the key is sent (`in`) and under what `name`.
 * @param handler - Resolves the request to a principal, or `null` for `401`.
 *
 * @example
 * ```ts
 * apiKey({ in: 'header', name: 'X-API-Key' }, (req) => lookupKey(req));
 * ```
 */
export function apiKey(
  location: { in: 'header' | 'query' | 'cookie'; name: string },
  handler: SecurityHandler,
): SecurityScheme {
  return { scheme: { type: 'apiKey', in: location.in, name: location.name }, handler };
}

/**
 * Builds an **OAuth2** security scheme.
 *
 * @param flows - The OAuth2 flows object (implicit/password/clientCredentials/authorizationCode).
 * @param handler - Resolves the request to a principal, or `null` for `401`.
 */
export function oauth2(
  flows: OpenAPIV3_1.OAuth2SecurityScheme['flows'],
  handler: SecurityHandler,
): SecurityScheme {
  return { scheme: { type: 'oauth2', flows }, handler };
}
