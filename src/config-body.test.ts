import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRelay, env } from './config';
import { buildConfigBody } from './config-body';
import { phone } from './phone';

const config = defineRelay({
  channels: {
    sales: { type: 'relay_telegram' },
    panelBot: { type: 'telegram' },
    own: {
      type: 'telegram',
      name: 'Свой бот',
      botToken: env('TG_TOKEN'),
      recipients: [
        { name: 'Анна', chatId: 1 },
        { chatId: 2, projectTopic: true },
      ],
    },
    mail: {
      type: 'email',
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'robot@example.com',
      pass: env('SMTP_PASS'),
      from: 'robot@example.com',
      to: ['sales@example.com'],
    },
    crm: {
      type: 'webhook',
      url: env('CRM_URL'),
      headers: { Authorization: env('CRM_TOKEN'), 'X-Env': 'prod' },
    },
  },
  events: {
    lead: {
      name: 'Заявка',
      schema: z.object({ name: z.string(), phone: phone() }),
      send: {
        sales: { defaultTemplate: '<b>{{name}}</b>' },
        crm: { template: '{"name": {{name}}}' },
        mail: true,
        'from-panel': true,
      },
    },
    ping: { name: 'Проверка', schema: z.object({}) },
  },
});

const ENV = {
  TG_TOKEN: '1:abc',
  SMTP_PASS: 'secret',
  CRM_URL: 'https://crm.example/hook',
  CRM_TOKEN: 'Bearer t',
};

describe('buildConfigBody', () => {
  it('тело PUT /api/v1/config: секреты из env; без токена в коде — токен из панели', () => {
    expect(buildConfigBody(config, ENV)).toEqual({
      warnings: [],
      body: {
        channels: {
          sales: { type: 'relay_telegram', config: {} },
          panelBot: { type: 'telegram', config: {} },
          own: {
            type: 'telegram',
            name: 'Свой бот',
            config: {
              botToken: '1:abc',
              recipients: [
                { name: 'Анна', chatId: 1 },
                { chatId: 2, projectTopic: true },
              ],
            },
          },
          mail: {
            type: 'email',
            config: {
              host: 'smtp.example.com',
              port: 465,
              secure: true,
              user: 'robot@example.com',
              pass: 'secret',
              from: 'robot@example.com',
              to: ['sales@example.com'],
            },
          },
          crm: {
            type: 'webhook',
            config: {
              url: 'https://crm.example/hook',
              headers: { Authorization: 'Bearer t', 'X-Env': 'prod' },
            },
          },
        },
        events: {
          lead: {
            name: 'Заявка',
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                phone: { type: 'string', format: 'phone' },
              },
              required: ['name', 'phone'],
            },
            send: {
              sales: { defaultTemplate: '<b>{{name}}</b>' },
              crm: { template: '{"name": {{name}}}' },
              mail: true,
              'from-panel': true,
            },
          },
          ping: {
            name: 'Проверка',
            schema: { type: 'object', properties: {} },
          },
        },
      },
    });
  });

  it('HTTP-запрос: секреты и авторизация из env, запрос маршрута как есть', () => {
    const request = {
      url: 'crm.lead.add.json',
      body: {
        format: 'form' as const,
        fields: [{ name: 'fields[NAME]', value: '{{name}}' }],
      },
    };
    const http = defineRelay({
      channels: {
        bitrix: {
          type: 'http',
          baseUrl: 'https://x.bitrix24.ru/rest/1/{{secret.token}}',
          secrets: { token: env('BITRIX_TOKEN'), source: 'site' },
        },
        api: {
          type: 'http',
          baseUrl: 'https://api.example',
          method: 'PUT',
          auth: { type: 'basic', user: 'robot', password: env('API_PASS') },
          headers: [{ name: 'X-Source', value: '{{secret.source}}' }],
        },
        bearer: {
          type: 'http',
          auth: { type: 'bearer', token: env('API_TOKEN') },
        },
      },
      events: {
        lead: {
          name: 'Заявка',
          schema: z.object({ name: z.string() }),
          send: { bitrix: { request }, api: true },
        },
      },
    });
    const { body } = buildConfigBody(http, {
      BITRIX_TOKEN: 'abc',
      API_PASS: 'pass',
      API_TOKEN: 'tok',
    });
    expect(body.channels).toEqual({
      bitrix: {
        type: 'http',
        config: {
          baseUrl: 'https://x.bitrix24.ru/rest/1/{{secret.token}}',
          secrets: { token: 'abc', source: 'site' },
        },
      },
      api: {
        type: 'http',
        config: {
          baseUrl: 'https://api.example',
          method: 'PUT',
          auth: { type: 'basic', user: 'robot', password: 'pass' },
          headers: [{ name: 'X-Source', value: '{{secret.source}}' }],
        },
      },
      bearer: {
        type: 'http',
        config: { auth: { type: 'bearer', token: 'tok' } },
      },
    });
    expect(body.events.lead.send).toEqual({ bitrix: { request }, api: true });

    expect(() => buildConfigBody(http, {})).toThrow(
      'Missing environment variables: BITRIX_TOKEN, API_PASS, API_TOKEN.',
    );
  });

  it('нет переменных окружения — одна ошибка со всеми именами', () => {
    expect(() => buildConfigBody(config, { TG_TOKEN: '1:abc' })).toThrow(
      'Missing environment variables: SMTP_PASS, CRM_URL, CRM_TOKEN.',
    );
  });
});
