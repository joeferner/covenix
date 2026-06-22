import type { ZodType } from 'zod';
import type { ParamMetadata } from './metadata.js';
import { getMultipartFields, getObjectFields } from './multipart.js';

/**
 * Asserts that a handler's body-sourced parameter injectors line up with its
 * `@Body` schema, throwing a descriptive error if they don't. This catches the
 * structural half of an annotation/schema mismatch — the part that *is* knowable
 * at registration time (names and schema shape), unlike the TypeScript parameter
 * type, which is erased and can't be checked.
 *
 * It rejects:
 * - `@BodyParam('field')` / `@File`/`@Files` when the handler declares no `@Body`;
 * - `@BodyParam('field')` naming a field absent from an object `@Body` schema;
 * - `@File('field')` whose field isn't a single `z.file()`;
 * - `@Files('field')` whose field isn't a `z.array(z.file())`.
 *
 * A name-less `@BodyParam()` (the whole body) is always allowed — it's the
 * escape hatch for an unvalidated or non-object body.
 *
 * @param handlerName - The controller method name (for error messages).
 * @param body - The route's `@Body` schema, if any.
 * @param params - The handler's injected-parameter metadata.
 */
export function assertValidBodyParams(
  handlerName: string,
  body: ZodType | undefined,
  params: ParamMetadata[],
): void {
  const bodyParams = params.filter((p) => p.source === 'body');
  if (bodyParams.length === 0) {
    return;
  }

  if (!body) {
    // A named field or file injector has nothing to resolve against without a body.
    const offender = bodyParams.find((p) => p.name !== undefined || p.file);
    if (offender) {
      throw new Error(
        `avero: ${injectorLabel(offender)} on "${handlerName}" reads a request body field, but the handler declares no @Body schema`,
      );
    }
    return;
  }

  const fields = getObjectFields(body);
  // name -> multiple? (true = z.array(z.file()), false = z.file()); absent = not a file field.
  const fileFields = new Map(getMultipartFields(body).map((f) => [f.name, f.multiple]));

  for (const param of bodyParams) {
    if (param.name === undefined) {
      continue; // whole-body @BodyParam()
    }
    if (param.file === 'single') {
      if (fileFields.get(param.name) !== false) {
        throw new Error(
          `avero: @File('${param.name}') on "${handlerName}" must name a single z.file() field in the @Body schema`,
        );
      }
      continue;
    }
    if (param.file === 'multiple') {
      if (fileFields.get(param.name) !== true) {
        throw new Error(
          `avero: @Files('${param.name}') on "${handlerName}" must name a z.array(z.file()) field in the @Body schema`,
        );
      }
      continue;
    }
    // Plain @BodyParam('name'): the field must exist on an object @Body schema.
    if (fields && !fields.has(param.name)) {
      throw new Error(
        `avero: @BodyParam('${param.name}') on "${handlerName}" names a field absent from the @Body schema`,
      );
    }
  }
}

/** A human-readable decorator label for an offending body injector. */
function injectorLabel(param: ParamMetadata): string {
  if (param.file === 'single') {
    return `@File('${param.name ?? ''}')`;
  }
  if (param.file === 'multiple') {
    return `@Files('${param.name ?? ''}')`;
  }
  return `@BodyParam('${param.name ?? ''}')`;
}
