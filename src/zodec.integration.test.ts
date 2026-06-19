import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { Get, Returns, Route, Tags } from './decorators.js';
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

describe('Zodec register + mount', () => {
  it('serves a registered controller route end to end', async () => {
    const app = express();
    app.use(express.json());

    const api = new Zodec({ info: { title: 'Test API', version: '1.0.0' } });
    api.register(new HelloController());
    api.mount(app);

    const res = await request(app).get('/hello');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'hello world' });
  });
});
