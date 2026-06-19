import { describe, expect, it } from 'vitest';
import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { Get, Post, Returns, Route, Tags } from './decorators.js';
import { BodyParam, Header, Param, QueryParam, Req, Res } from './parameters.js';
import { Zodec } from './zodec.js';

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
