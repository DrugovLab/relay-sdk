import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhook } from './webhook';

const secret = 'whsec_test';
const body = '{"type":"lead","data":{"name":"Анна"}}';

function sign(t: number, payload = body, key = secret): string {
  const v1 = createHmac('sha256', key).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('verifyWebhook', () => {
  const now = 1_700_000_000;
  afterEach(() => vi.useRealTimers());

  function at(seconds: number) {
    vi.useFakeTimers({ now: seconds * 1000, toFake: ['Date'] });
  }

  it('верная подпись — true, тело строкой и байтами', async () => {
    at(now);
    const signature = sign(now);
    await expect(verifyWebhook({ secret, signature, body })).resolves.toBe(
      true,
    );
    await expect(
      verifyWebhook({
        secret,
        signature,
        body: new TextEncoder().encode(body),
      }),
    ).resolves.toBe(true);
  });

  it.each([
    ['другое тело', sign(now, '{}')],
    ['другой секрет', sign(now, body, 'whsec_other')],
    ['нет заголовка', null],
    ['мусор', 't=abc,v1=xyz'],
  ])('%s — false', async (_, signature) => {
    at(now);
    await expect(verifyWebhook({ secret, signature, body })).resolves.toBe(
      false,
    );
  });

  it('подпись старше 5 минут — false, допуск настраивается', async () => {
    at(now + 301);
    await expect(
      verifyWebhook({ secret, signature: sign(now), body }),
    ).resolves.toBe(false);
    await expect(
      verifyWebhook({ secret, signature: sign(now), body, toleranceSec: 600 }),
    ).resolves.toBe(true);
  });

  it('пустой секрет — ошибка, а не false', async () => {
    await expect(
      verifyWebhook({ secret: '', signature: sign(now), body }),
    ).rejects.toThrow('secret is empty');
  });
});
