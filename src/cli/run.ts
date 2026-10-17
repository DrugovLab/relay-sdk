import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createJiti } from 'jiti';
import { createRelay, fetchConfig } from '../client';
import { configSource } from '../codegen';
import { isRelayConfig, type RelayConfig } from '../config';
import { RelayConfigError } from '../errors';
import { formatError, formatPush } from './format';

const CONFIG_FILES = [
  'relay.config.ts',
  'relay.config.mts',
  'relay.config.js',
  'relay.config.mjs',
];

const COMMAND_OPTIONS: Record<'push' | 'pull', string[]> = {
  push: ['dry-run', 'prune', 'config', 'env-file'],
  pull: ['out', 'force', 'env-file'],
};

const USAGE = `Usage:
  relay push [--dry-run] [--prune] [--config <path>] [--env-file <path>]
  relay pull [--out <path>] [--force] [--env-file <path>]

  push            apply the configuration from relay.config.ts
  --dry-run       list the changes without applying them
  --prune         delete channels and event types from code that are no longer in the configuration
  --config        configuration file; relay.config.ts in the current folder by default

  pull            write relay.config.ts from what is set up in Relay
  --out           where to write; relay.config.ts by default
  --force         overwrite an existing file

  --env-file      environment file; .env by default, if it exists

Environment: RELAY_SECRET_KEY — project secret key.`;

export interface CliContext {
  cwd: string;
  env: Record<string, string | undefined>;
  write: (text: string) => void;
  // Ошибки — в stderr: в CI их видно отдельно от отчёта.
  error: (text: string) => void;
  fetch?: typeof fetch;
}

// Код выхода: 0 — успех, 1 — ошибка; для CI.
export async function runCli(
  argv: string[],
  context: CliContext,
): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    context.error(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const [command] = args.positionals;
  if (args.values.help || command === undefined || command === 'help') {
    context.write(USAGE);
    return command === undefined && !args.values.help ? 1 : 0;
  }
  if (command !== 'push' && command !== 'pull') {
    context.error(`Unknown command: ${command}.\n\n${USAGE}`);
    return 1;
  }
  const foreign = Object.keys(args.values).filter(
    (option) => !COMMAND_OPTIONS[command].includes(option),
  );
  if (foreign.length > 0) {
    context.error(
      `Flag --${foreign[0]} does not apply to relay ${command}.\n\n${USAGE}`,
    );
    return 1;
  }
  try {
    // Переменные из файла — в само окружение: в CLI это process.env, и
    // process.env.X в relay.config.ts видит их так же, как env('X').
    Object.assign(context.env, readEnvFile(context, args.values['env-file']));
    const env = context.env;
    const secretKey = env.RELAY_SECRET_KEY;
    if (!secretKey) {
      throw new RelayConfigError(
        'RELAY_SECRET_KEY is not set: the project secret key from Relay settings.',
      );
    }
    if (command === 'pull') {
      return await pull(context, env, secretKey, args.values);
    }
    const config = await loadConfig(context.cwd, args.values.config);
    const relay = createRelay({
      secretKey,
      config,
      env,
      ...(env.RELAY_URL && { url: env.RELAY_URL }),
      ...(context.fetch && { fetch: context.fetch }),
    });
    const dryRun = args.values['dry-run'] ?? false;
    const result = await relay.push({
      dryRun,
      prune: args.values.prune ?? false,
    });
    context.write(formatPush(result, dryRun));
    return 0;
  } catch (error) {
    context.error(formatError(error));
    return 1;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      prune: { type: 'boolean' },
      config: { type: 'string' },
      'env-file': { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

// Выгрузка из Relay → relay.config.ts. Существующий файл — только с --force:
// в нём могут быть правки, которых нет в Relay.
async function pull(
  context: CliContext,
  env: Record<string, string | undefined>,
  secretKey: string,
  options: { out?: string; force?: boolean },
): Promise<number> {
  const out = options.out ?? 'relay.config.ts';
  const path = resolve(context.cwd, out);
  if (existsSync(path) && statSync(path).isDirectory()) {
    throw new RelayConfigError(
      `${out} is a folder. Pass a file: --out ${join(out, 'relay.config.ts')}.`,
    );
  }
  if (existsSync(path) && !options.force) {
    throw new RelayConfigError(
      `${out} already exists. Overwrite: relay pull --force; another file: --out <path>.`,
    );
  }
  const body = await fetchConfig({
    secretKey,
    ...(env.RELAY_URL && { url: env.RELAY_URL }),
    ...(context.fetch && { fetch: context.fetch }),
  });
  const { source, keptInPanel, notes } = configSource(body);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  const counts = `channels: ${Object.keys(body.channels).length}, event types: ${Object.keys(body.events).length}`;
  context.write(
    [
      `Wrote ${out} (${counts}).`,
      ...(keptInPanel.length > 0
        ? [
            `Kept in the panel, not in the file: ${keptInPanel.join(', ')}. To move into code: env('VARIABLE_NAME').`,
          ]
        : []),
      ...(notes.length > 0
        ? [
            '',
            'Differs in code from Relay:',
            ...notes.map((note) => `  ${note}`),
          ]
        : []),
    ].join('\n'),
  );
  return 0;
}

// Переменные из файла не заменяют заданные в окружении: в CI главнее окружение.
function readEnvFile(
  context: CliContext,
  file: string | undefined,
): Record<string, string> {
  const path = resolve(context.cwd, file ?? '.env');
  if (!existsSync(path)) {
    if (file) throw new RelayConfigError(`File ${file} not found.`);
    return {};
  }
  const parsed = parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => context.env[key] === undefined),
  );
}

async function loadConfig(
  cwd: string,
  file: string | undefined,
): Promise<RelayConfig> {
  const path = file
    ? resolve(cwd, file)
    : CONFIG_FILES.map((name) => resolve(cwd, name)).find(existsSync);
  if (!path || !existsSync(path)) {
    throw new RelayConfigError(
      file
        ? `Config file ${file} not found.`
        : `No relay.config.ts in ${cwd}. Pass a file: --config <path>.`,
    );
  }
  // jiti загружает TypeScript с импортами без расширений и алиасами tsconfig.
  const jiti = createJiti(pathToFileURL(path).href, { tsconfigPaths: true });
  const module = await jiti.import<Record<string, unknown>>(path);
  const config = module.default ?? module.config;
  if (!isRelayConfig(config)) {
    throw new RelayConfigError(
      `${path}: export the result of defineRelay as default.`,
    );
  }
  return config;
}
