import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Get, Returns, Summary, Route, Tags } from './decorators.js';
import { getPrefix, getRoutes, getTags } from './metadata.js';

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
