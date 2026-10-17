import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { afterAll, describe, expect, it } from 'vitest';
import { configSource, PACKAGE_NAME } from './codegen';
import { buildConfigBody, type ConfigBody } from './config-body';
import { isRelayConfig } from './config';

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
