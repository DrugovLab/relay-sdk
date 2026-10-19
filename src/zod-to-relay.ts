import { z } from 'zod';
import { RelayConfigError } from './errors';
import type { RelayFieldSchema, RelayOption, RelaySchema } from './json-schema';
import { optionTitles } from './options';
import { fileAccept } from './file';
import { isPhoneCheck } from './phone';

export interface ConversionResult {
  schema: RelaySchema;
  // Что не переносится в Relay: refine и transform проверяются только у клиента.
  warnings: string[];
}

type Json = Record<string, unknown>;

const FIELD_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
];
const KEPT = [
  'type',
  'title',
  'format',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'items',
  'minItems',
  'maxItems',
  'pattern',
  'const',
  'default',
];
// Форматы zod (bag.format) и JSON Schema (format) → формат Relay.
const FORMATS: Record<string, RelayFieldSchema['format']> = {
  email: 'email',
  url: 'uri',
  uri: 'uri',
  date: 'date',
  datetime: 'date-time',
  'date-time': 'date-time',
  time: 'time',
  phone: 'phone',
};
// Проверки JSON Schema, которых нет в Relay: без них сервер пропустил бы то,
// что не пропускает клиент.
const UNSUPPORTED = [
  'multipleOf',
  'additionalItems',
  'uniqueItems',
  'contains',
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'dependencies',
  'not',
  'if',
  'then',
  'else',
  'allOf',
];
const SAFE_INT = Number.MAX_SAFE_INTEGER;

// zod-схема события → схема Relay. Порядок полей сохраняется. Неподдерживаемое
// (вложенные объекты, массивы не из списка, null, объединения) — ошибка с
// именем поля.
export function zodToRelaySchema(
  schema: z.ZodObject,
  path = 'schema',
): ConversionResult {
  const warnings: string[] = [];
  const properties: Record<string, RelayFieldSchema> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema.shape) as [
    string,
    z.ZodType,
  ][]) {
    const fieldPath = `${path}.${name}`;
    let json: Json;
    try {
      json = z.toJSONSchema(field, {
        io: 'input',
        target: 'draft-7',
        unrepresentable: 'throw',
      }) as Json;
    } catch (error) {
      throw new RelayConfigError(
        `${fieldPath}: the type cannot be converted to a Relay schema (${(error as Error).message}).`,
      );
    }
    properties[name] = normalizeField(fieldPath, inlineRefs(json), field);
    warnings.push(...unportedChecks(fieldPath, field));
    // Обязательные — по входу: поле с .optional() и .default() можно не
    // передавать, у них optin задан.
    if (field._zod.optin === undefined) required.push(name);
  }
  if (
    schema._zod.def.checks?.some((check) => check._zod.def.check === 'custom')
  ) {
    warnings.push(
      `${path}: object-level refine runs only on the client; Relay does not know it.`,
    );
  }
  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
    },
    warnings,
  };
}

function normalizeField(
  path: string,
  json: Json,
  field: z.ZodType,
): RelayFieldSchema {
  const fail = (text: string): never => {
    throw new RelayConfigError(`${path}: ${text}`);
  };
  // Файл: z.file(), file('image/*') или их список.
  const inner = unwrap(field);
  if (inner._zod.def.type === 'file') return fileField(json, inner);
  const element = (inner._zod.def as { element?: z.ZodType }).element;
  if (
    json.type === 'array' &&
    element &&
    unwrap(element)._zod.def.type === 'file'
  ) {
    return {
      type: 'array',
      ...(json.title !== undefined && { title: json.title as string }),
      items: fileField(json.items as Json, unwrap(element)) as never,
      ...(json.minItems !== undefined && { minItems: json.minItems as number }),
      ...(json.maxItems !== undefined && { maxItems: json.maxItems as number }),
    };
  }
  if (json.anyOf || json.oneOf || Array.isArray(json.type)) {
    fail('null and union types are not supported.');
  }
  // Объект в Relay — только словарь строк: z.record(z.string(), z.string()).
  if (json.type === 'object') return dictionaryField(json, fail);
  if (!FIELD_TYPES.includes(json.type as string)) {
    fail(
      `the type must be a string, number, boolean or z.array(z.enum([...])).`,
    );
  }
  // Массив в Relay — только несколько значений из списка.
  if (json.type === 'array' && !isEnumItems(json.items)) {
    fail('arrays are supported only as z.array(z.enum([...])).');
  }
  const result: Json = {};
  for (const [key, value] of Object.entries(json)) {
    // Шаблоны строки берутся из проверок zod: в JSON Schema шаблон формата
    // (email, datetime) не отличить от своего.
    if (json.type === 'string' && (key === 'pattern' || key === 'allOf')) {
      continue;
    }
    if (UNSUPPORTED.includes(key)) {
      fail(`"${key}" is not supported in Relay schemas.`);
    }
    // Прочее, кроме ключей Relay, — пометки из .meta() (placeholder,
    // examples): на проверку не влияют.
    if (KEPT.includes(key)) result[key] = value;
  }

  if (json.type === 'string') {
    const zodFormat =
      stringFormat(field) ?? (json.format as string | undefined);
    if (zodFormat !== undefined && PATTERN_CHECKS.includes(zodFormat)) {
      delete result.format;
    } else if (zodFormat !== undefined) {
      const format = FORMATS[zodFormat];
      if (!format) fail(`format "${zodFormat}" is not supported in Relay.`);
      result.format = format;
    }
    const patterns = ownPatterns(field);
    if (patterns.some((pattern) => pattern.flags.includes('v'))) {
      fail('regex flag v is not supported: its syntax differs in Relay.');
    }
    if (patterns.length > 1) {
      fail(
        'a field has one pattern in Relay: combine regex, startsWith and the like into one regex.',
      );
    }
    if (patterns.length === 1) {
      // Флаги i, m, s в RE2 пишутся в начале шаблона: /abc/i → (?i)abc.
      // g, y, d на проверку не влияют.
      const flags = [...patterns[0].flags]
        .filter((flag) => 'ims'.includes(flag))
        .join('');
      result.pattern = (flags ? `(?${flags})` : '') + patternText(patterns[0]);
    }
  }
  if (json.type === 'integer') {
    if (result.minimum === -SAFE_INT) delete result.minimum;
    if (result.maximum === SAFE_INT) delete result.maximum;
  }
  // Подписи из options() — oneOf из const и title.
  if (Array.isArray(result.enum)) {
    const oneOf = labeledOptions(result.enum as string[], optionTitles(inner));
    if (oneOf) {
      result.oneOf = oneOf;
      delete result.enum;
    }
  }
  if (json.type === 'array' && element) {
    const items = result.items as { enum: string[] };
    const oneOf = labeledOptions(items.enum, optionTitles(unwrap(element)));
    if (oneOf) result.items = { type: 'string', oneOf };
  }
  if (
    result.const !== undefined &&
    !(json.type === 'boolean' && result.const === true)
  ) {
    fail('only z.literal(true) is supported among exact values.');
  }
  return result as unknown as RelayFieldSchema;
}

// Варианты с подписями; без подписей, отличных от значений, — undefined.
function labeledOptions(
  values: string[],
  titles: Record<string, string> | undefined,
): RelayOption<string>[] | undefined {
  if (!titles || values.every((value) => (titles[value] ?? value) === value)) {
    return undefined;
  }
  return values.map((value) =>
    titles[value] !== undefined && titles[value] !== value
      ? { const: value, title: titles[value] }
      : { const: value },
  );
}

function dictionaryField(
  json: Json,
  fail: (text: string) => never,
): RelayFieldSchema {
  const values = json.additionalProperties;
  const keys = json.propertyNames as Json | undefined;
  const isString = (node: unknown, allowed: string[]): boolean =>
    typeof node === 'object' &&
    node !== null &&
    (node as Json).type === 'string' &&
    Object.keys(node).every((key) => key === 'type' || allowed.includes(key));
  if (
    !isString(values, ['maxLength']) ||
    (keys !== undefined && !isString(keys, ['minLength', 'maxLength'])) ||
    Object.keys(json).some(
      (key) =>
        ![
          '$schema',
          'type',
          'title',
          'additionalProperties',
          'propertyNames',
        ].includes(key),
    )
  ) {
    fail(
      'objects are supported only as z.record(z.string(), z.string()): keys of 1–100 characters, string values.',
    );
  }
  return {
    type: 'object',
    ...(json.title !== undefined && { title: json.title as string }),
    additionalProperties: values as RelayFieldSchema['additionalProperties'] &
      object,
  };
}

// Файл в схеме Relay: { type: 'string', format: 'binary', contentMediaType }.
// Типы — из file('…') или z.file().mime([...]).
function fileField(json: Json, schema: z.ZodType): RelayFieldSchema {
  const checks = (schema._zod.def as { checks?: z.core.$ZodCheck[] }).checks;
  const accept =
    checks
      ?.map((check) => fileAccept((check._zod.def as { fn?: unknown }).fn))
      .find((value) => value !== undefined) ??
    (Array.isArray(json.anyOf)
      ? (json.anyOf as Json[])
          .map((item) => item.contentMediaType as string)
          .join(', ')
      : (json.contentMediaType as string | undefined));
  return {
    type: 'string',
    format: 'binary',
    ...(json.title !== undefined && { title: json.title as string }),
    ...(accept && { contentMediaType: accept }),
  };
}

function isEnumItems(items: unknown): boolean {
  if (typeof items !== 'object' || items === null) return false;
  const { type, enum: values, ...rest } = items as Json;
  return (
    type === 'string' &&
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === 'string') &&
    Object.keys(rest).length === 0
  );
}

// Схема с .meta({ id }) уходит в definitions, на её месте — $ref (у
// необязательной — allOf: [{ $ref }]). Подставляем её обратно.
function inlineRefs(json: Json): Json {
  const definitions = (json.definitions ?? {}) as Record<string, Json>;
  const resolve = (node: Json): Json => {
    const { definitions: _definitions, $ref, allOf, ...rest } = node;
    if (typeof $ref === 'string') {
      const target = definitions[$ref.replace('#/definitions/', '')] ?? {};
      return { ...resolve(target), ...rest };
    }
    const [only] = Array.isArray(allOf) ? allOf : [];
    if (allOf && (allOf as unknown[]).length === 1 && isRef(only)) {
      return { ...resolve(only), ...rest };
    }
    return allOf === undefined ? rest : { ...rest, allOf };
  };
  return resolve(json);
}

function isRef(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && '$ref' in value;
}

// Проверки строки, которые zod помечает в bag.format, хотя это шаблоны: в JSON
// Schema они — pattern.
const PATTERN_CHECKS = [
  'regex',
  'starts_with',
  'ends_with',
  'includes',
  'lowercase',
  'uppercase',
];

// Шаблоны, которые задал разработчик: regex, startsWith и другие проверки строки.
function ownPatterns(field: z.ZodType): RegExp[] {
  const checks = (unwrap(field)._zod.def as { checks?: z.core.$ZodCheck[] })
    .checks;
  return (checks ?? []).flatMap((check) => {
    const def = check._zod.def as { format?: unknown; pattern?: unknown };
    return typeof def.format === 'string' &&
      PATTERN_CHECKS.includes(def.format) &&
      def.pattern instanceof RegExp
      ? [def.pattern]
      : [];
  });
}

// Текст шаблона как его написали: RegExp.source экранирует «/» как «\/»,
// а сервер сравнивает шаблоны по тексту.
function patternText(pattern: RegExp): string {
  let text = '';
  for (let index = 0; index < pattern.source.length; index++) {
    const char = pattern.source[index];
    if (char === '\\' && pattern.source[index + 1] === '/') continue;
    text += char;
    if (char === '\\') text += pattern.source[++index] ?? '';
  }
  return text;
}

// Формат строки из zod: у datetime в JSON Schema только шаблон, без format.
// Телефон — по проверке phone(): meta до zod 4.1 не переходит на схему после
// .refine() и .min().
function stringFormat(field: z.ZodType): string | undefined {
  const inner = unwrap(field);
  const checks = (inner._zod.def as { checks?: z.core.$ZodCheck[] }).checks;
  if (
    checks?.some((check) =>
      isPhoneCheck((check._zod.def as { fn?: unknown }).fn),
    )
  ) {
    return 'phone';
  }
  const format =
    (inner._zod.def as { format?: unknown }).format ??
    (inner._zod.bag as { format?: unknown }).format;
  return typeof format === 'string' ? format : undefined;
}

// Схема, которую проверяет Relay: без optional, default и pipe. У transform
// и pipe это вход, у preprocess — выход: вход у него — сама функция.
function unwrap(field: z.ZodType): z.ZodType {
  let current = field;
  for (;;) {
    const def = current._zod.def as {
      type: string;
      innerType?: z.ZodType;
      in?: z.ZodType;
      out?: z.ZodType;
    };
    if (def.innerType) current = def.innerType;
    else if (def.type === 'pipe' && def.in && def.out) {
      current = def.in._zod.def.type === 'transform' ? def.out : def.in;
    } else return current;
  }
}

// refine (кроме проверки phone()), transform и pipe в Relay не переносятся.
function unportedChecks(path: string, field: z.ZodType): string[] {
  const warnings: string[] = [];
  let current: z.ZodType | undefined = field;
  while (current) {
    const def = current._zod.def as {
      type: string;
      innerType?: z.ZodType;
      checks?: { _zod: { def: { check: string; fn?: unknown } } }[];
    };
    // Проверку phone() на сервере заменяет format: phone; свой refine поверх
    // phone() — отдельная проверка.
    if (
      def.checks?.some(
        (check) =>
          check._zod.def.check === 'custom' &&
          !isPhoneCheck(check._zod.def.fn) &&
          fileAccept(check._zod.def.fn) === undefined,
      )
    ) {
      warnings.push(
        `${path}: refine runs only on the client; Relay does not know it.`,
      );
    }
    // transform, pipe и preprocess — всё это pipe. send отправляет результат,
    // а схема Relay построена по входу.
    // Размер файла Relay не знает: у него предел на все файлы события.
    if (
      def.type === 'file' &&
      def.checks?.some((check) =>
        ['min_size', 'max_size'].includes(check._zod.def.check),
      )
    ) {
      warnings.push(
        `${path}: file size checks run only on the client; Relay limits all files of an event to 20 MB together.`,
      );
    }
    if (def.type === 'pipe') {
      warnings.push(
        `${path}: transform and pipe run only on the client: Relay receives the result and validates it against the input schema.`,
      );
      break;
    }
    current = def.innerType;
  }
  return warnings;
}
