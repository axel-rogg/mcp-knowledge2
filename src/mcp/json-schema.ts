// Lokaler Zod→JSON-Schema-Konverter für MCP `tools/list`.
//
// Bewusst minimal — KC2 nimmt nicht das npm-Paket `zod-to-json-schema`, weil
// (a) der Output-Footprint kleiner sein soll (nur die Tool-Input-Schemas) und
// (b) wir keine `$ref`-Verweise wollen, die manche MCP-Clients schlecht
// auflösen. Wenn neue Zod-Typen auftauchen (z.B. tuple, intersect): hier
// ergänzen.
//
// Phase-1 Wrapper-Migration (2026-05-18): extrahiert aus register_tools.ts,
// damit Sub-Tool-Files (notes/lists/docs/...) ihn importieren können ohne
// Zirkular-Import.

import type { z } from 'zod';
import { z as zRuntime } from 'zod';

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return walk(schema);
}

function walk(schema: z.ZodTypeAny): Record<string, unknown> {
  // unwrap optional/default/nullable/effects (refine/transform) for descend
  if (schema instanceof zRuntime.ZodOptional || schema instanceof zRuntime.ZodDefault) {
    return walk((schema._def as { innerType: z.ZodTypeAny }).innerType);
  }
  if (schema instanceof zRuntime.ZodEffects) {
    // .refine() / .transform() / .superRefine() wrap the schema in ZodEffects.
    // The JSON-schema mirror should reflect the underlying object shape.
    return walk((schema._def as { schema: z.ZodTypeAny }).schema);
  }
  if (schema instanceof zRuntime.ZodNullable) {
    const inner = walk((schema._def as { innerType: z.ZodTypeAny }).innerType);
    const innerType = inner['type'];
    if (typeof innerType === 'string') {
      inner['type'] = [innerType, 'null'];
    }
    return inner;
  }
  if (schema instanceof zRuntime.ZodString) return { type: 'string' };
  if (schema instanceof zRuntime.ZodNumber) return { type: 'number' };
  if (schema instanceof zRuntime.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof zRuntime.ZodEnum) {
    return { type: 'string', enum: schema._def.values };
  }
  if (schema instanceof zRuntime.ZodArray) {
    return { type: 'array', items: walk(schema._def.type as z.ZodTypeAny) };
  }
  if (schema instanceof zRuntime.ZodRecord) {
    return { type: 'object', additionalProperties: walk(schema._def.valueType as z.ZodTypeAny) };
  }
  if (schema instanceof zRuntime.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = walk(value);
      if (!(value instanceof zRuntime.ZodOptional) && !(value instanceof zRuntime.ZodDefault)) {
        required.push(key);
      }
    }
    const out: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) out['required'] = required;
    return out;
  }
  if (schema instanceof zRuntime.ZodUnion) {
    return { anyOf: schema._def.options.map((o: z.ZodTypeAny) => walk(o)) };
  }
  return {};
}
