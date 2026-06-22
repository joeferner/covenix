import type { OpenApiInfo } from 'covenix';

// Shared OpenAPI info used by both the instance-based and static swagger
// generators (and the Covenix instance), so their output matches exactly.
// `info` is the full OpenAPI Info Object — title + version are required, the
// rest (description, contact, license, …) is optional and emitted verbatim.
export const apiInfo: OpenApiInfo = {
  title: 'Kitchen Sink API',
  version: '1.0.0',
  description: 'Exercises every covenix feature end to end.',
  license: { name: 'MIT' },
};
