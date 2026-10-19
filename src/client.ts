import type { z } from 'zod';
import {
  RelayCaptchaError,
  RelayConfigError,
  RelayError,
  RelayNetworkError,
  RelayRateLimitError,
  RelayValidationError,
  type AnyRelayError,
  type FieldErrors,
} from './errors';
import {
  isRelayConfig,
  type ChannelDefinition,
  type ConfigEvents,
  type RelayConfig,
} from './config';
import type { ConfigBody } from './config-body';
import type { RelaySchema } from './json-schema';

export const DEFAULT_URL = 'https://relay.drugovlab.ru';
const DEFAULT_TIMEOUT_MS = 10_000;
// Сервер применяет конфигурацию в транзакции до 30 с.
const CONFIG_TIMEOUT_MS = 60_000;
// Паузы перед повторами отправки после сетевой ошибки и 5xx.
export const RETRY_DELAYS_MS = [500, 1_500];

// publicKey — в браузере (сайт должен быть в списке разрешённых проекта),
// secretKey is server-only.
export type RelayAuth =
  | { publicKey: string; secretKey?: never }
  | { secretKey: string; publicKey?: never };

export type RelayOptions = RelayAuth & {
  // Адрес Relay; по умолчанию — relay.drugovlab.ru.
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type Schemas = Record<string, z.ZodType<Record<string, unknown>>>;

export interface SendOptions {
  // Токен капчи из её виджета, если у типа она включена.
  captchaToken?: string;
  // Ключ события: Relay создаёт событие с ним один раз. По умолчанию — новый
  // на каждый вызов; свой нужен, чтобы повтор отправки формы не задвоил её.
  idempotencyKey?: string;
}

export type SendResult =
  { ok: true; id: string } | { ok: false; error: AnyRelayError };

export interface EventClient<
  Input,
  Schema extends z.ZodType | undefined = undefined,
> {
  // Своя схема события (из schemas или config); без неё — undefined.
  readonly schema: Schema;
  // Проверка своей схемой, затем отправка. Ошибки — исключения RelayError.
  send(data: Input, options?: SendOptions): Promise<{ id: string }>;
  // То же без исключений.
  safeSend(data: Input, options?: SendOptions): Promise<SendResult>;
  // Схема типа из Relay — для форм, которые строятся по полям из панели.
  // fallback — схема на случай, если Relay недоступен.
  fetchSchema<Fallback extends z.ZodObject = z.ZodObject>(options?: {
    fallback?: Fallback;
  }): Promise<z.ZodObject | Fallback>;
}

export interface Relay<Clients> {
  readonly events: Clients;
}

export interface ConfigChange {
  kind: 'channel' | 'event' | 'route';
  key: string;
  action: 'create' | 'update' | 'delete' | 'release';
  details: string[];
  // Ломающие изменения схемы: прежние данные формы могут не пройти проверку.
  breaking: string[];
}

export interface PushResult {
  // false — пробный запуск, ничего не записано.
  applied: boolean;
  changes: ConfigChange[];
  // Что из схем не перенеслось в Relay (refine, transform).
  warnings: string[];
}

export interface PushOptions {
  // Список изменений без применения.
  dryRun?: boolean;
  // Удалить каналы и типы из кода, которых больше нет в конфигурации.
  prune?: boolean;
}

// Сервер с конфигурацией: проверка схемами из неё и применение конфигурации.
export interface ServerRelay<Clients> extends Relay<Clients> {
  push(options?: PushOptions): Promise<PushResult>;
}

type SchemaClients<S extends Schemas> = {
  readonly [K in keyof S & string]: EventClient<z.input<S[K]>, S[K]>;
};

type ConfigClients<Config> =
  Config extends RelayConfig<Record<string, ChannelDefinition>, infer Events>
    ? {
        readonly [K in keyof Events & string]: EventClient<
          z.input<Events[K]['schema']>,
          Events[K]['schema']
        >;
      }
    : never;

// Только типы: из typeof config или явной записи { ключ: данные }.
type TypedClients<Types> = Types extends RelayConfig
  ? {
      readonly [K in keyof ConfigEvents<Types>]: EventClient<
        ConfigEvents<Types>[K]
      >;
    }
  : {
      // Данные события — объект; другое — ошибка при обращении к событию.
      readonly [K in keyof Types & string]: Types[K] extends object
        ? EventClient<Types[K]>
        : never;
    };

type BaseOptions = {
  // Адрес Relay; по умолчанию — relay.drugovlab.ru.
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type ServerOptions<Config extends RelayConfig> = BaseOptions & {
  secretKey: string;
  publicKey?: never;
  config: Config;
  // Откуда брать значения env(); по умолчанию — process.env.
  env?: Record<string, string | undefined>;
};

// На сервере с конфигурацией: проверка её схемами и relay.push().
export function createRelay<const Config extends RelayConfig>(
  options: ServerOptions<Config>,
): ServerRelay<ConfigClients<Config>>;
// Свои схемы: проверка до запроса.
export function createRelay<const S extends Schemas>(
  options: RelayOptions & { schemas: S },
): Relay<SchemaClients<S>>;
// Только типы: createRelay<typeof config>({ publicKey }) во фронтенде или
// createRelay<{ lead: { name: string } }>(…). Проверяет сервер.
export function createRelay<
  // object, а не Record: тип событий можно описать и через interface.
  Types extends object = Record<string, Record<string, unknown>>,
>(options: RelayOptions): Relay<TypedClients<Types>>;
export function createRelay(
  options: RelayOptions & {
    schemas?: Schemas;
    config?: RelayConfig;
    env?: Record<string, string | undefined>;
  },
  // Типы клиентов задают перегрузки выше; здесь они не выводятся.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ServerRelay<any> {
  if (!options.publicKey === !options.secretKey) {
    throw new RelayConfigError(
      'Pass exactly one key: publicKey in the browser or secretKey on the server.',
    );
  }
  if (
    options.secretKey &&
    typeof window !== 'undefined' &&
    typeof document !== 'undefined'
  ) {
    throw new RelayConfigError(
      'secretKey is server-only: in the browser any visitor can read it. Use publicKey in the frontend.',
    );
  }
  if (options.config && !isRelayConfig(options.config)) {
    throw new RelayConfigError('config must be the result of defineRelay().');
  }
  const config = options.config;
  // События, описанные схемами или конфигурацией. Только свои ключи: слаг
  // может совпасть с constructor или toString. Без Object.hasOwn: его нет в
  // Safari до 15.4.
  const described = config ? config.events : options.schemas;
  const isDescribed = (slug: string): boolean =>
    !!described && Object.prototype.hasOwnProperty.call(described, slug);
  const schemaOf = (slug: string): z.ZodType | undefined => {
    if (!isDescribed(slug)) return undefined;
    return config ? config.events[slug].schema : options.schemas?.[slug];
  };
  const transport = new Transport(options);
  const clients = new Map<
    string,
    EventClient<unknown, z.ZodType | undefined>
  >();
  // Клиент события создаётся при первом обращении: ключи событий могут быть
  // известны только из типов.
  const clientOf = (slug: string) => {
    let client = clients.get(slug);
    if (!client) {
      client = eventClient(transport, slug, schemaOf(slug));
      clients.set(slug, client);
    }
    return client;
  };
  // Отправить можно в любое событие; Object.keys и in видят описанные.
  const events = new Proxy(
    {} as Record<string, EventClient<unknown, z.ZodType | undefined>>,
    {
      get: (_, slug) => (typeof slug === 'string' ? clientOf(slug) : undefined),
      has: (_, slug) => typeof slug === 'string' && isDescribed(slug),
      ownKeys: () => (described ? Object.keys(described) : []),
      getOwnPropertyDescriptor: (_, slug) =>
        typeof slug === 'string' && isDescribed(slug)
          ? {
              value: clientOf(slug),
              enumerable: true,
              configurable: true,
              writable: false,
            }
          : undefined,
    },
  );
  return {
    events,
    async push(pushOptions = {}) {
      if (!config || !options.secretKey) {
        throw new RelayConfigError(
          'push applies the configuration: it needs secretKey and config.',
        );
      }
      // Перевод zod в схему Relay загружается здесь: в бандл фронтенда он
      // и zod не попадают.
      const { buildConfigBody } = await import('./config-body');
      const { body, warnings } = buildConfigBody(
        config,
        options.env ?? processEnv(),
      );
      const query = new URLSearchParams();
      if (pushOptions.dryRun) query.set('dryRun', 'true');
      if (pushOptions.prune) query.set('prune', 'true');
      const result = await transport.request(
        'PUT',
        `/api/v1/config${query.size > 0 ? `?${query}` : ''}`,
        { body, timeoutMs: options.timeoutMs ?? CONFIG_TIMEOUT_MS },
      );
      if (
        typeof result.applied !== 'boolean' ||
        !Array.isArray(result.changes)
      ) {
        throw invalidReply();
      }
      return {
        applied: result.applied,
        // details и breaking — с запасом на сервер другой версии.
        changes: (result.changes as Partial<ConfigChange>[]).map((change) => ({
          ...(change as ConfigChange),
          details: Array.isArray(change.details) ? change.details : [],
          breaking: Array.isArray(change.breaking) ? change.breaking : [],
        })),
        warnings,
      };
    },
  };
}

function processEnv(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : process.env;
}

function eventClient(
  transport: Transport,
  slug: string,
  schema: z.ZodType | undefined,
): EventClient<unknown, z.ZodType | undefined> {
  async function send(
    data: unknown,
    options?: SendOptions,
  ): Promise<{ id: string }> {
    let body = data;
    if (schema) {
      // Async: в схеме бывают асинхронные refine.
      const parsed = await schema.safeParseAsync(data);
      if (!parsed.success) {
        throw new RelayValidationError(
          'Validation failed.',
          issuesToFields(parsed.error.issues, data),
        );
      }
      body = parsed.data;
    }
    const { id } = await transport.request(
      'POST',
      `/v1/events/${encodeURIComponent(slug)}`,
      {
        // С файлами — multipart: в JSON файл не передать.
        body: hasFiles(body)
          ? toFormData(body as Record<string, unknown>)
          : body,
        headers: {
          'idempotency-key': options?.idempotencyKey ?? newIdempotencyKey(),
          ...(options?.captchaToken
            ? { 'x-captcha-token': options.captchaToken }
            : {}),
        },
        // Повтор с тем же ключом не создаёт второе событие, если первый
        // запрос дошёл, а ответ потерялся.
        retryDelaysMs: RETRY_DELAYS_MS,
      },
    );
    if (typeof id !== 'string') throw invalidReply();
    return { id };
  }

  return {
    schema,
    send,
    async safeSend(data, options) {
      try {
        return { ok: true, ...(await send(data, options)) };
      } catch (error) {
        if (error instanceof RelayError) {
          return { ok: false, error: error as AnyRelayError };
        }
        throw error;
      }
    },
    async fetchSchema(options) {
      try {
        const { schema: remote } = await transport.request(
          'GET',
          `/v1/events/${encodeURIComponent(slug)}/schema`,
        );
        if (!isRecord(remote) || !isRecord(remote.properties)) {
          throw invalidReply();
        }
        return await schemaToZod(remote as unknown as RelaySchema);
      } catch (error) {
        if (options?.fallback && error instanceof RelayError) {
          return options.fallback;
        }
        throw error;
      }
    },
  };
}

// Как и в push: код с zod загружается при первом вызове. Не загрузился (сайт
// обновился, сеть) или схема не переводится — ошибка RelayError: на неё
// срабатывает fallback.
async function schemaToZod(schema: RelaySchema): Promise<z.ZodObject> {
  let relaySchemaToZod: typeof import('./json-schema').relaySchemaToZod;
  try {
    ({ relaySchemaToZod } = await import('./json-schema'));
  } catch (error) {
    throw new RelayNetworkError('Failed to load the schema converter.', {
      cause: error,
    });
  }
  try {
    return relaySchemaToZod(schema);
  } catch (error) {
    throw new RelayConfigError(
      `The Relay schema cannot be converted to zod: ${(error as Error).message}`,
    );
  }
}

// Первая ошибка на поле, как у сервера: { phone: { code, message } }. Коды —
// как у сервера (ключевые слова JSON Schema): форма подбирает текст по коду
// одинаково для проверки до запроса и на сервере.
function issuesToFields(
  issues: z.core.$ZodIssue[],
  data: unknown,
): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of issues) {
    const name = issue.path.length > 0 ? String(issue.path[0]) : '';
    const value =
      typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>)[name]
        : undefined;
    fields[name] ??= { code: fieldCode(issue, value), message: issue.message };
  }
  return fields;
}

// Проверки строки, которые в схеме Relay — pattern.
const PATTERN_FORMATS = [
  'regex',
  'starts_with',
  'ends_with',
  'includes',
  'lowercase',
  'uppercase',
];

function fieldCode(issue: z.core.$ZodIssue, value: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      return value === undefined ? 'required' : 'type';
    case 'too_small':
      if (issue.origin === 'string') return 'minLength';
      if (issue.origin === 'array') return 'minItems';
      return issue.inclusive === false ? 'exclusiveMinimum' : 'minimum';
    case 'too_big':
      if (issue.origin === 'string') return 'maxLength';
      if (issue.origin === 'array') return 'maxItems';
      return issue.inclusive === false ? 'exclusiveMaximum' : 'maximum';
    case 'invalid_format':
      return PATTERN_FORMATS.includes(issue.format) ? 'pattern' : 'format';
    case 'invalid_value':
      return issue.values.length === 1 && issue.values[0] === true
        ? 'const'
        : 'enum';
    case 'custom':
      if (typeof issue.params?.code === 'string') return issue.params.code;
      return issue.params?.format === 'phone' ? 'format' : 'custom';
    default:
      return issue.code;
  }
}

// Текущая конфигурация проекта из Relay — тело PUT /api/v1/config:
// секреты и адреса вебхуков — null. Нужен секретный ключ.
export async function fetchConfig(options: {
  secretKey: string;
  url?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<ConfigBody> {
  const transport = new Transport(options);
  const reply = await transport.request('GET', '/api/v1/config', {
    timeoutMs: options.timeoutMs ?? CONFIG_TIMEOUT_MS,
  });
  if (!isRecord(reply.channels) || !isRecord(reply.events)) {
    throw invalidReply();
  }
  return reply as unknown as ConfigBody;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

class Transport {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: RelayOptions) {
    this.url = (options.url ?? DEFAULT_URL).replace(/\/+$/, '');
    // Неверный адрес — ошибка при создании клиента, а не при первой отправке.
    if (!isHttpUrl(this.url)) {
      throw new RelayConfigError(
        `url must be a Relay address like https://relay.example.com, got "${options.url}".`,
      );
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: RequestOptions & { retryDelaysMs?: number[] } = {},
  ): Promise<Record<string, unknown>> {
    const delays = options.retryDelaysMs ?? [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(method, path, options);
      } catch (error) {
        if (!(error instanceof RelayNetworkError) || attempt >= delays.length) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  private async requestOnce(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    { body, headers: extraHeaders, timeoutMs = this.timeoutMs }: RequestOptions,
  ): Promise<Record<string, unknown>> {
    const url = new URL(this.url + path);
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.options.publicKey) {
      url.searchParams.set('key', this.options.publicKey);
    } else {
      headers.authorization = `Bearer ${this.options.secretKey}`;
    }
    // FormData браузер и Node отправляют сами, с границей частей в типе.
    const form = body instanceof FormData;
    if (body !== undefined && !form) {
      headers['content-type'] = 'application/json';
    }
    // До запроса: данные не в JSON (BigInt, циклы) — ошибка в коде, а не сети.
    const json = body === undefined || form ? body : JSON.stringify(body);

    // AbortController, а не AbortSignal.timeout: того нет в Safari до 16.
    // Таймаут действует и на чтение тела.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let reply:
      { error?: string; message?: string; errors?: FieldErrors } | undefined;
    try {
      try {
        response = await this.fetch(url, {
          method,
          headers,
          body: json,
          signal: controller.signal,
        });
      } catch (error) {
        throw new RelayNetworkError(
          controller.signal.aborted
            ? `Relay did not respond within ${timeoutMs / 1000} s.`
            : 'Relay is unreachable.',
          { cause: error },
        );
      }
      // Тело может оборваться по таймауту или оказаться не JSON (прокси,
      // страница ошибки хостинга): тогда ответа нет.
      reply = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      if (!isRecord(reply)) throw invalidReply();
      return reply;
    }

    const message =
      reply?.message ?? `Relay responded with ${response.status}.`;
    if (response.status === 400 && reply?.errors) {
      throw new RelayValidationError(message, reply.errors);
    }
    if (
      response.status === 403 &&
      (reply?.error === 'captcha_required' || reply?.error === 'captcha_failed')
    ) {
      throw new RelayCaptchaError(message, reply.error);
    }
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const retryAfter = header === null ? NaN : Number(header);
      throw new RelayRateLimitError(
        message,
        Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
      );
    }
    // 5xx — временно: база, провайдер капчи. Повтор поможет. Кроме ошибок
    // настройки: их повтор не исправит.
    if (response.status >= 500 && !CONFIG_ERRORS.includes(reply?.error ?? '')) {
      throw new RelayNetworkError(message);
    }
    throw new RelayConfigError(
      message,
      response.status,
      reply?.error,
      reply?.errors,
    );
  }
}

function isFile(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function hasFiles(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    Object.values(data).some(
      (value) => isFile(value) || (Array.isArray(value) && value.some(isFile)),
    )
  );
}

// Поля — частями формы, как их разбирает сервер: список — повтором ключа,
// словарь — ключ[название], остальное — строкой.
function toFormData(data: Record<string, unknown>): FormData {
  const form = new FormData();
  const append = (key: string, value: unknown) => {
    if (isFile(value)) {
      form.append(key, value, value instanceof File ? value.name : 'file');
    } else {
      form.append(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) append(key, item);
    } else if (typeof value === 'object' && !isFile(value)) {
      for (const [name, item] of Object.entries(value)) {
        append(`${key}[${name}]`, item);
      }
    } else {
      append(key, value);
    }
  }
  return form;
}

// Ошибки 5xx, которые исправляет владелец проекта, а не повтор.
const CONFIG_ERRORS = ['captcha_not_configured'];

function invalidReply(): RelayNetworkError {
  return new RelayNetworkError(
    'Relay responded in an unexpected format: check the Relay url.',
  );
}

// randomUUID есть только на https и localhost, getRandomValues — везде.
function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

// Без URL.canParse: его нет в Safari до 17.
function isHttpUrl(text: string): boolean {
  try {
    return /^https?:$/.test(new URL(text).protocol);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
