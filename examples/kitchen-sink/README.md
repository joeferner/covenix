# kitchen-sink

A two-package workspace that exercises **every** zodec feature end to end. It is
**aspirational**: it represents the state we want to be in once
[`tmp/requirements.md`](../../tmp/requirements.md) is implemented and the root
[`README.md`](../../README.md) is fulfilled. `zodec` is not implemented yet, so
this example does **not** compile — that is expected and fine for now.

## Layout

```
kitchen-sink/
  schemas/                 # node module #1 — shared Zod schemas only
    src/
      common.ts            #   ErrorSchema, PaginationQuerySchema
      user.ts              #   User / CreateUser / UpdateUser / UserList
      auth.ts              #   Login / Token
      index.ts             #   re-exports
  express-app/             # node module #2 — a typical Express app
    src/
      api.ts               #   the configured Zodec instance + registered controllers (shared)
      main.ts              #   server startup: mount + zodecErrorHandler + listen
      generate-swagger.ts  #   headless swagger.json generation (no server), reuses api.ts
      services/            #   UserService, AuthService — fake in-memory, constructor-injected
      controllers/         #   files named after the class they export
        UsersController.ts    # full CRUD — all method/param decorators, multiple @Returns
        HealthController.ts   # @Req/@Res escape hatch, @Header
        AuthController.ts     # login + me, @Header
```

## The cross-module point

The schemas live in their **own package** (`@kitchen-sink/schemas`) and are
imported by the controllers in `@kitchen-sink/express-app`. The decorators in one
module reference Zod schemas defined in another — demonstrating that a zodec
schema is just a value and works across module boundaries with no special wiring.

## Feature coverage

| Feature                                                           | Where                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `@Route`, `@Tags`                                                 | every controller                                             |
| `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete`                          | `UsersController.ts`                                         |
| `@Params`, `@Query`, `@Body`, stackable `@Returns`, `@Summary`    | `UsersController.ts`                                         |
| `@Param`, `@QueryParam`, `@BodyParam`, `@Header`                  | `UsersController.ts`, `AuthController.ts`                    |
| Multipart upload — `z.file()` in `@Body`, `@File`/`@Files`        | `UsersController.ts`                                         |
| `@ReturnsFile` + `FileResponse`; `RangeFileResponse` (HTTP Range) | `UsersController.ts`                                         |
| `@Security` + `@Principal`, scopes, `bearer()` handler            | `AuthController.ts`, `UsersController.ts`, `api-security.ts` |
| `@Req` / `@Res` escape hatch                                      | `HealthController.ts`                                        |
| `new Zodec({ info })`, `register`, `mount`, `swagger`             | `api.ts`, `main.ts`, `generate-swagger.ts`                   |
| `zodecErrorHandler()`                                             | `main.ts`                                                    |
| `http-errors` thrown from handlers                                | controllers + services                                       |
| Named schemas via `.meta({ id })` → `#/components/schemas/*`      | `schemas/`                                                   |
