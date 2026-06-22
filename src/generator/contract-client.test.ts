import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import {
  Body,
  Deprecated,
  Description,
  Get,
  Params,
  Post,
  Returns,
  ReturnsFile,
  Route,
  Sse,
  Summary,
  Tags,
} from '../decorators.js';
import { generateContract } from '../contract.js';
import { generateTypeScriptClient } from './contract-client.js';

const User = z.object({ id: z.uuid(), name: z.string() }).meta({ id: 'User' });
const CreateUser = z.object({ name: z.string() }).meta({ id: 'CreateUser' });
const ApiError = z.object({ message: z.string() }).meta({ id: 'ApiError' });

@Route('users')
@Tags('Users')
class UsersController {
  @Get('{id}')
  @Params(z.object({ id: z.uuid() }))
  @Returns(200, User)
  @Returns(404, ApiError)
  public get(): unknown {
    return null;
  }

  @Post()
  @Body(CreateUser)
  @Returns(201, User)
  public create(): unknown {
    return null;
  }

  @Post('{id}/avatar')
  @Params(z.object({ id: z.uuid() }))
  @Body(z.object({ avatar: z.file(), caption: z.string().optional() }))
  @Returns(200, z.object({ ok: z.boolean() }))
  public upload(): unknown {
    return null;
  }

  @Get('events')
  @Sse(z.object({ tick: z.number() }))
  public async *events(): AsyncGenerator<never> {
    // empty stream
  }

  @Get('{id}/file')
  @Params(z.object({ id: z.uuid() }))
  @ReturnsFile(200, { contentType: 'application/octet-stream' })
  @Returns(404, ApiError)
  public download(): unknown {
    return null;
  }
}

const contract = generateContract([UsersController], { title: 'Test', version: '1.0.0' });
const client = generateTypeScriptClient(contract);

describe('generateTypeScriptClient — output', () => {
  it('reconstructs named schemas as interfaces', () => {
    expect(client).toContain('export interface User {\n  id: string;\n  name: string;\n}');
    expect(client).toContain('export interface CreateUser {\n  name: string;\n}');
  });

  it('groups operations by tag', () => {
    expect(client).toMatch(/export interface Client \{[\s\S]*users: \{/);
  });

  it('emits a throwing call signature plus a .raw discriminated union', () => {
    // Default form returns the success body…
    expect(client).toContain(
      '(args: { params: { id: string }; headers?: Record<string, string> }): Promise<User>;',
    );
    // …and .raw returns the per-status union, each arm exposing response headers.
    expect(client).toContain(
      'Promise<{ status: 200; body: User; headers: Headers } | { status: 404; body: ApiError; headers: Headers }>',
    );
  });

  it('types multipart bodies with File | Blob', () => {
    expect(client).toContain('body: { avatar: File | Blob; caption?: string }');
  });

  it('types SSE responses as an async iterable and marks the spec as a stream', () => {
    expect(client).toContain('Promise<AsyncIterable<{ tick: number }>>');
    expect(client).toContain('stream: true');
  });

  it('renders z.date() as string in the default client (revival is opt-in via validate)', () => {
    @Route('cal')
    class CalController {
      @Post('events')
      @Body(z.object({ when: z.date() }))
      @Returns(200, z.object({ id: z.string(), when: z.date() }))
      public make(): unknown {
        return null;
      }
    }
    const generated = generateTypeScriptClient(generateContract([CalController]));
    expect(generated).toContain('id: string; when: string'); // response body
    expect(generated).toContain('body: { when: string }'); // request body
    expect(generated).not.toContain(': Date'); // never typed as a real Date
  });

  it('inlines the runtime so the module has no imports', () => {
    expect(client).not.toMatch(/^\s*import\s/m);
    expect(client).toContain('export class CovenixClientError');
    expect(client).toContain('export function createClient');
  });

  it('starts with lint-disable pragmas (it is generated, not hand-edited)', () => {
    expect(client.startsWith('/* tslint:disable */\n/* eslint-disable */\n')).toBe(true);
  });
});

describe('generateTypeScriptClient — JSDoc from descriptions', () => {
  it('documents interfaces, fields, and methods', () => {
    const Widget = z
      .object({
        id: z.string(),
        label: z.string().describe('Human-readable label.'),
      })
      .meta({ id: 'Widget', description: 'A widget.' });

    @Route('widgets')
    @Tags('Widgets')
    class WidgetsController {
      @Get('{id}')
      @Summary('Fetch a widget')
      @Description('Returns a single widget by id.')
      @Deprecated()
      @Params(z.object({ id: z.string() }))
      @Returns(200, Widget)
      public get(): unknown {
        return null;
      }
    }
    const generated = generateTypeScriptClient(generateContract([WidgetsController]));
    // Interface-level JSDoc (from .meta({ description })).
    expect(generated).toContain('/** A widget. */\nexport interface Widget');
    // Field-level JSDoc (from .describe()).
    expect(generated).toContain('/** Human-readable label. */');
    // Method JSDoc combines summary + description + @deprecated.
    expect(generated).toMatch(
      /\/\*\*\n\s+\* Fetch a widget\n\s+\*\n\s+\* Returns a single widget by id\.\n\s+\*\n\s+\* @deprecated\n\s+\*\/\n\s+get:/,
    );
  });
});

describe('generateTypeScriptClient — type-checks under strict mode', () => {
  it('produces a client module with zero compiler diagnostics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'covenix-client-'));
    const file = join(dir, 'api.gen.ts');
    writeFileSync(file, client);
    try {
      const program = ts.createProgram([file], {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        noEmit: true,
        skipLibCheck: true,
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Runtime behavior: transpile the generated module to JS, import it, and
// exercise it with a fake fetch (the standalone client has no imports to resolve).
interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface TestClient {
  users: {
    get: {
      (args: { params: { id: string } }): Promise<{ id: string; name: string }>;
      raw(args: {
        params: { id: string };
      }): Promise<{ status: number; body: unknown; headers: Headers }>;
    };
    create(args: { body: { name: string } }): Promise<{ id: string; name: string }>;
    upload(args: { params: { id: string }; body: { avatar: Blob } }): Promise<{ ok: boolean }>;
    events(): Promise<AsyncIterable<{ tick: number }>>;
    download(args: { params: { id: string }; headers?: Record<string, string> }): Promise<Blob>;
  };
}

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Transpiles the generated client, imports it, and wires the given fake fetch. */
async function instantiate(
  fakeFetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<TestClient> {
  const js = ts.transpileModule(client, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), 'covenix-client-rt-'));
  tmpDirs.push(dir);
  const file = join(dir, `client-${tmpDirs.length}.mjs`);
  writeFileSync(file, js);
  const mod = (await import(pathToFileURL(file).href)) as {
    createClient: (opts: unknown) => TestClient;
  };
  return mod.createClient({ baseUrl: 'https://api.test', fetch: fakeFetch });
}

async function loadClient(
  responder: (call: FetchCall) => { status: number; body: unknown },
): Promise<{ api: TestClient; calls: FetchCall[] }> {
  const calls: FetchCall[] = [];
  const api = await instantiate((url, init) => {
    const headers = init.headers as Record<string, string>;
    const call: FetchCall = { url, method: init.method ?? 'GET', headers, body: init.body };
    calls.push(call);
    const { status, body } = responder(call);
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { api, calls };
}

/** A fake `text/event-stream` response that emits the given SSE frames then ends. */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const encoder = new TextEncoder();
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('generated client — runtime behavior', () => {
  it('builds the URL with path params and returns the parsed success body', async () => {
    const { api, calls } = await loadClient(() => ({
      status: 200,
      body: { id: 'abc', name: 'Ada' },
    }));
    const user = await api.users.get({ params: { id: 'abc' } });
    expect(user).toEqual({ id: 'abc', name: 'Ada' });
    expect(calls[0]?.url).toBe('https://api.test/users/abc');
    expect(calls[0]?.method).toBe('GET');
  });

  it('sends a JSON body for non-multipart mutations', async () => {
    const { api, calls } = await loadClient(() => ({ status: 201, body: { id: '1', name: 'Bo' } }));
    await api.users.create({ body: { name: 'Bo' } });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toBe(JSON.stringify({ name: 'Bo' }));
  });

  it('sends FormData (not JSON) for a multipart body', async () => {
    const { api, calls } = await loadClient(() => ({ status: 200, body: { ok: true } }));
    await api.users.upload({
      params: { id: 'x' },
      body: { avatar: new Blob(['hi'], { type: 'text/plain' }) },
    });
    expect(calls[0]?.body).toBeInstanceOf(FormData);
    expect(calls[0]?.headers['content-type']).toBeUndefined(); // boundary set by runtime
  });

  it('throws CovenixClientError carrying status + parsed body on non-2xx', async () => {
    const { api } = await loadClient(() => ({ status: 404, body: { message: 'nope' } }));
    await expect(api.users.get({ params: { id: 'missing' } })).rejects.toMatchObject({
      name: 'CovenixClientError',
      status: 404,
      body: { message: 'nope' },
    });
  });

  it('returns a Blob for a binary/file response (and forwards a Range header)', async () => {
    const calls: FetchCall[] = [];
    const api = await instantiate((url, init) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method ?? 'GET', headers, body: init.body });
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );
    });
    const blob = await api.users.download({ params: { id: 'x' }, headers: { Range: 'bytes=0-2' } });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(3);
    expect(calls[0]?.headers['Range']).toBe('bytes=0-2');
  });

  it('consumes an SSE response as an async iterable of parsed events', async () => {
    const api = await instantiate(() =>
      Promise.resolve(
        sseResponse([': keep-alive\n\n', 'data: {"tick":1}\n\n', 'data: {"tick":2}\n\n']),
      ),
    );
    const ticks: { tick: number }[] = [];
    for await (const event of await api.users.events()) {
      ticks.push(event);
    }
    expect(ticks).toEqual([{ tick: 1 }, { tick: 2 }]); // comment frame skipped
  });

  it('.raw returns the { status, body, headers } envelope instead of throwing', async () => {
    const { api } = await loadClient(() => ({ status: 404, body: { message: 'nope' } }));
    const res = await api.users.get.raw({ params: { id: 'missing' } });
    expect(res).toMatchObject({ status: 404, body: { message: 'nope' } });
    // `.raw()` surfaces response headers as a standard Headers object.
    expect(res.headers).toBeInstanceOf(Headers);
    expect(res.headers.get('content-type')).toContain('json');
  });
});

// ---------------------------------------------------------------------------
// Validating client ({ validate: 'zod' })
// ---------------------------------------------------------------------------

const Visit = z.object({ id: z.string(), at: z.date() }).meta({ id: 'Visit' });

@Route('visits')
@Tags('Visits')
class VisitsController {
  @Get('{id}')
  @Params(z.object({ id: z.string() }))
  @Returns(200, Visit)
  public get(): unknown {
    return null;
  }

  @Post()
  @Body(z.object({ name: z.string().min(3) }))
  @Returns(201, Visit)
  public create(): unknown {
    return null;
  }
}

const vContract = generateContract([VisitsController], { title: 'Test', version: '1.0.0' });
const vClient = generateTypeScriptClient(vContract, { validate: 'zod' });

describe("generateTypeScriptClient — validating ({ validate: 'zod' }) output", () => {
  it('imports zod and emits a validator const per named schema', () => {
    expect(vClient).toContain("import { z } from 'zod';");
    expect(vClient).toContain('const Visit$schema: z.ZodType<Visit> = z.object({');
  });

  it('revives z.date() as a real Date (typed Date, parsed with z.coerce.date)', () => {
    expect(vClient).toContain('at: Date'); // interface field
    expect(vClient).toContain('z.coerce.date()'); // validator
    expect(vClient).not.toContain('at: string');
  });

  it('wires request-input and response validators into the operation specs', () => {
    expect(vClient).toContain('responses: { 200: z.lazy(() => Visit$schema) }'); // response
    expect(vClient).toContain('body: z.object({ name: z.string().min(3) })'); // request body
    expect(vClient).toContain('export class CovenixClientValidationError');
  });
});

/** A validating client typed loosely for the runtime tests. */
interface VClient {
  visits: {
    get(args: { params: { id: string } }): Promise<{ id: string; at: Date }>;
    create(args: { body: { name: string } }): Promise<{ id: string; at: Date }>;
  };
}

/**
 * Transpiles + imports the validating client. Written inside the repo so its
 * `import { z } from 'zod'` resolves to the project's node_modules.
 */
async function instantiateValidating(
  fakeFetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<VClient> {
  const js = ts.transpileModule(vClient, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const dir = mkdtempSync(join(process.cwd(), 'covenix-vclient-'));
  tmpDirs.push(dir);
  const file = join(dir, 'client.mjs');
  writeFileSync(file, js);
  const mod = (await import(pathToFileURL(file).href)) as {
    createClient: (opts: unknown) => VClient;
  };
  return mod.createClient({ baseUrl: 'https://api.test', fetch: fakeFetch });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe("generateTypeScriptClient — validating ({ validate: 'zod' }) runtime", () => {
  it('parses a valid response and revives z.date() into a real Date', async () => {
    const api = await instantiateValidating(() =>
      Promise.resolve(jsonResponse(200, { id: 'v1', at: '2020-01-02T03:04:05.000Z' })),
    );
    const visit = await api.visits.get({ params: { id: 'v1' } });
    expect(visit.at).toBeInstanceOf(Date);
    expect(visit.at.toISOString()).toBe('2020-01-02T03:04:05.000Z');
  });

  it('throws CovenixClientValidationError when a response violates its schema', async () => {
    const api = await instantiateValidating(() => Promise.resolve(jsonResponse(200, { id: 'v1' }))); // missing `at`
    await expect(api.visits.get({ params: { id: 'v1' } })).rejects.toMatchObject({
      name: 'CovenixClientValidationError',
      phase: 'response',
    });
  });

  it('validates request inputs before sending (no fetch on failure)', async () => {
    let fetched = false;
    const api = await instantiateValidating(() => {
      fetched = true;
      return Promise.resolve(jsonResponse(201, { id: 'v1', at: '2020-01-02T03:04:05.000Z' }));
    });
    await expect(api.visits.create({ body: { name: 'ab' } })).rejects.toMatchObject({
      name: 'CovenixClientValidationError',
      phase: 'request',
    });
    expect(fetched).toBe(false);
  });
});
