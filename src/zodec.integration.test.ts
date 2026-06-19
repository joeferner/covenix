import { describe, expect, it } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import multer, { type Options } from 'multer';
import { z } from 'zod';
import { Body, Get, Params, Post, Query, Returns, ReturnsFile, Route, Tags } from './decorators.js';
import { BodyParam, File, Files, Header, Param, QueryParam, Req, Res } from './parameters.js';
import { Zodec } from './zodec.js';
import { zodecErrorHandler } from './errors.js';
import { FileResponse } from './file-response.js';

const Greeting = z.object({ message: z.string() });

@Route('hello')
@Tags('Hello')
class HelloController {
  @Get()
  @Returns(200, Greeting)
  public greet(): z.infer<typeof Greeting> {
    return { message: 'hello world' };
  }
}

function makeApp(...controllers: object[]): express.Express {
  const app = express();
  app.use(express.json());
  const api = new Zodec({ info: { title: 'Test API', version: '1.0.0' } });
  for (const controller of controllers) {
    api.register(controller);
  }
  api.mount(app);
  return app;
}

function makeAppWithErrorHandler(...controllers: object[]): express.Express {
  const app = makeApp(...controllers);
  app.use(zodecErrorHandler());
  return app;
}

describe('Zodec register + mount', () => {
  it('serves a registered controller route end to end', async () => {
    const res = await request(makeApp(new HelloController())).get('/hello');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'hello world' });
  });
});

describe('handler argument assembly', () => {
  @Route('echo')
  class EchoController {
    // Mixed parameter decorators, deliberately not in index order, plus a
    // plain undecorated trailing arg to prove gaps stay undefined.
    @Post('{id}')
    @Returns(200, z.object({}))
    public echo(
      @Param('id') id: string,
      @QueryParam('q') q: string,
      @BodyParam() body: unknown,
      @Header('x-token') token: string,
    ): Record<string, unknown> {
      return { id, q, body, token };
    }
  }

  it('injects param, query, body, and header values by index', async () => {
    const app = makeApp(new EchoController());

    const res = await request(app)
      .post('/echo/42?q=search')
      .set('x-token', 'secret')
      .send({ hello: 'world' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: '42',
      q: 'search',
      body: { hello: 'world' },
      token: 'secret',
    });
  });
});

describe('request validation', () => {
  const IdParams = z.object({ id: z.coerce.number().int() });
  const Pagination = z.object({ page: z.coerce.number().int().default(1) });
  const CreateBody = z.object({ name: z.string().min(3) });

  @Route('items')
  class ItemController {
    @Get('{id}')
    @Params(IdParams)
    @Query(Pagination)
    @Returns(200, z.object({}))
    public get(@Param('id') id: number, @QueryParam('page') page: number): Record<string, unknown> {
      // Echo the coerced/defaulted values along with their runtime types.
      return { id, page, idType: typeof id, pageType: typeof page };
    }

    @Post()
    @Body(CreateBody)
    @Returns(201, z.object({}))
    public create(@BodyParam() body: unknown): unknown {
      return body;
    }
  }

  it('coerces and defaults params/query before the handler runs', async () => {
    const res = await request(makeApp(new ItemController())).get('/items/42');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 42,
      page: 1,
      idType: 'number',
      pageType: 'number',
    });
  });

  it('returns 400 when params fail validation', async () => {
    const res = await request(makeApp(new ItemController())).get('/items/abc');
    expect(res.status).toBe(400);
  });

  it('returns 422 when the body fails validation', async () => {
    const res = await request(makeApp(new ItemController())).post('/items').send({ name: 'no' });
    expect(res.status).toBe(422);
  });

  it('accepts a valid body', async () => {
    const res = await request(makeApp(new ItemController()))
      .post('/items')
      .send({ name: 'widget' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'widget' });
  });
});

describe('response validation', () => {
  const Strict = z.object({ id: z.string() });

  @Route('out')
  class OutController {
    @Get('good')
    @Returns(200, Strict)
    public good(): unknown {
      return { id: 'ok' };
    }

    @Get('bad')
    @Returns(200, Strict)
    public bad(): unknown {
      // id should be a string — returning a number is a server-side contract bug.
      return { id: 123 };
    }
  }

  it('passes a response that matches its @Returns schema', async () => {
    const res = await request(makeApp(new OutController())).get('/out/good');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'ok' });
  });

  it('throws 500 when the response violates its @Returns schema', async () => {
    const res = await request(makeApp(new OutController())).get('/out/bad');
    expect(res.status).toBe(500);
  });
});

describe('zodecErrorHandler', () => {
  const CreateBody = z.object({ name: z.string().min(3) });

  @Route('things')
  class ThingController {
    @Post()
    @Body(CreateBody)
    @Returns(201, z.object({}))
    public create(@BodyParam() body: unknown): unknown {
      return body;
    }

    @Get('boom')
    @Returns(200, z.object({}))
    public boom(): unknown {
      throw new Error('not a validation error');
    }
  }

  it('renders a ValidationError as { status, errors: [{ path, message }] }', async () => {
    const res = await request(makeAppWithErrorHandler(new ThingController()))
      .post('/things')
      .send({ name: 'no' });

    const body = res.body as {
      status: number;
      errors: { path: unknown[]; message: string }[];
    };
    expect(res.status).toBe(422);
    expect(body.status).toBe(422);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.path).toEqual(['name']);
    expect(typeof body.errors[0]?.message).toBe('string');
  });

  it('passes non-validation errors through untouched', async () => {
    const res = await request(makeAppWithErrorHandler(new ThingController())).get('/things/boom');

    expect(res.status).toBe(500);
    // Not rendered in zodec's validation shape.
    expect(res.body).not.toHaveProperty('errors');
  });

  it('honors a custom formatError', async () => {
    const app = makeApp(new ThingController());
    app.use(
      zodecErrorHandler({
        formatError: (error) => ({ ok: false, count: error.issues.length }),
      }),
    );

    const res = await request(app).post('/things').send({ name: 'no' });
    const body = res.body as { ok: boolean; count: number };

    expect(res.status).toBe(422);
    expect(body).toEqual({ ok: false, count: 1 });
  });
});

describe('file responses', () => {
  @Route('files')
  class FileController {
    @Get('report')
    @ReturnsFile(200, { contentType: 'text/csv' })
    public report(): FileResponse {
      return new FileResponse(Buffer.from('a,b\n1,2\n'), {
        contentType: 'text/csv',
        filename: 'report.csv',
      });
    }
  }

  it('streams a FileResponse with the right headers and body', async () => {
    const res = await request(makeApp(new FileController())).get('/files/report');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('report.csv');
    expect(res.text).toBe('a,b\n1,2\n');
  });

  it('encodes a UTF-8 filename per RFC 5987 (filename* with ASCII fallback)', async () => {
    @Route('files')
    class UnicodeController {
      @Get('report')
      @ReturnsFile(200, { contentType: 'text/plain' })
      public report(): FileResponse {
        return new FileResponse(Buffer.from('hello'), {
          contentType: 'text/plain',
          filename: 'résumé €.txt',
        });
      }
    }

    const res = await request(makeApp(new UnicodeController())).get('/files/report');
    const disposition = res.headers['content-disposition'];

    expect(res.status).toBe(200);
    // RFC 5987 UTF-8 form with the non-ASCII bytes percent-encoded...
    expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%E2%82%AC.txt");
    // ...plus an ASCII fallback `filename` for older clients.
    expect(disposition).toMatch(/filename="[^"]*"/);
    expect(res.text).toBe('hello');
  });
});

describe('multipart file uploads', () => {
  const AvatarUpload = z.object({
    avatar: z.file().max(1_000).mime(['image/png', 'text/plain']),
    caption: z.string().max(10).optional(),
  });
  const GalleryUpload = z.object({
    photos: z.array(z.file()).max(2),
  });

  @Route('uploads')
  class UploadController {
    @Post('avatar')
    @Body(AvatarUpload)
    @Returns(
      200,
      z.object({ name: z.string(), type: z.string(), size: z.number(), text: z.string() }),
    )
    public async avatar(
      @File('avatar') avatar: globalThis.File,
      @BodyParam('caption') caption: string | undefined,
    ): Promise<Record<string, unknown>> {
      return {
        name: avatar.name,
        type: avatar.type,
        size: avatar.size,
        text: await avatar.text(),
        caption,
      };
    }

    @Post('photos')
    @Body(GalleryUpload)
    @Returns(200, z.object({ count: z.number(), names: z.array(z.string()) }))
    public photos(@Files('photos') photos: globalThis.File[]): Record<string, unknown> {
      return { count: photos.length, names: photos.map((p) => p.name) };
    }
  }

  it('parses an uploaded file into a web File and a text field', async () => {
    const res = await request(makeApp(new UploadController()))
      .post('/uploads/avatar')
      .field('caption', 'hi')
      .attach('avatar', Buffer.from('pixels'), { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'a.png',
      type: 'image/png',
      size: 6,
      text: 'pixels',
      caption: 'hi',
    });
  });

  it('returns 422 when a file exceeds the schema size limit', async () => {
    const big = Buffer.alloc(2_000, 0x41);
    const res = await request(makeApp(new UploadController()))
      .post('/uploads/avatar')
      .attach('avatar', big, { filename: 'big.png', contentType: 'image/png' });

    expect(res.status).toBe(422);
  });

  it('returns 422 when a file has a disallowed mime type', async () => {
    const res = await request(makeApp(new UploadController()))
      .post('/uploads/avatar')
      .attach('avatar', Buffer.from('x'), { filename: 'a.gif', contentType: 'image/gif' });

    expect(res.status).toBe(422);
  });

  it('returns 422 when a required file is missing', async () => {
    const res = await request(makeApp(new UploadController()))
      .post('/uploads/avatar')
      .field('caption', 'hi');

    expect(res.status).toBe(422);
  });

  it('injects multiple files as an array', async () => {
    const res = await request(makeApp(new UploadController()))
      .post('/uploads/photos')
      .attach('photos', Buffer.from('1'), { filename: 'one.png', contentType: 'image/png' })
      .attach('photos', Buffer.from('2'), { filename: 'two.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2, names: ['one.png', 'two.png'] });
  });

  it('returns 422 when more files arrive than the schema array allows', async () => {
    const res = await request(makeApp(new UploadController()))
      .post('/uploads/photos')
      .attach('photos', Buffer.from('1'), { filename: 'one.png', contentType: 'image/png' })
      .attach('photos', Buffer.from('2'), { filename: 'two.png', contentType: 'image/png' })
      .attach('photos', Buffer.from('3'), { filename: 'three.png', contentType: 'image/png' });

    expect(res.status).toBe(422);
  });
});

describe('multipart storage engines', () => {
  const Upload = z.object({ file: z.file().max(1_000) });

  @Route('store')
  class StoreController {
    @Post()
    @Body(Upload)
    @Returns(200, z.object({ name: z.string(), size: z.number(), text: z.string() }))
    public async store(@File('file') file: globalThis.File): Promise<Record<string, unknown>> {
      return { name: file.name, size: file.size, text: await file.text() };
    }
  }

  function appWith(multipart: Options | undefined): express.Express {
    const app = express();
    const api = new Zodec({
      info: { title: 'T', version: '1.0.0' },
      ...(multipart ? { multipart } : {}),
    });
    api.register(new StoreController());
    api.mount(app);
    return app;
  }

  // Whatever the storage engine, the handler should receive an equivalent File —
  // memory wraps the buffer; disk (`dest` or a `diskStorage`) is backed lazily by
  // the file on disk via openAsBlob.
  it.each<[string, Options | undefined]>([
    ['memory (default)', undefined],
    ['disk via dest', { dest: mkdtempSync(join(tmpdir(), 'zodec-dest-')) }],
    ['disk via diskStorage', { storage: multer.diskStorage({}) }],
  ])('adapts an upload to a File with %s storage', async (_label, multipart) => {
    const res = await request(appWith(multipart))
      .post('/store')
      .attach('file', Buffer.from('hello disk'), {
        filename: 'f.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'f.txt', size: 10, text: 'hello disk' });
  });
});

describe('@Res escape hatch', () => {
  @Route('raw')
  class RawController {
    @Get()
    public ping(@Req() _req: Request, @Res() res: Response): void {
      res.status(202).type('text/plain').send('pong');
    }
  }

  it('lets the handler write the response without double-sending', async () => {
    const res = await request(makeApp(new RawController())).get('/raw');

    expect(res.status).toBe(202);
    expect(res.text).toBe('pong');
  });
});
