import type { ConfigChange, PushResult } from '../client';
import { RelayConfigError, RelayError, RelayValidationError } from '../errors';

const KINDS: Record<ConfigChange['kind'], string> = {
  channel: 'channel',
  event: 'event type',
  route: 'route',
};

const ACTIONS: Record<ConfigChange['action'], [string, string]> = {
  create: ['+', 'created'],
  update: ['~', 'updated'],
  delete: ['-', 'deleted'],
  release: ['?', 'no longer from code'],
};

// Отчёт push: изменения, ломающие изменения отдельно, предупреждения.
export function formatPush(result: PushResult, dryRun: boolean): string {
  const lines: string[] = [];
  const count = result.changes.length;
  lines.push(
    count === 0
      ? 'No changes.'
      : dryRun
        ? `Dry run, nothing applied. Changes: ${count}.`
        : `Applied changes: ${count}.`,
  );
  for (const change of result.changes) {
    const [mark, action] = ACTIONS[change.action];
    const details =
      change.details.length > 0 ? `: ${change.details.join('; ')}` : '';
    lines.push(
      `  ${mark} ${KINDS[change.kind]} ${change.key} — ${action}${details}`,
    );
    for (const breaking of change.breaking) {
      lines.push(`    ! breaking: ${breaking}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of result.warnings) lines.push(`  ${warning}`);
  }
  return lines.join('\n');
}

// Ошибки Relay — сообщение и пути. Прочие (синтаксис relay.config.ts, импорт) —
// со стеком: по нему видно, где в файле ошибка.
export function formatError(error: unknown): string {
  if (!(error instanceof RelayError)) {
    return error instanceof Error
      ? (error.stack ?? error.message)
      : String(error);
  }
  const lines = [error.message];
  const fields =
    error instanceof RelayValidationError || error instanceof RelayConfigError
      ? error.fields
      : undefined;
  for (const [path, field] of Object.entries(fields ?? {})) {
    lines.push(`  ${path}: ${field.message}`);
  }
  return lines.join('\n');
}
