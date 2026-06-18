import { z } from 'zod';

export const LoginSchema = z
  .object({
    username: z.string().min(3),
    password: z.string().min(8),
  })
  .meta({ id: 'Login' });

export const TokenSchema = z
  .object({
    token: z.string(),
    expiresIn: z.number().int(),
  })
  .meta({ id: 'Token' });

export type Login = z.infer<typeof LoginSchema>;
export type Token = z.infer<typeof TokenSchema>;
