import type { ConfigBody } from './config-body';
import { RelayConfigError } from './errors';
import type { RelayFieldSchema, RelaySchema } from './json-schema';
import { splitFlags } from './pattern';

export const PACKAGE_NAME = '@drugovlab/relay-sdk';

export interface GeneratedConfig {
  source: string;
  // Поля, которые остались в панели: секреты, адрес и заголовки вебхука.
  keptInPanel: string[];
  // Что в коде выглядит иначе, чем в Relay.
  notes: string[];
}

// Фрагмент кода, который вставляется как есть: z.string()…
class Code {
  constructor(readonly text: string) {}
}

// Выгрузка из Relay (тело PUT /api/v1/config) → исходник relay.config.ts.
// Секреты, адрес и заголовки вебхука сервер отдаёт как null: в код они не
// попадают и остаются в панели.
export function configSource(body: ConfigBody): GeneratedConfig {
  const keptInPanel: string[] = [];
  const notes: string[] = [];
  let usesPhone = false;

  const channels: Record<string, unknown> = {};
  for (const [key, channel] of Object.entries(body.channels)) {
    const config: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(channel.config)) {
      if (value === null || (isRecord(value) && hasNull(value))) {
        keptInPanel.push(`channels.${key}.${field}`);
      } else {
        config[field] = value;
      }
    }
    channels[key] = {
      type: channel.type,
      ...(channel.name !== undefined &&
        channel.name !== key && { name: channel.name }),
      ...config,
    };
  }

  const events: Record<string, unknown> = {};
  for (const [slug, event] of Object.entries(body.events)) {
    // Схема стоит в events.<ключ>.schema: отступ 6 пробелов.
    const schema = schemaSource(
      event.schema,
      '      ',
      `events.${slug}.schema`,
    );
    usesPhone ||= schema.usesPhone;
    notes.push(...schema.notes);
    events[slug] = {
      name: event.name,
      schema: new Code(schema.text),
      // send: {} — каналы типа задаёт код, и их нет; без send — каналы в панели.
      ...(event.send && { send: event.send }),
    };
  }

  const imports = usesPhone ? 'defineRelay, phone' : 'defineRelay';
  const config: Record<string, unknown> = {};
  if (Object.keys(channels).length > 0) config.channels = channels;
  config.events = events;
  const source = [
    `// Generated from Relay by relay pull.`,
    `import { ${imports} } from '${PACKAGE_NAME}';`,
    `import { z } from 'zod';`,
    ``,
    `export default defineRelay(${literal(config, '')});`,
    ``,
  ].join('\n');
  return { source, keptInPanel, notes };
}

function hasNull(value: Record<string, unknown>): boolean {
  return Object.values(value).some((item) => item === null);
}

// Схема Relay → код zod, обратный переводу при push. notes — что в коде
// выглядит иначе, чем в Relay; path — путь схемы для ошибок и заметок.
export function schemaSource(
  schema: RelaySchema,
  indent = '',
  path = 'schema',
): {
  text: string;
  usesPhone: boolean;
  notes: string[];
} {
  const required = new Set(schema.required ?? []);
  const notes: string[] = [];
  let usesPhone = false;
  const fields = Object.entries(schema.properties).map(([name, field]) => {
    const fieldPath = `${path}.${name}`;
    usesPhone ||= field.format === 'phone';
    let code = fieldSource(field, fieldPath, notes);
    const meta = [
      ...(field.title !== undefined ? [`title: ${quote(field.title)}`] : []),
      // Выбор из целых: z.literal даёт number, тип задаёт meta.
      ...(field.type === 'integer' && field.enum ? [`type: 'integer'`] : []),
    ];
    if (meta.length > 0) code += `.meta({ ${meta.join(', ')} })`;
    if (field.default !== undefined) {
      code += `.default(${JSON.stringify(field.default)})`;
      if (required.has(name)) {
        notes.push(
          `${fieldPath}: required with a default value: in code it is .default(); push will report the field as changed, validation is the same.`,
        );
      }
    } else if (!required.has(name)) {
      code += '.optional()';
    }
    return `${key(name)}: ${code}`;
  });
  const inner = `${indent}  `;
  const lines = fields.map((field) => `${inner}${field},`).join('\n');
  return {
    text:
      fields.length === 0
        ? 'z.object({})'
        : `z.object({\n${lines}\n${indent}})`,
    usesPhone,
    notes,
  };
}

const ENUM_IGNORED = [
  'format',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
] as const;

function fieldSource(
  field: RelayFieldSchema,
  path: string,
  notes: string[],
): string {
  if (field.enum) {
    const ignored = ENUM_IGNORED.filter((name) => field[name] !== undefined);
    if (field.type === 'boolean' || ignored.length > 0) {
      const what =
        field.type === 'boolean' ? 'the boolean type' : ignored.join(', ');
      notes.push(`${path}: in code only the list of values, without ${what}.`);
    }
    return field.type === 'string'
      ? `z.enum([${field.enum.map((value) => quote(String(value))).join(', ')}])`
      : `z.literal([${field.enum.map((value) => JSON.stringify(value)).join(', ')}])`;
  }
  switch (field.type) {
    case 'boolean':
      return field.const === true ? 'z.literal(true)' : 'z.boolean()';
    case 'number':
    case 'integer': {
      let code = field.type === 'integer' ? 'z.int()' : 'z.number()';
      if (field.minimum !== undefined) code += `.min(${field.minimum})`;
      if (field.maximum !== undefined) code += `.max(${field.maximum})`;
      if (field.exclusiveMinimum !== undefined) {
        code += `.gt(${field.exclusiveMinimum})`;
      }
      if (field.exclusiveMaximum !== undefined) {
        code += `.lt(${field.exclusiveMaximum})`;
      }
      return code;
    }
    case 'array': {
      const values = (field.items?.enum ?? []).map(quote).join(', ');
      let code = `z.array(z.enum([${values}]))`;
      if (field.minItems !== undefined) code += `.min(${field.minItems})`;
      if (field.maxItems !== undefined) code += `.max(${field.maxItems})`;
      return code;
    }
    case 'string': {
      let code = FORMATS[field.format ?? ''] ?? 'z.string()';
      if (field.minLength !== undefined) code += `.min(${field.minLength})`;
      if (field.maxLength !== undefined) code += `.max(${field.maxLength})`;
      if (field.pattern !== undefined) {
        code += `.regex(${regexLiteral(field.pattern, path)})`;
      }
      return code;
    }
  }
}

// Переводы строк, которые не могут стоять в литерале регулярного выражения.
const LINE_BREAKS = [10, 13, 0x2028, 0x2029].map((code) =>
  String.fromCharCode(code),
);

// Шаблон Relay (RE2) → литерал JavaScript; (?ims) в начале — флаги. Синтаксис
// RE2, которого нет в JavaScript ((?i) в середине, \pL), — ошибка: файл с
// выброшенной проверкой хуже.
function regexLiteral(pattern: string, path: string): string {
  const { source, flags } = splitFlags(pattern);
  try {
    new RegExp(source, `${flags}u`);
  } catch {
    throw new RelayConfigError(
      `${path}: pattern "${pattern}" is not valid JavaScript. Fix it in the panel and run pull again.`,
    );
  }
  if (LINE_BREAKS.some((char) => source.includes(char))) {
    return `new RegExp(${quote(source)}, '${flags}u')`;
  }
  // В литерале «/» экранируется; при push экранирование снимается.
  let text = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '/') text += '\\/';
    else if (char === '\\') text += char + (source[++index] ?? '');
    else text += char;
  }
  return `/${text}/${flags}u`;
}

const FORMATS: Record<string, string> = {
  email: 'z.email()',
  uri: 'z.url()',
  date: 'z.iso.date()',
  'date-time': 'z.iso.datetime({ local: true, offset: true })',
  phone: 'phone()',
};

function quote(text: string): string {
  return `'${text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`;
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Значение → литерал TypeScript с отступами по 2 пробела.
function literal(value: unknown, indent: string): string {
  if (value instanceof Code) return value.text;
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = indent + '  ';
    return `[\n${value.map((item) => `${inner}${literal(item, inner)},`).join('\n')}\n${indent}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined,
    );
    if (entries.length === 0) return '{}';
    const inner = indent + '  ';
    return `{\n${entries
      .map(([name, item]) => `${inner}${key(name)}: ${literal(item, inner)},`)
      .join('\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}
