import 'reflect-metadata';
import type { ZodType } from 'zod';

/** HTTP methods zodec routes can be mapped to. */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Everything declared for a single response status. Exactly one of `schema`
 * (a JSON body from `@Returns`, possibly `undefined` for a no-content status like
 * `204`) or `file` (a binary body from `@ReturnsFile`) describes the body —
 * declaring both for one status is an error. `description`/`headers` annotate it.
 */
export interface ResponseMetadata {
  /** `@Returns` body schema; `undefined` means the status has no body. */
  schema?: ZodType | undefined;
  /** `@ReturnsFile` binary body declaration. */
  file?: FileResponseDecl | undefined;
  /** Response description (`@Returns(..., { description })`). */
  description?: string | undefined;
  /** Response headers (`@Returns(..., { headers })`), name → Zod schema. */
  headers?: Record<string, ZodType> | undefined;
}

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
  /** Declared responses, keyed by status code. One entry per declared status. */
  responses: Record<number, ResponseMetadata>;
  /** Class-level `@Tags`, folded onto each route. */
  tags?: string[] | undefined;
  /** `@Summary` text, if any. */
  summary?: string | undefined;
  /** `@Description` text (the operation's long description), if any. */
  description?: string | undefined;
  /** `@OperationId` value (unique operation identifier), if any. */
  operationId?: string | undefined;
  /** Whether the operation is marked `@Deprecated`. */
  deprecated?: boolean | undefined;
  /** Example values (from `@Example`) for the request body and/or responses. */
  examples?: ExampleMetadata[] | undefined;
  /**
   * Security requirements (from `@Security`), each a scheme name + required
   * scopes. Stacked `@Security` decorators are alternatives (OR); the route is
   * allowed if any one is satisfied. Empty/absent means the route is public.
   */
  security?: SecurityRequirement[] | undefined;
}

/** A single `@Security` requirement: a scheme name and the scopes it requires. */
export interface SecurityRequirement {
  /** The security scheme name (a key in the `Zodec` instance's `security` map). */
  scheme: string;
  /** Scopes the route requires for this scheme; `[]` when none. */
  scopes: string[];
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
export type ParamSource = 'param' | 'query' | 'body' | 'header' | 'req' | 'res' | 'principal';

/** Metadata for one injected handler parameter, as returned by {@link getParams}. */
export interface ParamMetadata {
  /** Zero-based position in the handler's parameter list. */
  index: number;
  /** Request location the value is read from. */
  source: ParamSource;
  /** Key name for `param`/`query`/`header` sources; absent otherwise. */
  name?: string | undefined;
}

/**
 * Metadata is stored as one mutable record per scope, rather than one symbol per
 * concern: {@link ROUTE_KEY} holds a method's whole route entry, {@link CONTROLLER_KEY}
 * holds the class-level entry. Decorators get-or-create their record and set
 * their own field on it (synchronously, in decorator-evaluation order), so the
 * shape is assembled in one place — {@link getRoutes} — instead of stitched back
 * together from many keys. {@link HANDLER_NAMES_KEY} is the registry of which
 * methods are routes (reflect-metadata can't enumerate decorated members).
 */
const ROUTE_KEY = Symbol('zodec:route');
const CONTROLLER_KEY = Symbol('zodec:controller');
const HANDLER_NAMES_KEY = Symbol('zodec:handlerNames');

/** Mutable per-method storage, accumulated by the method/parameter decorators. */
interface RouteEntry {
  method?: HttpMethod;
  path?: string;
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  responses?: Record<number, ResponseMetadata>;
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  examples?: ExampleMetadata[];
  security?: SecurityRequirement[];
  paramInjections?: ParamMetadata[];
}

/** Mutable class-level storage, accumulated by the class decorators. */
interface ControllerEntry {
  prefix?: string;
  tags?: string[];
  security?: SecurityRequirement[];
}

/** Reads a method's route entry without creating one. */
function readRoute(target: object, handlerName: string): RouteEntry | undefined {
  return Reflect.getOwnMetadata(ROUTE_KEY, target, handlerName) as RouteEntry | undefined;
}

/** Gets (creating + storing if needed) a method's mutable route entry. */
function routeEntry(target: object, handlerName: string): RouteEntry {
  const existing = readRoute(target, handlerName);
  if (existing) {
    return existing;
  }
  const created: RouteEntry = {};
  Reflect.defineMetadata(ROUTE_KEY, created, target, handlerName);
  return created;
}

/** Gets (creating + storing if needed) the per-status entry within a route. */
function responseEntry(entry: RouteEntry, status: number): ResponseMetadata {
  entry.responses ??= {};
  return (entry.responses[status] ??= {});
}

/** Reads the controller entry without creating one. */
function readController(target: object): ControllerEntry | undefined {
  return Reflect.getOwnMetadata(CONTROLLER_KEY, target) as ControllerEntry | undefined;
}

/** Gets (creating + storing if needed) the controller's mutable entry. */
function controllerEntry(target: object): ControllerEntry {
  const existing = readController(target);
  if (existing) {
    return existing;
  }
  const created: ControllerEntry = {};
  Reflect.defineMetadata(CONTROLLER_KEY, created, target);
  return created;
}

const STATUS_CONFLICT = (handlerName: string, status: number): Error =>
  new Error(
    `zodec: status ${status} on "${handlerName}" is declared by both @Returns and @ReturnsFile`,
  );

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
  const entry = routeEntry(target, handlerName);
  entry.method = method;
  entry.path = path;
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
  const response = responseEntry(routeEntry(target, handlerName), status);
  if (response.file) {
    throw STATUS_CONFLICT(handlerName, status);
  }
  response.schema = schema;
}

/** Stores the `req.params` schema for a handler. Called by `@Params`. */
export function setParamsSchema(target: object, handlerName: string, schema: ZodType): void {
  routeEntry(target, handlerName).params = schema;
}

/** Stores the `req.query` schema for a handler. Called by `@Query`. */
export function setQuerySchema(target: object, handlerName: string, schema: ZodType): void {
  routeEntry(target, handlerName).query = schema;
}

/** Stores the `req.body` schema for a handler. Called by `@Body`. */
export function setBodySchema(target: object, handlerName: string, schema: ZodType): void {
  routeEntry(target, handlerName).body = schema;
}

/** Records response headers for a status code. Called by `@Returns`. */
export function addResponseHeaders(
  target: object,
  handlerName: string,
  status: number,
  headers: Record<string, ZodType>,
): void {
  const response = responseEntry(routeEntry(target, handlerName), status);
  response.headers = { ...response.headers, ...headers };
}

/** Records a response description for a status code. Called by `@Returns`. */
export function addResponseDescription(
  target: object,
  handlerName: string,
  status: number,
  description: string,
): void {
  responseEntry(routeEntry(target, handlerName), status).description = description;
}

/** Records a binary/file response for a status code. Called by `@ReturnsFile`. */
export function addFileResponse(
  target: object,
  handlerName: string,
  status: number,
  decl: FileResponseDecl,
): void {
  const response = responseEntry(routeEntry(target, handlerName), status);
  if ('schema' in response) {
    throw STATUS_CONFLICT(handlerName, status);
  }
  response.file = decl;
}

/** Appends an example value for a handler. Called by `@Example`. */
export function addExample(target: object, handlerName: string, example: ExampleMetadata): void {
  const entry = routeEntry(target, handlerName);
  (entry.examples ??= []).push(example);
}

/** Stores the operation summary for a handler. Called by `@Summary`. */
export function setSummary(target: object, handlerName: string, text: string): void {
  routeEntry(target, handlerName).summary = text;
}

/** Stores the operation description for a handler. Called by `@Description`. */
export function setDescription(target: object, handlerName: string, text: string): void {
  routeEntry(target, handlerName).description = text;
}

/** Stores the operation id for a handler. Called by `@OperationId`. */
export function setOperationId(target: object, handlerName: string, id: string): void {
  routeEntry(target, handlerName).operationId = id;
}

/** Marks a handler's operation as deprecated. Called by `@Deprecated`. */
export function setDeprecated(target: object, handlerName: string): void {
  routeEntry(target, handlerName).deprecated = true;
}

/**
 * Adds a security requirement. Called by `@Security`. When `handlerName` is
 * omitted the requirement is class-level (applies to every route that doesn't
 * declare its own). Stacked decorators accumulate as alternatives (OR), kept in
 * source order (decorators evaluate bottom-up, so we `unshift`).
 */
export function addSecurity(
  target: object,
  handlerName: string | undefined,
  requirement: SecurityRequirement,
): void {
  const entry =
    handlerName === undefined ? controllerEntry(target) : routeEntry(target, handlerName);
  (entry.security ??= []).unshift(requirement);
}

/**
 * Reads the class-level `@Security` requirements from a prototype.
 *
 * @param target - The controller prototype.
 * @returns The requirements, or `[]` if none were set.
 */
export function getClassSecurity(target: object): SecurityRequirement[] {
  return readController(target)?.security ?? [];
}

/** Stores the controller path prefix on a prototype. Called by `@Route`. */
export function setPrefix(target: object, prefix: string): void {
  controllerEntry(target).prefix = prefix;
}

/**
 * Reads the controller `@Route` prefix from a prototype.
 *
 * @param target - The controller prototype.
 * @returns The prefix, or `''` if none was set.
 */
export function getPrefix(target: object): string {
  return readController(target)?.prefix ?? '';
}

/** Stores the controller tags on a prototype. Called by `@Tags`. */
export function setTags(target: object, tags: string[]): void {
  controllerEntry(target).tags = tags;
}

/**
 * Reads the controller `@Tags` from a prototype.
 *
 * @param target - The controller prototype.
 * @returns The tags, or `[]` if none were set.
 */
export function getTags(target: object): string[] {
  return readController(target)?.tags ?? [];
}

/**
 * Appends parameter-injection metadata for a handler. Called by the parameter
 * decorators (`@Param`, `@QueryParam`, etc.).
 */
export function addParam(target: object, handlerName: string, param: ParamMetadata): void {
  const entry = routeEntry(target, handlerName);
  (entry.paramInjections ??= []).push(param);
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
  return readRoute(target, handlerName)?.paramInjections ?? [];
}

/**
 * Assembles {@link RouteMetadata}[] at read time from each route's stored entry.
 * The handler-name list is the source of truth for which methods are routes;
 * class-level tags/security are folded onto every route so each result is
 * self-contained for downstream consumers (e.g. swagger).
 *
 * @param target - The controller prototype.
 * @returns One entry per route declared on the controller.
 */
export function getRoutes(target: object): RouteMetadata[] {
  const names = (Reflect.getOwnMetadata(HANDLER_NAMES_KEY, target) ?? []) as string[];
  const controller = readController(target) ?? {};
  const tags = controller.tags && controller.tags.length > 0 ? controller.tags : undefined;
  const classSecurity = controller.security;
  return names.map((handlerName) => {
    const entry = readRoute(target, handlerName) ?? {};
    return {
      method: entry.method as HttpMethod,
      path: entry.path ?? '',
      handlerName,
      params: entry.params,
      query: entry.query,
      body: entry.body,
      responses: entry.responses ?? {},
      tags,
      summary: entry.summary,
      description: entry.description,
      operationId: entry.operationId,
      deprecated: entry.deprecated,
      examples: entry.examples,
      // A method's own @Security overrides the class-level default.
      security: entry.security ?? classSecurity,
    } satisfies RouteMetadata;
  });
}
