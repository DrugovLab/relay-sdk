import { describe, expect, it } from 'vitest';
import { relaySchemaToZod, type RelaySchema } from './json-schema';
import { isPhoneLike } from './phone';

const schema: RelaySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Имя', minLength: 2, maxLength: 5 },
    email: { type: 'string', format: 'email' },
    site: { type: 'string', format: 'uri' },
    date: { type: 'string', format: 'date' },
    at: { type: 'string', format: 'date-time' },
    code: { type: 'string', pattern: '^[A-Z]{3}$' },
    plan: { type: 'string', enum: ['basic', 'pro'] },
    level: { type: 'integer', enum: [1, 2] },
    qty: { type: 'integer', minimum: 1, maximum: 10 },
    price: { type: 'number' },
    consent: { type: 'boolean', const: true },
    news: { type: 'boolean', default: false },
    source: { type: 'string', default: 'site' },
  },
  required: ['name', 'consent', 'source'],
};
const zod = relaySchemaToZod(schema);
const valid = { name: 'Анна', consent: true };

describe('relaySchemaToZod', () => {
  it('обязательные, необязательные и значения по умолчанию', () => {
    expect(zod.parse(valid)).toEqual({ ...valid, news: false, source: 'site' });
    expect(zod.safeParse({ name: 'Анна' }).success).toBe(false);
    expect(zod.safeParse({ ...valid, consent: false }).success).toBe(false);
  });

  it.each([
    ['name', 'А'],
    ['name', 'Анастасия'],
    ['email', 'не почта'],
    ['site', 'не адрес'],
    ['date', '07.10.2026'],
    ['at', '2026-10-07'],
    ['code', 'abc'],
    ['plan', 'free'],
    ['level', 3],
    ['qty', 1.5],
    ['qty', 11],
    ['price', '5'],
  ])('%s = %j не проходит', (field, value) => {
    expect(zod.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it.each([
    ['email', 'a@example.com'],
    ['site', 'https://site.ru/page'],
    ['date', '2026-10-07'],
    ['at', '2026-10-07T12:00'],
    ['at', '2026-10-07T12:00:00+03:00'],
    ['code', 'ABC'],
    ['plan', 'pro'],
    ['level', 2],
    ['qty', 10],
  ])('%s = %j проходит', (field, value) => {
    expect(zod.safeParse({ ...valid, [field]: value }).success).toBe(true);
  });

  it('неизвестные поля отбрасываются, как на сервере', () => {
    expect(zod.parse({ ...valid, extra: 1 })).not.toHaveProperty('extra');
  });

  it('несколько из списка и строгие границы', () => {
    const form = relaySchemaToZod({
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: { type: 'string', enum: ['a', 'b'] },
          minItems: 1,
          maxItems: 2,
        },
        weight: { type: 'number', exclusiveMinimum: 0.5 },
      },
      required: ['services'],
    });
    expect(form.safeParse({ services: ['a', 'b'], weight: 0.6 }).success).toBe(
      true,
    );
    for (const data of [
      { services: [] },
      { services: ['c'] },
      { services: ['a', 'b', 'a'] },
      { services: ['a'], weight: 0.5 },
    ]) {
      expect(form.safeParse(data).success).toBe(false);
    }
  });

  it('(?i) в начале шаблона — флаг; RE2, которого нет в JavaScript, форма не проверяет', () => {
    const form = relaySchemaToZod({
      type: 'object',
      properties: {
        promo: { type: 'string', pattern: '(?i)^promo-\\d+$' },
        code: { type: 'string', pattern: 'a(?i)bc' },
      },
    });
    expect(form.safeParse({ promo: 'PROMO-1', code: 'aBC' }).success).toBe(
      true,
    );
    expect(form.safeParse({ promo: 'x', code: 'aBC' }).success).toBe(false);
  });
});

describe('isPhoneLike — символы сервера и 7–15 цифр', () => {
  it.each([
    '+7 (999) 123-45-67',
    '8 (495) 123-45-67',
    ' 9991234567 ',
    '4580300963',
    '+1 202 555 0143',
    '1234567',
    '123456789012345',
  ])('принимает %j', (input) => {
    expect(isPhoneLike(input)).toBe(true);
  });

  it.each([
    '123456',
    '1234567890123456',
    '+7 999 abc',
    '++79991234567',
    '8.999.123.45.67',
    '7+9991234567',
    '',
  ])('отклоняет %j', (input) => {
    expect(isPhoneLike(input)).toBe(false);
  });
});
