import { z } from 'zod';

/**
 * A notification pushed to clients out-of-band (e.g. over a separate channel) —
 * not tied to any HTTP route. Registering the schema (see `api.ts`) documents it
 * under `components.schemas` so client generators still emit a type for it. A
 * discriminated union is the typical message-envelope shape.
 */
export const NotificationSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('message'), from: z.string(), text: z.string() }),
    z.object({ type: z.literal('presence'), userId: z.string(), online: z.boolean() }),
  ])
  .meta({ id: 'Notification' });

export type Notification = z.infer<typeof NotificationSchema>;
