import { z, type ZodType } from 'zod';
import type { OpenAPIV3_1 } from 'openapi-types';
import { getPrefix, getRoutes, type ExampleMetadata, type RouteMetadata } from './metadata.js';
import { isMultipart } from './multipart.js';
import { downConvertToV30 } from './downconvert.js';
import { collectDiscriminators, type DiscriminatorInfo } from './discriminator.js';
import type { SecuritySchemes } from './security.js';

/**
 * OpenAPI specification version to emit. avero produces **`'3.1'`** by default
 * (its native form — Zod 4's `z.toJSONSchema()` is JSON Schema draft 2020-12,
 * which 3.1 uses verbatim). Choose `'3.0'` when a consumer has only partial 3.1
 * support (e.g. `openapi-generator`'s `typescript-fetch`); avero down-converts
 * the schemas (nullable, exclusive bounds, `const`, binary, …) accordingly.
 */
export type SpecVersion = '3.0' | '3.1';

/** Optional inputs for OpenAPI generation beyond the controllers themselves. */
export interface OpenApiOptions {
  /**
   * Security scheme definitions to emit under `components.securitySchemes`. The
   * `Avero` instance derives these from its `security` config; pass them
   * explicitly to {@link generateSwagger} for instance-free generation.
   */
  securitySchemes?: SecuritySchemes | undefined;
  /** OpenAPI spec version to emit. Defaults to `'3.1'`. */
  specVersion?: SpecVersion | undefined;
  /** `servers` array for the document (base URLs). */
  servers?: OpenAPIV3_1.ServerObject[] | undefined;
  /** Top-level `externalDocs` for the document. */
  externalDocs?: OpenAPIV3_1.ExternalDocumentationObject | undefined;
  /**
   * Top-level `tags` array — tag definitions with descriptions. The tag *names*
   * on operations come from `@Tags`; this adds their descriptions/metadata.
   */
  tags?: OpenAPIV3_1.TagObject[] | undefined;
  /**
   * Standalone schemas to emit under `components.schemas`, in addition to those
   * referenced by routes. Each must be named via `.meta({ id })`. Useful for
   * types not tied to any HTTP route (e.g. WebSocket message shapes) so client
   * generators still produce them.
   */
  schemas?: ZodType[] | undefined;
}

/**
 * A controller to document: its prototype (where decorator metadata lives) plus
 * an optional registration-time `basePrefix` (e.g. a `/v1` version segment) that
 * is prepended to the controller's own `@Route` prefix.
 */
export interface ControllerSource {
  /** The controller prototype (where decorator metadata is stored). */
  prototype: object;
  /** Base path prepended to the controller's `@Route` prefix; defaults to none. */
  basePrefix?: string | undefined;
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
  return z.toJSONSchema(schema, {
    // `z.date()` (and other types JSON Schema can't represent) would otherwise
    // throw; emit them as `any` and then give dates the conventional OpenAPI
    // representation. A JS `Date` travels as an ISO string over JSON.
    unrepresentable: 'any',
    override: (ctx) => {
      const def = (ctx.zodSchema as { _zod?: { def?: { type?: string } } })._zod?.def;
      if (def?.type === 'date') {
        ctx.jsonSchema.type = 'string';
        ctx.jsonSchema.format = 'date-time';
      }
    },
  });
}

/**
 * OpenAPI `info` block. `title` and `version` are required; the rest of the
 * OpenAPI Info Object (`description`, `summary`, `termsOfService`, `contact`,
 * `license`) is optional and emitted verbatim.
 */
export type OpenApiInfo = OpenAPIV3_1.InfoObject;

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
 * (OpenAPI uses the same curly-brace syntax avero routes are written in).
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
 * Header names that must not be expressed as `in: header` parameters — OpenAPI
 * defines these elsewhere (content negotiation / security) and ignores them as
 * parameters. Compared case-insensitively.
 */
const RESERVED_HEADERS = new Set(['authorization', 'accept', 'content-type']);

/**
 * Walks controller metadata (read off each prototype) and hand-assembles an
 * OpenAPI 3.1 document. Named schemas accumulate in `components.schemas`.
 */
class DocumentBuilder {
  private readonly schemas: Record<string, OpenAPIV3_1.SchemaObject> = {};
  /** Named discriminated unions found while converting, keyed by component id. */
  private readonly discriminators = new Map<string, DiscriminatorInfo>();

  public build(
    sources: ControllerSource[],
    info: OpenApiInfo,
    options: OpenApiOptions = {},
  ): OpenApiDocument {
    const paths: OpenAPIV3_1.PathsObject = {};
    for (const { prototype: proto, basePrefix } of sources) {
      // The registration-time base path (e.g. `/v1`) sits in front of the
      // controller's own `@Route` prefix; the join collapses empty segments.
      const prefix = basePrefix ? `${basePrefix}/${getPrefix(proto)}` : getPrefix(proto);
      for (const route of getRoutes(proto)) {
        const path = toOpenApiPath(prefix, route.path);
        const item: OpenAPIV3_1.PathItemObject = paths[path] ?? {};
        (item as Record<string, OpenAPIV3_1.OperationObject>)[route.method] = this.operation(route);
        paths[path] = item;
      }
    }
    // Standalone schemas (not referenced by any route) → components.schemas.
    for (const schema of options.schemas ?? []) {
      this.registerStandaloneSchema(schema);
    }
    // All components are registered now; attach `discriminator` to any that came
    // from a named `z.discriminatedUnion`.
    this.applyDiscriminators();
    const components: OpenAPIV3_1.ComponentsObject = { schemas: this.schemas };
    if (options.securitySchemes && Object.keys(options.securitySchemes).length > 0) {
      components.securitySchemes = options.securitySchemes;
    }
    const document: OpenApiDocument = {
      openapi: '3.1.0',
      info,
      paths,
      components,
    };
    // Top-level document metadata — emitted verbatim when provided.
    if (options.servers) {
      document.servers = options.servers;
    }
    if (options.externalDocs) {
      document.externalDocs = options.externalDocs;
    }
    if (options.tags) {
      document.tags = options.tags;
    }
    return document;
  }

  private operation(route: RouteMetadata): OpenAPIV3_1.OperationObject {
    const examples = route.examples ?? [];
    const parameters: OpenAPIV3_1.ParameterObject[] = [
      ...(route.params ? this.parameters(route.params, 'path') : []),
      ...(route.query ? this.parameters(route.query, 'query') : []),
      ...(route.headers ? this.parameters(route.headers, 'header') : []),
      ...(route.cookies ? this.parameters(route.cookies, 'cookie') : []),
    ];
    const responses: Record<string, OpenAPIV3_1.ResponseObject> = {};
    for (const [status, decl] of Object.entries(route.responses)) {
      // A file response wins the description fallback; otherwise the @Returns one.
      const response: OpenAPIV3_1.ResponseObject = {
        description: decl.file?.description ?? decl.description ?? '',
      };
      if (decl.file) {
        // Binary/file response (@ReturnsFile) advertises a binary body.
        response.content = {
          [decl.file.contentType]: { schema: { type: 'string', format: 'binary' } },
        };
      } else if (decl.sse) {
        // SSE (@Sse) — text/event-stream; document the per-event data shape.
        response.content = {
          'text/event-stream': decl.sse.eventSchema
            ? this.media(decl.sse.eventSchema)
            : { schema: { type: 'string' } },
        };
      } else if (decl.schema) {
        // A status declared with no schema (e.g. 204) has no response body.
        const example = examples.find((e) => e.status === Number(status));
        response.content = { 'application/json': this.media(decl.schema, example) };
      }
      if (decl.headers) {
        response.headers = Object.fromEntries(
          Object.entries(decl.headers).map(([name, schema]) => [
            name,
            { schema: asParameterSchema(this.toJson(schema)) },
          ]),
        );
      }
      responses[status] = response;
    }

    const operation: OpenAPIV3_1.OperationObject = { responses };
    if (route.tags && route.tags.length > 0) {
      operation.tags = route.tags;
    }
    if (route.summary) {
      operation.summary = route.summary;
    }
    if (route.description) {
      operation.description = route.description;
    }
    // Defaults to the handler method name; @OperationId overrides. (Operation ids
    // must be unique across the document — override when method names collide.)
    operation.operationId = route.operationId ?? route.handlerName;
    if (route.deprecated) {
      operation.deprecated = true;
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
    const json = toJsonSchema(schema) as unknown as JsonObject;
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
    const json = toJsonSchema(schema) as unknown as JsonObject;
    this.hoist(json);
    // Record any named discriminated unions reachable from here (incl. nested),
    // so `discriminator` can be attached once every component is registered.
    collectDiscriminators(schema, this.discriminators);
    const id = schema.meta()?.id;
    if (typeof id === 'string') {
      this.schemas[id] = asSchemaObject(json);
      return { $ref: `#/components/schemas/${id}` } as OpenAPIV3_1.SchemaObject;
    }
    return asSchemaObject(json);
  }

  /**
   * Attaches `discriminator` to each registered component that came from a named
   * `z.discriminatedUnion`. Only applies to a component whose body is a `oneOf`
   * (the form `z.discriminatedUnion` produces); a `mapping` is set when every
   * variant is named.
   */
  private applyDiscriminators(): void {
    for (const [id, info] of this.discriminators) {
      const target = this.schemas[id] as Record<string, unknown> | undefined;
      if (!target || !Array.isArray(target['oneOf'])) {
        continue;
      }
      const discriminator: Record<string, unknown> = { propertyName: info.propertyName };
      if (info.mapping) {
        discriminator['mapping'] = info.mapping;
      }
      target['discriminator'] = discriminator;
    }
  }

  /**
   * Registers a standalone schema into `components.schemas`. It must be named via
   * `.meta({ id })` — an anonymous schema has no key to register under, so it's
   * rejected rather than silently dropped.
   */
  private registerStandaloneSchema(schema: ZodType): void {
    if (typeof schema.meta()?.id !== 'string') {
      throw new Error('avero: schemas passed to registerSchemas must be named via .meta({ id })');
    }
    // `schema()` converts, hoists nested named schemas, and registers this one.
    this.schema(schema);
  }

  /**
   * Decomposes a `@Params`/`@Query`/`@Headers`/`@Cookies` object schema into
   * individual OpenAPI parameters — one per property. Path parameters are always
   * required. A property marked `.meta({ deprecated: true })` sets `deprecated`
   * on the parameter object itself (the canonical OpenAPI location, vs. the
   * nested schema). Reserved headers (`authorization`/`accept`/`content-type`)
   * are dropped from the `header` location: OpenAPI handles those elsewhere and
   * ignores them as parameters.
   */
  private parameters(
    schema: ZodType,
    location: 'path' | 'query' | 'header' | 'cookie',
  ): OpenAPIV3_1.ParameterObject[] {
    const json = toJsonSchema(schema) as unknown as JsonObject;
    this.hoist(json);
    const properties = (json['properties'] ?? {}) as Record<string, JsonSchema>;
    const required = new Set((json['required'] as string[] | undefined) ?? []);
    return Object.entries(properties)
      .filter(([name]) => !(location === 'header' && RESERVED_HEADERS.has(name.toLowerCase())))
      .map(([name, propSchema]) => {
        const parameter: OpenAPIV3_1.ParameterObject = {
          name,
          in: location,
          required: location === 'path' ? true : required.has(name),
          schema: asParameterSchema(propSchema),
        };
        // Hoist a property-level `deprecated` onto the parameter, dropping the
        // redundant nested copy so the output matches a hand-written spec.
        if (typeof propSchema === 'object' && propSchema['deprecated'] === true) {
          parameter.deprecated = true;
          delete propSchema['deprecated'];
        }
        return parameter;
      });
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
 * Builds an OpenAPI 3.1 document from controller sources (prototype + optional
 * registration `basePrefix`). Independent of route mounting — only reads
 * class-level metadata.
 */
export function generateOpenApiDocument(
  sources: ControllerSource[],
  info: OpenApiInfo,
  options: OpenApiOptions = {},
): OpenApiDocument {
  const document = new DocumentBuilder().build(sources, info, options);
  // The builder always emits 3.1 (avero's native form); down-convert if asked.
  return options.specVersion === '3.0' ? downConvertToV30(document) : document;
}

/**
 * One static controller for {@link generateSwagger}: either a controller class
 * directly, or a class wrapped with a registration-time `prefix` (the static
 * analogue of `api.register(c, { prefix })` / `api.group(prefix, …)`).
 */
export type StaticController =
  | { prototype: object }
  | { controller: { prototype: object }; prefix?: string | undefined };

/**
 * Standalone, instance-free OpenAPI generation: pass the controller classes
 * directly. Swagger is derived entirely from class-level metadata, so no
 * instances (and thus no dependency wiring) are needed — the lightest path for
 * CI spec checks and client codegen.
 *
 * @param controllers - The controller classes (constructors, not instances).
 *   To mirror grouped/prefixed registration, wrap a class as
 *   `{ controller, prefix }` to prepend a base path (e.g. `{ controller: UsersController, prefix: '/v1' }`).
 * @param info - OpenAPI `info` block. Defaults to `{ title: 'API', version: '1.0.0' }`.
 * @param options - Extra inputs: `securitySchemes` (needed when routes use
 *   `@Security`, since scheme definitions aren't carried on the classes) and
 *   `specVersion` (`'3.1'` by default; `'3.0'` to down-convert).
 * @returns The assembled OpenAPI document (3.1 by default).
 *
 * @example
 * ```ts
 * const doc = generateSwagger([UsersController, HealthController]);
 * const v1 = generateSwagger([{ controller: UsersController, prefix: '/v1' }]);
 * ```
 */
export function generateSwagger(
  controllers: StaticController[],
  info: OpenApiInfo = { title: 'API', version: '1.0.0' },
  options: OpenApiOptions = {},
): OpenApiDocument {
  return generateOpenApiDocument(
    controllers.map((c) =>
      'controller' in c
        ? { prototype: c.controller.prototype, basePrefix: c.prefix }
        : { prototype: c.prototype },
    ),
    info,
    options,
  );
}
