import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRelay } from './client';
import { file } from './file';
import { relaySchemaToZod } from './json-schema';
import { zodToRelaySchema } from './zod-to-relay';

const pdf = new File(['%PDF-1'], 'Резюме.pdf', { type: 'application/pdf' });
const png = new File(['png'], 'фото.png', { type: 'image/png' });

describe('file()', () => {
  it('проверяет тип по маске, ошибка — с кодом contentMediaType', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const relay = createRelay({
      url: 'https://relay.example',
      publicKey: 'pk_1',
      schemas: { job: z.object({ resume: file('application/pdf, image/*') }) },
      fetch,
    });
    const result = await relay.events.job.safeSend({
      resume: new File(['x'], 'a.txt', { type: 'text/plain' }),
    });
    expect(!result.ok && result.error).toMatchObject({
      kind: 'validation',
      fields: {
        resume: {
          code: 'contentMediaType',
          message: 'File type is not allowed.',
        },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(file('image/*').safeParse(png).success).toBe(true);
    expect(file().safeParse(pdf).success).toBe(true);
  });
});

describe('отправка с файлами', () => {
  it('multipart: поля частями формы, файлы — с именами, без своего Content-Type', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ id: 'e1' }, { status: 202 }),
    );
    const relay = createRelay({
      url: 'https://relay.example',
      secretKey: 'sk_1',
      fetch,
    });
    await relay.events.job.send({
      name: 'Анна',
      age: 30,
      agree: true,
      tags: ['a', 'b'],
      meta: { utm_source: 'yandex' },
      resume: pdf,
      photos: [png, png],
      empty: undefined,
    });
    const init = fetch.mock.calls[0][1]!;
    expect(init.headers).not.toHaveProperty('content-type');
    expect(init.headers).toHaveProperty('idempotency-key');
    const form = init.body as FormData;
    // В lib SDK нет DOM.Iterable: части формы — через итератор.
    const keys = Array.from(
      form as unknown as Iterable<[string, unknown]>,
      ([key]) => key,
    );
    expect(keys).toEqual([
      'name',
      'age',
      'agree',
      'tags',
      'tags',
      'meta[utm_source]',
      'resume',
      'photos',
      'photos',
    ]);
    expect(form.get('age')).toBe('30');
    expect(form.get('agree')).toBe('true');
    expect((form.get('resume') as File).name).toBe('Резюме.pdf');
  });

  it('без файлов — JSON, как раньше', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ id: 'e1' }, { status: 202 }),
    );
    const relay = createRelay({
      url: 'https://relay.example',
      secretKey: 'sk_1',
      fetch,
    });
    await relay.events.job.send({ name: 'Анна' });
    expect(fetch.mock.calls[0][1]!.body).toBe('{"name":"Анна"}');
  });
});

describe('файл в схеме Relay', () => {
  it('file(), z.file().mime() и список — format: binary', () => {
    const { schema, warnings } = zodToRelaySchema(
      z.object({
        resume: file('application/pdf, image/*').meta({ title: 'Резюме' }),
        scan: z.file().mime(['application/pdf', 'image/png']).optional(),
        photos: z.array(file('image/*')).min(1).max(3).optional(),
        any: z.file().max(1000).optional(),
      }),
    );
    expect(schema.properties).toEqual({
      resume: {
        type: 'string',
        format: 'binary',
        title: 'Резюме',
        contentMediaType: 'application/pdf, image/*',
      },
      scan: {
        type: 'string',
        format: 'binary',
        contentMediaType: 'application/pdf, image/png',
      },
      photos: {
        type: 'array',
        items: {
          type: 'string',
          format: 'binary',
          contentMediaType: 'image/*',
        },
        minItems: 1,
        maxItems: 3,
      },
      any: { type: 'string', format: 'binary' },
    });
    expect(schema.required).toEqual(['resume']);
    expect(warnings).toEqual([
      'schema.any: file size checks run only on the client; Relay limits all files of an event to 20 MB together.',
    ]);
  });

  it('обратно — file() с теми же типами', () => {
    const form = relaySchemaToZod({
      type: 'object',
      properties: {
        resume: {
          type: 'string',
          format: 'binary',
          contentMediaType: 'application/pdf',
        },
        photos: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          maxItems: 2,
        },
      },
      required: ['resume'],
    });
    expect(form.safeParse({ resume: pdf }).success).toBe(true);
    expect(form.safeParse({ resume: png }).success).toBe(false);
    expect(
      form.safeParse({ resume: pdf, photos: [png, png, png] }).success,
    ).toBe(false);
    expect(zodToRelaySchema(form).schema.properties.resume).toEqual({
      type: 'string',
      format: 'binary',
      contentMediaType: 'application/pdf',
    });
  });
});
