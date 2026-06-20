import type { ZodType } from 'zod';

/**
 * The OpenAPI `discriminator` derived from a `z.discriminatedUnion`: the property
 * every variant keys on, and (when every variant is a named schema) a `mapping`
 * from each discriminator value to that variant's component `$ref`.
 */
export interface DiscriminatorInfo {
  /** The discriminator property name (the union's discriminator key). */
  propertyName: string;
  /** Discriminator value → variant `$ref`; omitted if any variant is anonymous. */
  mapping?: Record<string, string> | undefined;
}

/**
 * Zod 4 stores a schema's structure on `schema._zod.def`. We read it directly to
 * recognise a discriminated union and walk into nested schemas — more robust than
 * inferring the union shape back out of the converted JSON Schema. Typed loosely:
 * only the fields we traverse are named.
 */
interface ZodDef {
  type: string;
  discriminator?: string;
  options?: ZodType[];
  shape?: Record<string, ZodType>;
  element?: ZodType;
  innerType?: ZodType;
  left?: ZodType;
  right?: ZodType;
  items?: ZodType[];
  rest?: ZodType;
  keyType?: ZodType;
  valueType?: ZodType;
  in?: ZodType;
  out?: ZodType;
  getter?: () => ZodType;
  values?: unknown[];
}

/** Reads the internal Zod 4 def off a schema. */
function defOf(schema: ZodType): ZodDef | undefined {
  return (schema as unknown as { _zod?: { def?: ZodDef } })._zod?.def;
}

/** The component id assigned via `.meta({ id })`, if any. */
function idOf(schema: ZodType): string | undefined {
  const id = schema.meta()?.id;
  return typeof id === 'string' ? id : undefined;
}

/** The literal value(s) of a variant's discriminator property, if it is a literal. */
function literalValues(variant: ZodType, propertyName: string): unknown[] | undefined {
  const prop = defOf(variant)?.shape?.[propertyName];
  const propDef = prop ? defOf(prop) : undefined;
  return propDef?.type === 'literal' && Array.isArray(propDef.values) ? propDef.values : undefined;
}

/** The directly-nested schemas of a Zod schema, by container type. */
function childSchemas(def: ZodDef): ZodType[] {
  switch (def.type) {
    case 'object':
      return def.shape ? Object.values(def.shape) : [];
    case 'array':
      return def.element ? [def.element] : [];
    case 'union':
      return def.options ?? [];
    case 'intersection':
      return [def.left, def.right].filter((s): s is ZodType => s !== undefined);
    case 'tuple':
      return [...(def.items ?? []), ...(def.rest ? [def.rest] : [])];
    case 'record':
    case 'map':
      return [def.keyType, def.valueType].filter((s): s is ZodType => s !== undefined);
    case 'set':
      return def.valueType ? [def.valueType] : [];
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
    case 'promise':
      return def.innerType ? [def.innerType] : [];
    case 'pipe':
      return [def.in, def.out].filter((s): s is ZodType => s !== undefined);
    case 'lazy':
      return def.getter ? [def.getter()] : [];
    default:
      return [];
  }
}

/**
 * Walks a Zod schema tree and records every **named** `z.discriminatedUnion`
 * (`.meta({ id })`) into `out`, keyed by component id. The discriminator key is
 * read straight from the union's def; the `mapping` is built from each variant's
 * id + discriminator literal, and omitted if any variant is anonymous (OpenAPI's
 * `mapping` references variants by `$ref`, so an unnamed one has nothing to point
 * at). The `visited` set guards against recursive/lazy schemas.
 */
export function collectDiscriminators(
  schema: ZodType,
  out: Map<string, DiscriminatorInfo>,
  visited: Set<ZodType> = new Set(),
): void {
  if (visited.has(schema)) {
    return;
  }
  visited.add(schema);
  const def = defOf(schema);
  if (!def) {
    return;
  }

  if (def.type === 'union' && typeof def.discriminator === 'string') {
    const id = idOf(schema);
    if (id !== undefined) {
      const propertyName = def.discriminator;
      const mapping: Record<string, string> = {};
      let allNamed = true;
      for (const variant of def.options ?? []) {
        const variantId = idOf(variant);
        const values = literalValues(variant, propertyName);
        if (variantId !== undefined && values && values.length > 0) {
          for (const value of values) {
            mapping[String(value)] = `#/components/schemas/${variantId}`;
          }
        } else {
          allNamed = false;
        }
      }
      out.set(id, {
        propertyName,
        mapping: allNamed && Object.keys(mapping).length > 0 ? mapping : undefined,
      });
    }
  }

  for (const child of childSchemas(def)) {
    collectDiscriminators(child, out, visited);
  }
}
