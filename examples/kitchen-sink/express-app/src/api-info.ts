import type { OpenApiInfo } from 'zodec';

// Shared OpenAPI info used by both the instance-based and static swagger
// generators (and the Zodec instance), so their output matches exactly.
export const apiInfo: OpenApiInfo = {
  title: 'Kitchen Sink API',
  version: '1.0.0',
};
