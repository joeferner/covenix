import { z } from 'zod';
import type { Response } from 'express';
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
  ReturnsFile,
  Summary,
  Description,
  OperationId,
  Deprecated,
  Example,
  Security,
  Param,
  QueryParam,
  BodyParam,
  Header,
  Res,
  File,
  Files,
  Principal,
  FileResponse,
  RangeFileResponse,
} from 'zodec';
import {
  CreateUserSchema,
  UpdateUserSchema,
  UserSchema,
  UserListSchema,
  PaginationQuerySchema,
  AvatarUploadSchema,
  GalleryUploadSchema,
  UploadResultSchema,
  ErrorSchema,
  type CreateUser,
  type UpdateUser,
  type UserList,
  type UploadResult,
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
  // Declare a response header — documented in the OpenAPI `responses.200.headers`
  // (zodec doesn't set it for you; the handler does, via @Res or res).
  @Returns(200, UserListSchema, {
    headers: { 'X-Total-Count': z.number().int() },
  })
  public async list(
    @QueryParam('page') page: number,
    @QueryParam('limit') limit: number,
    @Res() res: Response,
  ): Promise<UserList> {
    const list = await this.users.list(page, limit);
    res.set('X-Total-Count', String(list.total));
    return list;
  }

  @Get('{id}')
  @Summary('Fetch a single user by id')
  @Params(IdParams)
  // The optional `description` fills the OpenAPI Response Object description
  // (which the spec requires) instead of leaving it blank.
  @Returns(200, UserSchema, { description: 'The requested user' })
  @Returns(404, ErrorSchema, { description: 'No user with that id' })
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
  // @Description adds the longer prose; @OperationId names it for client codegen
  // (otherwise it would default to the method name, `avatar`); @Deprecated marks
  // it superseded — the route still works, but tools render it struck through.
  @Description(
    'Returns a URL string. Superseded by `GET {id}/avatar/raw`, which streams the image with HTTP Range support.',
  )
  @OperationId('getUserAvatarUrl')
  @Deprecated()
  @Returns(200, z.object({ url: z.string() }))
  public async avatar(
    @Param('id') id: string,
    @QueryParam('size') size: string | undefined,
  ): Promise<{ url: string }> {
    const dimension = size ?? '128';
    return { url: `https://avatars.example.com/${id}?size=${dimension}` };
  }

  // File download: return a `FileResponse` instead of JSON. zodec streams the
  // body and sets Content-Type / Content-Disposition, and `@ReturnsFile`
  // declares the binary media type in the generated OpenAPI (so swagger reflects
  // the non-JSON body). The 404 still flows through the normal error pipeline.
  @Get('{id}/export')
  @Summary('Download a user as a CSV file')
  @Params(IdParams)
  @ReturnsFile(200, { contentType: 'text/csv' })
  @Returns(404, ErrorSchema)
  public async export(@Param('id') id: string): Promise<FileResponse> {
    const user = await this.users.findById(id);
    if (!user) throw new createError.NotFound(`No user ${id}`);
    const csv = `id,username,email\n${user.id},${user.username},${user.email}\n`;
    return new FileResponse(Buffer.from(csv), {
      contentType: 'text/csv',
      filename: `user-${user.id}.csv`,
    });
  }

  // File upload (multipart/form-data). zodec auto-detects multipart because the
  // @Body schema has a `z.file()` field — there's no @Multipart marker. multer
  // (memory storage) parses the request, each file is adapted to a web-standard
  // `File`, and the whole body is validated against the schema like any other:
  // `avatar` must be a ≤2 MB PNG/JPEG, `caption` an optional short string. A
  // violation throws the usual 422.
  @Post('{id}/avatar')
  @Summary('Upload an avatar image for a user')
  @Params(IdParams)
  @Body(AvatarUploadSchema)
  @Returns(200, UploadResultSchema)
  @Returns(404, ErrorSchema)
  public async uploadAvatar(
    @Param('id') id: string,
    @File('avatar') avatar: File,
    @BodyParam('caption') caption: string | undefined,
  ): Promise<UploadResult> {
    const bytes = new Uint8Array(await avatar.arrayBuffer());
    await this.users.setAvatar(id, { bytes, contentType: avatar.type });
    return { filename: avatar.name, contentType: avatar.type, size: avatar.size, caption };
  }

  // Multiple files in a single field: `z.array(z.file())` in the schema, injected
  // as `File[]` via @Files. Each element is validated against the inner file
  // schema, and the array length cap (`.max(8)`) is enforced too.
  @Post('{id}/photos')
  @Summary('Upload multiple photos for a user')
  @Params(IdParams)
  @Body(GalleryUploadSchema)
  @Returns(200, z.object({ uploaded: z.number().int() }))
  @Returns(404, ErrorSchema)
  public async uploadPhotos(
    @Param('id') id: string,
    @Files('photos') photos: File[],
  ): Promise<{ uploaded: number }> {
    const user = await this.users.findById(id);
    if (!user) throw new createError.NotFound(`No user ${id}`);
    return { uploaded: photos.length };
  }

  // Download the avatar uploaded above, with HTTP Range support. Returning a
  // RangeFileResponse (rather than FileResponse) is the opt-in: its body type is
  // narrowed to range-capable sources, so zodec advertises `Accept-Ranges: bytes`
  // and serves 206/416 automatically. A Uint8Array body is range-capable by
  // construction (the size is intrinsic). `disposition: 'inline'` lets a browser
  // render it in an <img> instead of downloading.
  @Get('{id}/avatar/raw')
  @Summary('Download a user avatar (supports HTTP Range)')
  @Params(IdParams)
  @ReturnsFile(200, { description: 'The stored avatar image' })
  @Returns(404, ErrorSchema)
  public async getAvatar(@Param('id') id: string): Promise<RangeFileResponse> {
    const avatar = await this.users.getAvatar(id);
    if (!avatar) throw new createError.NotFound(`No avatar for user ${id}`);
    return new RangeFileResponse(avatar.bytes, {
      contentType: avatar.contentType,
      filename: `avatar-${id}`,
      disposition: 'inline',
    });
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

  // Admin-only. @Security('bearer', ['admin']) runs the bearer handler with the
  // `['admin']` scope before this handler; the handler 401s on a bad token and
  // 403s unless the principal's role is admin (see api-security.ts). @Principal()
  // injects the authenticated actor — here just to log who performed the delete.
  @Delete('{id}')
  @Summary('Delete a user (admin only)')
  @Security('bearer', ['admin'])
  @Params(IdParams)
  @Returns(204)
  @Returns(401, ErrorSchema)
  @Returns(403, ErrorSchema)
  @Returns(404, ErrorSchema)
  public async remove(@Param('id') id: string, @Principal() actor: User): Promise<void> {
    console.warn(`user ${actor.id} deleting user ${id}`);
    await this.users.remove(id);
  }
}
