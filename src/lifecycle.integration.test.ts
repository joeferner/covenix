import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import createError from 'http-errors';
import { z } from 'zod';
import { Body, Delete, Get, Params, Patch, Post, Put, Returns, Route } from './decorators.js';
import { BodyParam, Param } from './parameters.js';
import { Zodec } from './zodec.js';
import { zodecErrorHandler } from './errors.js';

const Item = z.object({ id: z.string(), name: z.string() }).meta({ id: 'Item' });
const Upsert = z.object({ name: z.string().min(1) });
const IdParams = z.object({ id: z.string() });

interface ItemBody {
  name: string;
}

@Route('items')
class ItemsController {
  @Get()
  @Returns(200, z.object({ items: z.array(z.string()) }))
  public list(): unknown {
    return { items: ['a', 'b'] };
  }

  @Post()
  @Body(Upsert)
  @Returns(201, Item)
  public create(@BodyParam() body: ItemBody): unknown {
    return { id: '1', name: body.name };
  }

  @Get('{id}')
  @Params(IdParams)
  @Returns(200, Item)
  @Returns(404, z.object({}))
  public get(@Param('id') id: string): unknown {
    if (id === 'missing') {
      throw new createError.NotFound('no such item');
    }
    return { id, name: 'found' };
  }

  @Put('{id}')
  @Params(IdParams)
  @Body(Upsert)
  @Returns(200, Item)
  public replace(@Param('id') id: string, @BodyParam() body: ItemBody): unknown {
    return { id, name: body.name };
  }

  @Patch('{id}')
  @Params(IdParams)
  @Body(z.object({ name: z.string().optional() }))
  @Returns(200, Item)
  public update(@Param('id') id: string, @BodyParam() body: { name?: string }): unknown {
    return { id, name: body.name ?? 'unchanged' };
  }

  @Delete('{id}')
  @Params(IdParams)
  @Returns(204, z.null())
  public remove(): null {
    return null;
  }
}

function app(): express.Express {
  const instance = express();
  instance.use(express.json());
  const api = new Zodec({ info: { title: 'Items', version: '1.0.0' } });
  api.register(new ItemsController());
  api.mount(instance);
  instance.use(zodecErrorHandler());
  return instance;
}

describe('full request lifecycle per HTTP method', () => {
  it('GET (collection) routes and responds', async () => {
    const res = await request(app()).get('/items');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: ['a', 'b'] });
  });

  it('POST creates and returns 201', async () => {
    const res = await request(app()).post('/items').send({ name: 'widget' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: '1', name: 'widget' });
  });

  it('GET (item) injects the path param', async () => {
    const res = await request(app()).get('/items/abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'abc', name: 'found' });
  });

  it('PUT replaces with path param + body', async () => {
    const res = await request(app()).put('/items/abc').send({ name: 'new' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'abc', name: 'new' });
  });

  it('PATCH updates with an optional body field', async () => {
    const res = await request(app()).patch('/items/abc').send({ name: 'patched' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'abc', name: 'patched' });
  });

  it('DELETE responds 204 with no content', async () => {
    const res = await request(app()).delete('/items/abc');
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });
});

describe('error handler responses', () => {
  it('propagates a thrown http-errors with its status', async () => {
    // createError.NotFound is not a ValidationError, so zodecErrorHandler passes
    // it through; Express honors its `status`.
    const res = await request(app()).get('/items/missing');
    expect(res.status).toBe(404);
  });

  it('renders a ValidationError through zodecErrorHandler', async () => {
    const res = await request(app()).post('/items').send({ name: '' });
    const body = res.body as { status: number; errors: unknown[] };
    expect(res.status).toBe(422);
    expect(body.status).toBe(422);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
