import { z } from 'zod';

/**
 * A notification pushed to clients out-of-band (e.g. over a separate channel) —
 * not tied to any HTTP route. Registering the schema (see `api.ts`) documents it
 * under `components.schemas` so client generators still emit a type for it. A
 * discriminated union is the typical message-envelope shape.
 *
 * Naming each variant via `.meta({ id })` lets zodec emit a full OpenAPI
 * `discriminator` (with a `propertyName` → `$ref` mapping), so generators like
 * `openapi-generator-cli`'s `typescript-fetch` produce a proper discriminated
 * TypeScript union instead of a flattened interface.
 */
export const MessageNotificationSchema = z
  .object({ type: z.literal('message'), from: z.string(), text: z.string() })
  .meta({ id: 'MessageNotification' });

export const PresenceNotificationSchema = z
  .object({ type: z.literal('presence'), userId: z.string(), online: z.boolean() })
  .meta({ id: 'PresenceNotification' });

export const NotificationSchema = z
  .discriminatedUnion('type', [MessageNotificationSchema, PresenceNotificationSchema])
  .meta({ id: 'Notification' });

export type Notification = z.infer<typeof NotificationSchema>;
