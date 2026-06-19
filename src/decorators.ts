import type { ZodType } from 'zod';
import {
  addReturnSchema,
  setHttpMethod,
  setPrefix,
  setSummary,
  setTags,
  type HttpMethod,
} from './metadata.js';

function httpMethodDecorator(method: HttpMethod, path = ''): MethodDecorator {
  return (target, propertyKey) => {
    setHttpMethod(target, String(propertyKey), method, path);
  };
}

export function Route(prefix: string): ClassDecorator {
  return (target) => {
    setPrefix(target.prototype as object, prefix);
  };
}

export function Tags(...tags: string[]): ClassDecorator {
  return (target) => {
    setTags(target.prototype as object, tags);
  };
}

export const Get = (path = ''): MethodDecorator => httpMethodDecorator('get', path);
export const Post = (path = ''): MethodDecorator => httpMethodDecorator('post', path);
export const Put = (path = ''): MethodDecorator => httpMethodDecorator('put', path);
export const Patch = (path = ''): MethodDecorator => httpMethodDecorator('patch', path);
export const Delete = (path = ''): MethodDecorator => httpMethodDecorator('delete', path);

export function Returns(status: number, schema: ZodType): MethodDecorator {
  return (target, propertyKey) => {
    addReturnSchema(target, String(propertyKey), status, schema);
  };
}

export function Summary(text: string): MethodDecorator {
  return (target, propertyKey) => {
    setSummary(target, String(propertyKey), text);
  };
}
