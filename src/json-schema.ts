import { z } from 'zod';
import { splitFlags } from './pattern';
import { options } from './options';
import { phone } from './phone';

// Схема типа события в Relay — подмножество JSON Schema: объект с полями
// string, number, integer, boolean, array (несколько значений из списка) и
// ключевыми словами из SPEC Relay.
export interface RelayFieldSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  title?: string;
  format?: 'email' | 'uri' | 'date' | 'date-time' | 'time' | 'phone';
  enum?: unknown[];
  // Варианты с подписями: const — значение, title — подпись для людей.
  oneOf?: RelayOption[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  // Несколько из списка: элементы — строки из enum или oneOf.
  items?: { type: 'string'; enum?: string[]; oneOf?: RelayOption<string>[] };
  minItems?: number;
  maxItems?: number;
  // Словарь «ключ → строка»: метки и метаданные сайта.
  additionalProperties?: { type: 'string'; maxLength?: number };
  maxProperties?: number;
  pattern?: string;
  const?: true;
  default?: unknown;
}

export interface RelayOption<T = unknown> {
  const: T;
  title?: string;
}

// Значения вариантов из enum или oneOf; undefined — вариантов нет.
export function optionValues(owner: {
  enum?: unknown[];
  oneOf?: RelayOption[];
}): unknown[] | undefined {
  return owner.enum ?? owner.oneOf?.map((option) => option.const);
}

export interface RelaySchema {
  type: 'object';
  properties: Record<string, RelayFieldSchema>;
  required?: string[];
}

// Ключ словаря в Relay — от 1 до 100 символов.
const MAX_KEY_LENGTH = 100;

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
      const values = optionValues(field);
      if (values) return z.literal(values as number[]);
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
    case 'object': {
      const maxLength = field.additionalProperties?.maxLength;
      return z.record(
        z.string().min(1).max(MAX_KEY_LENGTH),
        maxLength === undefined ? z.string() : z.string().max(maxLength),
      );
    }
    case 'array': {
      let list = z.array(stringOptions(field.items ?? {}));
      if (field.minItems !== undefined) list = list.min(field.minItems);
      if (field.maxItems !== undefined) list = list.max(field.maxItems);
      return list;
    }
    case 'string': {
      if (field.enum || field.oneOf) return stringOptions(field);
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

// Варианты строки: с подписями — options(), без них — z.enum.
function stringOptions(owner: {
  enum?: unknown[];
  oneOf?: RelayOption[];
}): z.ZodType {
  if (owner.oneOf?.some((option) => option.title !== undefined)) {
    return options(
      Object.fromEntries(
        owner.oneOf.map((option) => [
          String(option.const),
          option.title ?? String(option.const),
        ]),
      ),
    );
  }
  return z.enum((optionValues(owner) ?? []) as [string, ...string[]]);
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
    // Время дня без пояса: HH:MM или HH:MM:SS.
    case 'time':
      return z.iso.time();
    case 'phone':
      return phone();
    case undefined:
      return null;
  }
}
