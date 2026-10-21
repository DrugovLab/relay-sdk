export interface VerifyWebhookOptions {
  // Секрет подписи канала: настройки вебхука в панели, «Подпись запросов».
  secret: string;
  // Заголовок X-Relay-Signature как пришёл.
  signature: string | null | undefined;
  // Тело запроса до разбора JSON: подпись считается по байтам как пришли.
  body: string | Uint8Array;
  // Насколько старую подпись принимать, секунды. По умолчанию 300.
  toleranceSec?: number;
}

const DEFAULT_TOLERANCE_SEC = 300;

// Проверяет, что вебхук отправил Relay: X-Relay-Signature: t=<секунды>,v1=<hex>,
// v1 — HMAC-SHA256 от "<t>.<тело>". Старая подпись не принимается: перехваченный
// запрос нельзя повторить позже. Web Crypto: работает в Node, Deno, Bun и edge.
export async function verifyWebhook({
  secret,
  signature,
  body,
  toleranceSec = DEFAULT_TOLERANCE_SEC,
}: VerifyWebhookOptions): Promise<boolean> {
  if (!secret) throw new Error('verifyWebhook: secret is empty.');
  const parts = new Map(
    (signature ?? '').split(',').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  );
  const t = parts.get('t') ?? '';
  const v1 = parts.get('v1') ?? '';
  if (!/^\d+$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;

  const encoder = new TextEncoder();
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const prefix = encoder.encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  const expected = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  // Сравнение без раннего выхода: время не выдаёт, сколько символов совпало.
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ v1.charCodeAt(index);
  }
  return difference === 0;
}
