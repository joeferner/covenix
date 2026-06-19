import { addParam } from './metadata.js';

export function Param(name: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'param', name });
  };
}

export function QueryParam(name: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'query', name });
  };
}

export function BodyParam(): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'body' });
  };
}

export function Header(name: string): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'header', name });
  };
}

export function Req(): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'req' });
  };
}

export function Res(): ParameterDecorator {
  return (target, propertyKey, index) => {
    addParam(target, String(propertyKey), { index, source: 'res' });
  };
}
