import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Body, Get, Params, Post, Query, Returns, Route, Security, Sse } from './decorators.js';
import { ReturnsFile } from './decorators.js';
import { Covenix } from './covenix.js';
import {
  CONTRACT_VERSION,
  generateContract,
  parseContract,
  CovenixContractSchema,
  type ContractOperation,
  type SchemaNode,
} from './contract.js';

/** Pull a single operation out of a generated contract by operationId. */
function op(contract: { operations: ContractOperation[] }, id: string): ContractOperation {
  const found = contract.operations.find((o) => o.operationId === id);
  if (!found) {
    throw new Error(`no operation ${id}`);
  }
  return found;
}

describe('generateContract', () => {
  const User = z.object({ id: z.uuid(), name: z.string() }).meta({ id: 'User' });
  const CreateUser = z.object({ name: z.string().min(1) }).meta({ id: 'CreateUser' });

  @Route('users')
  class UsersController {
    @Get('{id}')
    @Params(z.object({ id: z.uuid() }))
    @Query(z.object({ verbose: z.coerce.boolean().optional() }))
    @Returns(200, User)
    @Returns(404, z.object({ message: z.string() }))
    public get(): unknown {
      return null;
    }

    @Post()
    @Body(CreateUser)
    @Returns(201, User)
    public create(): unknown {
      return null;
    }
  }

  it('emits a versioned, validated contract', () => {
    const contract = generateContract([UsersController], { title: 'Users', version: '2.0.0' });
    expect(contract.covenixContract).toBe(CONTRACT_VERSION);
    expect(contract.info).toEqual({ title: 'Users', version: '2.0.0' });
    // Validate-on-write means the output already conforms; re-parsing must pass.
    expect(() => parseContract(contract)).not.toThrow();
  });

  it('builds one operation per route with method, path, and operationId', () => {
    const contract = generateContract([UsersController]);
    expect(contract.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual([
      'get /users/{id}',
      'post /users',
    ]);
    expect(op(contract, 'get').operationId).toBe('get');
  });

  it('records params, query, body media type, and all response statuses', () => {
    const contract = generateContract([UsersController]);
    const get = op(contract, 'get');
    expect(get.params).toEqual({
      kind: 'object',
      properties: { id: { schema: { kind: 'string', format: 'uuid' } } },
      additionalProperties: false,
    });
    expect(get.query?.kind).toBe('object');
    expect(Object.keys(get.responses).sort()).toEqual(['200', '404']);
    // Named schemas become refs into the shared schemas map.
    expect(get.responses['200']).toEqual({ schema: { kind: 'ref', id: 'User' } });

    const create = op(contract, 'create');
    expect(create.body).toEqual({
      mediaType: 'application/json',
      schema: { kind: 'ref', id: 'CreateUser' },
    });
    expect(create.responses['201']).toEqual({ schema: { kind: 'ref', id: 'User' } });
  });

  it('hoists named schemas into the shared schemas map once', () => {
    const contract = generateContract([UsersController]);
    expect(Object.keys(contract.schemas).sort()).toEqual(['CreateUser', 'User']);
    expect(contract.schemas['User']).toEqual({
      kind: 'object',
      properties: {
        id: { schema: { kind: 'string', format: 'uuid' } },
        name: { schema: { kind: 'string' } },
      },
      additionalProperties: false,
    });
  });

  it('matches Covenix#contract() for the same controllers', () => {
    const info = { title: 'API', version: '1.0.0' };
    const fromClasses = generateContract([UsersController], info);
    const api = new Covenix({ info });
    api.register(new UsersController());
    expect(api.contract()).toEqual(fromClasses);
  });

  it('applies a group/register prefix to the path', () => {
    const fromClasses = generateContract([{ controller: UsersController, prefix: '/v1' }]);
    expect(fromClasses.operations.map((o) => o.path).sort()).toEqual([
      '/v1/users',
      '/v1/users/{id}',
    ]);
  });
});

describe('schema-node fidelity', () => {
  /** Convert a single schema by putting it on a route body and reading it back. */
  function nodeOf(schema: z.ZodType): SchemaNode {
    @Route('t')
    class C {
      @Post()
      @Body(schema)
      @Returns(200, z.object({ ok: z.boolean() }))
      public go(): unknown {
        return null;
      }
    }
    const body = generateContract([C]).operations[0]?.body;
    if (!body) {
      throw new Error('no body');
    }
    return body.schema;
  }

  it('captures string formats and constraints', () => {
    expect(nodeOf(z.object({ a: z.string().min(2).max(5) })).kind).toBe('object');
    expect(nodeOf(z.email())).toEqual({ kind: 'string', format: 'email' });
    expect(nodeOf(z.string().min(3))).toEqual({ kind: 'string', minLength: 3 });
  });

  it('captures number int + bounds (inclusive vs exclusive)', () => {
    expect(nodeOf(z.int().min(0).max(10))).toEqual({
      kind: 'number',
      int: true,
      minimum: 0,
      maximum: 10,
    });
    expect(nodeOf(z.number().gt(0))).toEqual({ kind: 'number', exclusiveMinimum: 0 });
  });

  it('uses semantic kinds for date and file (not string)', () => {
    expect(nodeOf(z.date())).toEqual({ kind: 'date' });
    expect(nodeOf(z.file())).toEqual({ kind: 'file' });
  });

  it('models per-property optionality and defaults, unwrapping the marker', () => {
    const node = nodeOf(z.object({ a: z.string().optional(), b: z.number().default(1) }));
    expect(node).toEqual({
      kind: 'object',
      properties: {
        a: { schema: { kind: 'string' }, optional: true },
        b: { schema: { kind: 'number' }, default: 1 },
      },
      additionalProperties: false,
    });
  });

  it('models arrays, tuples, records, enums, literals, nullable', () => {
    expect(nodeOf(z.array(z.string()).min(1))).toEqual({
      kind: 'array',
      element: { kind: 'string' },
      minItems: 1,
    });
    expect(nodeOf(z.enum(['a', 'b']))).toEqual({ kind: 'enum', values: ['a', 'b'] });
    expect(nodeOf(z.literal('x'))).toEqual({ kind: 'literal', values: ['x'] });
    expect(nodeOf(z.string().nullable())).toEqual({ kind: 'nullable', inner: { kind: 'string' } });
    expect(nodeOf(z.record(z.string(), z.number()))).toEqual({
      kind: 'record',
      key: { kind: 'string' },
      value: { kind: 'number' },
    });
  });

  it('keeps discriminated unions first-class with named-variant refs', () => {
    const A = z.object({ type: z.literal('a'), x: z.number() }).meta({ id: 'A' });
    const B = z.object({ type: z.literal('b'), y: z.string() }).meta({ id: 'B' });
    const U = z.discriminatedUnion('type', [A, B]).meta({ id: 'U' });
    const node = nodeOf(z.object({ u: U }));
    expect(node).toMatchObject({ kind: 'object' });

    @Route('u')
    class UC {
      @Get()
      @Returns(200, U)
      public g(): unknown {
        return null;
      }
    }
    const contract = generateContract([UC]);
    expect(contract.schemas['U']).toEqual({
      kind: 'discriminatedUnion',
      discriminator: 'type',
      variants: [
        { kind: 'ref', id: 'A' },
        { kind: 'ref', id: 'B' },
      ],
    });
  });

  it('falls back to unsupported (embedding JSON Schema) for transforms', () => {
    const node = nodeOf(z.object({ t: z.string().transform((s) => s.length) }));
    expect(node.kind).toBe('object');
    const t =
      node.kind === 'object' ? node.properties['t']?.schema : ({ kind: 'unknown' } as SchemaNode);
    expect(t?.kind).toBe('unsupported');
  });
});

describe('file and sse responses', () => {
  it('records file and sse response bodies', () => {
    @Route('r')
    class C {
      @Get('download')
      @ReturnsFile(200, { contentType: 'text/csv' })
      public dl(): null {
        return null;
      }

      @Get('stream')
      @Sse(z.object({ tick: z.number() }))
      public async *stream(): AsyncGenerator<never> {
        // empty stream
      }
    }
    const contract = generateContract([C]);
    expect(op(contract, 'dl').responses['200']).toEqual({ file: { contentType: 'text/csv' } });
    expect(op(contract, 'stream').responses['200']).toEqual({
      sse: {
        schema: {
          kind: 'object',
          properties: { tick: { schema: { kind: 'number' } } },
          additionalProperties: false,
        },
      },
    });
  });
});

describe('security', () => {
  it('records the security requirement on the operation', () => {
    @Route('s')
    @Security('bearer', ['read'])
    class C {
      @Get()
      @Returns(200, z.object({ ok: z.boolean() }))
      public g(): unknown {
        return null;
      }
    }
    const contract = generateContract([C]);
    expect(op(contract, 'g').security).toEqual([{ scheme: 'bearer', scopes: ['read'] }]);
  });
});

describe('route-less schemas option', () => {
  const Msg = z.object({ kind: z.literal('chat'), text: z.string() }).meta({ id: 'WsMessage' });

  @Route('x')
  class C {
    @Get()
    @Returns(200, z.object({ ok: z.boolean() }))
    public g(): unknown {
      return null;
    }
  }

  it('adds a route-less named schema to schemas', () => {
    const contract = generateContract([C], undefined, { schemas: [Msg] });
    expect(contract.schemas['WsMessage']).toEqual({
      kind: 'object',
      properties: {
        kind: { schema: { kind: 'literal', values: ['chat'] } },
        text: { schema: { kind: 'string' } },
      },
      additionalProperties: false,
    });
    // No operation references it.
    expect(contract.operations.some((o) => JSON.stringify(o).includes('WsMessage'))).toBe(false);
  });

  it('is available on Covenix#contract() too', () => {
    const api = new Covenix({ info: { title: 'API', version: '1.0.0' } });
    api.register(new C());
    expect(api.contract({ schemas: [Msg] }).schemas).toHaveProperty('WsMessage');
  });

  it('throws when a route-less schema is not named via .meta({ id })', () => {
    expect(() =>
      generateContract([C], undefined, { schemas: [z.object({ x: z.string() })] }),
    ).toThrow(/named via \.meta/);
  });
});

describe('parseContract / versioning', () => {
  it('round-trips a generated contract through JSON', () => {
    @Route('x')
    class C {
      @Get()
      @Returns(200, z.object({ ok: z.boolean() }))
      public g(): unknown {
        return null;
      }
    }
    const contract = generateContract([C]);
    const roundTripped = parseContract(JSON.parse(JSON.stringify(contract)));
    expect(roundTripped).toEqual(contract);
  });

  it('rejects a contract with a mismatched version', () => {
    expect(() =>
      parseContract({ covenixContract: '9.9', info: {}, operations: [], schemas: {} }),
    ).toThrow();
  });

  it('rejects a malformed contract', () => {
    expect(() => parseContract({ nope: true })).toThrow();
    expect(CovenixContractSchema.safeParse({}).success).toBe(false);
  });
});
