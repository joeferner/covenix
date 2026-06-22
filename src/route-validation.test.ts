import { describe, expect, it } from 'vitest';
import express from 'express';
import { z } from 'zod';
import { Body, Post, Route } from './decorators.js';
import { BodyParam, File, Files } from './parameters.js';
import { getParams } from './metadata.js';
import { assertValidBodyParams } from './route-validation.js';
import { Avero } from './avero.js';

function mount(...controllers: object[]): void {
  const api = new Avero({ info: { title: 'T', version: '1.0.0' } });
  for (const c of controllers) {
    api.register(c);
  }
  api.mount(express());
}

const Item = z.object({ name: z.string(), qty: z.number() });
const Upload = z.object({
  avatar: z.file(),
  photos: z.array(z.file()),
  caption: z.string().optional(),
});

describe('@BodyParam(schema) sugar', () => {
  it('registers the @Body schema and injects the whole body', () => {
    @Route('items')
    class Controller {
      @Post()
      public create(@BodyParam(Item) _item: z.infer<typeof Item>): void {}
    }

    expect(getParams(Controller.prototype, 'create')).toEqual([{ index: 0, source: 'body' }]);
    // The schema was registered as the route body, so this mounts cleanly.
    expect(() => mount(new Controller())).not.toThrow();
  });

  it('throws when the body is also declared with a separate @Body', () => {
    expect(() => {
      @Route('items')
      class Conflict {
        @Post()
        @Body(Item)
        public create(@BodyParam(z.object({ other: z.string() })) _item: unknown): void {}
      }
      return Conflict;
    }).toThrow(/declares its request body more than once/);
  });
});

describe('assertValidBodyParams', () => {
  it('accepts a @BodyParam naming a field present in the @Body schema', () => {
    expect(() =>
      assertValidBodyParams('h', Item, [{ index: 0, source: 'body', name: 'name' }]),
    ).not.toThrow();
  });

  it('rejects a @BodyParam naming a field absent from the @Body schema', () => {
    expect(() =>
      assertValidBodyParams('h', Item, [{ index: 0, source: 'body', name: 'nope' }]),
    ).toThrow(/@BodyParam\('nope'\).*absent from the @Body schema/);
  });

  it('rejects a named body field when there is no @Body schema', () => {
    expect(() =>
      assertValidBodyParams('h', undefined, [{ index: 0, source: 'body', name: 'name' }]),
    ).toThrow(/no @Body schema/);
  });

  it('allows a name-less whole-body @BodyParam without a @Body schema', () => {
    expect(() =>
      assertValidBodyParams('h', undefined, [{ index: 0, source: 'body' }]),
    ).not.toThrow();
  });

  it('accepts @File on a single z.file() field and @Files on an array of files', () => {
    expect(() =>
      assertValidBodyParams('h', Upload, [
        { index: 0, source: 'body', name: 'avatar', file: 'single' },
        { index: 1, source: 'body', name: 'photos', file: 'multiple' },
        { index: 2, source: 'body', name: 'caption' },
      ]),
    ).not.toThrow();
  });

  it('rejects @File pointed at a non-file field', () => {
    expect(() =>
      assertValidBodyParams('h', Upload, [
        { index: 0, source: 'body', name: 'caption', file: 'single' },
      ]),
    ).toThrow(/@File\('caption'\).*single z\.file\(\) field/);
  });

  it('rejects @File pointed at an array-of-files field', () => {
    expect(() =>
      assertValidBodyParams('h', Upload, [
        { index: 0, source: 'body', name: 'photos', file: 'single' },
      ]),
    ).toThrow(/@File\('photos'\).*single z\.file\(\) field/);
  });

  it('rejects @Files pointed at a single file field', () => {
    expect(() =>
      assertValidBodyParams('h', Upload, [
        { index: 0, source: 'body', name: 'avatar', file: 'multiple' },
      ]),
    ).toThrow(/@Files\('avatar'\).*z\.array\(z\.file\(\)\) field/);
  });
});

describe('mount enforces body-param/schema agreement', () => {
  it('throws when a @BodyParam names a missing field', () => {
    @Route('items')
    class Controller {
      @Post()
      @Body(Item)
      public create(@BodyParam('missing') _x: unknown): void {}
    }

    expect(() => mount(new Controller())).toThrow(/@BodyParam\('missing'\)/);
  });

  it('throws when @File does not match a file field', () => {
    @Route('uploads')
    class Controller {
      @Post()
      @Body(Item) // no file fields
      public up(@File('avatar') _f: unknown): void {}
    }

    expect(() => mount(new Controller())).toThrow(/@File\('avatar'\)/);
  });

  it('mounts a correct multipart handler without error', () => {
    @Route('uploads')
    class Controller {
      @Post()
      @Body(Upload)
      public up(
        @File('avatar') _a: unknown,
        @Files('photos') _p: unknown,
        @BodyParam('caption') _c: unknown,
      ): void {}
    }

    expect(() => mount(new Controller())).not.toThrow();
  });
});
