import { z, type ZodType } from 'zod';
import type { PropertyNode, SchemaNode } from './contract.js';

/** The optional fields of a string node (everything but `kind`). */
type StringFields = Omit<Extract<SchemaNode, { kind: 'string' }>, 'kind'>;
/** The optional fields of a number node (everything but `kind`). */
type NumberFields = Omit<Extract<SchemaNode, { kind: 'number' }>, 'kind'>;
/** An object node. */
type ObjectNode = Extract<SchemaNode, { kind: 'object' }>;

/**
 * Converts Zod schemas into the contract's {@link SchemaNode} representation,
 * hoisting every named (`.meta({ id })`) schema into {@link SchemaConverter.schemas}
 * and returning a `ref` node in its place — so shared types are emitted once.
 * Reads Zod 4's internal `_zod.def` directly (more faithful than round-tripping
 * through JSON Schema). Constructs the v1 node set doesn't model fall back to an
 * `unsupported` node embedding `z.toJSONSchema` output, so nothing is lost.
 *
 * Known limits (documented on {@link SchemaNode}): Zod brands are type-only and
 * unrecoverable; transforms/pipes have no static output type and fall back.
 */

/** The Zod 4 internal def fields the converter reads. Typed loosely. */
interface ZodDef {
  type: string;
  format?: string;
  checks?: { _zod?: { def?: Record<string, unknown> } }[];
  discriminator?: string;
  options?: ZodType[];
  shape?: Record<string, ZodType>;
  element?: ZodType;
  innerType?: ZodType;
  defaultValue?: unknown;
  items?: ZodType[];
  rest?: ZodType;
  keyType?: ZodType;
  valueType?: ZodType;
  catchall?: ZodType;
  values?: unknown[];
  entries?: Record<string, unknown>;
  getter?: () => ZodType;
}

function defOf(schema: ZodType): ZodDef | undefined {
  return (schema as unknown as { _zod?: { def?: ZodDef } })._zod?.def;
}

function idOf(schema: ZodType): string | undefined {
  const id = schema.meta()?.id;
  return typeof id === 'string' ? id : undefined;
}

/** The def of each check on a schema (the object holding `check`, `minimum`, …). */
function checkDefs(def: ZodDef): Record<string, unknown>[] {
  return (def.checks ?? [])
    .map((c) => c._zod?.def)
    .filter((d): d is Record<string, unknown> => d !== undefined);
}

export class SchemaConverter {
  /** Named schemas collected during conversion, keyed by `.meta({ id })`. */
  public readonly schemas: Record<string, SchemaNode> = {};
  private readonly inProgress = new Set<string>();

  /** Converts a schema, returning a `ref` node for named (`.meta({ id })`) schemas. */
  public toNode(schema: ZodType): SchemaNode {
    const id = idOf(schema);
    if (id !== undefined) {
      // Build the body once; the in-progress guard breaks recursive references.
      if (!(id in this.schemas) && !this.inProgress.has(id)) {
        this.inProgress.add(id);
        this.schemas[id] = this.build(schema);
        this.inProgress.delete(id);
      }
      return { kind: 'ref', id };
    }
    return this.build(schema);
  }

  /** Builds the node for a schema's own structure (no id short-circuit). */
  private build(schema: ZodType): SchemaNode {
    const def = defOf(schema);
    if (!def) {
      return { kind: 'unsupported', jsonSchema: this.json(schema) };
    }
    switch (def.type) {
      case 'string':
        return { kind: 'string', ...this.stringFields(def) };
      case 'number':
        return { kind: 'number', ...this.numberFields(def) };
      case 'boolean':
        return { kind: 'boolean' };
      case 'date':
        return { kind: 'date' };
      case 'file':
        return { kind: 'file' };
      case 'null':
        return { kind: 'null' };
      case 'any':
        return { kind: 'any' };
      case 'unknown':
        return { kind: 'unknown' };
      case 'literal':
        return {
          kind: 'literal',
          values: (def.values ?? []) as Extract<SchemaNode, { kind: 'literal' }>['values'],
        };
      case 'enum':
        return {
          kind: 'enum',
          values: Object.values(def.entries ?? {}) as Extract<
            SchemaNode,
            { kind: 'enum' }
          >['values'],
        };
      case 'object':
        return this.objectNode(def);
      case 'array':
        return this.arrayNode(def);
      case 'tuple':
        return {
          kind: 'tuple',
          items: (def.items ?? []).map((i) => this.toNode(i)),
          ...(def.rest ? { rest: this.toNode(def.rest) } : {}),
        };
      case 'union':
        return this.unionNode(def);
      case 'record':
      case 'map':
        return {
          kind: 'record',
          key: def.keyType ? this.toNode(def.keyType) : { kind: 'string' },
          value: def.valueType ? this.toNode(def.valueType) : { kind: 'unknown' },
        };
      case 'nullable':
        return { kind: 'nullable', inner: this.inner(def) };
      case 'optional':
        return { kind: 'optional', inner: this.inner(def) };
      case 'default':
      case 'prefault':
        return { kind: 'default', inner: this.inner(def), value: def.defaultValue };
      // Transparent wrappers — unwrap to the inner type.
      case 'readonly':
      case 'catch':
      case 'nonoptional':
      case 'promise':
        return this.inner(def);
      case 'lazy':
        return def.getter ? this.toNode(def.getter()) : { kind: 'unknown' };
      // Transforms/pipes/codecs have no statically-derivable output type — fall back.
      default:
        return { kind: 'unsupported', jsonSchema: this.json(schema) };
    }
  }

  private inner(def: ZodDef): SchemaNode {
    return def.innerType ? this.toNode(def.innerType) : { kind: 'unknown' };
  }

  private stringFields(def: ZodDef): StringFields {
    const node: StringFields = {};
    if (def.format) {
      node.format = def.format;
    }
    for (const c of checkDefs(def)) {
      if (c['check'] === 'min_length' && typeof c['minimum'] === 'number') {
        node.minLength = c['minimum'];
      } else if (c['check'] === 'max_length' && typeof c['maximum'] === 'number') {
        node.maxLength = c['maximum'];
      } else if (c['check'] === 'string_format' && c['format'] === 'regex') {
        if (c['pattern'] instanceof RegExp) {
          node.pattern = c['pattern'].source;
        }
      } else if (
        c['check'] === 'string_format' &&
        typeof c['format'] === 'string' &&
        !node.format
      ) {
        node.format = c['format'];
      }
    }
    return node;
  }

  private numberFields(def: ZodDef): NumberFields {
    const node: NumberFields = {};
    if (def.format && /int/i.test(def.format)) {
      node.int = true;
    }
    for (const c of checkDefs(def)) {
      const value = c['value'];
      if (c['check'] === 'greater_than' && typeof value === 'number') {
        if (c['inclusive']) {
          node.minimum = value;
        } else {
          node.exclusiveMinimum = value;
        }
      } else if (c['check'] === 'less_than' && typeof value === 'number') {
        if (c['inclusive']) {
          node.maximum = value;
        } else {
          node.exclusiveMaximum = value;
        }
      } else if (c['check'] === 'multiple_of' && typeof value === 'number') {
        node.multipleOf = value;
      }
    }
    return node;
  }

  private objectNode(def: ZodDef): ObjectNode {
    const properties: Record<string, PropertyNode> = {};
    for (const [name, propSchema] of Object.entries(def.shape ?? {})) {
      properties[name] = this.property(propSchema);
    }
    return {
      kind: 'object',
      properties,
      // A catchall (`.loose()`/`.catchall()`) → open object; otherwise strict.
      additionalProperties: def.catchall ? this.toNode(def.catchall) : false,
    };
  }

  /** Peels optional/default markers into the property's flags, keeping the base node. */
  private property(schema: ZodType): PropertyNode {
    let current = schema;
    let optional = false;
    let hasDefault = false;
    let defaultValue: unknown;
    for (;;) {
      const def = defOf(current);
      if (def?.type === 'optional' && def.innerType) {
        optional = true;
        current = def.innerType;
      } else if ((def?.type === 'default' || def?.type === 'prefault') && def.innerType) {
        hasDefault = true;
        defaultValue = def.defaultValue;
        current = def.innerType;
      } else {
        break;
      }
    }
    return {
      schema: this.toNode(current),
      ...(optional ? { optional: true } : {}),
      ...(hasDefault ? { default: defaultValue } : {}),
    };
  }

  private arrayNode(def: ZodDef): SchemaNode {
    const node: Extract<SchemaNode, { kind: 'array' }> = {
      kind: 'array',
      element: def.element ? this.toNode(def.element) : { kind: 'unknown' },
    };
    for (const c of checkDefs(def)) {
      if (c['check'] === 'min_length' && typeof c['minimum'] === 'number') {
        node.minItems = c['minimum'];
      } else if (c['check'] === 'max_length' && typeof c['maximum'] === 'number') {
        node.maxItems = c['maximum'];
      }
    }
    return node;
  }

  private unionNode(def: ZodDef): SchemaNode {
    const variants = (def.options ?? []).map((o) => this.toNode(o));
    if (typeof def.discriminator === 'string') {
      return { kind: 'discriminatedUnion', discriminator: def.discriminator, variants };
    }
    return { kind: 'union', variants };
  }

  private json(schema: ZodType): unknown {
    return z.toJSONSchema(schema, { unrepresentable: 'any' });
  }
}
