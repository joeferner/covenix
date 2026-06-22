import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { Get, Returns, Route } from './decorators.js';
import { Avero } from './avero.js';
import { generateSwagger } from './swagger.js';

@Route('users')
class UsersController {
  @Get()
  @Returns(200, z.object({ users: z.array(z.string()) }))
  public list(): unknown {
    return { users: ['ada'] };
  }
}

@Route('health')
class HealthController {
  @Get()
  @Returns(200, z.object({ ok: z.boolean() }))
  public check(): unknown {
    return { ok: true };
  }
}

// A controller with an empty @Route prefix — the base path is the whole prefix.
@Route('')
class RootController {
  @Get('ping')
  @Returns(200, z.object({ pong: z.boolean() }))
  public ping(): unknown {
    return { pong: true };
  }
}

function build(configure: (api: Avero) => void): express.Express {
  const instance = express();
  instance.use(express.json());
  const api = new Avero({ info: { title: 'Grouping', version: '1.0.0' } });
  configure(api);
  api.mount(instance);
  return instance;
}

describe('grouping / versioning — routes', () => {
  it('register({ prefix }) prepends the base path to the @Route prefix', async () => {
    const app = build((api) => api.register(new UsersController(), { prefix: '/v1' }));
    expect((await request(app).get('/v1/users')).status).toBe(200);
    // The un-prefixed path is gone.
    expect((await request(app).get('/users')).status).toBe(404);
  });

  it('group() applies the base path to every controller in the scope', async () => {
    const app = build((api) =>
      api.group('/v1', (v1) => {
        v1.register(new UsersController());
        v1.register(new HealthController());
      }),
    );
    expect((await request(app).get('/v1/users')).status).toBe(200);
    expect((await request(app).get('/v1/health')).status).toBe(200);
  });

  it('the same controller can be mounted under two versions', async () => {
    const app = build((api) => {
      api.register(new UsersController(), { prefix: '/v1' });
      api.register(new UsersController(), { prefix: '/v2' });
    });
    expect((await request(app).get('/v1/users')).status).toBe(200);
    expect((await request(app).get('/v2/users')).status).toBe(200);
  });

  it('nested groups append their prefixes', async () => {
    const app = build((api) =>
      api.group('/v1', (v1) => {
        v1.group('/admin', (admin) => {
          admin.register(new UsersController());
        });
      }),
    );
    expect((await request(app).get('/v1/admin/users')).status).toBe(200);
  });

  it('a per-register prefix inside a group appends to the group prefix', async () => {
    const app = build((api) =>
      api.group('/v1', (v1) => {
        v1.register(new UsersController(), { prefix: '/admin' });
      }),
    );
    expect((await request(app).get('/v1/admin/users')).status).toBe(200);
  });

  it('a prefix on a controller without @Route forms the whole prefix', async () => {
    const app = build((api) => api.register(new RootController(), { prefix: '/v1' }));
    expect((await request(app).get('/v1/ping')).status).toBe(200);
  });

  it('register with no options keeps the bare @Route prefix', async () => {
    const app = build((api) => api.register(new UsersController()));
    expect((await request(app).get('/users')).status).toBe(200);
  });
});

describe('grouping / versioning — spec', () => {
  it('the generated paths carry the base prefix', () => {
    const api = new Avero({ info: { title: 'Grouping', version: '1.0.0' } });
    api.group('/v1', (v1) => {
      v1.register(new UsersController());
      v1.register(new HealthController());
    });
    const doc = api.swagger();
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(['/v1/health', '/v1/users']);
  });

  it('two versions of one controller produce two path entries', () => {
    const api = new Avero({ info: { title: 'Grouping', version: '1.0.0' } });
    api.register(new UsersController(), { prefix: '/v1' });
    api.register(new UsersController(), { prefix: '/v2' });
    const doc = api.swagger();
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(['/v1/users', '/v2/users']);
  });

  it('generateSwagger({ controller, prefix }) matches api.swagger() for the same prefix', () => {
    const api = new Avero({ info: { title: 'Grouping', version: '1.0.0' } });
    api.register(new UsersController(), { prefix: '/v1' });
    const fromInstance = api.swagger();
    const fromClasses = generateSwagger([{ controller: UsersController, prefix: '/v1' }], {
      title: 'Grouping',
      version: '1.0.0',
    });
    expect(fromClasses).toEqual(fromInstance);
  });
});
