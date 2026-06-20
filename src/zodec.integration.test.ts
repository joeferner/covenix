import { describe, expect, it } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import multer, { type Options } from 'multer';
import { z } from 'zod';
import {
  Body,
  Get,
  Params,
  Post,
  Query,
  Returns,
  ReturnsFile,
  Route,
  Security,
  Sse,
  Tags,
  Use,
} from './decorators.js';
import {
  BodyParam,
  File,
  Files,
  Header,
  Param,
  Principal,
  QueryParam,
  Req,
  Res,
} from './parameters.js';
import { Zodec } from './zodec.js';
import { bearer, apiKey } from './security.js';
import { SecurityError, ValidationError, zodecErrorHandler } from './errors.js';
import { FileResponse } from './file-response.js';
import { RangeFileResponse } from './range-file-response.js';
import { HttpResponse } from './http-response.js';
import { SseEvent } from './sse.js';

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
    // `.loose()` keeps the echoed payload — this test is about arg injection,
    // not response shaping (zodec otherwise strips undeclared fields).
    @Returns(200, z.object({}).loose())
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
    @Returns(200, z.object({}).loose())
    public get(@Param('id') id: number, @QueryParam('page') page: number): Record<string, unknown> {
      // Echo the coerced/defaulted values along with their runtime types.
      return { id, page, idType: typeof id, pageType: typeof page };
    }

    @Post()
    @Body(CreateBody)
    @Returns(201, z.object({}).loose())
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

    // Returns an extra `secret` field not declared in the schema.
    @Get('leaky')
    @Returns(200, Strict)
    public leaky(): unknown {
      return { id: 'ok', secret: 'do-not-leak' };
    }

    // A transform on the response schema runs during serialization.
    @Get('transformed')
    @Returns(200, z.object({ id: z.string().transform((s) => s.toUpperCase()) }))
    public transformed(): unknown {
      return { id: 'abc' };
    }

    // `.loose()` opts out of stripping — extra keys are preserved.
    @Get('loose')
    @Returns(200, z.object({ id: z.string() }).loose())
    public loose(): unknown {
      return { id: 'ok', extra: 'kept' };
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

  it('strips fields not declared in the response schema', async () => {
    const res = await request(makeApp(new OutController())).get('/out/leaky');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'ok' }); // `secret` stripped
    expect(res.body).not.toHaveProperty('secret');
  });

  it('applies response-schema transforms during serialization', async () => {
    const res = await request(makeApp(new OutController())).get('/out/transformed');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'ABC' });
  });

  it('keeps extra keys when the schema is .loose()', async () => {
    const res = await request(makeApp(new OutController())).get('/out/loose');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'ok', extra: 'kept' });
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

  it('renders a ValidationError as an RFC 9457 problem+json body', async () => {
    const res = await request(makeAppWithErrorHandler(new ThingController()))
      .post('/things')
      .send({ name: 'no' });

    const body = res.body as {
      type: string;
      title: string;
      status: number;
      errors: { path: unknown[]; message: string }[];
    };
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(body.type).toBe('about:blank');
    expect(body.title).toBe('Unprocessable Entity'); // status reason phrase
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

  it('honors a custom formatError (and falls back to application/json)', async () => {
    const app = makeApp(new ThingController());
    app.use(
      zodecErrorHandler({
        formatError: (error) => ({
          ok: false,
          count: error instanceof ValidationError ? error.issues.length : 0,
        }),
      }),
    );

    const res = await request(app).post('/things').send({ name: 'no' });
    const body = res.body as { ok: boolean; count: number };

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-type']).not.toContain('problem');
    expect(body).toEqual({ ok: false, count: 1 });
  });
});

describe('HttpResponse', () => {
  const User = z.object({ id: z.string(), name: z.string() }).meta({ id: 'HttpUser' });
  const Accepted = z.object({ queued: z.boolean() });

  @Route('hr')
  class HrController {
    // Bare return still works alongside HttpResponse on the same controller.
    @Get('bare')
    @Returns(200, User)
    public bare(): z.infer<typeof User> {
      return { id: '1', name: 'bare' };
    }

    @Get('wrapped')
    @Returns(200, User, { headers: { 'X-Count': z.number().int() } })
    public wrapped(): HttpResponse<z.infer<typeof User>> {
      return new HttpResponse(
        { id: '1', name: 'wrapped' },
        {
          headers: { 'X-Count': 5, 'X-Custom': 'hi' }, // declared (number) + undeclared
          cookies: [{ name: 'sid', value: 'abc', options: { httpOnly: true, sameSite: 'lax' } }],
        },
      );
    }

    // Extra fields on the body are stripped by the @Returns schema, as for a bare return.
    @Get('leaky')
    @Returns(200, User)
    public leaky(): HttpResponse<z.infer<typeof User>> {
      return new HttpResponse({ id: '1', name: 'leaky', secret: 'x' } as z.infer<typeof User>);
    }

    @Get('multi')
    @Returns(200, User)
    public multi(): HttpResponse<z.infer<typeof User>> {
      return new HttpResponse({ id: '1', name: 'multi' }, { headers: { Link: ['<a>', '<b>'] } });
    }

    // Status selection: send a non-default declared status, validated by ITS schema.
    @Post('create')
    @Returns(200, User)
    @Returns(202, Accepted)
    public create(): HttpResponse<z.infer<typeof Accepted>> {
      return new HttpResponse({ queued: true }, { status: 202 });
    }

    // An explicit status with no matching @Returns is a server bug → 500.
    @Get('undeclared-status')
    @Returns(200, User)
    public undeclaredStatus(): HttpResponse<z.infer<typeof User>> {
      return new HttpResponse({ id: '1', name: 'x' }, { status: 599 });
    }

    // A header value that fails its declared schema is a server bug → 500.
    @Get('bad-header')
    @Returns(200, User, { headers: { 'X-Count': z.number().int() } })
    public badHeader(): HttpResponse<z.infer<typeof User>> {
      return new HttpResponse({ id: '1', name: 'x' }, { headers: { 'X-Count': 'not-a-number' } });
    }
  }

  it('sends the body with a coerced declared header and an undeclared header', async () => {
    const res = await request(makeApp(new HrController())).get('/hr/wrapped');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '1', name: 'wrapped' });
    expect(res.headers['x-count']).toBe('5'); // number coerced to string
    expect(res.headers['x-custom']).toBe('hi'); // undeclared, allowed
  });

  it('sets cookies as Set-Cookie headers', async () => {
    const res = await request(makeApp(new HrController())).get('/hr/wrapped');

    const cookies = res.headers['set-cookie'] ?? [];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('sid=abc');
    expect(cookies[0]).toContain('HttpOnly');
  });

  it('emits an array header value as a repeated header', async () => {
    const res = await request(makeApp(new HrController())).get('/hr/multi');

    expect(res.status).toBe(200);
    // superagent joins repeated headers with ", "
    expect(res.headers['link']).toBe('<a>, <b>');
  });

  it('strips body fields not in the @Returns schema (same as a bare return)', async () => {
    const res = await request(makeApp(new HrController())).get('/hr/leaky');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '1', name: 'leaky' });
  });

  it('selects a non-default declared status and validates against its schema', async () => {
    const res = await request(makeApp(new HrController())).post('/hr/create');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
  });

  it('500s when the explicit status has no matching @Returns', async () => {
    const res = await request(makeAppWithErrorHandler(new HrController())).get(
      '/hr/undeclared-status',
    );

    expect(res.status).toBe(500);
  });

  it('500s when a header value fails its declared schema', async () => {
    const res = await request(makeAppWithErrorHandler(new HrController())).get('/hr/bad-header');

    expect(res.status).toBe(500);
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

  it('sends inline disposition with extra headers (Cache-Control)', async () => {
    @Route('files')
    class InlineController {
      @Get('avatar')
      @ReturnsFile(200, { contentType: 'image/png' })
      public avatar(): FileResponse {
        return new FileResponse(Buffer.from('PNGDATA'), {
          contentType: 'image/png',
          filename: 'me.png',
          disposition: 'inline',
          headers: { 'Cache-Control': 'private, no-store', 'X-Custom': 1 },
        });
      }
    }

    const res = await request(makeApp(new InlineController())).get('/files/avatar');

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['content-disposition']).toContain('me.png');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-custom']).toBe('1'); // numbers are stringified
  });

  it('lets an explicit header override the derived one', async () => {
    @Route('files')
    class OverrideController {
      @Get('thing')
      @ReturnsFile(200)
      public thing(): FileResponse {
        return new FileResponse(Buffer.from('x'), {
          contentType: 'text/plain',
          headers: { 'Content-Type': 'application/octet-stream' }, // wins
        });
      }
    }

    const res = await request(makeApp(new OverrideController())).get('/files/thing');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
  });
});

describe('range file responses', () => {
  const data = Buffer.from('helloworld'); // 10 bytes

  @Route('range')
  class RangeController {
    // Buffer body: range-capable by construction.
    @Get('buf')
    @ReturnsFile(200, { contentType: 'text/plain' })
    public buf(): RangeFileResponse {
      return new RangeFileResponse(new Uint8Array(data), { contentType: 'text/plain' });
    }

    // Stream source: zodec asks for the requested slice.
    @Get('stream')
    @ReturnsFile(200, { contentType: 'text/plain' })
    public stream(): RangeFileResponse {
      return new RangeFileResponse(
        {
          size: data.length,
          stream: (range) =>
            Readable.from(range ? data.subarray(range.start, range.end + 1) : data),
        },
        { contentType: 'text/plain' },
      );
    }
  }

  it('serves the full body with Accept-Ranges when no Range is sent', async () => {
    const res = await request(makeApp(new RangeController())).get('/range/buf');
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('10');
    expect(res.text).toBe('helloworld');
  });

  it('serves 206 with Content-Range for a single satisfiable range (buffer)', async () => {
    const res = await request(makeApp(new RangeController()))
      .get('/range/buf')
      .set('Range', 'bytes=0-4');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-4/10');
    expect(res.headers['content-length']).toBe('5');
    expect(res.text).toBe('hello');
  });

  it('asks a stream source for the requested slice (206)', async () => {
    const res = await request(makeApp(new RangeController()))
      .get('/range/stream')
      .set('Range', 'bytes=5-9');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 5-9/10');
    expect(res.text).toBe('world');
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const res = await request(makeApp(new RangeController()))
      .get('/range/buf')
      .set('Range', 'bytes=50-60');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */10');
  });

  it('falls back to a full 200 for a multi-range request', async () => {
    const res = await request(makeApp(new RangeController()))
      .get('/range/buf')
      .set('Range', 'bytes=0-1,3-4');
    expect(res.status).toBe(200);
    expect(res.text).toBe('helloworld');
  });

  describe('fromPath (Express sendFile)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zodec-range-'));
    const file = join(dir, 'data.txt');
    writeFileSync(file, 'helloworld');

    @Route('disk')
    class DiskController {
      @Get('file')
      @ReturnsFile(200, { contentType: 'text/plain' })
      public file(): RangeFileResponse {
        return RangeFileResponse.fromPath(file, { contentType: 'text/plain' });
      }
    }

    it('serves a disk file with Range support', async () => {
      const res = await request(makeApp(new DiskController()))
        .get('/disk/file')
        .set('Range', 'bytes=0-4');
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 0-4/10');
      expect(res.text).toBe('hello');
    });

    it('honors conditional GET (ETag → 304)', async () => {
      const app = makeApp(new DiskController());
      const first = await request(app).get('/disk/file');
      expect(first.status).toBe(200);
      const etag = first.headers['etag'] as string;
      expect(etag).toBeTruthy();

      const second = await request(app).get('/disk/file').set('If-None-Match', etag);
      expect(second.status).toBe(304);
    });
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
      z.object({
        name: z.string(),
        type: z.string(),
        size: z.number(),
        text: z.string(),
        caption: z.string().optional(),
      }),
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

describe('@Security', () => {
  interface User {
    id: string;
    role: 'admin' | 'user';
  }

  @Route('secure')
  class SecureController {
    @Get('me')
    @Security('bearer')
    @Returns(200, z.object({ id: z.string(), role: z.string() }))
    public me(@Principal() user: User): User {
      return user;
    }

    @Get('admin')
    @Security('bearer', ['admin'])
    @Returns(200, z.object({ ok: z.boolean() }))
    public admin(): { ok: boolean } {
      return { ok: true };
    }

    // Stacked = OR: a valid bearer token OR a valid API key gets in.
    @Get('either')
    @Security('bearer')
    @Security('apiKey')
    @Returns(200, z.object({ via: z.string() }))
    public either(@Principal() who: { via: string }): { via: string } {
      return who;
    }
  }

  // bearer: "Bearer admin" / "Bearer user" map to roles; anything else → null (401).
  // For ['admin'] scope, a non-admin principal throws 403.
  function secureApp(): express.Express {
    const app = express();
    const api = new Zodec({
      info: { title: 'T', version: '1.0.0' },
      security: {
        bearer: bearer((req, scopes) => {
          const auth = req.headers.authorization;
          const role = auth === 'Bearer admin' ? 'admin' : auth === 'Bearer user' ? 'user' : null;
          if (!role) {
            return null;
          }
          if (scopes.length > 0 && !scopes.includes(role)) {
            throw new SecurityError(403, 'Forbidden');
          }
          return { id: `u_${role}`, role, via: 'bearer' };
        }),
        apiKey: apiKey({ in: 'header', name: 'x-api-key' }, (req) =>
          req.headers['x-api-key'] === 'secret' ? { via: 'apiKey' } : null,
        ),
      },
    });
    api.register(new SecureController());
    api.mount(app);
    app.use(zodecErrorHandler());
    return app;
  }

  it('injects the principal on a valid token', async () => {
    const res = await request(secureApp()).get('/secure/me').set('authorization', 'Bearer user');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'u_user', role: 'user' });
  });

  it('rejects a missing/invalid token with 401 problem+json', async () => {
    const res = await request(secureApp()).get('/secure/me');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ type: 'about:blank', title: 'Unauthorized', status: 401 });
    expect(res.body).not.toHaveProperty('errors'); // SecurityError carries no field errors
  });

  it('allows an in-scope principal', async () => {
    const res = await request(secureApp())
      .get('/secure/admin')
      .set('authorization', 'Bearer admin');
    expect(res.status).toBe(200);
  });

  it('forbids an out-of-scope principal with 403', async () => {
    const res = await request(secureApp()).get('/secure/admin').set('authorization', 'Bearer user');
    expect(res.status).toBe(403);
  });

  it('OR: satisfied by the second scheme when the first fails', async () => {
    const res = await request(secureApp()).get('/secure/either').set('x-api-key', 'secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ via: 'apiKey' });
  });

  it('OR: rejects when no scheme is satisfied', async () => {
    const res = await request(secureApp()).get('/secure/either');
    expect(res.status).toBe(401);
  });

  it('runs security before body validation (401 precedes 422)', async () => {
    @Route('guarded')
    class GuardedController {
      @Post()
      @Security('bearer')
      @Body(z.object({ name: z.string().min(3) }))
      @Returns(201, z.object({}))
      public create(@BodyParam() body: unknown): unknown {
        return body;
      }
    }
    const app = express();
    app.use(express.json());
    const api = new Zodec({
      info: { title: 'T', version: '1.0.0' },
      security: { bearer: bearer(() => null) }, // always 401
    });
    api.register(new GuardedController());
    api.mount(app);

    // Invalid body too, but auth fails first → 401, not 422.
    const res = await request(app).post('/guarded').send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('@Use middleware', () => {
  const order: string[] = [];
  const tag =
    (name: string): express.RequestHandler =>
    (_req, _res, next) => {
      order.push(name);
      next();
    };

  @Route('mw')
  @Use(tag('class-a'), tag('class-b'))
  class MwController {
    @Get('run')
    @Use(tag('method'))
    @Returns(200, z.object({ ok: z.boolean() }))
    public run(): { ok: boolean } {
      order.push('handler');
      return { ok: true };
    }

    // Middleware that short-circuits by sending a response.
    @Get('guard')
    @Use((_req, res) => {
      res.status(403).json({ blocked: true });
    })
    @Returns(200, z.object({ ok: z.boolean() }))
    public guard(): { ok: boolean } {
      order.push('guard-handler');
      return { ok: true };
    }
  }

  it('runs class middleware (in order), then method middleware, then the handler', async () => {
    order.length = 0;
    const res = await request(makeApp(new MwController())).get('/mw/run');

    expect(res.status).toBe(200);
    expect(order).toEqual(['class-a', 'class-b', 'method', 'handler']);
  });

  it('short-circuits when middleware sends a response (handler not called)', async () => {
    order.length = 0;
    const res = await request(makeApp(new MwController())).get('/mw/guard');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ blocked: true });
    expect(order).not.toContain('guard-handler');
  });

  it('runs @Security before @Use', async () => {
    const seen: string[] = [];

    @Route('secured-mw')
    class SecuredMwController {
      @Get()
      @Security('bearer')
      @Use((_req, _res, next) => {
        seen.push('use');
        next();
      })
      @Returns(200, z.object({ ok: z.boolean() }))
      public run(): { ok: boolean } {
        return { ok: true };
      }
    }

    const app = express();
    const api = new Zodec({
      info: { title: 'T', version: '1.0.0' },
      security: {
        bearer: bearer((_req) => {
          seen.push('security');
          return { id: 'u' };
        }),
      },
    });
    api.register(new SecuredMwController());
    api.mount(app);

    const res = await request(app).get('/secured-mw').set('authorization', 'Bearer x');
    expect(res.status).toBe(200);
    expect(seen).toEqual(['security', 'use']); // auth ran before @Use
  });
});

describe('serveDocs', () => {
  function docsApp(path: string, options?: Parameters<Zodec['serveDocs']>[2]): express.Express {
    const app = express();
    const api = new Zodec({ info: { title: 'Docs API', version: '1.0.0' } });
    api.register(new HelloController());
    api.serveDocs(app, path, options);
    return app;
  }

  it('serves the spec at <path>/openapi.json', async () => {
    const res = await request(docsApp('/docs')).get('/docs/openapi.json');
    expect(res.status).toBe(200);
    expect((res.body as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('serves the Scalar UI (default) + its self-hosted bundle', async () => {
    const app = docsApp('/docs');
    const html = await request(app).get('/docs');
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.text).toContain('id="api-reference"');
    expect(html.text).toContain('data-url="/docs/openapi.json"');
    expect(html.text).toContain('src="/docs/scalar.js"');

    const bundle = await request(app).get('/docs/scalar.js');
    expect(bundle.status).toBe(200);
  });

  it('serves the Swagger UI + static assets', async () => {
    const app = docsApp('/docs', { ui: 'swagger-ui' });
    const html = await request(app).get('/docs');
    expect(html.text).toContain('SwaggerUIBundle');
    expect(html.text).toContain('"/docs/openapi.json"');

    const js = await request(app).get('/docs/assets/swagger-ui-bundle.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
  });

  it('serves the Redoc UI + its self-hosted bundle', async () => {
    const app = docsApp('/docs', { ui: 'redoc' });
    const html = await request(app).get('/docs');
    expect(html.text).toContain('<redoc spec-url="/docs/openapi.json">');

    const js = await request(app).get('/docs/redoc.standalone.js');
    expect(js.status).toBe(200);
  });

  it('uses a CDN script and serves no local asset when { cdn: true }', async () => {
    const app = docsApp('/docs', { ui: 'scalar', cdn: true });
    const html = await request(app).get('/docs');
    expect(html.text).toContain('https://cdn.jsdelivr.net/npm/@scalar/api-reference');

    const local = await request(app).get('/docs/scalar.js');
    expect(local.status).toBe(404); // no self-hosted asset route in cdn mode
  });

  it('honors specVersion for the served spec', async () => {
    const res = await request(docsApp('/docs', { cdn: true, specVersion: '3.0' })).get(
      '/docs/openapi.json',
    );
    expect((res.body as { openapi: string }).openapi).toBe('3.0.3');
  });
});

describe('@Sse (server-sent events)', () => {
  const TokenSchema = z.object({ text: z.string() });

  @Route('sse')
  class SseController {
    @Get('tokens')
    @Sse(TokenSchema)
    public async *tokens(): AsyncGenerator<unknown> {
      await Promise.resolve();
      yield { text: 'hello' };
      yield new SseEvent({ text: 'world' }, { event: 'token', id: '1' });
      yield { text: 'kept', secret: 'drop' }; // extra field stripped by the schema
    }

    @Get('raw')
    @Sse()
    public async *raw(): AsyncGenerator<unknown> {
      await Promise.resolve();
      yield 'ping';
      yield 'pong';
    }
  }

  it('streams framed events as text/event-stream (validated + serialized)', async () => {
    const res = await request(makeApp(new SseController())).get('/sse/tokens');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data: {"text":"hello"}\n\n');
    // SseEvent envelope → event/id lines precede the data line.
    expect(res.text).toContain('event: token\nid: 1\ndata: {"text":"world"}\n\n');
    // Schema strips undeclared fields from each event too.
    expect(res.text).toContain('data: {"text":"kept"}\n\n');
    expect(res.text).not.toContain('secret');
  });

  it('frames plain string events as data: lines when there is no schema', async () => {
    const res = await request(makeApp(new SseController())).get('/sse/raw');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data: ping\n\n');
    expect(res.text).toContain('data: pong\n\n');
  });

  it("runs the generator's finally on client disconnect", async () => {
    let cleanedUp = false;
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });

    @Route('live')
    class LiveController {
      @Get('stream')
      @Sse(TokenSchema)
      public async *stream(): AsyncGenerator<unknown> {
        try {
          for (let i = 0; ; i++) {
            yield { text: `t${i}` };
            await new Promise((r) => setTimeout(r, 10));
          }
        } finally {
          cleanedUp = true;
          resolveCleanup();
        }
      }
    }

    const server = makeApp(new LiveController()).listen(0);
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cleanup did not run')), 2000);
      const req = http.get(`http://127.0.0.1:${port}/live/stream`, (res) => {
        res.once('data', () => req.destroy()); // got the first frame → disconnect
        res.on('error', () => {});
      });
      req.on('error', () => {}); // destroy() surfaces an aborted-request error
      cleanup.then(
        () => {
          clearTimeout(timer);
          server.close();
          resolve();
        },
        () => {},
      );
    });

    expect(cleanedUp).toBe(true);
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
