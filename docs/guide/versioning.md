# Grouping & Versioning

Each controller carries its own path prefix via [`@Route`](/api/functions/Route).
For a base path shared across many controllers — most often an API **version**
segment like `/v1` — register them under a group instead of repeating the prefix
on every class. The base path is reflected in **both** the mounted Express routes
and the generated OpenAPI `paths`.

## A base path per controller

Pass a `prefix` when registering. It is prepended to the controller's own
`@Route` prefix:

```typescript
api.register(new UsersController(svc), { prefix: '/v1' });
// @Route('users') + '/v1'  →  /v1/users
```

## A group of controllers

`group(prefix, fn)` opens a scope; every controller registered on it inherits the
base path:

```typescript
api.group('/v1', (v1) => {
  v1.register(new UsersController(svc));
  v1.register(new AuthController(auth));
});
// → /v1/users, /v1/auth/...
```

Groups **nest**, and a per-`register` prefix appends to the enclosing group:

```typescript
api.group('/v1', (v1) => {
  v1.group('/admin', (admin) => {
    admin.register(new ReportsController(svc)); // → /v1/admin/reports
  });
  v1.register(new UsersController(svc), { prefix: '/internal' }); // → /v1/internal/users
});
```

## Running two versions side by side

Because registration is just recording an instance under a prefix, the **same**
controller class can be mounted under more than one version — or you can register
a new version's controller alongside the old one:

```typescript
api.group('/v1', (v1) => v1.register(new UsersController(svc)));
api.group('/v2', (v2) => v2.register(new UsersControllerV2(svc)));
```

Each produces its own entry in the spec (`/v1/users`, `/v2/users`), so clients
generated from the document see both versions.

::: tip Unversioned infra routes
Mount operational endpoints that shouldn't be versioned (a `/swagger.json`, a
`/docs` UI, a load-balancer `/healthz`) directly on the Express app rather than
inside a group — only avero controllers pick up the group prefix.
:::

## Static generation

To keep [static, instance-free generation](/guide/swagger#static-generation)
identical to `api.swagger()` when you use groups, wrap each class with its prefix:

```typescript
import { generateSwagger } from 'avero';

const doc = generateSwagger([
  { controller: UsersController, prefix: '/v1' },
  { controller: AuthController, prefix: '/v1' },
]);
```

A bare class (no wrapper) still works and carries no base path, so you can mix
the two forms.
