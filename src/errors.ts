// Ошибки отправки. kind — чтобы без instanceof решить, что делать:
// validation — показать ошибки полей, rate_limit — повторить позже,
// network — повторить, config — исправить ключ, адрес или тип события.
export type RelayErrorKind = 'validation' | 'rate_limit' | 'network' | 'config';

export interface FieldError {
  code: string;
  message: string;
}

export type FieldErrors = Record<string, FieldError>;

export abstract class RelayError extends Error {
  abstract readonly kind: RelayErrorKind;
}

// Данные не прошли проверку схемой: своей до запроса или сервера.
export class RelayValidationError extends RelayError {
  readonly kind = 'validation';

  constructor(
    message: string,
    readonly fields: FieldErrors,
  ) {
    super(message);
    this.name = 'RelayValidationError';
  }
}

// Превышен лимит; retryAfter — через сколько секунд повторить, если сервер сказал.
export class RelayRateLimitError extends RelayError {
  readonly kind = 'rate_limit';

  constructor(
    message: string,
    readonly retryAfter: number | undefined,
  ) {
    super(message);
    this.name = 'RelayRateLimitError';
  }
}

// Сервер недоступен, не ответил вовремя или временно не может принять событие.
export class RelayNetworkError extends RelayError {
  readonly kind = 'network';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RelayNetworkError';
  }
}

// Ошибка настройки: неверный ключ, сайт не разрешён, нет такого типа события.
// status и code — ответ сервера, если запрос дошёл; fields — ошибки по путям
// конфигурации, например «channels.sales.name».
export class RelayConfigError extends RelayError {
  readonly kind = 'config';

  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly fields?: FieldErrors,
  ) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

// Любая ошибка Relay: проверка kind сужает тип до класса, например
// error.kind === 'validation' → error.fields.
export type AnyRelayError =
  | RelayValidationError
  | RelayRateLimitError
  | RelayNetworkError
  | RelayConfigError;
