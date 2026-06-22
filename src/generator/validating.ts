import type { ContractOperation, SchemaNode } from '../contract.js';
import { propKey } from './contract-client.js';

// ---------------------------------------------------------------------------
// Schema node → Zod source (validating client only)
// ---------------------------------------------------------------------------

/** The runtime const name holding a named schema's Zod validator. */
function schemaConst(id: string): string {
  return `${id}$schema`;
}

/** Renders a literal value as a `z.literal(...)` (or `z.null()`). */
function zodLiteral(value: string | number | boolean | null): string {
  return value === null ? 'z.null()' : `z.literal(${JSON.stringify(value)})`;
}

/**
 * Renders a {@link SchemaNode} as Zod **source** for the validating client. Named
 * schemas are referenced via `z.lazy(() => Id$schema)` (handles forward/recursive
 * refs); `date` becomes `z.coerce.date()` so ISO strings revive to real `Date`s.
 * Lossy nodes (`unsupported`/`any`) fall back to `z.any()`.
 */
function zodExpr(node: SchemaNode): string {
  switch (node.kind) {
    case 'ref':
      return `z.lazy(() => ${schemaConst(node.id)})`;
    case 'string': {
      let s = 'z.string()';
      if (node.format) {
        s += zodStringFormat(node.format);
      }
      if (node.minLength !== undefined) {
        s += `.min(${node.minLength})`;
      }
      if (node.maxLength !== undefined) {
        s += `.max(${node.maxLength})`;
      }
      if (node.pattern !== undefined) {
        s += `.regex(new RegExp(${JSON.stringify(node.pattern)}))`;
      }
      return s;
    }
    case 'number': {
      let s = node.int ? 'z.number().int()' : 'z.number()';
      if (node.minimum !== undefined) {
        s += `.min(${node.minimum})`;
      }
      if (node.maximum !== undefined) {
        s += `.max(${node.maximum})`;
      }
      if (node.exclusiveMinimum !== undefined) {
        s += `.gt(${node.exclusiveMinimum})`;
      }
      if (node.exclusiveMaximum !== undefined) {
        s += `.lt(${node.exclusiveMaximum})`;
      }
      if (node.multipleOf !== undefined) {
        s += `.multipleOf(${node.multipleOf})`;
      }
      return s;
    }
    case 'boolean':
      return 'z.boolean()';
    case 'date':
      // Revive an ISO string (the JSON wire form) into a real Date.
      return 'z.coerce.date()';
    case 'null':
      return 'z.null()';
    case 'unknown':
      return 'z.unknown()';
    case 'any':
    case 'unsupported':
      // No faithful reconstruction — accept anything rather than over-reject.
      return 'z.any()';
    case 'file':
      // Files only appear in multipart request bodies; don't over-validate them.
      return 'z.any()';
    case 'literal':
      return node.values.length === 1
        ? zodLiteral(node.values[0]!)
        : `z.union([${node.values.map(zodLiteral).join(', ')}])`;
    case 'enum':
      return node.values.every((v) => typeof v === 'string')
        ? `z.enum(${JSON.stringify(node.values)})`
        : `z.union([${node.values.map(zodLiteral).join(', ')}])`;
    case 'array': {
      let s = `z.array(${zodExpr(node.element)})`;
      if (node.minItems !== undefined) {
        s += `.min(${node.minItems})`;
      }
      if (node.maxItems !== undefined) {
        s += `.max(${node.maxItems})`;
      }
      return s;
    }
    case 'tuple': {
      let s = `z.tuple([${node.items.map(zodExpr).join(', ')}])`;
      if (node.rest) {
        s += `.rest(${zodExpr(node.rest)})`;
      }
      return s;
    }
    case 'union':
    case 'discriminatedUnion':
      // A plain union validates the same as a discriminated one; the discriminator
      // is only an error/perf optimization, and `z.discriminatedUnion` can't type
      // variants that are `z.lazy(() => …)` refs (the discriminator key is hidden).
      return `z.union([${node.variants.map(zodExpr).join(', ')}])`;
    case 'record':
      return `z.record(${zodExpr(node.key)}, ${zodExpr(node.value)})`;
    case 'nullable':
      return `${zodExpr(node.inner)}.nullable()`;
    case 'optional':
      return `${zodExpr(node.inner)}.optional()`;
    case 'default':
      return `${zodExpr(node.inner)}.default(${JSON.stringify(node.value)})`;
    case 'object': {
      const props = Object.entries(node.properties).map(([name, prop]) => {
        let pe = zodExpr(prop.schema);
        if (prop.default !== undefined) {
          pe += `.default(${JSON.stringify(prop.default)})`;
        } else if (prop.optional) {
          pe += '.optional()';
        }
        return `${propKey(name)}: ${pe}`;
      });
      const obj = `z.object({ ${props.join(', ')} })`;
      return node.additionalProperties
        ? `${obj}.catchall(${zodExpr(node.additionalProperties)})`
        : obj;
    }
  }
}

/** Maps a string `format` to a Zod refinement (empty when unrecognized). */
function zodStringFormat(format: string): string {
  switch (format) {
    case 'email':
      return '.email()';
    case 'uuid':
    case 'guid':
      return '.uuid()';
    case 'url':
    case 'uri':
      return '.url()';
    case 'emoji':
      return '.emoji()';
    case 'cuid':
      return '.cuid()';
    case 'ulid':
      return '.ulid()';
    default:
      // datetime/date/duration/ip/etc. — left unconstrained to avoid false rejects
      // on payloads the server already validated against the real schema.
      return '';
  }
}

/** Zod validator consts for the contract's named schemas (validating client only). */
export function emitValidators(schemas: Record<string, SchemaNode>): string {
  const decls = Object.entries(schemas).map(
    ([id, node]) => `const ${schemaConst(id)}: z.ZodType<${id}> = ${zodExpr(node)};`,
  );
  return decls.join('\n');
}

/** The validator entries (params/query/body/per-status responses) for an operation. */
export function specValidators(op: ContractOperation): string[] {
  const parts: string[] = [];
  if (op.params) {
    parts.push(`params: ${zodExpr(op.params)}`);
  }
  if (op.query) {
    parts.push(`query: ${zodExpr(op.query)}`);
  }
  if (op.body) {
    parts.push(`body: ${zodExpr(op.body.schema)}`);
  }
  // Only JSON responses get a validator; file/SSE bodies aren't parsed as JSON.
  const responseArms = Object.entries(op.responses)
    .filter(([, response]) => response.schema !== undefined)
    .map(([status, response]) => `${status}: ${zodExpr(response.schema as SchemaNode)}`);
  if (responseArms.length > 0) {
    parts.push(`responses: { ${responseArms.join(', ')} }`);
  }
  return parts;
}

// The validating runtime: same shape as RUNTIME, but it validates/parses request
// inputs and response bodies through the generated Zod schemas (and revives dates).
// Kept as a separate, self-contained block so the default client carries none of it.
export const VALIDATING_RUNTIME = String.raw`/** Options for the generated client. */
export interface ClientOptions {
  /** Base URL the operation paths are appended to. */
  baseUrl: string;
  /** Static or lazily-resolved default headers (e.g. auth). */
  headers?: Record<string, string | (() => string | Promise<string>)>;
  /** Custom fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
}

/** Thrown by the default call form on a non-2xx response; carries the parsed body. */
export class AveroClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly headers: Headers,
  ) {
    super('avero client: request failed with status ' + status);
    this.name = 'AveroClientError';
  }
}

/**
 * Thrown when a request input or response body fails its schema. The underlying
 * ZodError is on '.cause'.
 */
export class AveroClientValidationError extends Error {
  public readonly phase: 'request' | 'response';
  constructor(phase: 'request' | 'response', options?: { cause?: unknown }) {
    super('avero client: ' + phase + ' validation failed', options);
    this.phase = phase;
    this.name = 'AveroClientValidationError';
  }
}

interface OperationSpec {
  method: string;
  path: string;
  mediaType?: string;
  stream?: boolean;
  binary?: boolean;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  responses?: Record<number, z.ZodType>;
}

interface RequestArgs {
  params?: Record<string, string | number | boolean>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

interface RawResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

/** Parses a value through a schema (when present), wrapping failures. */
function runValidate<T>(schema: z.ZodType | undefined, value: T, phase: 'request' | 'response'): T {
  if (!schema) return value;
  const result = schema.safeParse(value);
  if (!result.success) throw new AveroClientValidationError(phase, { cause: result.error });
  return result.data as T;
}

async function resolveHeaders(
  headers: ClientOptions['headers'],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = typeof value === 'function' ? await value() : value;
  }
  return out;
}

function buildUrl(
  baseUrl: string,
  path: string,
  params?: RequestArgs['params'],
  query?: RequestArgs['query'],
): string {
  const withParams = path.replace(/\{([^}]+)}/g, (_m: string, key: string) =>
    encodeURIComponent(String(params?.[key] ?? '')),
  );
  let url = baseUrl.replace(/\/$/, '') + withParams;
  if (query) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) qs.append(key, String(item));
      else qs.append(key, String(value));
    }
    const search = qs.toString();
    if (search) url += '?' + search;
  }
  return url;
}

function toFormData(body: unknown): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) form.append(key, item as Blob | string);
    else form.append(key, value as Blob | string);
  }
  return form;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  const text = await res.text();
  return text === '' ? undefined : text;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

async function fetchRaw(
  options: ClientOptions,
  spec: OperationSpec,
  args?: RequestArgs,
): Promise<Response> {
  const fetchFn = options.fetch ?? fetch;
  const params = runValidate(spec.params, args?.params, 'request');
  const query = runValidate(spec.query, args?.query, 'request');
  const url = buildUrl(options.baseUrl, spec.path, params, query);
  const headers = await resolveHeaders(options.headers);
  Object.assign(headers, args?.headers);
  let body: BodyInit | undefined;
  if (args?.body !== undefined) {
    const validated = runValidate(spec.body, args.body, 'request');
    if (spec.mediaType === 'multipart/form-data') {
      body = toFormData(validated); // the runtime sets the multipart boundary
    } else {
      if (!('content-type' in headers)) headers['content-type'] = 'application/json';
      body = JSON.stringify(validated);
    }
  }
  if (spec.stream && !('accept' in headers)) headers['accept'] = 'text/event-stream';
  return fetchFn(url, { method: spec.method.toUpperCase(), headers, body });
}

/** Reads a text/event-stream body, yielding each event's parsed data payload. */
async function* sseStream(res: Response): AsyncGenerator<unknown> {
  const stream = res.body;
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const data = parseSseFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (data !== undefined) yield data;
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel();
  }
}

/** Extracts and parses the data payload from one SSE frame (ignores comments). */
function parseSseFrame(frame: string): unknown {
  const lines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) lines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
  }
  if (lines.length === 0) return undefined;
  const payload = lines.join('\n');
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function responseValidator(spec: OperationSpec, status: number): z.ZodType | undefined {
  return spec.responses ? spec.responses[status] : undefined;
}

async function request(
  options: ClientOptions,
  spec: OperationSpec,
  args?: RequestArgs,
): Promise<unknown> {
  const res = await fetchRaw(options, spec, args);
  if (!isOk(res.status)) {
    throw new AveroClientError(res.status, await parseBody(res), res.headers);
  }
  if (spec.stream) return sseStream(res);
  if (spec.binary) return res.blob();
  return runValidate(responseValidator(spec, res.status), await parseBody(res), 'response');
}

async function requestRaw(
  options: ClientOptions,
  spec: OperationSpec,
  args?: RequestArgs,
): Promise<RawResponse> {
  const res = await fetchRaw(options, spec, args);
  let body: unknown;
  if (isOk(res.status) && spec.stream) body = sseStream(res);
  else if (isOk(res.status) && spec.binary) body = await res.blob();
  else body = runValidate(responseValidator(spec, res.status), await parseBody(res), 'response');
  return { status: res.status, body, headers: res.headers };
}`;
