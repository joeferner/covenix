import type { ZodType } from 'zod';

/**
 * A file-typed field discovered in a `@Body` schema. `multiple` is `true` when
 * the field is an array of files (`z.array(z.file())`), `false` for a single
 * `z.file()`.
 */
export interface MultipartFileField {
  /** Object property name (the form field name). */
  name: string;
  /** Whether the field accepts multiple files. */
  multiple: boolean;
}

/**
 * Minimal structural view of Zod 4's internal schema definition. We only read
 * the few fields needed to recognize file/array/object shapes, so we model just
 * those rather than depending on Zod's internal types.
 */
interface ZodInternal {
  _zod?: {
    def?: {
      type?: string;
      innerType?: ZodInternal;
      element?: ZodInternal;
      shape?: Record<string, ZodInternal>;
    };
  };
}

/**
 * Wrapper schema types that hold their subject under `innerType`. We descend
 * through these to find the underlying file/array shape, so `z.file().optional()`
 * and `z.array(z.file()).default([])` are still recognized as file fields.
 */
const WRAPPER_TYPES = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'catch',
  'readonly',
  'nonoptional',
]);

/** Peels wrapper schemas (optional/default/…) off to reach the core schema. */
function unwrap(node: ZodInternal | undefined): ZodInternal | undefined {
  let current = node;
  while (current?._zod?.def && WRAPPER_TYPES.has(current._zod.def.type ?? '')) {
    current = current._zod.def.innerType;
  }
  return current;
}

/** Classifies a single object property as a file field, or `undefined`. */
function classify(name: string, node: ZodInternal | undefined): MultipartFileField | undefined {
  const base = unwrap(node);
  const type = base?._zod?.def?.type;
  if (type === 'file') {
    return { name, multiple: false };
  }
  if (type === 'array' && unwrap(base?._zod?.def?.element)?._zod?.def?.type === 'file') {
    return { name, multiple: true };
  }
  return undefined;
}

/**
 * Inspects a `@Body` schema and returns its file-typed fields. A non-empty
 * result means the route is `multipart/form-data`: covenix parses the request with
 * multer, adapts each uploaded file to a web-standard `File`, and validates the
 * assembled body against the schema like any other body.
 *
 * @param schema - The route's `@Body` schema, if any.
 * @returns One entry per file field; empty when the body is not multipart.
 */
export function getMultipartFields(schema: ZodType | undefined): MultipartFileField[] {
  if (!schema) {
    return [];
  }
  const def = (schema as unknown as ZodInternal)._zod?.def;
  if (def?.type !== 'object' || !def.shape) {
    return [];
  }
  const fields: MultipartFileField[] = [];
  for (const [name, propSchema] of Object.entries(def.shape)) {
    const field = classify(name, propSchema);
    if (field) {
      fields.push(field);
    }
  }
  return fields;
}

/** Whether a `@Body` schema declares any file field (i.e. is multipart). */
export function isMultipart(schema: ZodType | undefined): boolean {
  return getMultipartFields(schema).length > 0;
}

/**
 * The property names of an object `@Body` schema, or `undefined` when the body
 * isn't a plain object (e.g. an array, union, or primitive — where field-level
 * `@BodyParam('name')` references can't be checked). Used by registration-time
 * validation to catch a `@BodyParam` that names a field the schema doesn't have.
 *
 * @param schema - The route's `@Body` schema, if any.
 */
export function getObjectFields(schema: ZodType | undefined): Set<string> | undefined {
  if (!schema) {
    return undefined;
  }
  const def = (schema as unknown as ZodInternal)._zod?.def;
  if (def?.type !== 'object' || !def.shape) {
    return undefined;
  }
  return new Set(Object.keys(def.shape));
}
