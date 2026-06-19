import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateSwagger, toJsonSchema } from './swagger.js';
import { Zodec } from './zodec.js';
import { Body, Get, Params, Post, Query, Returns, Route, Summary, Tags } from './decorators.js';

describe('toJsonSchema', () => {
  it('converts a Zod object to JSON Schema', () => {
    const schema = z.object({ id: z.string(), n: z.number().optional() });

    expect(toJsonSchema(schema)).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, n: { type: 'number' } },
      required: ['id'],
    });
  });

  it('reflects coercion and defaults', () => {
    const schema = z.object({ page: z.coerce.number().int().default(1) });
    const json = toJsonSchema(schema);

    expect(json.properties?.page).toMatchObject({ type: 'integer', default: 1 });
  });

  it('emits $ref/$defs for nested named (.meta({ id })) schemas', () => {
    const Inner = z.object({ x: z.string() }).meta({ id: 'Inner' });
    const Outer = z.object({ inner: Inner });
    const json = toJsonSchema(Outer);

    expect(json.properties?.inner).toMatchObject({ $ref: '#/$defs/Inner' });
    expect(json.$defs?.Inner).toMatchObject({ type: 'object' });
  });
});

describe('api.swagger()', () => {
  const User = z.object({ id: z.string(), name: z.string() }).meta({ id: 'User' });
  const CreateUser = z.object({ name: z.string() }).meta({ id: 'CreateUser' });

  @Route('users')
  @Tags('Users')
  class UsersController {
    @Get('{id}')
    @Summary('Get a user')
    @Params(z.object({ id: z.string() }))
    @Query(z.object({ verbose: z.coerce.boolean().optional() }))
    @Returns(200, User)
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

  function buildDoc(): ReturnType<Zodec['swagger']> {
    const api = new Zodec({ info: { title: 'My API', version: '1.0.0' } });
    api.register(new UsersController());
    return api.swagger();
  }

  it('assembles document, paths, tags, summary, and parameters', () => {
    const doc = buildDoc();

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'My API', version: '1.0.0' });

    const get = doc.paths?.['/users/{id}']?.get;
    expect(get?.tags).toEqual(['Users']);
    expect(get?.summary).toBe('Get a user');

    const params = get?.parameters ?? [];
    expect(params).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    );
    expect(params).toContainEqual(
      expect.objectContaining({ name: 'verbose', in: 'query', required: false }),
    );
  });

  it('refs named schemas into components for responses and bodies', () => {
    const doc = buildDoc();

    const okSchema = doc.paths?.['/users/{id}']?.get?.responses?.['200'];
    expect(okSchema).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
    });

    const post = doc.paths?.['/users']?.post;
    expect(post?.requestBody).toMatchObject({
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/CreateUser' } },
      },
    });

    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(['User', 'CreateUser']),
    );
  });

  it('generateSwagger(classes) matches api.swagger() for the same controllers', () => {
    const info = { title: 'My API', version: '1.0.0' };

    const api = new Zodec({ info });
    api.register(new UsersController());
    const fromInstance = api.swagger();

    const fromClasses = generateSwagger([UsersController], info);

    expect(fromClasses).toEqual(fromInstance);
  });
});
