---
layout: home
hero:
  name: covenix
  text: Zod-powered decorators for Express
  tagline: Typed routes, runtime validation, and accurate OpenAPI from a single source of truth.
  image:
    src: /logo.png
    alt: covenix
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/
features:
  - title: One source of truth
    details: The same Zod schema validates each request and produces its OpenAPI definition, so the two can never drift.
  - title: Runtime validation included
    details: Zod parses, coerces, and defaults every request before your handler runs. Handlers receive clean, typed data.
  - title: Accurate OpenAPI
    details: Generate a swagger.json straight from your decorators via z.toJSONSchema — no build step, no config file, no codegen.
---
