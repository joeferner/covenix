import type { Login, Token, User } from '@kitchen-sink/schemas';
import type { UserService } from './UserService.js';

const TOKEN_PREFIX = 'fake-token-for-';

/**
 * Toy auth — do NOT copy this. It exists only to give the `@Security('bearer')`
 * handler and the AuthController something to call.
 */
export class AuthService {
  constructor(private readonly users: UserService) {}

  public async login(creds: Login): Promise<Token | undefined> {
    const user = await this.users.findByUsername(creds.username);
    if (!user) return undefined;
    return { token: `${TOKEN_PREFIX}${creds.username}`, expiresIn: 3600 };
  }

  public async currentUser(authorization: string | undefined): Promise<User | undefined> {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const token = authorization.slice('Bearer '.length);
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    return this.users.findByUsername(token.slice(TOKEN_PREFIX.length));
  }
}
