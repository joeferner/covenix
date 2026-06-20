import { z } from 'zod';

export const UserSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string().min(3).max(32),
    email: z.string().email().describe('Primary contact email; also the login identifier.'),
    role: z.enum(['admin', 'user']).default('user').describe('Authorization role for the user.'),
    createdAt: z.string().datetime(),
  })
  // Descriptions (.describe() / .meta({ description })) flow into both the OpenAPI
  // document and the generated client's JSDoc.
  .meta({ id: 'User', description: 'A registered user account.' });

export const CreateUserSchema = z
  .object({
    username: z.string().min(3).max(32),
    email: z.string().email(),
    role: z.enum(['admin', 'user']).optional(),
  })
  .meta({ id: 'CreateUser' });

/** Partial of CreateUser — every field optional, for PATCH. */
export const UpdateUserSchema = CreateUserSchema.partial().meta({
  id: 'UpdateUser',
});

export const UserListSchema = z
  .object({
    items: z.array(UserSchema),
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: 'UserList' });

/**
 * A multipart/form-data upload. The `z.file()` field is what makes zodec treat
 * the body as `multipart/form-data` (auto-detected) and document it as a binary
 * part; the size/mime constraints come straight from the schema. Multipart form
 * schemas stay inline (no `.meta({ id })`) — they aren't reused as components.
 */
export const AvatarUploadSchema = z.object({
  avatar: z.file().max(2_000_000).mime(['image/png', 'image/jpeg']),
  caption: z.string().max(140).optional(),
});

/** Multiple files in one part: `z.array(z.file())` → injected as `File[]`. */
export const GalleryUploadSchema = z.object({
  photos: z.array(z.file().max(5_000_000).mime(['image/png', 'image/jpeg'])).max(8),
});

export const UploadResultSchema = z
  .object({
    filename: z.string(),
    contentType: z.string(),
    size: z.number().int(),
    caption: z.string().optional(),
  })
  .meta({ id: 'UploadResult' });

export type User = z.infer<typeof UserSchema>;
export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
export type UserList = z.infer<typeof UserListSchema>;
export type UploadResult = z.infer<typeof UploadResultSchema>;
