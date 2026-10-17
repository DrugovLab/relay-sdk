import { z } from 'zod';

// Символы, которые принимает сервер: цифры, «+» в начале, пробелы, скобки, дефисы.
const PHONE_CHARS = /^\+?[\d\s()-]+$/;

export const PHONE_MESSAGE = 'Invalid phone number.';

// Метка проверки phone(). Symbol.for: схему из relay.config.ts создаёт копия
// пакета из проекта, а переводит в схему Relay копия в CLI.
const PHONE_CHECK = Symbol.for('@drugovlab/relay-sdk/phone');

// Проверка до запроса: символы и число цифр (E.164 — до 15). Номер по правилам
// стран проверяет и приводит к E.164 сервер.
export function isPhoneLike(value: string): boolean {
  const trimmed = value.trim();
  if (!PHONE_CHARS.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

const phoneCheck = Object.assign((value: string) => isPhoneLike(value), {
  [PHONE_CHECK]: true,
});

// Проверка refine — та, что ставит phone(): на сервере её заменяет format: phone.
export function isPhoneCheck(fn: unknown): boolean {
  return typeof fn === 'function' && PHONE_CHECK in fn;
}

// Поле телефона. Номер уходит как введён, в Relay он хранится в E.164.
// В схеме Relay — format: 'phone'.
export function phone() {
  return z
    .string()
    .refine(phoneCheck, { message: PHONE_MESSAGE, params: { format: 'phone' } })
    .meta({ format: 'phone' });
}
