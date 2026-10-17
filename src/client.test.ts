import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRelay, RETRY_DELAYS_MS } from './client';
import { defineRelay, env } from './config';
import {
  RelayCaptchaError,
  RelayConfigError,
  RelayNetworkError,
  RelayRateLimitError,
  RelayValidationError,
} from './errors';
import { phone } from './phone';

const URL_BASE = 'https://relay.example';

// Повторы без пауз: тесты проверяют число попыток, а не ожидание.
RETRY_DELAYS_MS.fill(0);

function fakeFetch(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  );
}

const lead = z.object({
  name: z.string().min(1),
  phone: phone(),
  comment: z.string().optional(),
});

describe('createRelay', () => {
  it('нужен ровно один ключ', () => {
    expect(() => createRelay({} as never)).toThrow(RelayConfigError);
    expect(() =>
      createRelay({ publicKey: 'pk_1', secretKey: 'sk_1' } as never),
    ).toThrow('Pass exactly one key');
  });
});

describe('send', () => {
  it('публичный ключ — в адресе, данные после своей схемы', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({
      url: `${URL_BASE}/`,
      publicKey: 'pk_1',
      schemas: { lead },
      fetch,
    });
    await expect(
      relay.events.lead.send({ name: 'Иван', phone: '8 (999) 123-45-67' }),
    ).resolves.toEqual({ id: 'e1' });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${URL_BASE}/v1/events/lead?key=pk_1`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'idempotency-key': expect.stringMatching(/^[0-9a-f-]{32,36}$/),
    });
    // Номер уходит как введён: приводит сервер.
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'Иван',
      phone: '8 (999) 123-45-67',
    });
  });

  it('секретный ключ — в заголовке Authorization', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({ url: URL_BASE, secretKey: 'sk_1', fetch });
    await relay.events['order-created'].send({ total: 5 });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${URL_BASE}/v1/events/order-created`);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer sk_1' });
  });

  it('токен капчи — в заголовке X-Captcha-Token, в send и safeSend', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({ url: URL_BASE, publicKey: 'pk_1', fetch });
    await relay.events.lead.send({ name: 'Иван' }, { captchaToken: 't1' });
    await relay.events.lead.safeSend({ name: 'Иван' }, { captchaToken: 't2' });
    expect(fetch.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ 'x-captcha-token': 't1' }),
      expect.objectContaining({ 'x-captcha-token': 't2' }),
    ]);
  });

  it('повтор после сетевой ошибки и 5xx — с тем же ключом события', async () => {
    const flaky = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'e1' }), { status: 202 }),
      );
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: flaky,
    });
    await expect(relay.events.lead.send({ name: 'Иван' })).resolves.toEqual({
      id: 'e1',
    });
    const keys = flaky.mock.calls.map(
      ([, init]) =>
        (init!.headers as Record<string, string>)['idempotency-key'],
    );
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('новый ключ на каждую отправку, свой — из idempotencyKey', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({ url: URL_BASE, publicKey: 'pk_1', fetch });
    await relay.events.lead.send({});
    await relay.events.lead.send({});
    await relay.events.lead.safeSend({}, { idempotencyKey: 'form-1' });
    const keys = fetch.mock.calls.map(
      ([, init]) =>
        (init!.headers as Record<string, string>)['idempotency-key'],
    );
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe('form-1');
  });

  it('капча не пройдена — kind captcha с кодом, прочие 403 — config', async () => {
    for (const code of ['captcha_required', 'captcha_failed']) {
      const relay = createRelay({
        url: URL_BASE,
        publicKey: 'pk_1',
        fetch: fakeFetch(403, { error: code, message: 'Капча.' }),
      });
      const result = await relay.events.lead.safeSend({});
      expect(!result.ok && result.error).toMatchObject({
        kind: 'captcha',
        code,
      });
      expect(!result.ok && result.error).toBeInstanceOf(RelayCaptchaError);
    }
    const origin = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(403, { error: 'origin_not_allowed', message: 'Домен.' }),
    });
    const result = await origin.events.lead.safeSend({});
    expect(!result.ok && result.error).toMatchObject({
      kind: 'config',
      code: 'origin_not_allowed',
    });
  });

  it('не повторяет ошибки данных и настройки', async () => {
    for (const status of [400, 403, 422]) {
      const fetch = fakeFetch(status, {
        error: 'x',
        message: 'Ошибка.',
        errors: status === 400 ? { name: { code: 'required' } } : undefined,
      });
      const relay = createRelay({ url: URL_BASE, publicKey: 'pk_1', fetch });
      await relay.events.lead.safeSend({});
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('своя схема не пропустила — запроса нет, ошибки по полям', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      schemas: { lead },
      fetch,
    });
    const error = await relay.events.lead
      .send({ name: '', phone: '12345' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RelayValidationError);
    expect((error as RelayValidationError).fields).toMatchObject({
      name: { code: 'minLength' },
      phone: { code: 'format', message: 'Invalid phone number.' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('400 с ошибками полей от сервера — ошибка проверки', async () => {
    const fields = {
      phone: { code: 'format', message: 'Invalid phone number.' },
    };
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(400, {
        error: 'validation_failed',
        message: 'Validation failed.',
        errors: fields,
      }),
    });
    await expect(relay.events.lead.send({})).rejects.toMatchObject({
      kind: 'validation',
      fields,
    });
  });

  it('429 — лимит с Retry-After', async () => {
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(
        429,
        { error: 'rate_limited', message: 'Слишком много запросов.' },
        { 'retry-after': '30' },
      ),
    });
    const error = await relay.events.lead.send({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRateLimitError);
    expect((error as RelayRateLimitError).retryAfter).toBe(30);
  });

  it.each([
    [401, 'invalid_key'],
    [403, 'origin_not_allowed'],
    [404, 'event_type_not_found'],
  ])('%i — ошибка настройки с кодом сервера', async (status, code) => {
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(status, { error: code, message: 'Текст сервера.' }),
    });
    const error = await relay.events.lead.send({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayConfigError);
    expect(error).toMatchObject({ status, code, message: 'Текст сервера.' });
  });

  it('5xx и обрыв — сетевая ошибка', async () => {
    const unavailableFetch = fakeFetch(503, {
      error: 'unavailable',
      message: 'Нет базы.',
    });
    const unavailable = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: unavailableFetch,
    });
    await expect(unavailable.events.lead.send({})).rejects.toBeInstanceOf(
      RelayNetworkError,
    );
    // Первая попытка и два повтора.
    expect(unavailableFetch).toHaveBeenCalledTimes(3);
    const offline = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: vi.fn<typeof fetch>(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    await expect(offline.events.lead.send({})).rejects.toMatchObject({
      kind: 'network',
      message: 'Relay is unreachable.',
    });
  });
});

describe('safeSend', () => {
  it('без исключений: ok и id или ошибка с kind', async () => {
    const ok = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(202, { id: 'e1' }),
    });
    await expect(ok.events.lead.safeSend({})).resolves.toEqual({
      ok: true,
      id: 'e1',
    });
    const limited = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(429, { error: 'rate_limited', message: 'Лимит.' }),
    });
    const result = await limited.events.lead.safeSend({});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('rate_limit');
  });
});

describe('fetchSchema', () => {
  const remote = {
    name: 'Заявка',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Имя', maxLength: 100 },
        phone: { type: 'string', format: 'phone' },
      },
      required: ['name'],
    },
  };

  it('схема типа из Relay — zod-схема', async () => {
    const fetch = fakeFetch(200, remote);
    const relay = createRelay({ url: URL_BASE, publicKey: 'pk_1', fetch });
    const schema = await relay.events.lead.fetchSchema();
    expect(String(fetch.mock.calls[0][0])).toBe(
      `${URL_BASE}/v1/events/lead/schema?key=pk_1`,
    );
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
    expect(schema.parse({ name: 'Иван', phone: '89991234567' })).toEqual({
      name: 'Иван',
      phone: '89991234567',
    });
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('Relay недоступен — fallback, без него — ошибка', async () => {
    const fallback = z.object({ name: z.string() });
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(503),
    });
    await expect(relay.events.lead.fetchSchema({ fallback })).resolves.toBe(
      fallback,
    );
    await expect(relay.events.lead.fetchSchema()).rejects.toBeInstanceOf(
      RelayNetworkError,
    );
  });
});

describe('push', () => {
  const config = defineRelay({
    channels: { crm: { type: 'webhook', url: env('CRM_URL') } },
    events: {
      lead: {
        name: 'Заявка',
        schema: z.object({
          name: z.string(),
          password: z.string().refine((value) => value.length > 8),
        }),
        send: { crm: true },
      },
    },
  });
  const changes = [
    { kind: 'event', key: 'lead', action: 'create', details: [], breaking: [] },
  ];

  it('PUT /api/v1/config с секретным ключом; dryRun и prune — в адресе', async () => {
    const fetch = fakeFetch(200, { applied: false, changes });
    const relay = createRelay({
      url: URL_BASE,
      secretKey: 'sk_1',
      config,
      env: { CRM_URL: 'https://crm.example/hook' },
      fetch,
    });
    await expect(relay.push({ dryRun: true, prune: true })).resolves.toEqual({
      applied: false,
      changes,
      warnings: [
        'events.lead.schema.password: refine runs only on the client; Relay does not know it.',
      ],
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(
      `${URL_BASE}/api/v1/config?dryRun=true&prune=true`,
    );
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer sk_1' });
    expect(JSON.parse(init?.body as string)).toMatchObject({
      channels: {
        crm: { type: 'webhook', config: { url: 'https://crm.example/hook' } },
      },
      events: { lead: { name: 'Заявка', send: { crm: true } } },
    });
  });

  it('ошибка сервера с путём — RelayValidationError с полями', async () => {
    const fields = {
      'events.lead.send.crm': {
        code: 'unknown_channel',
        message: 'Канал crm в проекте не найден.',
      },
    };
    const relay = createRelay({
      url: URL_BASE,
      secretKey: 'sk_1',
      config,
      env: { CRM_URL: 'https://crm.example/hook' },
      fetch: fakeFetch(400, {
        error: 'unknown_channel',
        message: 'Канал crm в проекте не найден.',
        errors: fields,
      }),
    });
    await expect(relay.push()).rejects.toMatchObject({
      kind: 'validation',
      fields,
    });
  });

  it('проверка схемами конфигурации до отправки события', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({
      url: URL_BASE,
      secretKey: 'sk_1',
      config,
      fetch,
    });
    await expect(
      relay.events.lead.send({ name: 'Иван', password: 'short' }),
    ).rejects.toBeInstanceOf(RelayValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ответы не по договору и классы ошибок', () => {
  const htmlFetch = () =>
    vi.fn<typeof fetch>(
      async () =>
        new Response('<html>Bad gateway</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

  it('200 не JSON или без id — сетевая ошибка, safeSend не бросает', async () => {
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: htmlFetch(),
    });
    await expect(relay.events.lead.send({})).rejects.toBeInstanceOf(
      RelayNetworkError,
    );
    const noId = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(202, { ok: true }),
    });
    await expect(noId.events.lead.safeSend({})).resolves.toMatchObject({
      ok: false,
      error: { kind: 'network' },
    });
  });

  it('fetchSchema: ответ не по договору — fallback', async () => {
    const fallback = z.object({ name: z.string() });
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: htmlFetch(),
    });
    await expect(relay.events.lead.fetchSchema({ fallback })).resolves.toBe(
      fallback,
    );
  });

  it('429 без Retry-After — retryAfter не задан', async () => {
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(429, { error: 'rate_limited', message: 'Много.' }),
    });
    await expect(relay.events.lead.send({})).rejects.toMatchObject({
      kind: 'rate_limit',
      retryAfter: undefined,
    });
  });

  it('500 «капча не настроена» — ошибка настройки, прочие 5xx — сетевые', async () => {
    const captcha = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(500, {
        error: 'captcha_not_configured',
        message: 'Капча не настроена.',
      }),
    });
    await expect(captcha.events.lead.send({})).rejects.toMatchObject({
      kind: 'config',
      status: 500,
      code: 'captcha_not_configured',
    });
    const db = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      fetch: fakeFetch(503, { error: 'unavailable', message: 'Нет базы.' }),
    });
    await expect(db.events.lead.send({})).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('409 с путями — ошибка настройки с fields', async () => {
    const fields = {
      'channels.sales.name': { code: 'channel_name_taken', message: 'Занято.' },
    };
    const relay = createRelay({
      url: URL_BASE,
      secretKey: 'sk_1',
      config: defineRelay({ events: {} }),
      env: {},
      fetch: fakeFetch(409, {
        error: 'channel_name_taken',
        message: 'Занято.',
        errors: fields,
      }),
    });
    await expect(relay.push()).rejects.toMatchObject({
      kind: 'config',
      fields,
    });
  });

  it('push: пустой ответ — сетевая ошибка', async () => {
    const relay = createRelay({
      url: URL_BASE,
      secretKey: 'sk_1',
      config: defineRelay({ events: {} }),
      env: {},
      fetch: fakeFetch(200, {}),
    });
    await expect(relay.push()).rejects.toBeInstanceOf(RelayNetworkError);
  });

  it('слаг constructor — обычное событие', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      schemas: { lead },
      fetch,
    });
    const events = relay.events as unknown as Record<
      string,
      { send(data: unknown): Promise<unknown> }
    >;
    await expect(events['constructor'].send({ a: 1 })).resolves.toEqual({
      id: 'e1',
    });
  });

  it('secretKey в браузере — ошибка', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    try {
      expect(() => createRelay({ secretKey: 'sk_1' })).toThrow(
        'secretKey is server-only',
      );
      expect(() => createRelay({ publicKey: 'pk_1' })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('по второму ревью', () => {
  it('асинхронный refine в схеме — проверка до запроса работает', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      schemas: {
        lead: z.object({
          email: z.string().refine(async (value) => value !== 'taken@x.ru', {
            message: 'Занят.',
          }),
        }),
      },
      fetch,
    });
    await expect(
      relay.events.lead.safeSend({ email: 'taken@x.ru' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation', fields: { email: { message: 'Занят.' } } },
    });
    await expect(
      relay.events.lead.send({ email: 'free@x.ru' }),
    ).resolves.toEqual({ id: 'e1' });
  });

  it('данные не в JSON — ошибка кода, а не «Relay недоступен»', async () => {
    const fetch = fakeFetch(202, { id: 'e1' });
    const relay = createRelay({ url: URL_BASE, publicKey: 'pk_1', fetch });
    await expect(relay.events.lead.safeSend({ n: 10n })).rejects.toThrow(
      TypeError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('неверный url — ошибка при создании клиента', () => {
    expect(() =>
      createRelay({ publicKey: 'pk_1', url: 'relay.example.com' }),
    ).toThrow('url must be a Relay address like https://relay.example.com');
    expect(() =>
      createRelay({ publicKey: 'pk_1', url: 'ftp://relay.example.com' }),
    ).toThrow(RelayConfigError);
  });
});

describe('по третьему ревью', () => {
  it('таймаут без AbortSignal.timeout — сетевая ошибка с секундами', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    const relay = createRelay({
      url: URL_BASE,
      publicKey: 'pk_1',
      timeoutMs: 20,
      fetch,
    });
    await expect(relay.events.lead.send({})).rejects.toMatchObject({
      kind: 'network',
      message: 'Relay did not respond within 0.02 s.',
    });
  });

  it('Object.keys и in видят описанные события', () => {
    const relay = createRelay({ publicKey: 'pk_1', schemas: { lead } });
    expect(Object.keys(relay.events)).toEqual(['lead']);
    expect('lead' in relay.events).toBe(true);
    expect('other' in relay.events).toBe(false);
  });

  it('push: изменение без details и breaking — пустые списки', async () => {
    const relay = createRelay({
      url: URL_BASE,
      secretKey: 'sk_1',
      config: defineRelay({ events: {} }),
      env: {},
      fetch: fakeFetch(200, {
        applied: true,
        changes: [{ kind: 'event', key: 'lead', action: 'create' }],
      }),
    });
    await expect(relay.push()).resolves.toMatchObject({
      changes: [{ key: 'lead', details: [], breaking: [] }],
    });
  });
});

describe('коды ошибок полей — как у сервера', () => {
  it('ключевые слова JSON Schema для каждой проверки', async () => {
    const relay = createRelay({
      publicKey: 'pk_1',
      schemas: {
        form: z.object({
          missing: z.string(),
          wrongType: z.number(),
          short: z.string().min(3),
          long: z.string().max(2),
          small: z.int().min(5),
          big: z.int().max(1),
          above: z.number().gt(0.5),
          below: z.number().lt(1),
          services: z.array(z.enum(['a', 'b'])).min(1),
          few: z.array(z.enum(['a', 'b'])).max(1),
          picked: z.array(z.enum(['a', 'b'])),
          email: z.email(),
          code: z.string().regex(/^\d+$/),
          prefix: z.string().startsWith('A'),
          kind: z.enum(['a', 'b']),
          consent: z.literal(true),
          phone: phone(),
          own: z.string().refine(() => false),
        }),
      },
      fetch: fakeFetch(202, { id: 'e1' }),
    });
    const result = await relay.events.form.safeSend({
      wrongType: 'x',
      short: 'a',
      long: 'abc',
      small: 1,
      big: 9,
      above: 0.5,
      below: 1,
      services: [],
      few: ['a', 'b'],
      picked: ['c'],
      email: 'x',
      code: 'x',
      prefix: 'b',
      kind: 'c',
      consent: false,
      phone: '1',
      own: 'x',
    } as never);
    expect(result.ok).toBe(false);
    const fields = (result as { error: RelayValidationError }).error.fields;
    expect(
      Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [name, field.code]),
      ),
    ).toEqual({
      missing: 'required',
      wrongType: 'type',
      short: 'minLength',
      long: 'maxLength',
      small: 'minimum',
      big: 'maximum',
      above: 'exclusiveMinimum',
      below: 'exclusiveMaximum',
      services: 'minItems',
      few: 'maxItems',
      picked: 'enum',
      email: 'format',
      code: 'pattern',
      prefix: 'pattern',
      kind: 'enum',
      consent: 'const',
      phone: 'format',
      own: 'custom',
    });
  });
});
