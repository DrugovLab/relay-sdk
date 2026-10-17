import { z } from 'zod';
import { splitFlags } from './pattern';
import { phone } from './phone';

// Схема типа события в Relay — подмножество JSON Schema: объект с полями
// string, number, integer, boolean, array (несколько значений из списка) и
// ключевыми словами из SPEC Relay.
export interface RelayFieldSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  format?: 'email' | 'uri' | 'date' | 'date-time' | 'phone';
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  // Несколько из списка: элементы — строки из enum.
  items?: { type: 'string'; enum: string[] };
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  const?: true;
  default?: unknown;
}

export interface RelaySchema {
  type: 'object';
  properties: Record<string, RelayFieldSchema>;
  required?: string[];
}

// Схема Relay → zod-схема для форм. Неизвестные поля zod отбрасывает, как и сервер.
export function relaySchemaToZod(schema: RelaySchema): z.ZodObject {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    let result: z.ZodType = fieldSchema(field);
    if (field.title !== undefined) result = result.meta({ title: field.title });
    if (field.default !== undefined) {
      result = (result as z.ZodType<unknown>).default(field.default);
    } else if (!required.has(name)) {
      result = result.optional();
    }
    shape[name] = result;
  }
  return z.object(shape);
}

function fieldSchema(field: RelayFieldSchema): z.ZodType {
  switch (field.type) {
    case 'boolean':
      return field.const === true ? z.literal(true) : z.boolean();
    case 'number':
    case 'integer': {
      if (field.enum) return z.literal(field.enum as number[]);
      let number = field.type === 'integer' ? z.int() : z.number();
      if (field.minimum !== undefined) number = number.min(field.minimum);
      if (field.maximum !== undefined) number = number.max(field.maximum);
      if (field.exclusiveMinimum !== undefined) {
        number = number.gt(field.exclusiveMinimum);
      }
      if (field.exclusiveMaximum !== undefined) {
        number = number.lt(field.exclusiveMaximum);
      }
      return number;
    }
    case 'array': {
      let list = z.array(
        z.enum((field.items?.enum ?? []) as [string, ...string[]]),
      );
      if (field.minItems !== undefined) list = list.min(field.minItems);
      if (field.maxItems !== undefined) list = list.max(field.maxItems);
      return list;
    }
    case 'string': {
      if (field.enum) return z.enum(field.enum as [string, ...string[]]);
      let text = z.string();
      if (field.minLength !== undefined) text = text.min(field.minLength);
      if (field.maxLength !== undefined) text = text.max(field.maxLength);
      const pattern = field.pattern && jsPattern(field.pattern);
      if (pattern) text = text.regex(pattern);
      const format = formatSchema(field.format);
      return format ? text.pipe(format) : text;
    }
  }
}

// Шаблоны Relay выполняет RE2. Синтаксис RE2, которого нет в JavaScript
// ((?i), \pL), форма не проверяет — его проверит сервер.
function jsPattern(pattern: string): RegExp | undefined {
  const { source, flags } = splitFlags(pattern);
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    return undefined;
  }
}

function formatSchema(
  format: RelayFieldSchema['format'],
): z.ZodType<unknown, string> | null {
  switch (format) {
    case 'email':
      return z.email();
    case 'uri':
      return z.url();
    case 'date':
      return z.iso.date();
    // Время без пояса — время пояса проекта, Relay примет и такое.
    case 'date-time':
      return z.iso.datetime({ local: true, offset: true });
    case 'phone':
      return phone();
    case undefined:
      return null;
  }
}
