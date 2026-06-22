import { z, type ZodType } from 'zod';
import { getPrefix, getRoutes, type ResponseMetadata } from './metadata.js';
import { isMultipart } from './multipart.js';
import { SchemaConverter } from './contract-convert.js';
import type { ControllerSource, OpenApiInfo, StaticController } from './swagger.js';

/**
 * The covenix **contract** — a high-fidelity, language-agnostic intermediate
 * representation of an API, produced from the same controller metadata that
 * drives `swagger()`. Unlike OpenAPI it is purpose-built for client codegen: a
 * flat operations list and a schema representation ({@link SchemaNode}) that
 * keeps the semantic kinds JSON Schema flattens.
 *
 * The IR is defined here **with Zod**, so it validates on write (the generator
 * parses its own output) and on read ({@link parseContract} for any generator),
 * and the TypeScript types are inferred from these schemas. The recursive
 * {@link SchemaNode} is the one hand-written type — Zod recursion needs the
 * annotation — and everything else is `z.infer`red.
 */

/** The contract IR version. Bumped on any breaking change to the shape below. */
export const CONTRACT_VERSION = '0.1';

/**
 * A node in the contract's schema tree (see {@link SchemaNodeSchema} for the
 * runtime validator). Intentionally not JSON Schema: `date`/`file` are real
 * kinds, discriminated unions are first-class, and object optionality is
 * per-property. Constructs the v1 set doesn't model become an `unsupported` node
 * that embeds JSON Schema, so nothing is silently lost.
 */
export type SchemaNode =
  | { kind: 'ref'; id: string }
  | {
      kind: 'string';
      format?: string | undefined;
      minLength?: number | undefined;
      maxLength?: number | undefined;
      pattern?: string | undefined;
    }
  | {
      kind: 'number';
      int?: boolean | undefined;
      minimum?: number | undefined;
      maximum?: number | undefined;
      exclusiveMinimum?: number | undefined;
      exclusiveMaximum?: number | undefined;
      multipleOf?: number | undefined;
    }
  | { kind: 'boolean' }
  | { kind: 'literal'; values: (string | number | boolean | null)[] }
  | { kind: 'enum'; values: (string | number)[] }
  | {
      kind: 'object';
      properties: Record<string, PropertyNode>;
      additionalProperties?: SchemaNode | false | undefined;
      description?: string | undefined;
    }
  | {
      kind: 'array';
      element: SchemaNode;
      minItems?: number | undefined;
      maxItems?: number | undefined;
    }
  | { kind: 'tuple'; items: SchemaNode[]; rest?: SchemaNode | undefined }
  | { kind: 'union'; variants: SchemaNode[] }
  | { kind: 'discriminatedUnion'; discriminator: string; variants: SchemaNode[] }
  | { kind: 'record'; key: SchemaNode; value: SchemaNode }
  | { kind: 'nullable'; inner: SchemaNode }
  | { kind: 'optional'; inner: SchemaNode }
  | { kind: 'default'; inner: SchemaNode; value: unknown }
  | { kind: 'date' }
  | { kind: 'file' }
  | { kind: 'null' }
  | { kind: 'unknown' }
  | { kind: 'any' }
  | { kind: 'unsupported'; jsonSchema: unknown };

/** One property of an object node: its schema plus optionality / default. */
export interface PropertyNode {
  schema: SchemaNode;
  optional?: boolean | undefined;
  default?: unknown;
  description?: string | undefined;
}

/** Validator for a single object property. */
const PropertyNodeSchema: z.ZodType<PropertyNode> = z.object({
  schema: z.lazy(() => SchemaNodeSchema),
  optional: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

/** Runtime validator for {@link SchemaNode}. */
export const SchemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ref'), id: z.string() }),
    z.object({
      kind: z.literal('string'),
      format: z.string().optional(),
      minLength: z.number().optional(),
      maxLength: z.number().optional(),
      pattern: z.string().optional(),
    }),
    z.object({
      kind: z.literal('number'),
      int: z.boolean().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      exclusiveMinimum: z.number().optional(),
      exclusiveMaximum: z.number().optional(),
      multipleOf: z.number().optional(),
    }),
    z.object({ kind: z.literal('boolean') }),
    z.object({
      kind: z.literal('literal'),
      values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
    z.object({ kind: z.literal('enum'), values: z.array(z.union([z.string(), z.number()])) }),
    z.object({
      kind: z.literal('object'),
      properties: z.record(z.string(), PropertyNodeSchema),
      additionalProperties: z.union([z.lazy(() => SchemaNodeSchema), z.literal(false)]).optional(),
      description: z.string().optional(),
    }),
    z.object({
      kind: z.literal('array'),
      element: z.lazy(() => SchemaNodeSchema),
      minItems: z.number().optional(),
      maxItems: z.number().optional(),
    }),
    z.object({
      kind: z.literal('tuple'),
      items: z.array(z.lazy(() => SchemaNodeSchema)),
      rest: z.lazy(() => SchemaNodeSchema).optional(),
    }),
    z.object({ kind: z.literal('union'), variants: z.array(z.lazy(() => SchemaNodeSchema)) }),
    z.object({
      kind: z.literal('discriminatedUnion'),
      discriminator: z.string(),
      variants: z.array(z.lazy(() => SchemaNodeSchema)),
    }),
    z.object({
      kind: z.literal('record'),
      key: z.lazy(() => SchemaNodeSchema),
      value: z.lazy(() => SchemaNodeSchema),
    }),
    z.object({ kind: z.literal('nullable'), inner: z.lazy(() => SchemaNodeSchema) }),
    z.object({ kind: z.literal('optional'), inner: z.lazy(() => SchemaNodeSchema) }),
    z.object({
      kind: z.literal('default'),
      inner: z.lazy(() => SchemaNodeSchema),
      value: z.unknown(),
    }),
    z.object({ kind: z.literal('date') }),
    z.object({ kind: z.literal('file') }),
    z.object({ kind: z.literal('null') }),
    z.object({ kind: z.literal('unknown') }),
    z.object({ kind: z.literal('any') }),
    z.object({ kind: z.literal('unsupported'), jsonSchema: z.unknown() }),
  ]),
);

/** HTTP methods a contract operation can use. */
const MethodSchema = z.enum(['get', 'post', 'put', 'patch', 'delete']);

/** A single `@Security` requirement on an operation. */
const SecurityRequirementSchema = z.object({
  scheme: z.string(),
  scopes: z.array(z.string()),
});

/** The request body of an operation: its media type and schema. */
export const ContractBodySchema = z.object({
  mediaType: z.string(),
  schema: SchemaNodeSchema,
});

/**
 * One declared response. Exactly one body kind is present (a JSON `schema`, a
 * `file`, or an `sse` stream); `headers` annotate it. A status with no body
 * (e.g. `204`) has none set. Policy — how a client surfaces success vs error —
 * is left to the generator; the contract only records the facts.
 */
export const ContractResponseSchema = z.object({
  schema: SchemaNodeSchema.optional(),
  file: z.object({ contentType: z.string() }).optional(),
  sse: z.object({ schema: SchemaNodeSchema.optional() }).optional(),
  headers: z.record(z.string(), SchemaNodeSchema).optional(),
});

/** A single API operation (one route), with its request/response schemas. */
export const ContractOperationSchema = z.object({
  operationId: z.string(),
  method: MethodSchema,
  path: z.string(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  deprecated: z.boolean().optional(),
  params: SchemaNodeSchema.optional(),
  query: SchemaNodeSchema.optional(),
  headers: SchemaNodeSchema.optional(),
  cookies: SchemaNodeSchema.optional(),
  body: ContractBodySchema.optional(),
  responses: z.record(z.string(), ContractResponseSchema),
  security: z.array(SecurityRequirementSchema).optional(),
});

/** The contract document: version, info, the flat operations list, and shared schemas. */
export const CovenixContractSchema = z.object({
  covenixContract: z.literal(CONTRACT_VERSION),
  info: z.object({ title: z.string(), version: z.string() }).loose(),
  operations: z.array(ContractOperationSchema),
  schemas: z.record(z.string(), SchemaNodeSchema),
});

/** A contract request body (`{ mediaType, schema }`). */
export type ContractBody = z.infer<typeof ContractBodySchema>;
/** A single declared response in the contract. */
export type ContractResponse = z.infer<typeof ContractResponseSchema>;
/** A single operation in the contract. */
export type ContractOperation = z.infer<typeof ContractOperationSchema>;
/** A complete covenix contract document. */
export type CovenixContract = z.infer<typeof CovenixContractSchema>;

/**
 * Validates an unknown value as a {@link CovenixContract} — use this when reading a
 * `contract.json` in a generator. Throws (with a version-mismatch error for an
 * unrecognised `covenixContract`) if it doesn't conform.
 *
 * @param value - The parsed JSON to validate.
 * @returns The validated contract.
 */
export function parseContract(value: unknown): CovenixContract {
  return CovenixContractSchema.parse(value);
}

/**
 * Joins a registration base path, the controller's `@Route` prefix, and the
 * route path into one path, collapsing duplicate slashes and keeping `{id}`
 * placeholders (the same form OpenAPI uses).
 */
function contractPath(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return joined === '' ? '/' : joined;
}

/** Builds a {@link ContractResponse} from a route's per-status metadata. */
function contractResponse(decl: ResponseMetadata, convert: SchemaConverter): ContractResponse {
  const response: ContractResponse = {};
  if (decl.file) {
    response.file = { contentType: decl.file.contentType };
  } else if (decl.sse) {
    response.sse = decl.sse.eventSchema ? { schema: convert.toNode(decl.sse.eventSchema) } : {};
  } else if (decl.schema) {
    response.schema = convert.toNode(decl.schema);
  }
  if (decl.headers) {
    response.headers = Object.fromEntries(
      Object.entries(decl.headers).map(([name, schema]) => [name, convert.toNode(schema)]),
    );
  }
  return response;
}

/** Options for contract generation. */
export interface ContractOptions {
  /**
   * Route-less named schemas to add to `schemas`, beyond those referenced by
   * routes — e.g. WebSocket/event message shapes or shared DTOs not tied to any
   * HTTP route. Each must be named via `.meta({ id })`. Mirrors the `schemas`
   * option of `swagger()`.
   */
  schemas?: ZodType[] | undefined;
}

/**
 * Assembles a {@link CovenixContract} from controller sources (prototype + optional
 * registration `basePrefix`). All operations share one {@link SchemaConverter}, so
 * named schemas are hoisted once into `schemas`. The result is validated against
 * {@link CovenixContractSchema} before return (validate-on-write).
 */
export function generateContractDocument(
  sources: ControllerSource[],
  info: OpenApiInfo,
  options: ContractOptions = {},
): CovenixContract {
  const convert = new SchemaConverter();
  const operations: ContractOperation[] = [];

  for (const { prototype: proto, basePrefix } of sources) {
    const prefix = basePrefix ? `${basePrefix}/${getPrefix(proto)}` : getPrefix(proto);
    for (const route of getRoutes(proto)) {
      const operation: ContractOperation = {
        operationId: route.operationId ?? route.handlerName,
        method: route.method,
        path: contractPath(prefix, route.path),
        responses: Object.fromEntries(
          Object.entries(route.responses).map(([status, decl]) => [
            status,
            contractResponse(decl, convert),
          ]),
        ),
        ...(route.tags && route.tags.length > 0 ? { tags: route.tags } : {}),
        ...(route.summary !== undefined ? { summary: route.summary } : {}),
        ...(route.description !== undefined ? { description: route.description } : {}),
        ...(route.deprecated ? { deprecated: true } : {}),
        ...(route.params ? { params: convert.toNode(route.params) } : {}),
        ...(route.query ? { query: convert.toNode(route.query) } : {}),
        ...(route.headers ? { headers: convert.toNode(route.headers) } : {}),
        ...(route.cookies ? { cookies: convert.toNode(route.cookies) } : {}),
        ...(route.body
          ? {
              body: {
                mediaType: isMultipart(route.body) ? 'multipart/form-data' : 'application/json',
                schema: convert.toNode(route.body),
              },
            }
          : {}),
        ...(route.security && route.security.length > 0 ? { security: route.security } : {}),
      };
      operations.push(operation);
    }
  }

  // Route-less schemas → add to `schemas` (each must be named so it has a key).
  for (const schema of options.schemas ?? []) {
    if (typeof schema.meta()?.id !== 'string') {
      throw new Error('covenix: schemas passed to generateContract must be named via .meta({ id })');
    }
    convert.toNode(schema);
  }

  const contract: CovenixContract = {
    covenixContract: CONTRACT_VERSION,
    info,
    operations,
    schemas: convert.schemas,
  };
  // Validate on write — the generator's own output must satisfy the IR schema.
  return CovenixContractSchema.parse(contract);
}

/**
 * Standalone, instance-free contract generation: pass the controller **classes**
 * directly (or `{ controller, prefix }` to mirror grouped registration). The
 * contract is derived entirely from class-level metadata — no instances, no
 * dependency wiring — making this the path for build-time client codegen.
 *
 * @param controllers - The controller classes (constructors, not instances).
 * @param info - Contract `info` block. Defaults to `{ title: 'API', version: '1.0.0' }`.
 * @param options - Extra inputs, e.g. route-less `schemas`.
 * @returns The validated {@link CovenixContract}.
 *
 * @example
 * ```ts
 * const contract = generateContract([UsersController, HealthController]);
 * await writeFile('contract.json', JSON.stringify(contract, null, 2));
 * ```
 */
export function generateContract(
  controllers: StaticController[],
  info: OpenApiInfo = { title: 'API', version: '1.0.0' },
  options: ContractOptions = {},
): CovenixContract {
  const sources: ControllerSource[] = controllers.map((c) =>
    'controller' in c
      ? { prototype: c.controller.prototype, basePrefix: c.prefix }
      : { prototype: c.prototype },
  );
  return generateContractDocument(sources, info, options);
}
