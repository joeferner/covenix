import type { OpenApiInfo } from 'zodec';

// Shared OpenAPI info used by both the instance-based and static swagger
// generators (and the Zodec instance), so their output matches exactly.
// `info` is the full OpenAPI Info Object — title + version are required, the
// rest (description, contact, license, …) is optional and emitted verbatim.
export const apiInfo: OpenApiInfo = {
  title: 'Kitchen Sink API',
  version: '1.0.0',
  description: 'Exercises every zodec feature end to end.',
  license: { name: 'MIT' },
};
