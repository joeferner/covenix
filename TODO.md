# TODO

## Future

- **Authentication / `@Security`** — Add a `@Security(scheme, scopes?)` method
  decorator that records a security requirement on the route, wires a
  `security` handler map (configured on the `Zodec` instance), and reflects the
  requirement in the generated OpenAPI (`securitySchemes` + per-operation
  `security`). Removed from the README for now until implemented.

- **Additional framework adapters** — v1 targets Express only. The metadata
  layer is framework-agnostic, so other servers should slot in behind a thin
  adapter that knows how to (a) register a route + middleware and (b) read
  params/query/body/headers off that framework's request object. Candidates:
  Koa, Fastify, Hapi. Goal: keep all decorator/metadata/swagger code shared and
  isolate framework specifics to an adapter module.

- **`@Example` decorator** — Attach example values to a schema or response so
  they surface in the generated OpenAPI (`example`/`examples` on the schema or
  media type). Useful for richer Swagger UI docs and for client-generation
  fixtures.

- **Response headers** — Let routes declare response headers (e.g. a
  `@Header`-style response decorator or an option on `@Returns`) so they appear
  under the operation's `responses[status].headers` in the OpenAPI document.

- **Multipart / file uploads** — Support `multipart/form-data` bodies for file
  uploads: a way to declare file fields (validated where practical), parse them
  via the underlying framework's multipart handling, and represent them in
  OpenAPI as `type: string, format: binary`. Likely needs a dedicated decorator
  (e.g. `@Multipart`/`@FormField`) separate from the JSON `@Body` path.

- **File responses / downloads** — Let a handler respond with a file or binary
  stream (think file download) rather than JSON: stream a buffer/`Readable` or
  path to the client, set `Content-Type`/`Content-Disposition`, and represent
  the response in OpenAPI as a binary media type (e.g.
  `application/octet-stream` with `type: string, format: binary`). Probably a
  dedicated return type or `@Returns`-style declaration so swagger reflects the
  non-JSON body. Counterpart to multipart uploads on the response side.

- **Response validation in dev mode** — Check handler return values against the
  matching `@Returns` schema and log a warning on mismatch (no throw in
  production). Catches schema drift during development. (Mentioned in the
  Validation section of the README as a planned behavior.)
