# Typed Client

zodec can generate a **standalone, fully-typed TypeScript client** for your API.
It's the modern replacement for a `tsoa → swagger → openapi-generator-cli`
pipeline: one accurate hop instead of two lossy ones, no Java, and a generated
file with **no runtime dependency** — a front end imports it and calls your API
with full types.

```typescript
import { createClient } from './api.gen'; // the generated file — no zodec import

const api = createClient({
  baseUrl: 'https://api.example.com',
  headers: { authorization: () => `Bearer ${getToken()}` }, // static or lazy
});

const user = await api.users.get({ params: { id } });
//    ^? User
```

## How it works: the contract

The client is generated from a **contract** — a high-fidelity, language-agnostic
intermediate representation of your API, built from the same controller metadata
that drives [`swagger()`](/guide/swagger). It's a sibling of `swagger.json`, but
purpose-built for code generation: a flat operations list and a schema
representation that keeps the semantic detail JSON Schema flattens (real
`date`/`file` kinds, first-class discriminated unions, per-property optionality).

```typescript
import { generateContract, generateTypeScriptClient } from 'zodec';

// 1. controllers → contract (validated on write; serialize to contract.json if you like)
const contract = generateContract([UsersController, AuthController]);

// 2. contract → standalone TypeScript client
const source = generateTypeScriptClient(contract);
await writeFile('api.gen.ts', source);
```

From a running instance the contract comes off the same object you already
configured (the sibling of `api.swagger()`):

```typescript
const contract = api.contract({ schemas: extraSchemas }); // route-less schemas too
```

The contract is the stable, public artifact — because it's plain data, anyone can
write their own generator on top of it (React Query hooks, another language, a
different client style) without re-deriving anything from OpenAPI.

::: tip Run it at build time
Generate `api.gen.ts` in your build (or commit it). The pipeline is
**controllers → `contract` → `api.gen.ts`** — re-run it whenever the API changes,
the same way you'd regenerate any codegen output.
:::

## Calling endpoints

Operations are **grouped by their first `@Tags` tag** (`api.users.get(...)`);
untagged operations sit at the client root. Each method takes a single typed
`{ params, query, body, headers }` object — and only the keys that operation
actually declares are present (required or optional per the contract):

```typescript
// path param
const user = await api.users.get({ params: { id } }); //            → User

// optional query (defaults applied server-side)
const page = await api.users.list({ query: { page: 2, limit: 50 } }); // → UserList

// no inputs → no argument
const health = await api.health.check(); //                        → Health

// JSON body
const created = await api.users.create({ body: { username, email } }); // → User

// per-call header (e.g. an auth override or a Range request)
const slice = await api.users.getAvatar({ params: { id }, headers: { Range: 'bytes=0-1023' } });
```

Path params are interpolated, query is serialized, and a `File`/`File[]` body
switches the request to `multipart/form-data` automatically.

## Responses: throw by default, `.raw()` for exhaustive handling

The default call form returns the **success body** and **throws** a
`ZodecClientError` (carrying the status and parsed error body) on any non-2xx —
mirroring zodec's server model, where non-2xx are thrown errors:

```typescript
import { ZodecClientError } from './api.gen';

try {
  const user = await api.users.get({ params: { id } }); // user: User
} catch (err) {
  if (err instanceof ZodecClientError && err.status === 404) {
    err.body; // ^? the 404 schema from the contract
  }
}
```

When you want to handle every status without `try/catch`, call `.raw()` — it
returns a **status-discriminated union** of `{ status, body }` and never throws on
a declared status:

```typescript
const res = await api.users.get.raw({ params: { id } });
if (res.status === 200)
  res.body; // ^? User
else if (res.status === 404) res.body; // ^? Error
```

## Response shapes

The client handles every response kind zodec can declare:

| Server declares                      | Client method returns                           |
| ------------------------------------ | ----------------------------------------------- |
| `@Returns(status, Schema)`           | the parsed JSON body, typed                     |
| `@ReturnsFile` / `RangeFileResponse` | a `Blob` (pass a `Range` header for partials)   |
| `@Sse(EventSchema)`                  | `AsyncIterable<Event>` — `for await` the stream |
| no body (e.g. `204`)                 | `void`                                          |

```typescript
// File download (Blob); add a Range header for partial content
const blob = await api.users.getAvatar({ params: { id } });

// Server-Sent Events → a typed async iterable
for await (const event of await api.health.events()) {
  console.log(event); // ^? the @Sse event type
  // remember to `break` if the stream is open-ended — it cancels the connection
}
```

## What it does and doesn't do (v1)

Being honest about the edges:

- **It's codegen, not zero-codegen inference.** Unlike ts-rest (whose contract is
  a value the client infers from directly), zodec's contract comes from decorators,
  so the client is a generated file you regenerate on change. In return it's
  standalone (no runtime dependency) and works for any contract consumer.
- **Types only — no runtime validation yet.** The client trusts the server's
  responses. Opt-in runtime validation is planned
  ([#22](https://github.com/joeferner/zodec/issues/22)).
- **`z.date()` is typed `string`.** Dates travel as ISO strings over JSON and the
  types-only client does no revival, so `string` is the honest type. Reviving to a
  real `Date` rides on runtime validation
  ([#21](https://github.com/joeferner/zodec/issues/21)).
- **No React Query / framework hooks** — but the contract is open for a generator
  that emits them.

For non-TS or external consumers, keep emitting the
[OpenAPI document](/guide/swagger) and point any standard generator at it; the
typed client is the first-party TS path.
