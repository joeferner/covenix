import createError from 'http-errors';
import type { CreateUser, UpdateUser, User, UserList } from '@kitchen-sink/schemas';

/**
 * A fake in-memory store. A real app would inject a database client here — the
 * point is that zodec doesn't care: you own construction and DI, and pass the
 * built instance to `api.register(new UsersController(userService))`.
 */
export class UserService {
  private readonly users = new Map<string, User>();
  private readonly avatars = new Map<string, { bytes: Uint8Array; contentType: string }>();

  public async list(page: number, limit: number): Promise<UserList> {
    const all = [...this.users.values()];
    const start = (page - 1) * limit;
    return {
      items: all.slice(start, start + limit),
      page,
      limit,
      total: all.length,
    };
  }

  public async findById(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  public async findByUsername(username: string): Promise<User | undefined> {
    return [...this.users.values()].find((u) => u.username === username);
  }

  public async create(input: CreateUser): Promise<User> {
    const user: User = {
      id: crypto.randomUUID(),
      username: input.username,
      email: input.email,
      role: input.role ?? 'user',
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    return user;
  }

  public async replace(id: string, input: CreateUser): Promise<User> {
    const existing = this.users.get(id);
    if (!existing) throw new createError.NotFound(`No user ${id}`);
    const user: User = {
      ...existing,
      username: input.username,
      email: input.email,
      role: input.role ?? 'user',
    };
    this.users.set(id, user);
    return user;
  }

  public async update(id: string, input: UpdateUser): Promise<User> {
    const existing = this.users.get(id);
    if (!existing) throw new createError.NotFound(`No user ${id}`);
    const user: User = { ...existing, ...input };
    this.users.set(id, user);
    return user;
  }

  public async remove(id: string): Promise<void> {
    if (!this.users.delete(id)) throw new createError.NotFound(`No user ${id}`);
  }

  public async setAvatar(
    id: string,
    avatar: { bytes: Uint8Array; contentType: string },
  ): Promise<void> {
    if (!this.users.has(id)) throw new createError.NotFound(`No user ${id}`);
    this.avatars.set(id, avatar);
  }

  public async getAvatar(
    id: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    return this.avatars.get(id);
  }
}
