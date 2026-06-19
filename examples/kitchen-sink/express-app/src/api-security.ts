import createError from 'http-errors';
import type { Request } from 'express';
import type { SecuritySchemes } from 'zodec';
import type { AuthService } from './services/AuthService.js';

/**
 * The OpenAPI security scheme definitions — pure data, no handlers. Shared by the
 * running server (via {@link buildSecurity}) and the instance-free static swagger
 * generator (`generate-swagger-static.ts`), so the `components.securitySchemes`
 * both emit are guaranteed identical. Defining them here once is what lets the
 * static generator stay service-free while still producing a complete document.
 */
export const securitySchemes = {
  bearer: { type: 'http', scheme: 'bearer' },
} as const satisfies SecuritySchemes;

/**
 * Binds a runtime handler to each named scheme, reusing the {@link securitySchemes}
 * definitions above. Passed to `new Zodec({ security })`.
 *
 * The handler resolves the request to a principal (any value) or `null` for a
 * 401. Scopes are passed in and the handler decides what they mean — here a scope
 * is a required role, and a mismatch is a 403.
 */
export function buildSecurity(auth: AuthService) {
  return {
    bearer: {
      scheme: securitySchemes.bearer,
      handler: async (req: Request, scopes: string[]) => {
        const user = await auth.currentUser(req.headers.authorization);
        if (!user) {
          return null; // no/invalid token → 401
        }
        if (scopes.length > 0 && !scopes.includes(user.role)) {
          throw new createError.Forbidden(`Requires one of: ${scopes.join(', ')}`); // 403
        }
        return user; // becomes the @Principal()
      },
    },
  };
}
