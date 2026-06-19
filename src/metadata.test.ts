import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Body,
  Example,
  Get,
  Params,
  Post,
  Query,
  Returns,
  Summary,
  Route,
  Tags,
} from './decorators.js';
import {
  addReturnSchema,
  getPrefix,
  getRoutes,
  getTags,
  setBodySchema,
  setHttpMethod,
  setParamsSchema,
  setQuerySchema,
  setTags,
} from './metadata.js';

const Thing = z.object({ id: z.string() });

describe('metadata assembly', () => {
  it('assembles a route from its per-concern decorators', () => {
    @Route('things')
    @Tags('Things')
    class ThingController {
      @Get('{id}')
      @Summary('Get a thing')
      @Returns(200, Thing)
      public get(): unknown {
        return { id: 'x' };
      }
    }

    const proto = ThingController.prototype as object;
    expect(getPrefix(proto)).toBe('things');
    expect(getTags(proto)).toEqual(['Things']);

    const routes = getRoutes(proto);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'get',
      path: '{id}',
      handlerName: 'get',
      summary: 'Get a thing',
    });
    expect(Object.keys(routes[0]!.responses)).toEqual(['200']);
  });

  it('records @Example values for the request body and responses', () => {
    @Route('widgets')
    class WidgetController {
      @Post()
      @Body(Thing)
      @Example({ name: 'in' })
      @Returns(201, Thing)
      @Example({ id: 'out' }, 201)
      public create(): unknown {
        return null;
      }
    }

    // Decorators apply bottom-to-top, so order is not guaranteed; assert by
    // membership (the swagger builder looks examples up by status, not order).
    const route = getRoutes(WidgetController.prototype)[0]!;
    expect(route.examples).toHaveLength(2);
    expect(route.examples).toContainEqual({ value: { name: 'in' } });
    expect(route.examples).toContainEqual({ status: 201, value: { id: 'out' } });
  });

  it('captures @Params / @Query / @Body schemas via decorators', () => {
    const ParamsSchema = z.object({ id: z.string() });
    const QuerySchema = z.object({ page: z.coerce.number() });
    const BodySchema = z.object({ name: z.string() });

    @Route('widgets')
    class WidgetController {
      @Post('{id}')
      @Params(ParamsSchema)
      @Query(QuerySchema)
      @Body(BodySchema)
      @Returns(201, Thing)
      public create(): unknown {
        return { id: 'x' };
      }
    }

    const route = getRoutes(WidgetController.prototype)[0]!;
    expect(route.params).toBe(ParamsSchema);
    expect(route.query).toBe(QuerySchema);
    expect(route.body).toBe(BodySchema);
  });

  // The core correctness property: decorators key metadata on their own symbol,
  // so applying them in any order produces identical metadata.
  it('produces identical metadata regardless of decorator order', () => {
    @Route('a')
    class Forward {
      @Get('p')
      @Summary('s')
      @Returns(200, Thing)
      public h(): void {}
    }

    @Route('a')
    class Reversed {
      @Returns(200, Thing)
      @Summary('s')
      @Get('p')
      public h(): void {}
    }

    const forward = getRoutes(Forward.prototype);
    const reversed = getRoutes(Reversed.prototype);

    expect(forward).toHaveLength(1);
    expect(forward[0]!.method).toBe(reversed[0]!.method);
    expect(forward[0]!.path).toBe(reversed[0]!.path);
    expect(forward[0]!.summary).toBe(reversed[0]!.summary);
    expect(Object.keys(forward[0]!.responses)).toEqual(Object.keys(reversed[0]!.responses));
  });
});

describe('metadata store concerns', () => {
  const Params = z.object({ id: z.string() });
  const Query = z.object({ page: z.coerce.number() });
  const Body = z.object({ name: z.string() });

  it('assembles params/query/body/responses set independently', () => {
    // Drive the store setters directly — exercises the store layer in isolation
    // from the @Params/@Query/@Body decorators.
    const target = {};
    setHttpMethod(target, 'create', 'post', '');
    setParamsSchema(target, 'create', Params);
    setQuerySchema(target, 'create', Query);
    setBodySchema(target, 'create', Body);
    addReturnSchema(target, 'create', 201, Thing);

    const routes = getRoutes(target);
    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route.method).toBe('post');
    // Identity-equal: the store hands back the exact schema objects.
    expect(route.params).toBe(Params);
    expect(route.query).toBe(Query);
    expect(route.body).toBe(Body);
    expect(route.responses[201]).toBe(Thing);
  });

  it('leaves unset concerns undefined', () => {
    const target = {};
    setHttpMethod(target, 'list', 'get', '');

    const route = getRoutes(target)[0]!;
    expect(route.params).toBeUndefined();
    expect(route.query).toBeUndefined();
    expect(route.body).toBeUndefined();
    expect(route.tags).toBeUndefined();
    expect(route.summary).toBeUndefined();
    expect(route.responses).toEqual({});
  });

  it('folds class-level tags onto every route', () => {
    const target = {};
    setHttpMethod(target, 'a', 'get', 'a');
    setHttpMethod(target, 'b', 'get', 'b');
    setTags(target, ['Widgets']);

    const routes = getRoutes(target);
    expect(routes).toHaveLength(2);
    expect(routes[0]!.tags).toEqual(['Widgets']);
    expect(routes[1]!.tags).toEqual(['Widgets']);
  });
});
