import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateSwagger, toJsonSchema } from './swagger.js';
import { apiKey as apiKeyScheme, bearer } from './security.js';
import { Zodec } from './zodec.js';
import {
  Body,
  Deprecated,
  Description,
  Example,
  Get,
  OperationId,
  Params,
  Post,
  Query,
  Returns,
  ReturnsFile,
  Route,
  Security,
  Summary,
  Tags,
} from './decorators.js';

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

  it('emits a binary media type for @ReturnsFile', () => {
    @Route('files')
    class FileController {
      @Get('default')
      @ReturnsFile(200)
      public a(): null {
        return null;
      }

      @Get('csv')
      @ReturnsFile(200, { contentType: 'text/csv', description: 'A CSV export' })
      public b(): null {
        return null;
      }
    }

    const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
    api.register(new FileController());
    const doc = api.swagger();

    // Default media type when none is given.
    expect(doc.paths?.['/files/default']?.get?.responses?.['200']).toMatchObject({
      content: {
        'application/octet-stream': {
          schema: { type: 'string', format: 'binary' },
        },
      },
    });
    // Explicit media type + description.
    expect(doc.paths?.['/files/csv']?.get?.responses?.['200']).toMatchObject({
      description: 'A CSV export',
      content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
    });
  });

  it('attaches @Returns headers to the matching response', () => {
    @Route('widgets')
    class WidgetController {
      @Get()
      @Returns(200, z.object({ ok: z.boolean() }), {
        headers: { 'X-Total-Count': z.number().int(), 'X-Request-Id': z.string() },
      })
      public list(): unknown {
        return { ok: true };
      }
    }

    const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
    api.register(new WidgetController());
    const res200 = api.swagger().paths?.['/widgets']?.get?.responses?.['200'];

    expect(res200).toMatchObject({
      headers: {
        'X-Total-Count': { schema: { type: 'integer' } },
        'X-Request-Id': { schema: { type: 'string' } },
      },
    });
  });

  it('emits a multipart/form-data body when @Body has a file field', () => {
    @Route('uploads')
    class UploadController {
      @Post()
      @Body(
        z.object({
          avatar: z.file().max(2_000_000).mime(['image/png']),
          photos: z.array(z.file()).max(4),
          caption: z.string().optional(),
        }),
      )
      @Returns(200, z.object({ ok: z.boolean() }))
      public upload(): unknown {
        return { ok: true };
      }
    }

    const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
    api.register(new UploadController());
    const post = api.swagger().paths?.['/uploads']?.post;

    expect(post?.requestBody).toMatchObject({
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              avatar: { type: 'string', format: 'binary' },
              photos: { type: 'array', items: { type: 'string', format: 'binary' } },
              caption: { type: 'string' },
            },
          },
        },
      },
    });
    // Not the JSON media type.
    expect(post?.requestBody).not.toHaveProperty(['content', 'application/json']);
  });

  it('emits summary, description, explicit operationId, and deprecated', () => {
    @Route('widgets')
    class WidgetController {
      @Get('{id}')
      @Summary('Get a widget')
      @Description('Returns a single widget by its id.')
      @OperationId('getWidget')
      @Deprecated()
      @Returns(200, z.object({ id: z.string() }))
      public get(): unknown {
        return null;
      }
    }

    const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
    api.register(new WidgetController());
    const op = api.swagger().paths?.['/widgets/{id}']?.get;

    expect(op).toMatchObject({
      summary: 'Get a widget',
      description: 'Returns a single widget by its id.',
      operationId: 'getWidget',
      deprecated: true,
    });
  });

  it('defaults operationId to the handler method name when @OperationId is absent', () => {
    @Route('gadgets')
    class GadgetController {
      @Get()
      @Returns(200, z.object({ ok: z.boolean() }))
      public listGadgets(): unknown {
        return null;
      }
    }

    const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
    api.register(new GadgetController());
    const op = api.swagger().paths?.['/gadgets']?.get;

    expect(op?.operationId).toBe('listGadgets');
    expect(op).not.toHaveProperty('deprecated'); // only set when @Deprecated
  });

  it('emits extended info, servers, externalDocs, and top-level tags', () => {
    @Route('things')
    class ThingController {
      @Get()
      @Returns(200, z.object({ ok: z.boolean() }))
      public list(): unknown {
        return null;
      }
    }

    const api = new Zodec({
      info: { title: 'My API', version: '2.0.0', description: 'Does things.' },
      servers: [{ url: 'https://api.example.com/v1' }],
      externalDocs: { url: 'https://docs.example.com' },
      tags: [{ name: 'Things', description: 'Thing operations.' }],
    });
    api.register(new ThingController());
    const doc = api.swagger();

    expect(doc.info).toMatchObject({
      title: 'My API',
      version: '2.0.0',
      description: 'Does things.',
    });
    expect(doc.servers).toEqual([{ url: 'https://api.example.com/v1' }]);
    expect(doc.externalDocs).toEqual({ url: 'https://docs.example.com' });
    expect(doc.tags).toEqual([{ name: 'Things', description: 'Thing operations.' }]);
  });

  it('emits a @Returns description on the matching response', () => {
    @Route('orders')
    class OrderController {
      @Get('{id}')
      @Returns(200, z.object({ id: z.string() }), { description: 'The order' })
      @Returns(404, z.object({ error: z.string() }), { description: 'No such order' })
      public get(): unknown {
        return null;
      }
    }

    const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
    api.register(new OrderController());
    const responses = api.swagger().paths?.['/orders/{id}']?.get?.responses;

    expect(responses?.['200']).toMatchObject({ description: 'The order' });
    expect(responses?.['404']).toMatchObject({ description: 'No such order' });
  });

  it('emits a no-body response for @Returns(status) with no schema', () => {
    @Route('things')
    class ThingController {
      @Get('{id}')
      @Returns(204)
      public remove(): null {
        return null;
      }
    }

    const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
    api.register(new ThingController());
    const res204 = api.swagger().paths?.['/things/{id}']?.get?.responses?.['204'];

    expect(res204).toBeDefined();
    expect(res204).not.toHaveProperty('content');
  });

  it('surfaces @Example values on request and response media types', () => {
    const Created = z.object({ id: z.string() }).meta({ id: 'Created' });
    const CreateBody = z.object({ name: z.string() }).meta({ id: 'CreateBody' });

    @Route('widgets')
    class WidgetController {
      @Post()
      @Body(CreateBody)
      @Example({ name: 'gizmo' })
      @Returns(201, Created)
      @Example({ id: 'w_1' }, 201)
      public create(): unknown {
        return null;
      }
    }

    const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
    api.register(new WidgetController());
    const doc = api.swagger();

    const post = doc.paths?.['/widgets']?.post;
    expect(post?.requestBody).toMatchObject({
      content: { 'application/json': { example: { name: 'gizmo' } } },
    });
    expect(post?.responses?.['201']).toMatchObject({
      content: { 'application/json': { example: { id: 'w_1' } } },
    });
  });

  it('emits per-operation security (stacked = OR) and components.securitySchemes', () => {
    @Route('admin')
    class AdminController {
      @Get('a')
      @Security('bearerAuth', ['admin'])
      @Returns(200, z.object({ ok: z.boolean() }))
      public a(): unknown {
        return { ok: true };
      }

      @Get('b')
      @Security('bearerAuth')
      @Security('apiKey')
      @Returns(200, z.object({ ok: z.boolean() }))
      public b(): unknown {
        return { ok: true };
      }
    }

    const api = new Zodec({
      info: { title: 'API', version: '1.0.0' },
      security: {
        bearerAuth: bearer(() => ({})),
        apiKey: apiKeyScheme({ in: 'header', name: 'X-API-Key' }, () => ({})),
      },
    });
    api.register(new AdminController());
    const doc = api.swagger();

    // Single requirement with scopes.
    expect(doc.paths?.['/admin/a']?.get?.security).toEqual([{ bearerAuth: ['admin'] }]);
    // Stacked decorators → two requirement objects (OR), in source order.
    expect(doc.paths?.['/admin/b']?.get?.security).toEqual([{ bearerAuth: [] }, { apiKey: [] }]);
    // Scheme definitions land in components.
    expect(doc.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    });
  });

  describe('specVersion', () => {
    const Thing = z
      .object({
        name: z.string().nullable(), // anyOf [string, null] → nullable
        count: z.number().gt(0).lt(10), // exclusive bounds (numeric → boolean)
        kind: z.literal('widget'), // const → enum
        avatar: z.file().mime(['image/png']).optional(), // contentEncoding/contentMediaType
      })
      .meta({ id: 'Thing' });

    @Route('things')
    class ThingsController {
      @Post()
      @Body(Thing)
      @Returns(200, Thing)
      public create(): unknown {
        return null;
      }
    }

    function doc(specVersion?: '3.0' | '3.1'): ReturnType<Zodec['swagger']> {
      const api = new Zodec({ info: { title: 'API', version: '1.0.0' } });
      api.register(new ThingsController());
      return api.swagger(specVersion ? { specVersion } : {});
    }

    it('emits 3.1.0 by default', () => {
      expect(doc().openapi).toBe('3.1.0');
    });

    it('down-converts to 3.0.3 with 3.0-shaped schemas', () => {
      const d = doc('3.0');
      expect(d.openapi).toBe('3.0.3');
      expect(d.components?.schemas?.['Thing']).toMatchObject({
        properties: {
          name: { type: 'string', nullable: true }, // anyOf[..., null] collapsed
          count: { minimum: 0, maximum: 10, exclusiveMinimum: true, exclusiveMaximum: true },
          kind: { enum: ['widget'] }, // const → enum
          avatar: { type: 'string', format: 'binary' }, // 3.1 annotations dropped
        },
      });
      const props = (d.components?.schemas?.['Thing'] as { properties: Record<string, object> })
        .properties;
      expect(props['name']).not.toHaveProperty('anyOf');
      expect(props['kind']).not.toHaveProperty('const');
      expect(props['avatar']).not.toHaveProperty('contentEncoding');
    });
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
