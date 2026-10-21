import type { z } from 'zod';
import { RelayConfigError } from './errors';

// Symbol.for: конфигурация, загруженная CLI, создана копией пакета из проекта
// пользователя, а не той, что в CLI, — метки должны совпадать.
const ENV = Symbol.for('@drugovlab/relay-sdk/env');
const CONFIG = Symbol.for('@drugovlab/relay-sdk/config');

// Ссылка на переменную окружения: секреты не пишутся в конфигурацию,
// значение подставляется при push из process.env.
export interface EnvRef {
  readonly [ENV]: true;
  readonly name: string;
}

export function env(name: string): EnvRef {
  return { [ENV]: true, name };
}

export function isEnvRef(value: unknown): value is EnvRef {
  return typeof value === 'object' && value !== null && ENV in value;
}

export type Secret = string | EnvRef;

// Получатель Telegram: чат по ID; threadId — тема группы; projectTopic — своя
// тема проекта в личном чате, номер темы ставит сервер.
export type TelegramRecipient =
  | {
      name?: string;
      chatId: number | string;
      threadId?: number;
      projectTopic?: never;
    }
  | {
      name?: string;
      chatId: number | string;
      projectTopic: true;
      threadId?: never;
    };

// Поле, которого нет в коде, ведётся в панели: получатели, секреты, адрес и
// заголовки вебхука и HTTP-запроса, авторизация HTTP-запроса. Новый канал без
// нужного поля Relay не создаст.
interface ChannelBase {
  // Название в панели; без него — ключ канала.
  name?: string;
}

// Свой бот. Без botToken — токен, сохранённый в панели.
export interface TelegramChannel extends ChannelBase {
  type: 'telegram';
  botToken?: Secret;
  recipients?: TelegramRecipient[];
}

// Бот Relay: токен не нужен.
export interface RelayTelegramChannel extends ChannelBase {
  type: 'relay_telegram';
  botToken?: never;
  recipients?: TelegramRecipient[];
}

export interface EmailChannel extends ChannelBase {
  type: 'email';
  host: string;
  port: number;
  // true — TLS сразу (обычно порт 465), false — STARTTLS (587).
  secure: boolean;
  user?: string;
  pass?: Secret;
  from: string;
  to?: string[];
}

export interface WebhookChannel extends ChannelBase {
  type: 'webhook';
  url?: Secret;
  method?: 'POST' | 'PUT';
  headers?: Record<string, Secret>;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Значения — шаблоны Mustache: {{name}}, {{secret.token}}.
export interface HttpParam {
  name: string;
  value: string;
}

export type HttpAuth =
  | { type: 'bearer'; token: Secret }
  | { type: 'basic'; user: string; password: Secret };

// status — коды и диапазоны через запятую: '200, 201', '200-299'.
export interface HttpSuccess {
  status: string;
  body?: {
    check: 'equals' | 'not_equals' | 'contains' | 'not_contains';
    value: string;
  };
}

export interface HttpRetry {
  network: boolean;
  status: string;
  bodyContains?: string;
  // 1–8.
  maxAttempts: number;
}

// file — ключ поля-файла события.
export type HttpBody =
  | { format: 'json' | 'xml'; template: string }
  | { format: 'text'; template: string; contentType: string }
  | { format: 'form'; fields: HttpParam[] }
  | {
      format: 'multipart';
      fields: (
        | { name: string; value: string; file?: never }
        | { name: string; file: string; value?: never }
      )[];
    };

// Запрос маршрута в канал «HTTP-запрос». url — путь к baseUrl канала или
// полный адрес; success, retry и timeoutSec заменяют заданные в канале.
export interface HttpRouteRequest {
  method?: HttpMethod;
  url?: string;
  query?: HttpParam[];
  headers?: HttpParam[];
  body?: HttpBody;
  success?: HttpSuccess;
  retry?: HttpRetry;
  timeoutSec?: number;
}

// Запрос в формате получателя. baseUrl и заголовки — шаблоны: {{secret.token}}
// подставляет значение из secrets (имя — буква, затем буквы, цифры, _).
export interface HttpChannel extends ChannelBase {
  type: 'http';
  baseUrl?: string;
  method?: HttpMethod;
  headers?: HttpParam[];
  auth?: HttpAuth;
  secrets?: Record<string, Secret>;
  success?: HttpSuccess;
  retry?: HttpRetry;
  // 1–30.
  timeoutSec?: number;
}

export type ChannelDefinition =
  | TelegramChannel
  | RelayTelegramChannel
  | EmailChannel
  | WebhookChannel
  | HttpChannel;

// true — стандартное сообщение; template — шаблон задаёт код;
// defaultTemplate — ставится, пока шаблон не правили в панели; request —
// запрос канала «HTTP-запрос», template и defaultTemplate ему не подходят.
// Какое значение подходит каналу, проверяет сервер при push.
export type RouteDefinition =
  | true
  | { template: string; defaultTemplate?: never; request?: never }
  | { defaultTemplate: string; template?: never; request?: never }
  | { request: HttpRouteRequest; template?: never; defaultTemplate?: never };

export type EventSchema = z.ZodObject;

export interface EventDefinition<
  Schema extends EventSchema = EventSchema,
  ChannelKey extends string = string,
> {
  name: string;
  schema: Schema;
  // Каналы из конфигурации подсказываются; ключ канала из панели тоже подходит.
  send?: { [K in ChannelKey | (string & {})]?: RouteDefinition };
}

export interface RelayConfig<
  Channels extends Record<string, ChannelDefinition> = Record<
    string,
    ChannelDefinition
  >,
  Events extends Record<string, EventDefinition> = Record<
    string,
    EventDefinition
  >,
> {
  readonly [CONFIG]: true;
  readonly channels: Channels;
  readonly events: Events;
}

// Данные событий конфигурации: то, что передаётся в send.
export type ConfigEvents<Config> =
  Config extends RelayConfig<Record<string, ChannelDefinition>, infer Events>
    ? { [K in keyof Events & string]: z.input<Events[K]['schema']> }
    : never;

export function defineRelay<
  const Channels extends Record<string, ChannelDefinition> = {},
  const Events extends Record<
    string,
    EventDefinition<EventSchema, keyof Channels & string>
  > = {},
>(config: {
  channels?: Channels;
  events: Events;
}): RelayConfig<Channels, Events> {
  // В браузер конфигурация не попадает: в ней каналы, шаблоны и ссылки на
  // секреты. Фронтенд берёт только тип: createRelay<typeof config>.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    throw new RelayConfigError(
      'defineRelay is server and CLI only. In the frontend use import type and createRelay<typeof config>.',
    );
  }
  return {
    [CONFIG]: true,
    channels: config.channels ?? ({} as Channels),
    events: config.events,
  };
}

export function isRelayConfig(value: unknown): value is RelayConfig {
  return typeof value === 'object' && value !== null && CONFIG in value;
}
