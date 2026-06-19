import { z, type ZodType } from 'zod';
import type { OpenAPIV3_1 } from 'openapi-types';
import { getPrefix, getRoutes, type ExampleMetadata, type RouteMetadata } from './metadata.js';
import { isMultipart } from './multipart.js';
import { downConvertToV30 } from './downconvert.js';
import type { SecuritySchemes } from './security.js';

/**
 * OpenAPI specification version to emit. zodec produces **`'3.1'`** by default
 * (its native form — Zod 4's `z.toJSONSchema()` is JSON Schema draft 2020-12,
 * which 3.1 uses verbatim). Choose `'3.0'` when a consumer has only partial 3.1
 * support (e.g. `openapi-generator`'s `typescript-fetch`); zodec down-converts
 * the schemas (nullable, exclusive bounds, `const`, binary, …) accordingly.
 */
export type SpecVersion = '3.0' | '3.1';

/** Optional inputs for OpenAPI generation beyond the controllers themselves. */
export interface OpenApiOptions {
  /**
   * Security scheme definitions to emit under `components.securitySchemes`. The
   * `Zodec` instance derives these from its `security` config; pass them
   * explicitly to {@link generateSwagger} for instance-free generation.
   */
  securitySchemes?: SecuritySchemes | undefined;
  /** OpenAPI spec version to emit. Defaults to `'3.1'`. */
  specVersion?: SpecVersion | undefined;
}

/**
 * A JSON Schema document or fragment. Uses Zod's own JSON Schema type — it is
 * authoritative for what `z.toJSONSchema` emits (draft 2020-12) — so converting
 * schemas needs no extra conversion dependency.
 */
export type JsonSchema = z.core.JSONSchema.BaseSchema;

/** The assembled spec, typed with the authoritative `openapi-types` definitions. */
export type OpenApiDocument = OpenAPIV3_1.Document;

/**
 * Converts a single Zod schema to its JSON Schema representation. Nested schemas
 * named via `.meta({ id })` are emitted as `$ref`s into a `$defs` block; the doc
 * assembly step rewrites those references for OpenAPI components.
 *
 * @param schema - The Zod schema to convert.
 * @returns The schema as JSON Schema (draft 2020-12).
 */
export function toJsonSchema(schema: ZodType): JsonSchema {
  return z.toJSONSchema(schema);
}

/** OpenAPI `info` block (title + version) passed to the document builders. */
export interface OpenApiInfo {
  /** API title. */
  title: string;
  /** API version string. */
  version: string;
}

/** A mutable JSON object, used while rewriting converted schemas. */
type JsonObject = Record<string, unknown>;

/** Rewrites Zod's `#/$defs/X` references to OpenAPI's `#/components/schemas/X`. */
function rewriteRefs(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(rewriteRefs);
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as JsonObject;
    const ref = obj['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      obj['$ref'] = `#/components/schemas/${ref.slice('#/$defs/'.length)}`;
    }
    for (const key of Object.keys(obj)) {
      rewriteRefs(obj[key]);
    }
  }
}

/**
 * Joins controller prefix + route path for OpenAPI, keeping `{id}` placeholders
 * (OpenAPI uses the same curly-brace syntax zodec routes are written in).
 */
function toOpenApiPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return joined === '' ? '/' : joined;
}

/**
 * Our JSON Schema fragments are draft-2020-12 (what OpenAPI 3.1 uses), but the
 * nominal types differ — bridge them at these boundaries.
 */
function asSchemaObject(schema: JsonSchema): OpenAPIV3_1.SchemaObject {
  return schema as unknown as OpenAPIV3_1.SchemaObject;
}

/**
 * `ParameterObject` is aliased to the V3 shape in openapi-types, whose `schema`
 * field doesn't accept a V3.1 SchemaObject — bridge to exactly that field type.
 */
function asParameterSchema(schema: JsonSchema): NonNullable<OpenAPIV3_1.ParameterObject['schema']> {
  return schema as unknown as NonNullable<OpenAPIV3_1.ParameterObject['schema']>;
}

/**
 * Walks controller metadata (read off each prototype) and hand-assembles an
 * OpenAPI 3.1 document. Named schemas accumulate in `components.schemas`.
 */
class DocumentBuilder {
  private readonly schemas: Record<string, OpenAPIV3_1.SchemaObject> = {};

  public build(
    prototypes: object[],
    info: OpenApiInfo,
    options: OpenApiOptions = {},
  ): OpenApiDocument {
    const paths: OpenAPIV3_1.PathsObject = {};
    for (const proto of prototypes) {
      const prefix = getPrefix(proto);
      for (const route of getRoutes(proto)) {
        const path = toOpenApiPath(prefix, route.path);
        const item: OpenAPIV3_1.PathItemObject = paths[path] ?? {};
        (item as Record<string, OpenAPIV3_1.OperationObject>)[route.method] = this.operation(route);
        paths[path] = item;
      }
    }
    const components: OpenAPIV3_1.ComponentsObject = { schemas: this.schemas };
    if (options.securitySchemes && Object.keys(options.securitySchemes).length > 0) {
      components.securitySchemes = options.securitySchemes;
    }
    return {
      openapi: '3.1.0',
      info,
      paths,
      components,
    };
  }

  private operation(route: RouteMetadata): OpenAPIV3_1.OperationObject {
    const examples = route.examples ?? [];
    const parameters: OpenAPIV3_1.ParameterObject[] = [
      ...(route.params ? this.parameters(route.params, 'path') : []),
      ...(route.query ? this.parameters(route.query, 'query') : []),
    ];
    const responses: Record<string, OpenAPIV3_1.ResponseObject> = {};
    for (const [status, schema] of Object.entries(route.responses)) {
      const response: OpenAPIV3_1.ResponseObject = { description: '' };
      // A status declared with no schema (e.g. 204) has no response body.
      if (schema) {
        const example = examples.find((e) => e.status === Number(status));
        response.content = { 'application/json': this.media(schema, example) };
      }
      responses[status] = response;
    }
    // Binary/file responses (@ReturnsFile) advertise a binary body.
    for (const [status, decl] of Object.entries(route.fileResponses ?? {})) {
      responses[status] = {
        description: decl.description ?? '',
        content: {
          [decl.contentType]: {
            schema: { type: 'string', format: 'binary' },
          },
        },
      };
    }
    // Response headers (@Returns(..., { headers })) attach to their response.
    for (const [status, headers] of Object.entries(route.responseHeaders ?? {})) {
      const response = responses[status];
      if (response) {
        response.headers = Object.fromEntries(
          Object.entries(headers).map(([name, schema]) => [
            name,
            { schema: asParameterSchema(this.toJson(schema)) },
          ]),
        );
      }
    }

    const operation: OpenAPIV3_1.OperationObject = { responses };
    if (route.tags && route.tags.length > 0) {
      operation.tags = route.tags;
    }
    if (route.summary) {
      operation.summary = route.summary;
    }
    // Stacked @Security = OR → one security requirement object per requirement.
    if (route.security && route.security.length > 0) {
      operation.security = route.security.map((req) => ({ [req.scheme]: req.scopes }));
    }
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }
    if (route.body) {
      const example = examples.find((e) => e.status === undefined);
      // A body with a file field is multipart/form-data; the schema conversion
      // already emits file props as `{ type: 'string', format: 'binary' }`.
      const mediaType = isMultipart(route.body) ? 'multipart/form-data' : 'application/json';
      operation.requestBody = {
        required: true,
        content: { [mediaType]: this.media(route.body, example) },
      };
    }
    return operation;
  }

  /** Converts a Zod schema to a JSON Schema fragment, hoisting named `$defs`. */
  private toJson(schema: ZodType): JsonSchema {
    const json = z.toJSONSchema(schema) as unknown as JsonObject;
    this.hoist(json);
    return json;
  }

  /** Builds a media type object: the converted schema plus an optional example. */
  private media(schema: ZodType, example?: ExampleMetadata): OpenAPIV3_1.MediaTypeObject {
    const media: OpenAPIV3_1.MediaTypeObject = { schema: this.schema(schema) };
    if (example) {
      media.example = example.value;
    }
    return media;
  }

  /**
   * Converts a schema, hoisting nested named schemas into components. A schema
   * that is itself named becomes a component and is returned as a `$ref`.
   */
  private schema(schema: ZodType): OpenAPIV3_1.SchemaObject {
    const json = z.toJSONSchema(schema) as unknown as JsonObject;
    this.hoist(json);
    const id = schema.meta()?.id;
    if (typeof id === 'string') {
      this.schemas[id] = asSchemaObject(json);
      return { $ref: `#/components/schemas/${id}` } as OpenAPIV3_1.SchemaObject;
    }
    return asSchemaObject(json);
  }

  /**
   * Decomposes a `@Params`/`@Query` object schema into individual OpenAPI
   * parameters — one per property. Path parameters are always required.
   */
  private parameters(schema: ZodType, location: 'path' | 'query'): OpenAPIV3_1.ParameterObject[] {
    const json = z.toJSONSchema(schema) as unknown as JsonObject;
    this.hoist(json);
    const properties = (json['properties'] ?? {}) as Record<string, JsonSchema>;
    const required = new Set((json['required'] as string[] | undefined) ?? []);
    return Object.entries(properties).map(([name, propSchema]) => ({
      name,
      in: location,
      required: location === 'path' ? true : required.has(name),
      schema: asParameterSchema(propSchema),
    }));
  }

  /** Moves nested `$defs` into components, strips `$schema`, and rewrites refs. */
  private hoist(json: JsonObject): void {
    const defs = json['$defs'] as Record<string, JsonObject> | undefined;
    if (defs) {
      for (const [name, def] of Object.entries(defs)) {
        delete def['$schema'];
        rewriteRefs(def);
        this.schemas[name] = asSchemaObject(def);
      }
      delete json['$defs'];
    }
    delete json['$schema'];
    rewriteRefs(json);
  }
}

/**
 * Builds an OpenAPI 3.1 document from controller prototypes. Independent of
 * route mounting — only reads class-level metadata.
 */
export function generateOpenApiDocument(
  prototypes: object[],
  info: OpenApiInfo,
  options: OpenApiOptions = {},
): OpenApiDocument {
  const document = new DocumentBuilder().build(prototypes, info, options);
  // The builder always emits 3.1 (zodec's native form); down-convert if asked.
  return options.specVersion === '3.0' ? downConvertToV30(document) : document;
}

/**
 * Standalone, instance-free OpenAPI generation: pass the controller classes
 * directly. Swagger is derived entirely from class-level metadata, so no
 * instances (and thus no dependency wiring) are needed — the lightest path for
 * CI spec checks and client codegen.
 *
 * @param controllers - The controller classes (constructors, not instances).
 * @param info - OpenAPI `info` block. Defaults to `{ title: 'API', version: '1.0.0' }`.
 * @param options - Extra inputs: `securitySchemes` (needed when routes use
 *   `@Security`, since scheme definitions aren't carried on the classes) and
 *   `specVersion` (`'3.1'` by default; `'3.0'` to down-convert).
 * @returns The assembled OpenAPI document (3.1 by default).
 *
 * @example
 * ```ts
 * const doc = generateSwagger([UsersController, HealthController]);
 * ```
 */
export function generateSwagger(
  controllers: { prototype: object }[],
  info: OpenApiInfo = { title: 'API', version: '1.0.0' },
  options: OpenApiOptions = {},
): OpenApiDocument {
  return generateOpenApiDocument(
    controllers.map((controller) => controller.prototype),
    info,
    options,
  );
}
