import 'reflect-metadata';
import type { ZodType } from 'zod';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteMetadata {
  method: HttpMethod;
  path: string;
  handlerName: string;
  responses: Record<number, ZodType>;
  summary?: string | undefined;
}

// One symbol per concern. Each decorator writes under its own key, so two
// decorators on the same method can never clobber each other regardless of the
// order they run in.
const HTTP_METHOD_KEY = Symbol('zodec:httpMethod');
const RETURNS_KEY = Symbol('zodec:returns');
const SUMMARY_KEY = Symbol('zodec:summary');
const HANDLER_NAMES_KEY = Symbol('zodec:handlerNames');
const PREFIX_KEY = Symbol('zodec:prefix');
const TAGS_KEY = Symbol('zodec:tags');

interface HttpMethodEntry {
  method: HttpMethod;
  path: string;
}

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

export function addReturnSchema(
  target: object,
  handlerName: string,
  status: number,
  schema: ZodType,
): void {
  const returns = (Reflect.getOwnMetadata(RETURNS_KEY, target, handlerName) ?? {}) as Record<
    number,
    ZodType
  >;
  returns[status] = schema;
  Reflect.defineMetadata(RETURNS_KEY, returns, target, handlerName);
}

export function setSummary(target: object, handlerName: string, text: string): void {
  Reflect.defineMetadata(SUMMARY_KEY, text, target, handlerName);
}

export function setPrefix(target: object, prefix: string): void {
  Reflect.defineMetadata(PREFIX_KEY, prefix, target);
}

export function getPrefix(target: object): string {
  return (Reflect.getOwnMetadata(PREFIX_KEY, target) ?? '') as string;
}

export function setTags(target: object, tags: string[]): void {
  Reflect.defineMetadata(TAGS_KEY, tags, target);
}

export function getTags(target: object): string[] {
  return (Reflect.getOwnMetadata(TAGS_KEY, target) ?? []) as string[];
}

// Assembles RouteMetadata[] at read time from the per-concern entries. The
// handler-name list is the source of truth for which methods are routes.
export function getRoutes(target: object): RouteMetadata[] {
  const names = (Reflect.getOwnMetadata(HANDLER_NAMES_KEY, target) ?? []) as string[];
  return names.map((handlerName) => {
    const entry = Reflect.getOwnMetadata(HTTP_METHOD_KEY, target, handlerName) as HttpMethodEntry;
    return {
      method: entry.method,
      path: entry.path,
      handlerName,
      responses: (Reflect.getOwnMetadata(RETURNS_KEY, target, handlerName) ?? {}) as Record<
        number,
        ZodType
      >,
      summary: Reflect.getOwnMetadata(SUMMARY_KEY, target, handlerName) as string | undefined,
    };
  });
}
