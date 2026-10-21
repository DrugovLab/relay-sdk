import {
  isEnvRef,
  type ChannelDefinition,
  type HttpRouteRequest,
  type RelayConfig,
  type RouteDefinition,
  type Secret,
} from './config';
import { RelayConfigError } from './errors';
import type { RelaySchema } from './json-schema';
import { zodToRelaySchema } from './zod-to-relay';

// Тело PUT /api/v1/config — договор с сервером Relay.
export interface ConfigBody {
  channels: Record<
    string,
    { type: string; name?: string; config: Record<string, unknown> }
  >;
  events: Record<
    string,
    {
      name: string;
      schema: RelaySchema;
      send?: Record<
        string,
        | true
        | { template: string }
        | { defaultTemplate: string }
        | { request: HttpRouteRequest }
      >;
    }
  >;
}

export interface BuiltConfig {
  body: ConfigBody;
  warnings: string[];
}

type Env = Record<string, string | undefined>;

// Конфигурация → тело запроса. Ссылки env() подставляются из env; каких
// переменных нет — одной ошибкой со всеми именами.
export function buildConfigBody(config: RelayConfig, env: Env): BuiltConfig {
  const missing = new Set<string>();
  const resolve = (value: Secret): string => {
    if (!isEnvRef(value)) return value;
    const resolved = env[value.name];
    if (resolved === undefined || resolved === '') missing.add(value.name);
    return resolved ?? '';
  };

  const channels: ConfigBody['channels'] = {};
  for (const [key, channel] of Object.entries(config.channels)) {
    channels[key] = channelBody(channel, resolve);
  }

  const warnings: string[] = [];
  const events: ConfigBody['events'] = {};
  for (const [slug, event] of Object.entries(config.events)) {
    const converted = zodToRelaySchema(event.schema, `events.${slug}.schema`);
    warnings.push(...converted.warnings);
    events[slug] = {
      name: event.name,
      schema: converted.schema,
      ...(event.send && { send: routesBody(event.send) }),
    };
  }

  if (missing.size > 0) {
    throw new RelayConfigError(
      `Missing environment variables: ${[...missing].join(', ')}.`,
    );
  }
  return { body: { channels, events }, warnings };
}

function channelBody(
  channel: ChannelDefinition,
  resolve: (value: Secret) => string,
): ConfigBody['channels'][string] {
  const name = channel.name === undefined ? {} : { name: channel.name };
  switch (channel.type) {
    case 'telegram': {
      const { type: _type, name: _name, botToken, ...rest } = channel;
      return {
        type: 'telegram',
        ...name,
        config:
          botToken === undefined
            ? rest
            : { ...rest, botToken: resolve(botToken) },
      };
    }
    case 'relay_telegram': {
      const { type: _type, name: _name, ...rest } = channel;
      return { type: 'relay_telegram', ...name, config: rest };
    }
    case 'email': {
      const { type: _type, name: _name, pass, ...rest } = channel;
      return {
        type: 'email',
        ...name,
        config: pass === undefined ? rest : { ...rest, pass: resolve(pass) },
      };
    }
    case 'webhook': {
      const { type: _type, name: _name, url, headers, ...rest } = channel;
      return {
        type: 'webhook',
        ...name,
        config: {
          ...rest,
          ...(url !== undefined && { url: resolve(url) }),
          ...(headers && { headers: resolveValues(headers, resolve) }),
        },
      };
    }
    case 'http': {
      const { type: _type, name: _name, auth, secrets, ...rest } = channel;
      return {
        type: 'http',
        ...name,
        config: {
          ...rest,
          ...(auth && {
            auth:
              auth.type === 'bearer'
                ? { ...auth, token: resolve(auth.token) }
                : { ...auth, password: resolve(auth.password) },
          }),
          ...(secrets && { secrets: resolveValues(secrets, resolve) }),
        },
      };
    }
  }
}

function resolveValues(
  values: Record<string, Secret>,
  resolve: (value: Secret) => string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, resolve(value)]),
  );
}

function routesBody(
  send: Record<string, RouteDefinition | undefined>,
): NonNullable<ConfigBody['events'][string]['send']> {
  const routes: NonNullable<ConfigBody['events'][string]['send']> = {};
  for (const [channel, route] of Object.entries(send)) {
    if (route === undefined) continue;
    routes[channel] =
      route === true
        ? true
        : route.template !== undefined
          ? { template: route.template }
          : route.request !== undefined
            ? { request: route.request }
            : { defaultTemplate: route.defaultTemplate };
  }
  return routes;
}
