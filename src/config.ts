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
// заголовки вебхука. Новый канал без нужного поля Relay не создаст.
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

export type ChannelDefinition =
  TelegramChannel | RelayTelegramChannel | EmailChannel | WebhookChannel;

// true — стандартное сообщение; template — шаблон задаёт код;
// defaultTemplate — ставится, пока шаблон не правили в панели.
export type RouteDefinition =
  | true
  | { template: string; defaultTemplate?: never }
  | { defaultTemplate: string; template?: never };

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
