import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Body, Get, Post, Returns, Route } from './decorators.js';
import { BodyParam } from './parameters.js';
import { Zodec } from './zodec.js';
import { serve, toExpress } from './express.js';

const Greeting = z.object({ message: z.string() });
const NameBody = z.object({ name: z.string() });

@Route('hello')
class HelloController {
  @Get()
  @Returns(200, Greeting)
  public greet(): z.infer<typeof Greeting> {
    return { message: 'hi' };
  }

  @Post()
  @Body(NameBody)
  @Returns(200, Greeting)
  public echo(@BodyParam('name') name: string): z.infer<typeof Greeting> {
    return { message: name };
  }

  // Returns a value that violates @Returns → a 500 ValidationError, which the
  // zodec error handler formats as application/problem+json.
  @Get('bad')
  @Returns(200, Greeting)
  public bad(): z.infer<typeof Greeting> {
    return { wrong: 'shape' } as unknown as z.infer<typeof Greeting>;
  }
}

function api(): Zodec {
  const zodec = new Zodec({ info: { title: 'Test', version: '1.0.0' } });
  zodec.register(new HelloController());
  return zodec;
}

describe('toExpress', () => {
  it('builds a mounted app that serves routes', async () => {
    const res = await request(toExpress(api())).get('/hello');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'hi' });
  });

  it('parses JSON bodies by default and serves docs + error handler', async () => {
    const app = toExpress(api());

    const post = await request(app).post('/hello').send({ name: 'zo' });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ message: 'zo' });

    // Docs are mounted by default.
    const docs = await request(app).get('/docs/openapi.json');
    expect(docs.status).toBe(200);
    expect((docs.body as { openapi?: string }).openapi).toMatch(/^3\./);

    // The default zodec error handler maps a ValidationError to a JSON problem.
    const bad = await request(app).get('/hello/bad');
    expect(bad.status).toBe(500);
    expect(bad.headers['content-type']).toContain('json');
  });

  it('opts out of json, docs, and the error handler when set to false', async () => {
    const app = toExpress(api(), { json: false, docs: false, errorHandler: false });

    // No body parser → @Body sees undefined → 422.
    const post = await request(app).post('/hello').send({ name: 'zo' });
    expect(post.status).toBe(422);

    // No docs route.
    const docs = await request(app).get('/docs/openapi.json');
    expect(docs.status).toBe(404);

    // No zodec error handler → Express default (HTML), not a JSON problem.
    const bad = await request(app).get('/hello/bad');
    expect(bad.status).toBe(500);
    expect(bad.headers['content-type']).not.toContain('json');
  });

  it('parses urlencoded bodies when enabled', async () => {
    const app = toExpress(api(), { json: false, urlencoded: true });

    const res = await request(app).post('/hello').type('form').send({ name: 'form-val' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'form-val' });
  });

  it('runs configure before routes and after before the error handler', async () => {
    const app = toExpress(api(), {
      configure: (a) => {
        // Pre-route: short-circuits before any route matches.
        a.use((req, res, next) => {
          if (req.path === '/blocked') {
            res.status(403).send('blocked');
            return;
          }
          next();
        });
      },
      after: (a) => {
        // Post-route fallback: only reached for unmatched paths.
        a.use((_req, res) => res.status(200).json({ message: 'fallback' }));
      },
    });

    expect((await request(app).get('/blocked')).status).toBe(403); // configure won
    expect((await request(app).get('/hello')).body).toEqual({ message: 'hi' }); // route still wins
    expect((await request(app).get('/unmatched')).body).toEqual({ message: 'fallback' }); // after
  });

  it('adds route-less docs schemas to the served spec', async () => {
    const Standalone = z.object({ tag: z.string() }).meta({ id: 'Standalone' });
    const app = toExpress(api(), { docs: { schemas: [Standalone] } });

    const res = await request(app).get('/docs/openapi.json');
    const components = (res.body as { components?: { schemas?: Record<string, unknown> } })
      .components;
    expect(components?.schemas?.Standalone).toBeDefined();
  });

  it('builds onto a provided app, preserving its existing routes', async () => {
    const base = express();
    base.get('/pre', (_req, res) => {
      res.json({ ok: true });
    });

    const app = toExpress(api(), { app: base });

    expect((await request(app).get('/pre')).body).toEqual({ ok: true });
    expect((await request(app).get('/hello')).body).toEqual({ message: 'hi' });
  });
});

describe('serve', () => {
  it('listens and returns the http.Server', async () => {
    const server = await serve(api(), { port: 0 });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await request(`http://127.0.0.1:${port}`).get('/hello');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'hi' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
