import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RelayConfigError } from './errors';
import { phone } from './phone';
import { zodToRelaySchema } from './zod-to-relay';

describe('zodToRelaySchema', () => {
  it('поля из таблицы SPEC; порядок полей сохраняется', () => {
    const { schema, warnings } = zodToRelaySchema(
      z.object({
        name: z.string().min(1).max(100).meta({ title: 'Имя' }),
        email: z.email().optional(),
        site: z.url(),
        date: z.iso.date(),
        at: z.iso.datetime({ local: true, offset: true }),
        phone: phone(),
        qty: z.int().min(1).max(10),
        positive: z.int().positive(),
        price: z.number().min(0),
        plan: z.enum(['basic', 'pro']),
        consent: z.literal(true),
        news: z.boolean().default(false),
        code: z.string().regex(/^[A-Z]{3}$/),
      }),
    );
    expect(warnings).toEqual([]);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100, title: 'Имя' },
        email: { type: 'string', format: 'email' },
        site: { type: 'string', format: 'uri' },
        date: { type: 'string', format: 'date' },
        at: { type: 'string', format: 'date-time' },
        phone: { type: 'string', format: 'phone' },
        qty: { type: 'integer', minimum: 1, maximum: 10 },
        positive: { type: 'integer', exclusiveMinimum: 0 },
        price: { type: 'number', minimum: 0 },
        plan: { type: 'string', enum: ['basic', 'pro'] },
        consent: { type: 'boolean', const: true },
        news: { type: 'boolean', default: false },
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
      },
      required: [
        'name',
        'site',
        'date',
        'at',
        'phone',
        'qty',
        'positive',
        'price',
        'plan',
        'consent',
        'code',
      ],
    });
    expect(Object.keys(schema.properties)[0]).toBe('name');
  });

  it('необязательный телефон — тоже формат phone', () => {
    const { schema } = zodToRelaySchema(
      z.object({ phone: phone().optional() }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: { phone: { type: 'string', format: 'phone' } },
    });
  });

  it.each([
    [z.object({ a: z.object({ b: z.string() }) }), 'nested objects'],
    [z.object({ a: z.array(z.string()) }), 'arrays are supported only'],
    [z.object({ a: z.string().nullable() }), 'null and union'],
    [z.object({ a: z.uuid() }), 'format "uuid"'],
    [z.object({ a: z.number().multipleOf(5) }), '"multipleOf"'],
    [z.object({ a: z.literal('x') }), 'only z.literal(true)'],
    [z.object({ a: z.date() }), 'events.lead.schema.a'],
  ])('%# неподдерживаемое — ошибка с путём к полю', (schema, text) => {
    expect(() => zodToRelaySchema(schema, 'events.lead.schema')).toThrow(
      RelayConfigError,
    );
    expect(() => zodToRelaySchema(schema, 'events.lead.schema')).toThrow(text);
  });

  it('refine, transform, pipe и preprocess — предупреждения, phone() — нет', () => {
    const { warnings } = zodToRelaySchema(
      z
        .object({
          password: z.string().refine((value) => value.length > 8),
          slug: z.string().transform((value) => value.toLowerCase()),
          count: z.string().pipe(z.coerce.number()),
          name: z.preprocess((value) => value, z.string()),
          phone: phone(),
        })
        .refine((data) => data.slug !== data.name),
    );
    const pipe =
      'transform and pipe run only on the client: Relay receives the result and validates it against the input schema.';
    expect(warnings).toEqual([
      'schema.password: refine runs only on the client; Relay does not know it.',
      `schema.slug: ${pipe}`,
      `schema.count: ${pipe}`,
      `schema.name: ${pipe}`,
      'schema: object-level refine runs only on the client; Relay does not know it.',
    ]);
  });

  it('preprocess: проверки внутренней схемы переносятся; свой refine у phone() — предупреждение', () => {
    const { schema, warnings } = zodToRelaySchema(
      z.object({
        code: z.preprocess((value) => value, z.string().regex(/^\d+$/)),
        ru: phone().refine((value) => value.startsWith('+7')),
      }),
    );
    expect(schema.properties.code).toEqual({
      type: 'string',
      pattern: '^\\d+$',
    });
    expect(schema.properties.ru).toEqual({ type: 'string', format: 'phone' });
    expect(warnings).toEqual([
      'schema.code: transform and pipe run only on the client: Relay receives the result and validates it against the input schema.',
      'schema.ru: refine runs only on the client; Relay does not know it.',
    ]);
  });

  it('шаблон: формат со своим regex, «/» без экранирования, флаги — в начале шаблона, v и два шаблона — ошибка', () => {
    const { schema } = zodToRelaySchema(
      z.object({
        email: z.email().regex(/@example\.ru$/),
        site: z.string().regex(/^https?:\/\/\w/),
        escaped: z.string().regex(/a\\\/b/),
        promo: z.string().regex(/^promo-\d+$/gi),
        text: z.string().regex(/^a.b$/ms),
      }),
    );
    expect(schema.properties).toEqual({
      email: { type: 'string', format: 'email', pattern: '@example\\.ru$' },
      site: { type: 'string', pattern: '^https?://\\w' },
      escaped: { type: 'string', pattern: 'a\\\\/b' },
      promo: { type: 'string', pattern: '(?i)^promo-\\d+$' },
      text: { type: 'string', pattern: '(?ms)^a.b$' },
    });
    expect(() =>
      zodToRelaySchema(
        z.object({ code: z.string().regex(new RegExp('[a]', 'v')) }),
      ),
    ).toThrow('schema.code: regex flag v is not supported');
    expect(() =>
      zodToRelaySchema(
        z.object({ code: z.string().startsWith('A').regex(/\d$/) }),
      ),
    ).toThrow('schema.code: a field has one pattern in Relay');
  });

  it('startsWith и regex — шаблон, а не формат', () => {
    const { schema } = zodToRelaySchema(
      z.object({ code: z.string().startsWith('A-') }),
    );
    expect(schema.properties.code).toEqual({
      type: 'string',
      pattern: '^A-.*',
    });
  });
});

describe('пометки в .meta()', () => {
  it('placeholder, examples и id не мешают; проверки JSON Schema без Relay — ошибка', () => {
    const { schema } = zodToRelaySchema(
      z.object({
        name: z
          .string()
          .min(2)
          .meta({ title: 'Имя', placeholder: 'Иван', examples: ['Анна'] }),
        nick: z.string().max(5).meta({ id: 'Nick', title: 'Ник' }).optional(),
      }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2, title: 'Имя' },
        nick: { type: 'string', maxLength: 5, title: 'Ник' },
      },
      required: ['name'],
    });
    expect(() =>
      zodToRelaySchema(z.object({ n: z.number().multipleOf(5) })),
    ).toThrow('schema.n: "multipleOf" is not supported in Relay schemas.');
  });
});

describe('строгие границы и несколько из списка', () => {
  it('gt и lt — exclusiveMinimum и exclusiveMaximum, у дробных тоже', () => {
    const { schema } = zodToRelaySchema(
      z.object({
        price: z.number().gt(0.5).lt(99.9),
        count: z.int().gt(5),
      }),
    );
    expect(schema.properties).toEqual({
      price: { type: 'number', exclusiveMinimum: 0.5, exclusiveMaximum: 99.9 },
      count: { type: 'integer', exclusiveMinimum: 5 },
    });
  });

  it('z.array(z.enum) — массив значений из списка с min и max', () => {
    const { schema } = zodToRelaySchema(
      z.object({
        services: z
          .array(z.enum(['Доставка', 'Сборка']))
          .min(1)
          .max(2)
          .meta({ title: 'Услуги' }),
        extra: z.array(z.enum(['a'])).default(['a']),
      }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: { type: 'string', enum: ['Доставка', 'Сборка'] },
          minItems: 1,
          maxItems: 2,
          title: 'Услуги',
        },
        extra: {
          type: 'array',
          items: { type: 'string', enum: ['a'] },
          default: ['a'],
        },
      },
      required: ['services'],
    });
  });
});
