import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { relaySchemaToZod, type RelaySchema } from './json-schema';
import { options, optionTitles } from './options';
import { zodToRelaySchema } from './zod-to-relay';

const plan = { pro: 'Тариф Про', basic: 'Базовый' } as const;

describe('options', () => {
  it('проверяет значения, подписи переживают .meta() и .optional()', () => {
    const schema = options(plan).meta({ title: 'Тариф' });
    expect(schema.parse('pro')).toBe('pro');
    expect(schema.safeParse('Тариф Про').success).toBe(false);
    expect(optionTitles(schema)).toEqual(plan);
    expectTypeOf(schema.parse('pro'));
  });

  it('в схеме Relay — oneOf из const и title, у списка — в items', () => {
    const { schema } = zodToRelaySchema(
      z.object({
        plan: options(plan).meta({ title: 'Тариф' }),
        extras: z.array(options({ tv: 'Телевидение', net: 'net' })).optional(),
        plain: z.enum(['a', 'b']),
        same: options({ a: 'a' }),
        at: z.iso.time(),
      }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          title: 'Тариф',
          oneOf: [
            { const: 'pro', title: 'Тариф Про' },
            { const: 'basic', title: 'Базовый' },
          ],
        },
        extras: {
          type: 'array',
          items: {
            type: 'string',
            oneOf: [{ const: 'tv', title: 'Телевидение' }, { const: 'net' }],
          },
        },
        plain: { type: 'string', enum: ['a', 'b'] },
        // Подписи совпадают со значениями — обычный enum.
        same: { type: 'string', enum: ['a'] },
        at: { type: 'string', format: 'time' },
      },
      required: ['plan', 'plain', 'same', 'at'],
    });
  });

  it('из схемы Relay — options() с теми же подписями, время — z.iso.time()', () => {
    const relay: RelaySchema = {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          oneOf: [{ const: 'pro', title: 'Тариф Про' }, { const: 'basic' }],
        },
        extras: {
          type: 'array',
          items: { type: 'string', oneOf: [{ const: 'tv', title: 'ТВ' }] },
        },
        at: { type: 'string', format: 'time' },
      },
      required: ['plan'],
    };
    const schema = relaySchemaToZod(relay);
    expect(optionTitles(schema.shape.plan as z.ZodType)).toEqual({
      pro: 'Тариф Про',
      basic: 'basic',
    });
    expect(schema.parse({ plan: 'pro', extras: ['tv'], at: '15:30' })).toEqual({
      plan: 'pro',
      extras: ['tv'],
      at: '15:30',
    });
    expect(schema.safeParse({ plan: 'Тариф Про' }).success).toBe(false);
    expect(schema.safeParse({ plan: 'pro', at: '25:00' }).success).toBe(false);
    const back = zodToRelaySchema(schema).schema.properties;
    expect(back.plan).toEqual(relay.properties.plan);
    expect(back.extras).toEqual(relay.properties.extras);
  });
});

// Тип значения options() — объединение ключей.
function expectTypeOf(value: 'pro' | 'basic'): void {
  void value;
}

describe('словарь: z.record(z.string(), z.string())', () => {
  it('в схеме Relay — object со строками, обратно — z.record', () => {
    const { schema } = zodToRelaySchema(
      z.object({
        meta: z
          .record(z.string(), z.string())
          .meta({ title: 'Метки' })
          .optional(),
        short: z.record(z.string(), z.string().max(50)),
      }),
    );
    expect(schema.properties).toEqual({
      meta: {
        type: 'object',
        title: 'Метки',
        additionalProperties: { type: 'string' },
      },
      short: {
        type: 'object',
        additionalProperties: { type: 'string', maxLength: 50 },
      },
    });
    const form = relaySchemaToZod(schema);
    expect(form.parse({ short: { utm_source: 'google' } })).toEqual({
      short: { utm_source: 'google' },
    });
    expect(form.safeParse({ short: { a: 'x'.repeat(51) } }).success).toBe(
      false,
    );
    expect(form.safeParse({ short: { a: 1 } }).success).toBe(false);
    expect(zodToRelaySchema(form).schema.properties).toEqual(schema.properties);
  });

  it('другие объекты — ошибка', () => {
    for (const field of [
      z.object({ a: z.string() }),
      z.record(z.string(), z.number()),
      z.record(z.string(), z.string().min(2)),
      z.record(z.enum(['a', 'b']), z.string()),
    ]) {
      expect(() => zodToRelaySchema(z.object({ meta: field }))).toThrow(
        'objects are supported only as z.record',
      );
    }
  });
});
