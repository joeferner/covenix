// The inlined fetch runtime for the default (non-validating) standalone client.
// Authored with String.raw so regex backslashes are literal; intentionally uses
// string concatenation (no template literals / `${}`) so it survives unescaped.
export const RUNTIME = String.raw`/** Options for the generated client. */
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

interface OperationSpec {
  method: string;
  path: string;
  mediaType?: string;
  stream?: boolean;
  binary?: boolean;
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
  const url = buildUrl(options.baseUrl, spec.path, args?.params, args?.query);
  const headers = await resolveHeaders(options.headers);
  Object.assign(headers, args?.headers);
  let body: BodyInit | undefined;
  if (args?.body !== undefined) {
    if (spec.mediaType === 'multipart/form-data') {
      body = toFormData(args.body); // the runtime sets the multipart boundary
    } else {
      if (!('content-type' in headers)) headers['content-type'] = 'application/json';
      body = JSON.stringify(args.body);
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
  return parseBody(res);
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
  else body = await parseBody(res);
  return { status: res.status, body, headers: res.headers };
}`;
