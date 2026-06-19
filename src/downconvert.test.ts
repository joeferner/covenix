import { describe, expect, it } from 'vitest';
import type { OpenAPIV3_1 } from 'openapi-types';
import { downConvertToV30 } from './downconvert.js';

type Json = Record<string, unknown>;

/** Wraps a schema as a one-component 3.1 doc, down-converts, returns the schema. */
function convert(schema: Json): Json {
  const doc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {},
    components: { schemas: { S: schema } },
  } as unknown as OpenAPIV3_1.Document;
  const out = downConvertToV30(doc);
  return (out.components?.schemas as Record<string, Json>)['S'] as Json;
}

describe('downConvertToV30', () => {
  it('sets the document version to 3.0.3', () => {
    const doc = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {},
    } as unknown as OpenAPIV3_1.Document;
    expect(downConvertToV30(doc).openapi).toBe('3.0.3');
  });

  describe('nullable', () => {
    it('collapses anyOf [scalar, null] onto the scalar with nullable: true', () => {
      const out = convert({ anyOf: [{ type: 'string', format: 'email' }, { type: 'null' }] });
      expect(out).toEqual({ type: 'string', format: 'email', nullable: true });
      expect(out).not.toHaveProperty('anyOf');
    });

    it('keeps anyOf when more than one non-null branch remains', () => {
      const out = convert({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] });
      expect(out).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }], nullable: true });
    });

    it('wraps a nullable $ref in allOf (3.0 forbids $ref siblings)', () => {
      const out = convert({ anyOf: [{ $ref: '#/components/schemas/User' }, { type: 'null' }] });
      expect(out).toEqual({ allOf: [{ $ref: '#/components/schemas/User' }], nullable: true });
    });

    it('handles oneOf the same way as anyOf', () => {
      const out = convert({ oneOf: [{ type: 'boolean' }, { type: 'null' }] });
      expect(out).toEqual({ type: 'boolean', nullable: true });
    });

    it('collapses a type array containing "null"', () => {
      expect(convert({ type: ['string', 'null'] })).toEqual({ type: 'string', nullable: true });
    });

    it('leaves a non-nullable composition untouched', () => {
      const out = convert({ anyOf: [{ type: 'string' }, { type: 'number' }] });
      expect(out).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
      expect(out).not.toHaveProperty('nullable');
    });
  });

  describe('numeric keywords', () => {
    it('converts numeric exclusiveMinimum/Maximum to boolean + minimum/maximum', () => {
      expect(convert({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 })).toEqual({
        type: 'number',
        minimum: 0,
        maximum: 10,
        exclusiveMinimum: true,
        exclusiveMaximum: true,
      });
    });

    it('leaves plain minimum/maximum alone', () => {
      expect(convert({ type: 'integer', minimum: 1, maximum: 5 })).toEqual({
        type: 'integer',
        minimum: 1,
        maximum: 5,
      });
    });
  });

  it('converts const to a single-value enum', () => {
    const out = convert({ type: 'string', const: 'widget' });
    expect(out).toEqual({ type: 'string', enum: ['widget'] });
    expect(out).not.toHaveProperty('const');
  });

  it('converts a schema-level examples array to a singular example', () => {
    const out = convert({ type: 'string', examples: ['a', 'b'] });
    expect(out).toEqual({ type: 'string', example: 'a' });
    expect(out).not.toHaveProperty('examples');
  });

  it('drops 3.1-only binary annotations but keeps format: binary', () => {
    const out = convert({
      type: 'string',
      format: 'binary',
      contentEncoding: 'binary',
      contentMediaType: 'image/png',
      maxLength: 10,
    });
    expect(out).toEqual({ type: 'string', format: 'binary', maxLength: 10 });
  });

  it('strips leftover $schema / $id', () => {
    const out = convert({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    });
    expect(out).toEqual({ type: 'object' });
  });

  describe('recursion', () => {
    it('converts nested object properties', () => {
      const out = convert({
        type: 'object',
        properties: {
          name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          age: { type: 'integer', exclusiveMinimum: 0 },
        },
      });
      expect(out['properties']).toEqual({
        name: { type: 'string', nullable: true },
        age: { type: 'integer', minimum: 0, exclusiveMinimum: true },
      });
    });

    it('converts array items', () => {
      const out = convert({ type: 'array', items: { type: 'string', const: 'x' } });
      expect(out).toEqual({ type: 'array', items: { type: 'string', enum: ['x'] } });
    });

    it('converts branches inside allOf', () => {
      const out = convert({ allOf: [{ type: 'object', properties: { k: { const: 1 } } }] });
      expect(out).toEqual({ allOf: [{ type: 'object', properties: { k: { enum: [1] } } }] });
    });

    it('converts additionalProperties schemas', () => {
      const out = convert({ type: 'object', additionalProperties: { const: 'v' } });
      expect(out).toEqual({ type: 'object', additionalProperties: { enum: ['v'] } });
    });
  });

  describe('operation schemas', () => {
    function operationDoc(): OpenAPIV3_1.Document {
      return {
        openapi: '3.1.0',
        info: { title: 't', version: '1' },
        paths: {
          '/w': {
            post: {
              parameters: [{ name: 'q', in: 'query', schema: { type: 'string', const: 'x' } }],
              requestBody: {
                content: {
                  'application/json': { schema: { type: 'number', exclusiveMinimum: 0 } },
                },
              },
              responses: {
                '200': {
                  description: '',
                  content: {
                    'application/json': {
                      schema: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    },
                  },
                  headers: { 'X-N': { schema: { type: 'integer', exclusiveMaximum: 9 } } },
                },
              },
            },
          },
        },
      } as unknown as OpenAPIV3_1.Document;
    }

    it('converts parameter, body, response, and header schemas', () => {
      const out = downConvertToV30(operationDoc());
      const op = (out.paths?.['/w'] as Json)['post'] as Json;

      const param = (op['parameters'] as Json[])[0] as Json;
      expect(param['schema']).toEqual({ type: 'string', enum: ['x'] });

      const body = op['requestBody'] as Json;
      const bodySchema = ((body['content'] as Json)['application/json'] as Json)['schema'];
      expect(bodySchema).toEqual({ type: 'number', minimum: 0, exclusiveMinimum: true });

      const res = (op['responses'] as Json)['200'] as Json;
      const resSchema = ((res['content'] as Json)['application/json'] as Json)['schema'];
      expect(resSchema).toEqual({ type: 'string', nullable: true });

      const headerSchema = ((res['headers'] as Json)['X-N'] as Json)['schema'];
      expect(headerSchema).toEqual({ type: 'integer', maximum: 9, exclusiveMaximum: true });
    });
  });
});
