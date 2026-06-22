# OpenAPI / Swagger

Name your top-level schemas with Zod 4's native `.meta({ id })` so they become
reusable components:

```typescript
const UserSchema = z
  .object({
    /* ... */
  })
  .meta({ id: 'User' });
//   → referenced as #/components/schemas/User in swagger
```

Anonymous inline schemas are allowed but produce inlined swagger (no `$ref`).

## From a running instance

The same [`Avero`](/api/classes/Avero) instance you registered controllers on
generates the spec — no need to list controllers a second time:

```typescript
app.get('/swagger.json', (_req, res) => res.json(api.swagger()));
```

[`api.swagger()`](/api/classes/Avero#swagger) builds the OpenAPI 3.1 document
from the registered controllers' metadata. It doesn't depend on routes being
mounted.

## Browsable docs UI

`api.serveDocs(app, path?)` mounts a documentation UI plus the spec it renders —
the UI HTML at `path` (default `/docs`), the spec at `${path}/openapi.json`:

```typescript
api.serveDocs(app); // Scalar at /docs
api.serveDocs(app, '/docs', { ui: 'swagger-ui' }); // or 'redoc'
```

The UI assets are **self-hosted from `node_modules`** by default (works offline /
under strict CSP), so install the one you use — it's an optional peer dependency:
`@scalar/api-reference` (Scalar, the default), `swagger-ui-dist` (Swagger UI), or
`redoc`. If it isn't installed, `serveDocs` throws a message telling you which to
install — or pass `{ cdn: true }` to load the bundle from a CDN with no install:

```typescript
api.serveDocs(app, '/docs', { ui: 'scalar', cdn: true }); // no peer dep needed
```

`specVersion` is honored too (`{ specVersion: '3.0' }`), so the browsable spec
matches whatever your clients consume.

## Static generation — no instances required

Swagger is derived entirely from class-level metadata, so if you only need the
spec you don't have to construct controllers (or their dependencies) at all.
[`generateSwagger`](/api/functions/generateSwagger) takes the controller
**classes** directly:

```typescript
import { writeFile } from 'node:fs/promises';
import { generateSwagger } from 'avero';

const swagger = generateSwagger([UsersController, HealthController]);
await writeFile('swagger.json', JSON.stringify(swagger, null, 2));
```

This is the lightest path for CI spec checks and client codegen: no `Avero`
instance, no service wiring, no Express — just the classes and their decorators.

## Schemas not tied to a route

Schemas reach `components.schemas` because a route references them. To document a
type that **no route uses** — a WebSocket/event message shape, a shared DTO, a
polymorphic variant — pass it via the `schemas` option so client generators still
emit a type for it. Each must be named with `.meta({ id })` (an anonymous schema
has no component key, so it's rejected):

```typescript
const Notification = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('message'), text: z.string() }),
    z.object({ type: z.literal('presence'), userId: z.string(), online: z.boolean() }),
  ])
  .meta({ id: 'Notification' });

api.swagger({ schemas: [Notification] }); // → components.schemas.Notification
```

`generateSwagger` takes the **same** option, so share one list across both paths
to keep instance and static output identical:

```typescript
export const extraSchemas = [Notification];

api.swagger({ schemas: extraSchemas });
generateSwagger([UsersController], info, { schemas: extraSchemas });
```

::: tip
Most generators (including `openapi-generator`'s `typescript-fetch`) emit a model
per `components/schemas` entry even when no operation references it — though
pruning of unreferenced schemas varies by tool. This documents the type's
**shape** only; for channels/direction of an event API, AsyncAPI is the right
tool.
:::

## Discriminated unions

A `z.discriminatedUnion` is emitted as `oneOf`, and avero also adds an OpenAPI
**`discriminator`** read straight from the union (no guessing the key back out of
the JSON). When every variant is named with `.meta({ id })`, the `discriminator`
includes a `mapping` from each discriminator value to that variant's component
`$ref`:

```typescript
const Message = z.object({ type: z.literal('message'), text: z.string() }).meta({ id: 'Message' });
const Presence = z
  .object({ type: z.literal('presence'), online: z.boolean() })
  .meta({ id: 'Presence' });

const Notification = z.discriminatedUnion('type', [Message, Presence]).meta({ id: 'Notification' });
```

```jsonc
"Notification": {
  "oneOf": [
    { "$ref": "#/components/schemas/Message" },
    { "$ref": "#/components/schemas/Presence" }
  ],
  "discriminator": {
    "propertyName": "type",
    "mapping": {
      "message": "#/components/schemas/Message",
      "presence": "#/components/schemas/Presence"
    }
  }
}
```

This is what lets generators like `openapi-generator`'s `typescript-fetch` emit a
proper discriminated **union** type with correct deserialization, rather than a
flattened interface. Name the variants for the full `mapping`; an anonymous
variant drops the `mapping` (the `propertyName` is still emitted). The
`discriminator` is preserved through the 3.0 down-convert below, and a plain
`z.union` (no discriminator) stays `anyOf`.

## Spec version: 3.1 (default) or 3.0

avero emits **OpenAPI 3.1.0 by default**. This is its native form: Zod 4's
`z.toJSONSchema()` produces JSON Schema draft 2020-12, which OpenAPI 3.1 uses
verbatim — so the spec is a faithful, lossless view of your schemas.

Some tooling only partially supports 3.1. The most common case is
[`openapi-generator`](https://openapi-generator.tech)'s `typescript-fetch`
template, which misreads 3.1 constructs like `type: [..., 'null']` nullables and
numeric `exclusiveMinimum`/`exclusiveMaximum`. For those consumers, pass
`specVersion: '3.0'` and avero down-converts the document:

```typescript
app.get('/swagger.json', (_req, res) => res.json(api.swagger({ specVersion: '3.0' })));

// or statically:
const swagger = generateSwagger([UsersController], info, { specVersion: '3.0' });
```

The down-conversion rewrites the 3.1-only constructs avero emits into their 3.0
equivalents:

| 3.1 (default)                                        | 3.0 (`specVersion: '3.0'`)                          |
| ---------------------------------------------------- | --------------------------------------------------- |
| `anyOf: [T, { type: 'null' }]` / `type: [T, 'null']` | `T` + `nullable: true` (a `$ref` → `allOf: [$ref]`) |
| numeric `exclusiveMinimum` / `exclusiveMaximum`      | `minimum`/`maximum` + boolean `exclusive*`          |
| `const: v`                                           | `enum: [v]`                                         |
| schema-level `examples: [...]`                       | singular `example`                                  |
| binary `contentEncoding` / `contentMediaType`        | dropped (`type: string, format: binary` kept)       |

Prefer the default `'3.1'` unless a downstream consumer forces `'3.0'` — 3.1 is
the more accurate representation, and the down-convert is necessarily lossy for
unions (3.0 has no union types).
