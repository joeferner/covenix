import createError from 'http-errors';
import { Route, Tags, Post, Get, Body, Returns, Summary, BodyParam, Header } from 'zodec';
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

@Route('auth')
@Tags('Auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Summary('Exchange credentials for a bearer token')
  @Body(LoginSchema)
  @Returns(200, TokenSchema)
  @Returns(401, ErrorSchema)
  public async login(@BodyParam() creds: Login): Promise<Token> {
    const token = await this.auth.login(creds);
    if (!token) throw new createError.Unauthorized('Bad credentials');
    return token;
  }

  @Get('me')
  @Summary('Return the currently authenticated user')
  @Returns(200, UserSchema)
  @Returns(401, ErrorSchema)
  public async me(@Header('authorization') authorization: string | undefined): Promise<User> {
    const user = await this.auth.currentUser(authorization);
    if (!user) throw new createError.Unauthorized();
    return user;
  }
}
