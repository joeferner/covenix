# Migrating from a hand-written OpenAPI document

If you currently author `openapi.json` / `openapi.yaml` by hand (or with an editor
like Stoplight/Swagger Editor) and then implement handlers to match, covenix
inverts the workflow:

- **You stop writing the document.** You write Zod schemas + decorators; covenix
  **generates** the OpenAPI 3.1 document from them.
- **Validation comes free.** The same schema that produces a `requestBody` also
  validates the request at runtime — the spec and the implementation can't drift,
  because they're the same source.
- **The generated document is still a plain object.** `api.swagger()` returns a
  mutable `OpenAPIV3_1.Document`, so anything covenix doesn't emit you can add by
  post-processing it (see [the escape hatch](#the-escape-hatch-post-processing)).

The mental shift: a hand-written spec is the source of truth that your code must
chase; in covenix the **code is the source of truth** and the spec is a build
artifact.

## Document structure

| OpenAPI document field                         | covenix                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `openapi: '3.1.0'`                             | Emitted automatically (3.1 default; `swagger({ specVersion: '3.0' })`).                                             |
| `info.title` / `info.version`                  | `new Covenix({ info: { title, version } })`                                                                           |
| `info.description` / `contact` / `license` / … | `new Covenix({ info })` takes the full OpenAPI Info Object                                                            |
| `servers`                                      | `new Covenix({ servers: [{ url }] })`                                                                                 |
| `paths`                                        | `@Route` prefix + `@Get`/`@Post`/… (with `{id}` path params)                                                        |
| `components.schemas`                           | Named (`.meta({ id })`) Zod schemas — referenced by routes, or passed via the `schemas` option for route-less types |
| `components.securitySchemes`                   | The `security` map on `new Covenix({ security })` (or the builders)                                                   |
| `security` (global)                            | `@Security` on the controller class (applies to all its routes)                                                     |
| `tags` (names)                                 | `@Tags(...)` on the controller class                                                                                |
| `tags` (descriptions)                          | `new Covenix({ tags: [{ name, description }] })`                                                                      |
| `externalDocs`                                 | `new Covenix({ externalDocs: { url } })`                                                                              |
| `webhooks` / `x-*`                             | Post-process the generated document                                                                                 |

## Operations

| Operation field       | covenix                                                               |
| --------------------- | ------------------------------------------------------------------- |
| HTTP method + path    | `@Get('{id}')`, `@Post()`, `@Put`, `@Patch`, `@Delete`              |
| `summary`             | `@Summary('…')`                                                     |
| `description`         | `@Description('…')`                                                 |
| `operationId`         | `@OperationId('…')` (defaults to the handler method name)           |
| `tags`                | `@Tags(...)` (controller-level)                                     |
| `deprecated`          | `@Deprecated()`                                                     |
| `parameters`          | `@Params(schema)` (path) + `@Query(schema)` (query)                 |
| `requestBody`         | `@Body(schema)`                                                     |
| `responses`           | `@Returns(status, schema?)` / `@ReturnsFile(status, …)` — stackable |
| `security`            | `@Security(scheme, scopes?)` — stackable = OR                       |
| `callbacks` / `links` | Post-process                                                        |

## Parameters

covenix decomposes a `@Params`/`@Query` **object schema** into one OpenAPI
parameter per property — path params are always `required`, query params follow
the schema's optionality.

| Hand-written parameter            | covenix                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `in: path`                        | `@Params(z.object({ id: z.string() }))` + `@Param('id')`                                                            |
| `in: query`                       | `@Query(z.object({ page: z.coerce.number() }))` + `@QueryParam('page')`                                             |
| `in: header`                      | `@Headers(z.object({ 'x-id': z.string() }))` + `@HeaderParam('x-id')` (reserved headers are validated, not emitted) |
| `in: cookie`                      | `@Cookies(z.object({ sid: z.string() }))` + `@CookieParam('sid')` (needs a cookie parser ahead of the route)        |
| parameter `description`/`example` | `.describe(...)` / `.meta({ examples })` on the property schema                                                     |
| `required`                        | Path → always; query/header/cookie → non-`.optional()` property                                                     |
| parameter `deprecated`            | `.meta({ deprecated: true })` on the property → `deprecated` on the parameter                                       |
| `style` / `explode`               | Post-process (covenix emits the default `schema` form)                                                                |

## Request bodies

| Hand-written requestBody                             | covenix                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `application/json`                                   | `@Body(z.object({ … }))`                                                                                    |
| `multipart/form-data` (file upload)                  | `@Body` with a `z.file()` / `z.array(z.file())` field — auto-detected ([File uploads](/guide/file-uploads)) |
| `required: true`                                     | Always set when `@Body` is present                                                                          |
| `application/x-www-form-urlencoded`, `text/*`, other | Post-process (covenix emits JSON or multipart)                                                                |
| request `example`                                    | `@Example(value)` (no `status`)                                                                             |

## Responses

| Hand-written response          | covenix                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `responses.<code>` (JSON)      | `@Returns(code, schema)` — stackable, one per status                                                                                         |
| no-body response (e.g. `204`)  | `@Returns(204)` (omit the schema)                                                                                                            |
| binary body (`format: binary`) | `@ReturnsFile(code, { contentType, description })` + return a `FileResponse` / `RangeFileResponse` ([File downloads](/guide/file-downloads)) |
| response `headers`             | `@Returns(code, schema, { headers: { 'X-…': z.…() } })`                                                                                      |
| response `description`         | `@Returns(code, schema, { description })` (or `@ReturnsFile(code, { description })`)                                                         |
| response `example`             | `@Example(value, code)`                                                                                                                      |
| `default` response             | Post-process                                                                                                                                 |

## Schema Object → Zod

This is the heart of it: the OpenAPI **Schema Object** (a JSON Schema dialect) is
exactly what Zod 4's `z.toJSONSchema()` produces, so every keyword has a Zod
spelling. Name a schema with `.meta({ id })` to get a `#/components/schemas/*`
`$ref`; leave it anonymous to inline.

| OpenAPI / JSON Schema                          | Zod                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `type: string` / `number` / `boolean`          | `z.string()` / `z.number()` / `z.boolean()`                      |
| `type: integer`                                | `z.number().int()`                                               |
| `type: array`, `items`                         | `z.array(T)`                                                     |
| `type: object`, `properties`, `required`       | `z.object({ a: T, b: T.optional() })`                            |
| `nullable` (3.0) / `type: [..., 'null']` (3.1) | `T.nullable()`                                                   |
| `enum`                                         | `z.enum(['a', 'b'])`                                             |
| `const`                                        | `z.literal('x')`                                                 |
| `format: date-time` / `date`                   | `z.iso.datetime()` / `z.iso.date()`                              |
| `format: email` / `uuid` / `uri`               | `z.email()` / `z.uuid()` / `z.url()`                             |
| `format: binary`                               | `z.file()` (upload) or `@ReturnsFile` (download)                 |
| `minLength` / `maxLength`                      | `.min(n)` / `.max(n)` on a string                                |
| `pattern`                                      | `.regex(/…/)`                                                    |
| `minimum` / `maximum`                          | `.min(n)` / `.max(n)` on a number                                |
| `exclusiveMinimum` / `exclusiveMaximum`        | `.gt(n)` / `.lt(n)`                                              |
| `multipleOf`                                   | `.multipleOf(n)`                                                 |
| `minItems` / `maxItems`                        | `.min(n)` / `.max(n)` on an array                                |
| `default`                                      | `.default(v)`                                                    |
| `additionalProperties: false`                  | `z.object({ … })` (covenix's default — objects are strict)         |
| `additionalProperties: <schema>`               | `z.record(z.string(), T)` or `z.object({…}).catchall(T)`         |
| `allOf`                                        | `z.intersection(A, B)` / `A.extend({ … })`                       |
| `anyOf`                                        | `z.union([A, B])`                                                |
| `oneOf`                                        | `z.discriminatedUnion('kind', [A, B])` (emits `oneOf`)           |
| tuple (`prefixItems`)                          | `z.tuple([A, B])`                                                |
| `title` / `description`                        | `.meta({ title })` / `.describe('…')`                            |
| `deprecated` / `readOnly` / `writeOnly`        | `.meta({ deprecated: true })` / `.meta({ readOnly: true })`      |
| `example` / `examples`                         | `.meta({ examples: [v] })` (or `@Example` on the operation)      |
| `$ref` reuse                                   | `.meta({ id: 'Name' })` (referenced wherever the schema is used) |

::: tip Reuse
A `.meta({ id })` schema becomes a single `components/schemas` entry and is
referenced by `$ref` everywhere it appears — the same deduplication you'd hand-roll
with `$ref`, but automatic. Nested named schemas are hoisted for you.
:::

A couple of keywords have no direct Zod spelling: `uniqueItems` and
`minProperties`/`maxProperties` need a `.refine(...)` (and won't appear in the
generated schema), and `discriminator` is not emitted (a discriminated union
generates plain `oneOf`). Add those by post-processing if a consumer requires
them.

## Security schemes

| OpenAPI security scheme              | covenix                                                   |
| ------------------------------------ | ------------------------------------------------------- |
| `type: http`, `scheme: bearer`       | `bearer(handler, { bearerFormat })`                     |
| `type: http`, `scheme: basic`        | `basic(handler)`                                        |
| `type: apiKey` (header/query/cookie) | `apiKey({ in, name }, handler)`                         |
| `type: oauth2`                       | `oauth2(flows, handler)`                                |
| `type: openIdConnect` / `mutualTLS`  | Raw `{ scheme: { type: 'openIdConnect', … }, handler }` |
| per-operation `security`             | `@Security('name', scopes?)`                            |
| multiple accepted schemes (OR)       | Stack `@Security` decorators                            |

Each scheme bundles its OpenAPI definition with a runtime handler, so declaring it
also enforces it. See [Authentication](/guide/authentication).

## The escape hatch: post-processing

`api.swagger()` (and `generateSwagger(...)`) return a plain
`OpenAPIV3_1.Document`. Anything in the tables above marked "post-process" — and
any vendor extension or future OpenAPI feature — you add by mutating that object
before serving or writing it:

```typescript
function buildSpec() {
  const doc = api.swagger();

  // Things covenix doesn't model — webhooks, vendor extensions, response links:
  (doc as Record<string, unknown>)['x-internal-build'] = process.env.BUILD_SHA;
  doc.webhooks = {
    userCreated: { post: { requestBody: { content: { 'application/json': {} } } } },
  };
  return doc;
}

app.get('/swagger.json', (_req, res) => res.json(buildSpec()));
```

Because the document is regenerated on each call, this stays a pure transform —
no files to keep in sync, and the validated parts still come straight from your
schemas.

## What this buys you

Going from a hand-maintained document to generated-from-code means the spec
**cannot lie**: the request body shape in the document is the exact schema that
rejects a bad request, the response shape is the exact schema covenix validates your
handler's return value against, and a renamed field changes both at once. The
parts covenix doesn't model yet are a small, additive post-processing step rather
than a second source of truth to maintain.

If you hit an OpenAPI feature you expected covenix to emit, please
[open an issue](https://github.com/joeferner/covenix/issues).
