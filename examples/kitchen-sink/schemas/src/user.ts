import { z } from 'zod';

export const UserSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string().min(3).max(32),
    email: z.string().email(),
    role: z.enum(['admin', 'user']).default('user'),
    createdAt: z.string().datetime(),
  })
  .meta({ id: 'User' });

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

export type User = z.infer<typeof UserSchema>;
export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
export type UserList = z.infer<typeof UserListSchema>;
