import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { afterAll, describe, expect, it } from 'vitest';
import { configSource, PACKAGE_NAME } from './codegen';
import { buildConfigBody, type ConfigBody } from './config-body';
import { isRelayConfig, type HttpRouteRequest } from './config';

// Сгенерированный файл кладётся внутрь проекта: zod берётся из node_modules.
const dir = mkdtempSync(join(__dirname, 'cli', '__fixtures__', 'pull-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function load(source: string) {
  const path = join(
    dir,
    `relay.config.${Math.random().toString(36).slice(2)}.ts`,
  );
  writeFileSync(path, source);
  const jiti = createJiti(pathToFileURL(path).href, {
    alias: { [PACKAGE_NAME]: resolve(__dirname, 'index.ts') },
  });
  const module = await jiti.import<{ default: unknown }>(path);
  if (!isRelayConfig(module.default)) throw new Error('не defineRelay');
  return module.default;
}

// Выгрузка сервера: секреты и адрес вебхука — null.
const exported: ConfigBody = {
  channels: {
    sales: {
      type: 'relay_telegram',
      name: 'Продажи',
      config: { recipients: [{ chatId: '-100', projectTopic: true }] },
    },
    bot: {
      type: 'telegram',
      name: 'bot',
      config: { botToken: null, recipients: [{ chatId: '1', threadId: 7 }] },
    },
    mail: {
      type: 'email',
      name: 'Почта',
      config: {
        host: 'smtp.example',
        port: 465,
        secure: true,
        user: 'robot',
        pass: null,
        from: 'robot@example.ru',
        to: ['a@example.ru'],
      },
    },
    crm: {
      type: 'webhook',
      name: 'CRM',
      config: {
        url: null,
        method: 'POST',
        headers: { 'X-Api-Key': null },
      },
    },
  },
  events: {
    lead: {
      name: "Заявка 'с сайта'",
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', title: 'Имя', minLength: 1, maxLength: 100 },
          phone: { type: 'string', format: 'phone' },
          email: { type: 'string', format: 'email' },
          site: { type: 'string', format: 'uri' },
          day: { type: 'string', format: 'date' },
          at: { type: 'string', format: 'date-time' },
          code: { type: 'string', pattern: '^\\d{4}$' },
          work: { type: 'string', format: 'email', pattern: '@example\\.ru$' },
          link: { type: 'string', pattern: '^https?://\\w' },
          promo: { type: 'string', pattern: '(?i)^promo-\\d+$' },
          services: {
            type: 'array',
            items: { type: 'string', enum: ['Доставка', "Сборка 'под ключ'"] },
            minItems: 1,
            maxItems: 2,
          },
          weight: {
            type: 'number',
            exclusiveMinimum: 0.5,
            exclusiveMaximum: 50,
          },
          level: { type: 'integer', enum: [1, 2, 3], title: 'Уровень' },
          size: { type: 'number', enum: [0.5, 1] },
          backup: { type: 'string', format: 'phone', default: '+79991234567' },
          kind: { type: 'string', enum: ['a', 'b'] },
          count: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
          price: { type: 'number', minimum: 0 },
          consent: { type: 'boolean', const: true },
          news: { type: 'boolean' },
          utm_source: { type: 'string' },
        },
        required: ['name', 'phone', 'consent'],
      },
      send: {
        sales: { defaultTemplate: 'Заявка\n{{name}}' },
        crm: { template: '{"name": {{name}}}' },
        mail: true,
      },
    },
    ping: { name: 'Пинг', schema: { type: 'object', properties: {} } },
    // Каналы типа задаёт код, и их нет: send {} остаётся в коде.
    silent: {
      name: 'Без каналов',
      schema: { type: 'object', properties: {} },
      send: {},
    },
  },
};

describe('configSource', () => {
  it('сгенерированный код даёт ту же конфигурацию; секреты, адрес и заголовки вебхука — в панели', async () => {
    const { source, keptInPanel } = configSource(exported);
    expect(keptInPanel).toEqual([
      'channels.bot.botToken',
      'channels.mail.pass',
      'channels.crm.url',
      'channels.crm.headers',
    ]);
    expect(source).toContain(
      `import { defineRelay, phone } from '${PACKAGE_NAME}';`,
    );
    expect(source).not.toContain('null');

    const config = await load(source);
    const { body, warnings } = buildConfigBody(config, {});
    expect(warnings).toEqual([]);
    expect(body.events).toEqual(exported.events);
    // То, что пришло null, не отправляется: сервер оставляет сохранённое.
    expect(body.channels).toEqual({
      sales: exported.channels.sales,
      // Имя, равное ключу, в код не пишется.
      bot: {
        type: 'telegram',
        config: { recipients: [{ chatId: '1', threadId: 7 }] },
      },
      mail: {
        type: 'email',
        name: 'Почта',
        config: {
          host: 'smtp.example',
          port: 465,
          secure: true,
          user: 'robot',
          from: 'robot@example.ru',
          to: ['a@example.ru'],
        },
      },
      crm: { type: 'webhook', name: 'CRM', config: { method: 'POST' } },
    });
  });

  it('HTTP-запрос: секреты и авторизация — в панели, запрос маршрута — в коде', async () => {
    const request: HttpRouteRequest = {
      method: 'POST',
      url: 'crm.lead.add.json',
      query: [{ name: 'source', value: 'site' }],
      body: {
        format: 'form',
        fields: [{ name: 'fields[NAME]', value: '{{name}}' }],
      },
      retry: { network: true, status: '500-599', maxAttempts: 3 },
    };
    const http: ConfigBody = {
      channels: {
        bitrix: {
          type: 'http',
          name: 'Битрикс24',
          config: {
            baseUrl: 'https://x.bitrix24.ru/rest/1/{{secret.token}}',
            headers: [{ name: 'X-Source', value: 'relay' }],
            secrets: { token: null },
            timeoutSec: 10,
          },
        },
        api: {
          type: 'http',
          name: 'api',
          config: {
            baseUrl: 'https://api.example',
            auth: { type: 'basic', user: 'robot', password: null },
            success: {
              status: '200',
              body: { check: 'contains', value: 'ok' },
            },
          },
        },
      },
      events: {
        lead: {
          name: 'Заявка',
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
          send: { bitrix: { request }, api: true },
        },
      },
    };
    const { source, keptInPanel } = configSource(http);
    expect(keptInPanel).toEqual([
      'channels.bitrix.secrets',
      'channels.api.auth',
    ]);
    expect(source).not.toContain('null');

    const config = await load(source);
    const { body } = buildConfigBody(config, {});
    expect(body.events).toEqual(http.events);
    expect(body.channels).toEqual({
      bitrix: {
        type: 'http',
        name: 'Битрикс24',
        config: {
          baseUrl: 'https://x.bitrix24.ru/rest/1/{{secret.token}}',
          headers: [{ name: 'X-Source', value: 'relay' }],
          timeoutSec: 10,
        },
      },
      api: {
        type: 'http',
        config: {
          baseUrl: 'https://api.example',
          success: {
            status: '200',
            body: { check: 'contains', value: 'ok' },
          },
        },
      },
    });
  });

  it('без каналов и телефона — только defineRelay', async () => {
    const { source, keptInPanel } = configSource({
      channels: {},
      events: { ping: exported.events.ping },
    });
    expect(keptInPanel).toEqual([]);
    expect(source).toBe(
      [
        '// Generated from Relay by relay pull.',
        `import { defineRelay } from '${PACKAGE_NAME}';`,
        "import { z } from 'zod';",
        '',
        'export default defineRelay({',
        '  events: {',
        '    ping: {',
        "      name: 'Пинг',",
        '      schema: z.object({}),',
        '    },',
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    const config = await load(source);
    expect(buildConfigBody(config, {}).body.events.ping).toEqual(
      exported.events.ping,
    );
  });

  it('то, что в коде выглядит иначе, — в заметках', () => {
    const { notes } = configSource({
      channels: {},
      events: {
        lead: {
          name: 'Заявка',
          schema: {
            type: 'object',
            properties: {
              count: { type: 'integer', default: 1 },
              kind: { type: 'string', enum: ['a'], minLength: 1 },
              flag: { type: 'boolean', enum: [true] },
            },
            required: ['count'],
          },
        },
      },
    });
    expect(notes).toEqual([
      'events.lead.schema.count: required with a default value: in code it is .default(); push will report the field as changed, validation is the same.',
      'events.lead.schema.kind: in code only the list of values, without minLength.',
      'events.lead.schema.flag: in code only the list of values, without the boolean type.',
    ]);
  });

  it('шаблон RE2, которого нет в JavaScript, — ошибка с путём', () => {
    expect(() =>
      configSource({
        channels: {},
        events: {
          lead: {
            name: 'Заявка',
            schema: {
              type: 'object',
              properties: { code: { type: 'string', pattern: 'a(?i)bc' } },
            },
          },
        },
      }),
    ).toThrow(
      'events.lead.schema.code: pattern "a(?i)bc" is not valid JavaScript',
    );
  });
});

describe('configSource: подписи вариантов и время', () => {
  it('oneOf с подписями — options(), время — z.iso.time(), push даёт то же', async () => {
    const events: ConfigBody['events'] = {
      plan: {
        name: 'Тариф',
        schema: {
          type: 'object',
          properties: {
            plan: {
              type: 'string',
              title: 'Тариф',
              oneOf: [
                { const: 'pro', title: 'Тариф «Про»' },
                { const: 'basic' },
              ],
            },
            extras: {
              type: 'array',
              items: { type: 'string', oneOf: [{ const: 'tv', title: 'ТВ' }] },
            },
            at: { type: 'string', format: 'time' },
          },
          required: ['plan'],
        },
      },
    };
    const { source } = configSource({ channels: {}, events });
    expect(source).toContain(
      `import { defineRelay, options } from '${PACKAGE_NAME}';`,
    );
    expect(source).toContain(
      "plan: options({ pro: 'Тариф «Про»', basic: 'basic' }).meta({ title: 'Тариф' }),",
    );
    expect(source).toContain(
      "extras: z.array(options({ tv: 'ТВ' })).optional(),",
    );
    expect(source).toContain('at: z.iso.time().optional(),');
    const config = await load(source);
    expect(buildConfigBody(config, {}).body.events).toEqual(events);
  });
});

describe('configSource: словарь', () => {
  it('object со строками — z.record, push даёт то же', async () => {
    const events: ConfigBody['events'] = {
      lead: {
        name: 'Заявка',
        schema: {
          type: 'object',
          properties: {
            meta: {
              type: 'object',
              title: 'Метки',
              additionalProperties: { type: 'string', maxLength: 200 },
            },
          },
        },
      },
    };
    const { source } = configSource({ channels: {}, events });
    expect(source).toContain(
      "meta: z.record(z.string(), z.string().max(200)).meta({ title: 'Метки' }).optional(),",
    );
    const config = await load(source);
    expect(buildConfigBody(config, {}).body.events).toEqual(events);
  });
});

describe('configSource: файлы', () => {
  it('файл — file(), список — z.array(file()), push даёт то же', async () => {
    const events: ConfigBody['events'] = {
      job: {
        name: 'Отклик',
        schema: {
          type: 'object',
          properties: {
            resume: {
              type: 'string',
              format: 'binary',
              title: 'Резюме',
              contentMediaType: 'application/pdf',
            },
            photos: {
              type: 'array',
              items: { type: 'string', format: 'binary' },
              maxItems: 3,
            },
          },
          required: ['resume'],
        },
      },
    };
    const { source } = configSource({ channels: {}, events });
    expect(source).toContain(
      `import { defineRelay, file } from '${PACKAGE_NAME}';`,
    );
    expect(source).toContain(
      "resume: file('application/pdf').meta({ title: 'Резюме' }),",
    );
    expect(source).toContain('photos: z.array(file()).max(3).optional(),');
    const config = await load(source);
    expect(buildConfigBody(config, {}).body.events).toEqual(events);
  });
});
