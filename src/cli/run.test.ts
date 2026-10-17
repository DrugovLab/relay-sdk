import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from './run';

const project = resolve(__dirname, '__fixtures__/project');

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

async function run(
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    fetch?: typeof fetch;
  } = {},
) {
  const output: string[] = [];
  const code = await runCli(argv, {
    cwd: options.cwd ?? project,
    env: options.env ?? { RELAY_SECRET_KEY: 'sk_1' },
    write: (text) => output.push(text),
    error: (text) => output.push(text),
    fetch: options.fetch,
  });
  return { code, output: output.join('\n') };
}

const changes = [
  { kind: 'channel', key: 'crm', action: 'create', details: [], breaking: [] },
  {
    kind: 'event',
    key: 'lead',
    action: 'update',
    details: ['название'],
    breaking: ['новое обязательное поле password'],
  },
];

describe('relay push', () => {
  it('загружает relay.config.ts с импортами без расширений и алиасами tsconfig', async () => {
    const fetch = fakeFetch(200, { applied: false, changes });
    const { code, output } = await run(
      ['push', '--dry-run', '--env-file', 'fixture.env'],
      { fetch },
    );
    expect(code).toBe(0);
    expect(output).toBe(
      [
        'Dry run, nothing applied. Changes: 2.',
        '  + channel crm — created',
        '  ~ event type lead — updated: название',
        '    ! breaking: новое обязательное поле password',
        '',
        'Warnings:',
        '  events.lead.schema.password: refine runs only on the client; Relay does not know it.',
      ].join('\n'),
    );
    const [url, init] = fetch.mock.calls[0];
    // RELAY_URL и CRM_URL — из файла переменных.
    expect(String(url)).toBe('https://relay.example/api/v1/config?dryRun=true');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer sk_1' });
    expect(JSON.parse(init?.body as string).channels.crm.config.url).toBe(
      'https://crm.example/from-file',
    );
  });

  it('окружение главнее файла переменных', async () => {
    const fetch = fakeFetch(200, { applied: true, changes: [] });
    const { output } = await run(['push', '--env-file', 'fixture.env'], {
      env: { RELAY_SECRET_KEY: 'sk_1', CRM_URL: 'https://crm.example/env' },
      fetch,
    });
    expect(output.split('\n')[0]).toBe('No changes.');
    expect(
      JSON.parse(fetch.mock.calls[0][1]?.body as string).channels.crm.config
        .url,
    ).toBe('https://crm.example/env');
  });

  it('process.env.X в relay.config.ts видит переменную из .env', async () => {
    // Временная конфигурация рядом с фикстурой: импорт SDK — по пути.
    const dir = mkdtempSync(join(project, 'process-env-'));
    writeFileSync(
      join(dir, 'relay.config.ts'),
      [
        "import { defineRelay } from '../../../../index';",
        'export default defineRelay({',
        "  channels: { crm: { type: 'webhook', url: process.env.PROCESS_URL } },",
        '  events: {},',
        '});',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, '.env'),
      'PROCESS_URL=https://crm.example/dotenv\n',
    );
    vi.stubEnv('RELAY_SECRET_KEY', 'sk_1');
    try {
      const fetch = fakeFetch(200, { applied: true, changes: [] });
      const { code } = await run(['push'], {
        cwd: dir,
        env: process.env,
        fetch,
      });
      expect(code).toBe(0);
      expect(
        JSON.parse(fetch.mock.calls[0][1]?.body as string).channels.crm.config
          .url,
      ).toBe('https://crm.example/dotenv');
    } finally {
      vi.unstubAllEnvs();
      delete process.env.PROCESS_URL;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.env в текущей папке читается без флага', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'relay-cli-'));
    writeFileSync(
      join(cwd, '.env'),
      'RELAY_SECRET_KEY=sk_env\nCRM_URL=https://x.example\n',
    );
    const fetch = fakeFetch(200, { applied: true, changes: [] });
    const { code } = await run(
      ['push', '--config', join(project, 'relay.config.ts')],
      { cwd, env: {}, fetch },
    );
    expect(code).toBe(0);
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      authorization: 'Bearer sk_env',
    });
  });

  it('ошибка сервера с путями — код 1 и поля', async () => {
    const { code, output } = await run(['push', '--env-file', 'fixture.env'], {
      fetch: fakeFetch(400, {
        error: 'unknown_channel',
        message: 'Канал crm в проекте не найден.',
        errors: {
          'events.lead.send.crm': {
            code: 'unknown_channel',
            message: 'Канал crm в проекте не найден.',
          },
        },
      }),
    });
    expect(code).toBe(1);
    expect(output).toBe(
      'Канал crm в проекте не найден.\n  events.lead.send.crm: Канал crm в проекте не найден.',
    );
  });

  it.each([
    [['push'], { env: {} }, 'RELAY_SECRET_KEY is not set'],
    [['push', '--config', 'нет.ts'], {}, 'Config file нет.ts not found.'],
    [
      ['push', '--env-file', 'fixture.env'],
      { cwd: tmpdir() },
      'File fixture.env not found.',
    ],
    [['deploy'], {}, 'Unknown command: deploy.'],
    [['push', '--force'], {}, 'Flag --force does not apply to relay push.'],
    [['push', '--bogus'], {}, "Unknown option '--bogus'"],
  ])('%j — код 1 и понятная ошибка', async (argv, options, text) => {
    const { code, output } = await run(argv, options);
    expect(code).toBe(1);
    expect(output).toContain(text);
  });

  it('без команды — подсказка и код 1, --help — код 0', async () => {
    expect((await run([])).code).toBe(1);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.output).toContain('relay push [--dry-run]');
    expect(help.output).toContain('relay pull [--out <path>]');
  });
});

const exported = {
  channels: {
    crm: { type: 'webhook', name: 'CRM', config: { url: null } },
  },
  events: {
    ping: { name: 'Пинг', schema: { type: 'object', properties: {} } },
  },
};

describe('relay pull', () => {
  it('записывает relay.config.ts и называет то, что осталось в панели', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'relay-pull-'));
    const fetch = fakeFetch(200, exported);
    const { code, output } = await run(['pull'], {
      cwd,
      env: { RELAY_SECRET_KEY: 'sk_1', RELAY_URL: 'https://relay.example' },
      fetch,
    });
    expect(code).toBe(0);
    expect(output).toBe(
      [
        'Wrote relay.config.ts (channels: 1, event types: 1).',
        "Kept in the panel, not in the file: channels.crm.url. To move into code: env('VARIABLE_NAME').",
      ].join('\n'),
    );
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://relay.example/api/v1/config');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer sk_1' });
    expect(readFileSync(join(cwd, 'relay.config.ts'), 'utf8')).not.toContain(
      'url',
    );
  });

  it('--out на папку — понятная ошибка, а не EISDIR', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'relay-pull-'));
    mkdirSync(join(cwd, 'relay'));
    const fetch = fakeFetch(200, exported);
    const { code, output } = await run(['pull', '--out', 'relay', '--force'], {
      cwd,
      fetch,
    });
    expect(code).toBe(1);
    expect(output).toContain('relay is a folder. Pass a file: --out ');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('существующий файл не перезаписывается без --force', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'relay-pull-'));
    writeFileSync(join(cwd, 'relay.config.ts'), 'старое');
    const fetch = fakeFetch(200, exported);
    const refused = await run(['pull'], { cwd, fetch });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('relay.config.ts already exists.');
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(join(cwd, 'relay.config.ts'), 'utf8')).toBe('старое');

    expect((await run(['pull', '--force'], { cwd, fetch })).code).toBe(0);
    expect(readFileSync(join(cwd, 'relay.config.ts'), 'utf8')).toContain(
      'defineRelay',
    );
    expect(
      (await run(['pull', '--out', 'relay/other.ts'], { cwd, fetch })).code,
    ).toBe(0);
    expect(readFileSync(join(cwd, 'relay', 'other.ts'), 'utf8')).toContain(
      'defineRelay',
    );
  });

  it('ошибка сервера — код 1, файл не создаётся', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'relay-pull-'));
    const { code, output } = await run(['pull'], {
      cwd,
      fetch: fakeFetch(401, {
        error: 'unauthorized',
        message: 'Неверный ключ.',
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain('Неверный ключ.');
    expect(() => readFileSync(join(cwd, 'relay.config.ts'))).toThrow();
  });
});
