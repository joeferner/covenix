import { NotificationSchema } from '@kitchen-sink/schemas';

// Schemas not referenced by any HTTP route, documented so client generators
// still emit a type for them. Pure data (no instance/services), shared by every
// swagger call site so their output matches: pass it to `api.swagger({ schemas })`
// (server + instance generator) and `generateSwagger(..., { schemas })` (static).
export const additionalSchemas = [NotificationSchema];
