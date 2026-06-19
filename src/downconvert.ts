import type { OpenAPIV3_1 } from 'openapi-types';

/**
 * Converts an assembled OpenAPI **3.1** document (as zodec builds it from Zod 4's
 * `z.toJSONSchema()`, which is JSON Schema draft 2020-12) down to **3.0**, in
 * place. zodec emits 3.1 by default; this is applied only when `specVersion: '3.0'`
 * is requested — typically so older tooling (e.g. `openapi-generator`'s
 * `typescript-fetch`, which has only partial 3.1 support) can consume the spec.
 *
 * It handles the differences that actually arise from zodec's output:
 *
 * - **nullable**: 3.1 `anyOf: [..., { type: 'null' }]` → 3.0 `nullable: true`
 *   (a lone `$ref` becomes `allOf: [$ref]` + `nullable`, since 3.0 forbids `$ref`
 *   siblings); a `type` array containing `'null'` is likewise collapsed.
 * - **exclusive bounds**: 3.1 numeric `exclusiveMinimum`/`exclusiveMaximum` →
 *   3.0 `minimum`/`maximum` + boolean `exclusiveMinimum`/`exclusiveMaximum`.
 * - **`const`** → single-value `enum`.
 * - **schema `examples`** (array) → 3.0 singular `example`.
 * - drops 3.1-only `contentEncoding`/`contentMediaType` (binary stays
 *   `type: string, format: binary`) and any leftover `$schema`/`$id`.
 */
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a schema branch is exactly `{ type: 'null' }` (the 3.1 null marker). */
function isNullBranch(branch: unknown): boolean {
  return isObject(branch) && branch['type'] === 'null' && Object.keys(branch).length === 1;
}

/** Folds an `anyOf`/`oneOf` that includes a `{ type: 'null' }` branch into 3.0 `nullable`. */
function foldNullable(node: JsonObject, keyword: 'anyOf' | 'oneOf'): void {
  const branches = node[keyword];
  if (!Array.isArray(branches)) {
    return;
  }
  const nonNull = branches.filter((branch) => !isNullBranch(branch));
  if (nonNull.length === branches.length) {
    return; // no null branch — leave the composition untouched
  }
  node['nullable'] = true;
  if (nonNull.length === 1 && isObject(nonNull[0])) {
    delete node[keyword];
    if ('$ref' in nonNull[0]) {
      // 3.0 ignores siblings of $ref — wrap it so `nullable` still applies.
      node['allOf'] = [nonNull[0]];
    } else {
      Object.assign(node, nonNull[0]);
    }
  } else {
    node[keyword] = nonNull;
  }
}

/** Recursively rewrites a single schema object from 3.1 form to 3.0 form, in place. */
function convertSchema(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(convertSchema);
    return;
  }
  if (!isObject(node)) {
    return;
  }

  // Recurse into nested schemas first, so folding sees converted children.
  if (isObject(node['properties'])) {
    for (const value of Object.values(node['properties'])) {
      convertSchema(value);
    }
  }
  convertSchema(node['items']);
  if (isObject(node['additionalProperties'])) {
    convertSchema(node['additionalProperties']);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
    if (Array.isArray(node[keyword])) {
      node[keyword].forEach(convertSchema);
    }
  }
  if (isObject(node['not'])) {
    convertSchema(node['not']);
  }

  foldNullable(node, 'anyOf');
  foldNullable(node, 'oneOf');

  // A `type` array (e.g. ['string', 'null']) — 3.0 has no union types.
  if (Array.isArray(node['type'])) {
    const types = node['type'].filter((type) => type !== 'null');
    if (types.length !== node['type'].length) {
      node['nullable'] = true;
    }
    node['type'] = types.length === 1 ? types[0] : types;
  }

  if (typeof node['exclusiveMinimum'] === 'number') {
    node['minimum'] = node['exclusiveMinimum'];
    node['exclusiveMinimum'] = true;
  }
  if (typeof node['exclusiveMaximum'] === 'number') {
    node['maximum'] = node['exclusiveMaximum'];
    node['exclusiveMaximum'] = true;
  }

  if ('const' in node) {
    node['enum'] = [node['const']];
    delete node['const'];
  }

  if (Array.isArray(node['examples'])) {
    if (node['examples'].length > 0) {
      node['example'] = node['examples'][0];
    }
    delete node['examples'];
  }

  delete node['contentEncoding'];
  delete node['contentMediaType'];
  delete node['$schema'];
  delete node['$id'];
}

/** Converts every schema reachable from an operation (params, body, responses). */
function convertOperation(operation: JsonObject): void {
  if (Array.isArray(operation['parameters'])) {
    for (const param of operation['parameters']) {
      if (isObject(param) && isObject(param['schema'])) {
        convertSchema(param['schema']);
      }
    }
  }
  const convertContent = (holder: unknown): void => {
    if (isObject(holder) && isObject(holder['content'])) {
      for (const media of Object.values(holder['content'])) {
        if (isObject(media) && isObject(media['schema'])) {
          convertSchema(media['schema']);
        }
      }
    }
  };
  convertContent(operation['requestBody']);
  if (isObject(operation['responses'])) {
    for (const response of Object.values(operation['responses'])) {
      convertContent(response);
      if (isObject(response) && isObject(response['headers'])) {
        for (const header of Object.values(response['headers'])) {
          if (isObject(header) && isObject(header['schema'])) {
            convertSchema(header['schema']);
          }
        }
      }
    }
  }
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Rewrites a 3.1 OpenAPI document to 3.0 in place and returns it. Sets
 * `openapi: '3.0.3'` and converts every schema in `components.schemas` and on
 * every operation.
 *
 * @param document - The assembled 3.1 document (mutated and returned).
 * @returns The same document, now 3.0-shaped.
 */
export function downConvertToV30(document: OpenAPIV3_1.Document): OpenAPIV3_1.Document {
  document.openapi = '3.0.3';
  const schemas = document.components?.schemas;
  if (schemas) {
    for (const schema of Object.values(schemas)) {
      convertSchema(schema);
    }
  }
  const paths = document.paths ?? {};
  for (const item of Object.values(paths)) {
    if (!isObject(item)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (isObject(operation)) {
        convertOperation(operation);
      }
    }
  }
  return document;
}
