import { z } from 'zod';
import createError from 'http-errors';
import {
  Route,
  Tags,
  Post,
  Get,
  Body,
  Returns,
  Summary,
  Example,
  Security,
  BodyParam,
  Cookies,
  CookieParam,
  Principal,
} from 'covenix';
import {
  LoginSchema,
  TokenSchema,
  UserSchema,
  ErrorSchema,
  type Login,
  type Token,
  type User,
} from '@kitchen-sink/schemas';
import type { AuthService } from '../services/AuthService.js';

const SessionResultSchema = z
  .object({ authenticated: z.boolean() })
  .meta({ id: 'SessionResult', description: 'Whether a session cookie was presented.' });

@Route('auth')
@Tags('Auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Summary('Exchange credentials for a bearer token')
  @Body(LoginSchema)
  @Example({ username: 'ada', password: 'correct-horse-battery' })
  @Returns(200, TokenSchema)
  @Example({ token: 'fake-token-for-ada', expiresIn: 3600 }, 200)
  @Returns(401, ErrorSchema)
  public async login(@BodyParam() creds: Login): Promise<Token> {
    const token = await this.auth.login(creds);
    if (!token) throw new createError.Unauthorized('Bad credentials');
    return token;
  }

  // @Security('bearer') runs the `bearer` handler (see api-security.ts) before the
  // handler. It rejects with 401 on a bad token, so `user` is always present — no
  // manual header parsing, and @Principal() injects whatever the handler returned.
  @Get('me')
  @Summary('Return the currently authenticated user')
  @Security('bearer')
  @Returns(200, UserSchema)
  @Returns(401, ErrorSchema)
  public me(@Principal() user: User): User {
    return user;
  }

  // @Cookies documents `sid` as an `in: cookie` parameter (and validates it);
  // @CookieParam injects the parsed value. covenix reads `req.cookies`, so a cookie
  // parser must run ahead of the route — see main.ts (`configure: cookieParser()`).
  @Get('session')
  @Summary('Report whether a session cookie is present')
  @Cookies(z.object({ sid: z.string().optional().describe('Session id cookie.') }))
  @Returns(200, SessionResultSchema)
  public session(@CookieParam('sid') sid: string | undefined): z.infer<typeof SessionResultSchema> {
    return { authenticated: sid !== undefined };
  }
}
