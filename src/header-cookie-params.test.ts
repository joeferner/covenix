import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { Cookies, Get, Headers, Returns, Route } from './decorators.js';
import { CookieParam, HeaderParam } from './parameters.js';
import { Avero } from './avero.js';
import { toExpress } from './express.js';
import { generateContract } from './contract.js';

const Echo = z.object({ requestId: z.string().optional(), sid: z.string().optional() });

@Route('things')
class ThingsController {
  @Get()
  @Headers(
    z.object({
      'x-request-id': z.uuid().optional().describe('Correlation id.'),
      authorization: z.string().optional(), // reserved → validated, not documented
    }),
  )
  @Cookies(z.object({ sid: z.string().optional().describe('Session id.') }))
  @Returns(200, Echo)
  public echo(
    @HeaderParam('x-request-id') requestId: string | undefined,
    @CookieParam('sid') sid: string | undefined,
  ): z.infer<typeof Echo> {
    return { requestId, sid };
  }
}

function buildApi(): Avero {
  const api = new Avero({ info: { title: 'T', version: '1.0.0' } });
  api.register(new ThingsController());
  return api;
}

// A tiny cookie parser so req.cookies is populated (mirrors cookie-parser).
const cookieMiddleware: express.RequestHandler = (req, _res, next) => {
  const header = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (header) {
    for (const pair of header.split(';')) {
      const eq = pair.indexOf('=');
      if (eq > -1) {
        cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
  }
  (req as express.Request & { cookies: Record<string, string> }).cookies = cookies;
  next();
};

describe('@Headers / @Cookies — OpenAPI emission', () => {
  it('emits in: header and in: cookie parameters', () => {
    const params = buildApi().swagger().paths?.['/things']?.get?.parameters ?? [];
    expect(params).toContainEqual(
      expect.objectContaining({ name: 'x-request-id', in: 'header', required: false }),
    );
    expect(params).toContainEqual(
      expect.objectContaining({ name: 'sid', in: 'cookie', required: false }),
    );
  });

  it('omits reserved headers (authorization) from the documented parameters', () => {
    const params = buildApi().swagger().paths?.['/things']?.get?.parameters ?? [];
    expect(params.some((p) => 'name' in p && p.name === 'authorization')).toBe(false);
  });
});

describe('@Headers / @Cookies — contract', () => {
  it('records request headers and cookies on the operation', () => {
    const op = generateContract([ThingsController]).operations.find((o) => o.path === '/things');
    expect(op?.headers?.kind).toBe('object');
    expect(op?.cookies?.kind).toBe('object');
  });
});

describe('@Headers / @Cookies — runtime', () => {
  function app(): express.Express {
    return toExpress(buildApi(), { configure: (a) => a.use(cookieMiddleware), docs: false });
  }

  it('injects the parsed header and cookie into the handler', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const res = await request(app())
      .get('/things')
      .set('x-request-id', id)
      .set('Cookie', 'sid=abc123');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requestId: id, sid: 'abc123' });
  });

  it('returns 400 when a header fails validation', async () => {
    const res = await request(app()).get('/things').set('x-request-id', 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('resolves to undefined when an optional header/cookie is absent', async () => {
    const res = await request(app()).get('/things');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});
