import { describe, expect, it } from 'vitest';
import { Get } from './decorators.js';
import { BodyParam, Header, Param, QueryParam, Req, Res } from './parameters.js';
import { getParams, type ParamMetadata } from './metadata.js';

function byIndex(params: ParamMetadata[]): ParamMetadata[] {
  return [...params].sort((a, b) => a.index - b.index);
}

describe('parameter metadata', () => {
  it('records source, index, and name for each parameter decorator', () => {
    class Controller {
      @Get('{id}')
      public handler(
        @Param('id') _id: string,
        @QueryParam('page') _page: number,
        @BodyParam() _body: unknown,
        @Header('authorization') _auth: string,
        @Req() _req: unknown,
        @Res() _res: unknown,
      ): void {}
    }

    const params = byIndex(getParams(Controller.prototype, 'handler'));
    expect(params).toEqual([
      { index: 0, source: 'param', name: 'id' },
      { index: 1, source: 'query', name: 'page' },
      { index: 2, source: 'body' },
      { index: 3, source: 'header', name: 'authorization' },
      { index: 4, source: 'req' },
      { index: 5, source: 'res' },
    ]);
  });

  it('keys parameters per method, not across the controller', () => {
    class Controller {
      @Get('a')
      public a(@Param('x') _x: string): void {}

      @Get('b')
      public b(@QueryParam('y') _y: string): void {}
    }

    expect(getParams(Controller.prototype, 'a')).toEqual([
      { index: 0, source: 'param', name: 'x' },
    ]);
    expect(getParams(Controller.prototype, 'b')).toEqual([
      { index: 0, source: 'query', name: 'y' },
    ]);
  });

  it('returns an empty list for a method with no parameter decorators', () => {
    class Controller {
      @Get()
      public none(): void {}
    }

    expect(getParams(Controller.prototype, 'none')).toEqual([]);
  });
});
