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

The same [`Zodec`](/api/classes/Zodec) instance you registered controllers on
generates the spec — no need to list controllers a second time:

```typescript
app.get('/swagger.json', (_req, res) => res.json(api.swagger()));
```

[`api.swagger()`](/api/classes/Zodec#swagger) builds the OpenAPI 3.1 document
from the registered controllers' metadata. It doesn't depend on routes being
mounted.

## Static generation — no instances required

Swagger is derived entirely from class-level metadata, so if you only need the
spec you don't have to construct controllers (or their dependencies) at all.
[`generateSwagger`](/api/functions/generateSwagger) takes the controller
**classes** directly:

```typescript
import { writeFile } from 'node:fs/promises';
import { generateSwagger } from 'zodec';

const swagger = generateSwagger([UsersController, HealthController]);
await writeFile('swagger.json', JSON.stringify(swagger, null, 2));
```

This is the lightest path for CI spec checks and client codegen: no `Zodec`
instance, no service wiring, no Express — just the classes and their decorators.

## Spec version: 3.1 (default) or 3.0

zodec emits **OpenAPI 3.1.0 by default**. This is its native form: Zod 4's
`z.toJSONSchema()` produces JSON Schema draft 2020-12, which OpenAPI 3.1 uses
verbatim — so the spec is a faithful, lossless view of your schemas.

Some tooling only partially supports 3.1. The most common case is
[`openapi-generator`](https://openapi-generator.tech)'s `typescript-fetch`
template, which misreads 3.1 constructs like `type: [..., 'null']` nullables and
numeric `exclusiveMinimum`/`exclusiveMaximum`. For those consumers, pass
`specVersion: '3.0'` and zodec down-converts the document:

```typescript
app.get('/swagger.json', (_req, res) => res.json(api.swagger({ specVersion: '3.0' })));

// or statically:
const swagger = generateSwagger([UsersController], info, { specVersion: '3.0' });
```

The down-conversion rewrites the 3.1-only constructs zodec emits into their 3.0
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
