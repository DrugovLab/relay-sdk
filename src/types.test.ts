// Проверки типов: их выполняет tsc (pnpm typecheck). @ts-expect-error —
// строка, которая не должна компилироваться.
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createRelay, type SendResult } from './client';
import { defineRelay, env } from './config';
import type { FieldErrors } from './errors';
import { phone } from './phone';

const lead = z.object({
  name: z.string(),
  phone: phone(),
  comment: z.string().optional(),
  source: z.string().default('site'),
});

const config = defineRelay({
  channels: {
    sales: { type: 'telegram' },
    crm: { type: 'webhook', url: env('CRM_URL') },
  },
  events: {
    lead: {
      name: 'Заявка',
      schema: lead,
      send: { sales: true, crm: { template: '{}' }, 'from-panel': true },
    },
    ping: { name: 'Проверка', schema: z.object({ at: z.iso.datetime() }) },
  },
});

type LeadInput = {
  name: string;
  phone: string;
  comment?: string | undefined;
  source?: string | undefined;
};

describe('типы', () => {
  it('сервер с конфигурацией: данные из схем, схема события, push', () => {
    const relay = createRelay({ secretKey: 'sk', config });
    expectTypeOf(relay.events.lead.send)
      .parameter(0)
      .toEqualTypeOf<LeadInput>();
    expectTypeOf(relay.events.lead.schema).toEqualTypeOf<typeof lead>();
    expectTypeOf(relay.events.ping.send)
      .parameter(0)
      .toEqualTypeOf<{ at: string }>();
    expectTypeOf(relay.push).toBeFunction();
    expectTypeOf(
      relay.events.lead.safeSend,
    ).returns.resolves.toEqualTypeOf<SendResult>();
    // @ts-expect-error — такого события нет в конфигурации
    void relay.events.order;
  });

  it('фронтенд: только тип конфигурации, без push и без схем', () => {
    const relay = createRelay<typeof config>({ publicKey: 'pk' });
    expectTypeOf(relay.events.lead.send)
      .parameter(0)
      .toEqualTypeOf<LeadInput>();
    expectTypeOf(relay.events.lead.schema).toEqualTypeOf<undefined>();
    // @ts-expect-error — push только у сервера с конфигурацией
    void relay.push;
  });

  it('свои схемы и явные типы', () => {
    const withSchemas = createRelay({ publicKey: 'pk', schemas: { lead } });
    expectTypeOf(withSchemas.events.lead.send)
      .parameter(0)
      .toEqualTypeOf<LeadInput>();
    // Не вызывается: строка проверяется только компилятором.
    // @ts-expect-error — данных не хватает
    void (() => withSchemas.events.lead.send({ name: 'Иван' }));

    const explicit = createRelay<{ order: { total: number } }>({
      publicKey: 'pk',
    });
    expectTypeOf(explicit.events.order.send)
      .parameter(0)
      .toEqualTypeOf<{ total: number }>();

    interface Events {
      order: { total: number };
    }
    const fromInterface = createRelay<Events>({ publicKey: 'pk' });
    expectTypeOf(fromInterface.events.order.send)
      .parameter(0)
      .toEqualTypeOf<{ total: number }>();

    const notObject = createRelay<{ order: string }>({ publicKey: 'pk' });
    // @ts-expect-error — данные события — объект
    void (() => notObject.events.order.send('строка'));
  });

  it('конфигурация: ключи, каналы и маршруты проверяются', () => {
    // @ts-expect-error — конфигурацию применяет только секретный ключ
    createRelay({ publicKey: 'pk', config });

    defineRelay({
      channels: {
        // Адрес и токен не в коде — хранятся в панели.
        crm: { type: 'webhook' },
        bot: { type: 'telegram' },
        relay: { type: 'relay_telegram' },
      },
      events: {},
    });
    defineRelay({
      // @ts-expect-error — у почты secure обязателен
      channels: { mail: { type: 'email', host: 'h', port: 465, from: 'a@b' } },
      events: {},
    });
    defineRelay({
      // @ts-expect-error — у бота Relay токена нет
      channels: { relay: { type: 'relay_telegram', botToken: '1:a' } },
      events: {},
    });

    defineRelay({
      events: {
        // @ts-expect-error — схема события — объект zod
        lead: { name: 'Заявка', schema: z.string() },
      },
    });

    defineRelay({
      events: {
        lead: {
          name: 'Заявка',
          schema: lead,
          // @ts-expect-error — template и defaultTemplate вместе нельзя
          send: { sales: { template: 'a', defaultTemplate: 'b' } },
        },
      },
    });

    defineRelay({
      channels: {
        tg: {
          type: 'telegram',
          // @ts-expect-error — у получателя с темой проекта не задаётся threadId
          recipients: [{ chatId: 1, projectTopic: true, threadId: 5 }],
        },
      },
      events: {},
    });
  });

  it('kind сужает ошибку safeSend до класса', () => {
    const check = (result: SendResult) => {
      if (!result.ok && result.error.kind === 'validation') {
        expectTypeOf(result.error.fields).toEqualTypeOf<FieldErrors>();
      }
      if (!result.ok && result.error.kind === 'rate_limit') {
        expectTypeOf(result.error.retryAfter).toEqualTypeOf<
          number | undefined
        >();
      }
    };
    void check;
  });
});
