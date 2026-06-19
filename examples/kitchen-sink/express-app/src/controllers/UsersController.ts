import { z } from 'zod';
import createError from 'http-errors';
import {
  Route,
  Tags,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Params,
  Query,
  Body,
  Returns,
  Summary,
  Example,
  Param,
  QueryParam,
  BodyParam,
  Header,
} from 'zodec';
import {
  CreateUserSchema,
  UpdateUserSchema,
  UserSchema,
  UserListSchema,
  PaginationQuerySchema,
  ErrorSchema,
  type CreateUser,
  type UpdateUser,
  type UserList,
  type User,
} from '@kitchen-sink/schemas';
import type { UserService } from '../services/UserService.js';

// The id path param is a small inline (anonymous) schema — allowed, just inlined
// in swagger with no $ref. The named schemas come from another module entirely.
const IdParams = z.object({ id: z.string().uuid() });

@Route('users')
@Tags('Users')
export class UsersController {
  // Dependency injected explicitly by the caller in main.ts — no container.
  constructor(private readonly users: UserService) {}

  @Get()
  @Summary('List users (paginated)')
  @Query(PaginationQuerySchema)
  @Returns(200, UserListSchema)
  public async list(
    @QueryParam('page') page: number,
    @QueryParam('limit') limit: number,
  ): Promise<UserList> {
    return this.users.list(page, limit);
  }

  @Get('{id}')
  @Summary('Fetch a single user by id')
  @Params(IdParams)
  @Returns(200, UserSchema)
  @Returns(404, ErrorSchema)
  public async get(@Param('id') id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user) throw new createError.NotFound(`No user ${id}`);
    return user;
  }

  // Method-level @Params AND @Query on the same route — both are validated and
  // coerced before the handler runs (e.g. `page`/`limit` arrive as numbers).
  @Get('{id}/related')
  @Summary('List users related to a given user (paginated)')
  @Params(IdParams)
  @Query(PaginationQuerySchema)
  @Returns(200, UserListSchema)
  @Returns(404, ErrorSchema)
  public async related(
    @Param('id') id: string,
    @QueryParam('page') page: number,
    @QueryParam('limit') limit: number,
  ): Promise<UserList> {
    const user = await this.users.findById(id);
    if (!user) throw new createError.NotFound(`No user ${id}`);
    return this.users.list(page, limit);
  }

  // No @Params / @Query here — the method-level validation decorators are
  // optional. @Param and @QueryParam still inject their values, but because
  // there's no schema to parse against, they arrive raw: `id` and `size` are
  // the untouched strings Express produced (note `size: string | undefined`,
  // not a coerced number).
  @Get('{id}/avatar')
  @Summary('Avatar URL for a user (no method-level schema on this route)')
  @Returns(200, z.object({ url: z.string() }))
  public async avatar(
    @Param('id') id: string,
    @QueryParam('size') size: string | undefined,
  ): Promise<{ url: string }> {
    const dimension = size ?? '128';
    return { url: `https://avatars.example.com/${id}?size=${dimension}` };
  }

  @Post()
  @Summary('Create a user')
  @Body(CreateUserSchema)
  // Request-body example (no status) and a 201 response example. Both surface on
  // their media types in the generated OpenAPI / Swagger UI.
  @Example({ username: 'ada', email: 'ada@example.com' })
  @Returns(201, UserSchema)
  @Example(
    {
      id: '7b9c1e2a-4f6d-4b8a-9c1e-2a4f6d4b8a9c',
      username: 'ada',
      email: 'ada@example.com',
      role: 'user',
      createdAt: '2026-06-19T00:00:00.000Z',
    },
    201,
  )
  @Returns(422, ErrorSchema)
  public async create(
    @BodyParam() body: CreateUser,
    @Header('x-request-id') requestId: string | undefined,
  ): Promise<User> {
    void requestId; // demonstrates header injection; a real app might log it
    return this.users.create(body);
  }

  @Put('{id}')
  @Summary('Replace a user')
  @Params(IdParams)
  @Body(CreateUserSchema)
  @Returns(200, UserSchema)
  @Returns(404, ErrorSchema)
  public async replace(@Param('id') id: string, @BodyParam() body: CreateUser): Promise<User> {
    return this.users.replace(id, body);
  }

  @Patch('{id}')
  @Summary('Partially update a user')
  @Params(IdParams)
  @Body(UpdateUserSchema)
  @Returns(200, UserSchema)
  @Returns(404, ErrorSchema)
  public async update(@Param('id') id: string, @BodyParam() body: UpdateUser): Promise<User> {
    return this.users.update(id, body);
  }

  @Delete('{id}')
  @Summary('Delete a user')
  @Params(IdParams)
  @Returns(204)
  @Returns(404, ErrorSchema)
  public async remove(@Param('id') id: string): Promise<void> {
    await this.users.remove(id);
  }
}
