import 'reflect-metadata';
import type { ZodType } from 'zod';

/** HTTP methods zodec routes can be mapped to. */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Assembled metadata for a single route, as returned by {@link getRoutes}. */
export interface RouteMetadata {
  /** HTTP method. */
  method: HttpMethod;
  /** Route sub-path (controller prefix is applied separately). */
  path: string;
  /** Name of the controller method that handles the route. */
  handlerName: string;
  /** `@Params` schema, if any. */
  params?: ZodType | undefined;
  /** `@Query` schema, if any. */
  query?: ZodType | undefined;
  /** `@Body` schema, if any. */
  body?: ZodType | undefined;
  /**
   * Declared responses, keyed by status code (from `@Returns`). A value of
   * `undefined` means the status was declared with no body (e.g. `204`).
   */
  responses: Record<number, ZodType | undefined>;
  /** Class-level `@Tags`, folded onto each route. */
  tags?: string[] | undefined;
  /** `@Summary` text, if any. */
  summary?: string | undefined;
  /** Example values (from `@Example`) for the request body and/or responses. */
  examples?: ExampleMetadata[] | undefined;
  /** Binary/file responses (from `@ReturnsFile`), keyed by status code. */
  fileResponses?: Record<number, FileResponseDecl> | undefined;
}

/** A binary/file response declaration recorded by `@ReturnsFile`. */
export interface FileResponseDecl {
  /**
   * Media type for the binary body in the OpenAPI document. Defaults to
   * `application/octet-stream` when not specified — the runtime `Content-Type`
   * (from the returned `FileResponse`) can differ.
   */
  contentType: string;
  /** Optional response description for the OpenAPI document. */
  description?: string | undefined;
}

/** An example value attached to a route by `@Example`. */
export interface ExampleMetadata {
  /** Response status the example illustrates; omitted means the request body. */
  status?: number | undefined;
  /** The example value, surfaced on the OpenAPI media type. */
  value: unknown;
}

/** Where an injected handler parameter is sourced from. */
export type ParamSource = 'param' | 'query' | 'body' | 'header' | 'req' | 'res';

/** Metadata for one injected handler parameter, as returned by {@link getParams}. */
export interface ParamMetadata {
  /** Zero-based position in the handler's parameter list. */
  index: number;
  /** Request location the value is read from. */
  source: ParamSource;
  /** Key name for `param`/`query`/`header` sources; absent otherwise. */
  name?: string | undefined;
}

/*
 * One symbol per concern. Each decorator writes under its own key, so two
 * decorators on the same method can never clobber each other regardless of the
 * order they run in.
 */
const HTTP_METHOD_KEY = Symbol('zodec:httpMethod');
const PARAMS_SCHEMA_KEY = Symbol('zodec:paramsSchema');
const QUERY_SCHEMA_KEY = Symbol('zodec:querySchema');
const BODY_KEY = Symbol('zodec:body');
const RETURNS_KEY = Symbol('zodec:returns');
const FILE_RESPONSES_KEY = Symbol('zodec:fileResponses');
const EXAMPLES_KEY = Symbol('zodec:examples');
const SUMMARY_KEY = Symbol('zodec:summary');
const HANDLER_NAMES_KEY = Symbol('zodec:handlerNames');
const PARAM_INJECTIONS_KEY = Symbol('zodec:paramInjections');
const PREFIX_KEY = Symbol('zodec:prefix');
const TAGS_KEY = Symbol('zodec:tags');

/** Internal storage shape for a method's HTTP verb + path. */
interface HttpMethodEntry {
  method: HttpMethod;
  path: string;
}

/**
 * Records a handler's HTTP method + path and registers its name in the route
 * list. Called by the `@Get`/`@Post`/... decorators.
 */
export function setHttpMethod(
  target: object,
  handlerName: string,
  method: HttpMethod,
  path: string,
): void {
  Reflect.defineMetadata(
    HTTP_METHOD_KEY,
    { method, path } satisfies HttpMethodEntry,
    target,
    handlerName,
  );
  const names = (Reflect.getOwnMetadata(HANDLER_NAMES_KEY, target) ?? []) as string[];
  if (!names.includes(handlerName)) {
    names.push(handlerName);
    Reflect.defineMetadata(HANDLER_NAMES_KEY, names, target);
  }
}

/**
 * Adds a response for a status code. Called by `@Returns`. A `schema` of
 * `undefined` declares the status with no body (e.g. `204`).
 */
export function addReturnSchema(
  target: object,
  handlerName: string,
  status: number,
  schema?: ZodType,
): void {
  const returns = (Reflect.getOwnMetadata(RETURNS_KEY, target, handlerName) ?? {}) as Record<
    number,
    ZodType | undefined
  >;
  returns[status] = schema;
  Reflect.defineMetadata(RETURNS_KEY, returns, target, handlerName);
}

/** Stores the `req.params` schema for a handler. Called by `@Params`. */
export function setParamsSchema(target: object, handlerName: string, schema: ZodType): void {
  Reflect.defineMetadata(PARAMS_SCHEMA_KEY, schema, target, handlerName);
}

/** Stores the `req.query` schema for a handler. Called by `@Query`. */
export function setQuerySchema(target: object, handlerName: string, schema: ZodType): void {
  Reflect.defineMetadata(QUERY_SCHEMA_KEY, schema, target, handlerName);
}

/** Stores the `req.body` schema for a handler. Called by `@Body`. */
export function setBodySchema(target: object, handlerName: string, schema: ZodType): void {
  Reflect.defineMetadata(BODY_KEY, schema, target, handlerName);
}

/** Records a binary/file response for a status code. Called by `@ReturnsFile`. */
export function addFileResponse(
  target: object,
  handlerName: string,
  status: number,
  decl: FileResponseDecl,
): void {
  const fileResponses = (Reflect.getOwnMetadata(FILE_RESPONSES_KEY, target, handlerName) ??
    {}) as Record<number, FileResponseDecl>;
  fileResponses[status] = decl;
  Reflect.defineMetadata(FILE_RESPONSES_KEY, fileResponses, target, handlerName);
}

/** Appends an example value for a handler. Called by `@Example`. */
export function addExample(target: object, handlerName: string, example: ExampleMetadata): void {
  const examples = (Reflect.getOwnMetadata(EXAMPLES_KEY, target, handlerName) ??
    []) as ExampleMetadata[];
  examples.push(example);
  Reflect.defineMetadata(EXAMPLES_KEY, examples, target, handlerName);
}

/** Stores the operation summary for a handler. Called by `@Summary`. */
export function setSummary(target: object, handlerName: string, text: string): void {
  Reflect.defineMetadata(SUMMARY_KEY, text, target, handlerName);
}

/** Stores the controller path prefix on a prototype. Called by `@Route`. */
export function setPrefix(target: object, prefix: string): void {
  Reflect.defineMetadata(PREFIX_KEY, prefix, target);
}

/**
 * Reads the controller `@Route` prefix from a prototype.
 *
 * @param target - The controller prototype.
 * @returns The prefix, or `''` if none was set.
 */
export function getPrefix(target: object): string {
  return (Reflect.getOwnMetadata(PREFIX_KEY, target) ?? '') as string;
}

/** Stores the controller tags on a prototype. Called by `@Tags`. */
export function setTags(target: object, tags: string[]): void {
  Reflect.defineMetadata(TAGS_KEY, tags, target);
}

/**
 * Reads the controller `@Tags` from a prototype.
 *
 * @param target - The controller prototype.
 * @returns The tags, or `[]` if none were set.
 */
export function getTags(target: object): string[] {
  return (Reflect.getOwnMetadata(TAGS_KEY, target) ?? []) as string[];
}

/**
 * Appends parameter-injection metadata for a handler. Called by the parameter
 * decorators (`@Param`, `@QueryParam`, etc.).
 */
export function addParam(target: object, handlerName: string, param: ParamMetadata): void {
  const params = (Reflect.getOwnMetadata(PARAM_INJECTIONS_KEY, target, handlerName) ??
    []) as ParamMetadata[];
  params.push(param);
  Reflect.defineMetadata(PARAM_INJECTIONS_KEY, params, target, handlerName);
}

/**
 * Reads the injected-parameter metadata for a handler. Parameter decorators run
 * right-to-left, so this list is not in declaration order; each entry carries
 * its own `index` for the caller to place by.
 *
 * @param target - The controller prototype.
 * @param handlerName - The method name to read parameters for.
 * @returns The parameter metadata entries (possibly empty).
 */
export function getParams(target: object, handlerName: string): ParamMetadata[] {
  return (Reflect.getOwnMetadata(PARAM_INJECTIONS_KEY, target, handlerName) ??
    []) as ParamMetadata[];
}

/**
 * Assembles {@link RouteMetadata}[] at read time from the per-concern entries.
 * The handler-name list is the source of truth for which methods are routes.
 *
 * @param target - The controller prototype.
 * @returns One entry per route declared on the controller.
 */
export function getRoutes(target: object): RouteMetadata[] {
  const names = (Reflect.getOwnMetadata(HANDLER_NAMES_KEY, target) ?? []) as string[];
  // Tags are declared once at the class level; fold them onto every route so a
  // RouteMetadata is self-contained for downstream consumers (e.g. swagger).
  const tags = getTags(target);
  return names.map((handlerName) => {
    const entry = Reflect.getOwnMetadata(HTTP_METHOD_KEY, target, handlerName) as HttpMethodEntry;
    return {
      method: entry.method,
      path: entry.path,
      handlerName,
      params: Reflect.getOwnMetadata(PARAMS_SCHEMA_KEY, target, handlerName) as ZodType | undefined,
      query: Reflect.getOwnMetadata(QUERY_SCHEMA_KEY, target, handlerName) as ZodType | undefined,
      body: Reflect.getOwnMetadata(BODY_KEY, target, handlerName) as ZodType | undefined,
      responses: (Reflect.getOwnMetadata(RETURNS_KEY, target, handlerName) ?? {}) as Record<
        number,
        ZodType | undefined
      >,
      tags: tags.length > 0 ? tags : undefined,
      summary: Reflect.getOwnMetadata(SUMMARY_KEY, target, handlerName) as string | undefined,
      examples: Reflect.getOwnMetadata(EXAMPLES_KEY, target, handlerName) as
        | ExampleMetadata[]
        | undefined,
      fileResponses: Reflect.getOwnMetadata(FILE_RESPONSES_KEY, target, handlerName) as
        | Record<number, FileResponseDecl>
        | undefined,
    };
  });
}
