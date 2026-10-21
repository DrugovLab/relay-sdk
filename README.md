# @drugovlab/relay-sdk

English | [Русский](README.ru.md)

TypeScript SDK for [Relay](https://relay.drugovlab.ru) — a service that receives events — form submissions, orders, sign-ups — from websites, apps and servers, and delivers them to connected channels: messengers, email, external systems via webhooks.

- Send events from the browser and from the server, with typed data.
- Validate data with a zod schema before the request.
- Describe channels and event types in code and apply them from CI.
- Field errors with codes, ready to show in a form.

The Relay panel is in Russian; panel labels below are quoted as they appear, with a translation.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start): panel setup, first event, connecting a form, sending from a server
- [Keys](#keys)
- [Sending events](#sending-events): field values, validation, captcha, retries
- [Errors](#errors)
- [Configuration as code](#configuration-as-code)
- [CLI](#cli)
- [Forms built from the Relay schema](#forms-built-from-the-relay-schema)
- [Verifying webhooks](#verifying-webhooks)
- [Reference](#reference)
- [Requirements](#requirements)

## Installation

```bash
npm install @drugovlab/relay-sdk zod
```

zod is a peer dependency. A client without its own schemas adds no zod to the website bundle.

## Quick start

### Panel setup

1. Create a project in the [Relay panel](https://relay.drugovlab.ru).
2. Create an event type and its fields. The type key is shown under its name: `/v1/events/<key>` — the SDK sends events by this key.
3. Connect channels to the type — where events are delivered.
4. On the type's «Подключение» (Connection) tab or in the project settings, add your site domain to the allowed list, e.g. `example.com` and `localhost` for development. Scheme and port do not matter, subdomains are included: `example.com` also allows `www.example.com`. To accept events only from a subdomain, add just that subdomain: `shop.example.com` does not allow `example.com`. The public key `pk_…` is shown there too.

The secret key `sk_…` is needed only for sending from a server and for the CLI. The panel shows it once, when the project is created; a new one is issued in the project settings with «Перевыпустить» (Reissue).

### First event

```ts
import { createRelay } from '@drugovlab/relay-sdk';

const relay = createRelay<{ lead: { name: string; phone: string } }>({
  publicKey: 'pk_…',
});

const result = await relay.events.lead.safeSend({
  name: 'John',
  phone: '+1 202 555 0143',
});

if (result.ok) {
  console.log('Sent', result.id);
}
```

Relay validates the data against the type schema and delivers the event to the channels connected to the type. The result is visible in the project journal.

### Connecting a form

Markup: the `name` of each input is the field key in the type schema.

```html
<form id="lead-form" novalidate>
  <input name="name" />
  <input name="phone" type="tel" />
  <label><input type="checkbox" name="services" value="Delivery" /> Delivery</label>
  <label><input type="checkbox" name="services" value="Assembly" /> Assembly</label>
  <label><input type="checkbox" name="consent" /> I agree to data processing</label>
  <button type="submit">Send</button>
</form>
```

Sending: values are collected into an object of the right types (see [Field values](#field-values)), field errors are shown by code.

```ts
import { createRelay, type FieldErrors } from '@drugovlab/relay-sdk';

type Lead = {
  name: string;
  phone: string;
  services?: string[];
  consent: boolean;
};

const relay = createRelay<{ lead: Lead }>({ publicKey: 'pk_…' });
const form = document.querySelector<HTMLFormElement>('#lead-form')!;

const MESSAGES: Record<string, string> = {
  required: 'Please fill in this field',
  format: 'Please check the format',
  const: 'Consent is required',
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = new FormData(form);
  const services = values.getAll('services').map(String);

  const button = form.querySelector('button')!;
  button.disabled = true;
  const result = await relay.events.lead.safeSend({
    name: String(values.get('name') ?? '').trim(),
    phone: String(values.get('phone') ?? '').trim(),
    ...(services.length > 0 && { services }),
    consent: values.get('consent') === 'on',
  });
  button.disabled = false;

  if (result.ok) {
    form.reset();
    alert('Sent');
  } else if (result.error.kind === 'validation') {
    showErrors(result.error.fields);
  } else {
    alert('Could not send, please try again later');
  }
});

function showErrors(fields: FieldErrors) {
  for (const [name, { code }] of Object.entries(fields)) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) {
      input.setCustomValidity(MESSAGES[code] ?? 'Please check the value');
      input.reportValidity();
      input.addEventListener('input', () => input.setCustomValidity(''), {
        once: true,
      });
    }
  }
}
```

In React, Vue and other frameworks the steps are the same: build an object from the form state, call `safeSend`, show `fields` next to the inputs.

### Sending from a server

From a backend, events are sent with the secret key: the allowed domains list and captcha are not checked. Example — a Next.js route handler:

```ts
// app/api/lead/route.ts
import { createRelay } from '@drugovlab/relay-sdk';

const relay = createRelay({ secretKey: process.env.RELAY_SECRET_KEY! });

export async function POST(request: Request) {
  const result = await relay.events.lead.safeSend(await request.json());
  if (result.ok) return Response.json({ id: result.id });
  return Response.json(
    {
      kind: result.error.kind,
      fields: result.error.kind === 'validation' ? result.error.fields : {},
    },
    { status: result.error.kind === 'validation' ? 400 : 502 },
  );
}
```

## Keys

| Key | Where | What it can do |
|---|---|---|
| `publicKey` (`pk_…`) | browser | send events from allowed domains |
| `secretKey` (`sk_…`) | server, CLI | send events and apply configuration |

The secret key does not work in the browser: `createRelay` throws with it when it sees `window`. Keep it in server and CI environment variables.

## Sending events

The event client is `relay.events.<event key>`:

```ts
await relay.events.lead.send(data);                    // { id } or throws
const result = await relay.events.lead.safeSend(data); // { ok: true, id } | { ok: false, error }
```

### Field values

Events are sent as JSON. Relay does not coerce types: a number sent as a string fails validation.

| Panel field | zod | Value |
|---|---|---|
| Text | `z.string()` | `'John'` |
| Email, link | `z.email()`, `z.url()` | `'john@example.com'`, `'https://example.com'` |
| Phone | `phone()` | a string in any form: `'+1 (202) 555-0143'` |
| Number, integer | `z.number()`, `z.int()` | a number: `2.5`, `3` |
| Date | `z.iso.date()` | `'2026-10-15'` |
| Date and time | `z.iso.datetime()` | `'2026-10-15T12:30:00+03:00'`; without an offset — the project time zone |
| Time | `z.iso.time()` | `'15:30'` or `'15:30:00'`, without an offset |
| Yes/no | `z.boolean()` | `true` or `false` |
| Choice from a list | `z.enum([...])` | one option, exactly as written in the list |
| Several from a list | `z.array(z.enum([...]))` | an array of options: `['Delivery', 'Assembly']` |
| Options with labels | `options({ pro: 'Pro plan' })` | the value (`'pro'`); people see the label |
| Key — value | `z.record(z.string(), z.string())` | an object of strings: `{ utm_source: 'google' }` |
| File | `file()`, `file('image/*, application/pdf')` | a `File`; several — `z.array(file())` |

With `options()` the site sends a stable value, and the form, Telegram, email and the Relay log show the label: renaming an option does not change the site code. The webhook receives the value. `z.array(options({...}))` works for several from a list.

A key — value field takes the site's tags and metadata: up to 50 keys of 1–100 characters, string values up to 1000 characters. In the browser `pageMeta()` collects UTM tags, the page without the query string and the external referrer; the tags are kept for the browser tab session, so they survive moving to another page:

```ts
import { pageMeta } from '@drugovlab/relay-sdk';

await relay.events.lead.safeSend({ name, phone, meta: pageMeta() });
```

- Do not send an optional field without a value: an empty string is a value too, and Relay checks its length and format.
- Relay drops fields that are not in the type schema.
- A required checkbox («Должно быть отмечено», must be checked) is `true`; `false` gives the `const` error.

### Validation before the request

Pass zod schemas — data is validated before the request, and types come from the schemas:

```ts
import { createRelay, phone } from '@drugovlab/relay-sdk';
import { z } from 'zod';

const lead = z.object({
  name: z.string().min(1),
  phone: phone(),
  comment: z.string().max(1000).optional(),
});

const relay = createRelay({ publicKey: 'pk_…', schemas: { lead } });

relay.events.lead.schema; // the same schema — for the form
```

`phone()` accepts a number in any form: `8 (999) 123-45-67`, `+1 202 555 0143`, `380501234567`. Before the request it checks the characters and the number of digits; Relay validates the number by country rules and stores it in E.164: `+12025550143`.

Without schemas, only Relay validates the data. Types are then set explicitly, as in the quick start, or taken from the configuration: `createRelay<typeof config>` — see [Frontend](#frontend).

### Files

A file field takes a `File` — from `<input type="file">`, a drag-and-drop zone or `new File(...)` on a server. With files in the data, `send` sends the event as `multipart/form-data`; without them — JSON, as usual.

```ts
import { createRelay, file } from '@drugovlab/relay-sdk';
import { z } from 'zod';

const relay = createRelay({
  publicKey: 'pk_…',
  schemas: {
    job: z.object({
      name: z.string(),
      resume: file('application/pdf, image/*'),
      photos: z.array(file('image/*')).max(5).optional(),
    }),
  },
});

const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
await relay.events.job.safeSend({ name: 'Anna', resume: input.files![0] });
```

- `file(accept)` — allowed types separated by commas, like `accept` of `<input type="file">`; a wrong type is a `validation` error with the code `contentMediaType`.
- All files of an event together — up to 20 MB, a field — up to 10 files.
- Relay delivers files as attachments to Telegram and email; a webhook gets download links.

### Captcha

If captcha is enabled for the event type, pass the token from its widget, e.g. Yandex SmartCaptcha:

```ts
await relay.events.lead.send(data, { captchaToken });
```

### Retries

Each `send` gets an idempotency key. On a network error or a 5xx response the SDK retries twice with the same key: if the first request reached Relay and only the reply was lost, the retry returns the same event id instead of creating a second event.

If the visitor submits the form again after a `network` error, pass the same key yourself, created once per filled form:

```ts
const idempotencyKey = crypto.randomUUID();
// on every submit of this form
await relay.events.lead.safeSend(data, { idempotencyKey });
```

## Errors

`send` throws, and `safeSend` returns, an error with a `kind` field:

| kind | Class | Cause | What to do |
|---|---|---|---|
| `validation` | `RelayValidationError` | the data failed validation | show the errors from `fields` |
| `captcha` | `RelayCaptchaError` | no captcha token (`code: 'captcha_required'`) or the captcha failed (`'captcha_failed'`) | reset the widget and ask to pass it again |
| `rate_limit` | `RelayRateLimitError` | too many requests | retry after `retryAfter` seconds |
| `network` | `RelayNetworkError` | Relay is unreachable or did not respond, after the SDK's own retries | keep the entered data, ask to try again |
| `config` | `RelayConfigError` | wrong key, domain not allowed, no such type; `code` is the server error code | fix the setup |

Checking `kind` narrows the error type in TypeScript: after `error.kind === 'validation'`, `error.fields` is available.

Data that cannot be converted to JSON (`BigInt`, circular references) is a bug in the calling code: `safeSend` throws it too.

### Field errors

`fields` holds the first error of each field: `{ phone: { code: 'format', message: '…' } }`. The codes are the same for validation with your own schema and validation in Relay:

| code | When |
|---|---|
| `required` | the field is missing |
| `type` | the value has another type |
| `format` | invalid email, link, date or phone |
| `pattern` | does not match `regex`, `startsWith` and other patterns |
| `minLength`, `maxLength` | string length out of bounds |
| `minimum`, `maximum` | number out of bounds |
| `exclusiveMinimum`, `exclusiveMaximum` | number out of strict bounds (`gt`, `lt`) |
| `minItems`, `maxItems` | fewer or more options selected than allowed |
| `enum` | a value not from the list, including in multi-select |
| `const` | a required checkbox is not checked |
| `custom` | your own `refine` failed |

`message` is meant for the developer. Pick the text for the site visitor by code:

```ts
const MESSAGES: Record<string, string> = {
  required: 'Please fill in this field',
  format: 'Please check the format',
  const: 'Consent is required',
};

const result = await relay.events.lead.safeSend(data);

if (!result.ok && result.error.kind === 'validation') {
  for (const [field, { code }] of Object.entries(result.error.fields)) {
    form.setError(field, MESSAGES[code] ?? 'Please check the value');
  }
}
```

## Configuration as code

Channels, event types and the routes between them can be described in code instead of the panel. The configuration lives in the repository, goes through review and is applied from CI. In the panel, what is described gets the «Из кода» (From code) mark.

### Schemas

Keep schemas in a separate file: both the configuration and the website forms import them.

```ts
// schemas.ts
import { phone } from '@drugovlab/relay-sdk';
import { z } from 'zod';

export const lead = z.object({
  name: z.string().min(1).meta({ title: 'Name' }),
  phone: phone().meta({ title: 'Phone' }),
  consent: z.literal(true).meta({ title: 'Consent to data processing' }),
});
```

`.meta({ title })` is the field label in the panel and in messages.

### relay.config.ts

```ts
// relay.config.ts
import { defineRelay, env } from '@drugovlab/relay-sdk';
import { lead } from './schemas';

export default defineRelay({
  channels: {
    sales: { type: 'relay_telegram', name: 'Sales' },
    crm: { type: 'webhook', url: env('CRM_URL') },
  },
  events: {
    lead: {
      name: 'Website lead',
      schema: lead,
      send: {
        sales: { defaultTemplate: '<b>Lead #{{_number}}</b>\nName: {{name}}' },
        crm: { template: '{"name": {{name}}, "phone": {{phone}}}' },
      },
    },
  },
});
```

The event key (`lead`) is the receiving address: do not change it after applying. The channel key (`sales`) is the channel's permanent identifier in the project.

### Channels

| type | Fields | Purpose |
|---|---|---|
| `relay_telegram` | `recipients?` | the Relay bot, no token needed |
| `telegram` | `botToken?`, `recipients?` | your own bot |
| `email` | `host`, `port`, `secure`, `user?`, `pass?`, `from`, `to?` | email over SMTP |
| `webhook` | `url?`, `method?`, `headers?` | an HTTP request to an external system |
| `http` | `baseUrl?`, `method?`, `headers?`, `auth?`, `secrets?`, `success?`, `retry?`, `timeoutSec?` | an HTTP request in the receiver's format |

Every channel has `name` — its name in the panel; without it, the name equals the key.

A Telegram recipient is `{ chatId, name?, threadId? }` or `{ chatId, projectTopic: true }`: a project topic in a private chat, created by Relay.

The `http` channel sends a request in the receiver's format. `{{secret.NAME}}` in the URL and headers is replaced with the value from `secrets`; `auth` is `{ type: 'bearer', token }` or `{ type: 'basic', user, password }`. The route sets the request: `{ request }` with a path appended to `baseUrl`, query parameters, headers and a body (`json`, `xml`, `text`, `form`, `multipart`).

```ts
channels: {
  bitrix: {
    type: 'http',
    baseUrl: 'https://example.bitrix24.ru/rest/1/{{secret.token}}',
    secrets: { token: env('BITRIX_TOKEN') },
  },
},
events: {
  lead: {
    name: 'Website lead',
    schema: lead,
    send: {
      bitrix: {
        request: {
          url: 'crm.lead.add.json',
          body: {
            format: 'form',
            fields: [
              { name: 'fields[TITLE]', value: 'Lead #{{_number}}' },
              { name: 'fields[NAME]', value: '{{name}}' },
            ],
          },
        },
      },
    },
  },
},
```

What is not in code is managed in the panel: recipients, the bot token, the email password, the webhook URL and headers, the URL, headers, secrets and auth of an `http` channel. This keeps secrets out of the repository. If a secret is needed in code, pass it with `env('NAME')`: the value is read from the environment variable when the configuration is applied. Unlike `process.env.NAME`, a missing variable stops the apply with an error listing every missing one. With `process.env`, the field silently drops out of the request, and Relay keeps the previous value from the panel.

Relay does not create a new channel without a required field and returns an error with the path, e.g. `channels.crm.config.url`.

### Routes

`send` lists the channels the event goes to and the message template:

| Value | Template |
|---|---|
| `true` | the standard message: type name, number and fields |
| `{ template }` | set by code; an edit in the panel is reset by the next apply |
| `{ defaultTemplate }` | initial; an edit in the panel is kept |
| `{ request }` | `http` channels only: a request instead of a template |

Templates are Mustache: `{{name}}`, event number `{{_number}}`, id `{{_id}}`. Values are escaped per channel: HTML for Telegram, JSON for webhooks. A multi-select field renders as «a, b», and `{{#services}}…{{/services}}` iterates its options. `send` may also reference a channel created in the panel — by its key.

Without `send`, the type's routes are managed in the panel.

### Applying

From CI or locally — with [`relay push`](#cli). From backend code — with `push`:

```ts
import { createRelay } from '@drugovlab/relay-sdk';
import config from './relay.config';

const relay = createRelay({ secretKey: process.env.RELAY_SECRET_KEY!, config });

const { changes, warnings } = await relay.push({ dryRun: true });
await relay.push();
```

- Applying is a single transaction: all or nothing.
- `dryRun: true` lists the changes without applying them. Breaking schema changes, such as a new required field, are listed in `breaking`.
- A channel or type removed from the configuration is not deleted; it goes back to being managed in the panel. To delete it, use `prune: true`.
- `warnings` lists zod checks that Relay does not carry over: `refine`, `transform`, `pipe`. They run only in the SDK.

Such a client validates outgoing events with the configuration schemas. Its types contain only the configuration's events; send events of types still managed in the panel with a client without `config`.

### Frontend

The configuration does not go to the frontend: it contains channels and templates, and `defineRelay` throws in the browser. Import only its type:

```ts
import type config from './relay.config';

const relay = createRelay<typeof config>({ publicKey: 'pk_…' });
```

For validation before the request — the schemas from `schemas.ts`:

```ts
import { lead } from './schemas';

const relay = createRelay({ publicKey: 'pk_…', schemas: { lead } });
```

### Supported schemas

Relay stores the type schema in a subset of JSON Schema. The SDK converts to it:

| zod | In Relay |
|---|---|
| `z.string()`, `.min()`, `.max()`, `.regex()`, `.startsWith()` | a string with length and pattern |
| `z.email()`, `z.url()`, `z.iso.date()`, `z.iso.datetime()`, `z.iso.time()` | email, link, date, date and time, time formats |
| `phone()` | phone |
| `z.number()`, `z.int()`, `.min()`, `.max()`, `.gt()`, `.lt()` | number and integer with bounds, including strict ones |
| `z.boolean()`, `z.literal(true)` | yes/no and a required checkbox |
| `z.enum([...])` | choice from a list |
| `options({ value: 'Label' })` | choice from a list with labels (`oneOf` with `const` and `title`) |
| `z.record(z.string(), z.string())`, values `.max()` | key — value (an object of strings) |
| `file()`, `file(accept)`, `z.file().mime([...])`, `z.array(file())` | file and several files (`format: binary`, `contentMediaType`) |
| `z.array(z.enum([...]))`, `.min()`, `.max()` | several from a list |
| `.optional()`, `.default(value)` | optional field and default value |
| `.meta({ title })` | field label |

Limitations:

- a field has one pattern; regex flags `i`, `m`, `s` are carried over, flag `v` is not;
- arrays only of values from a list (`z.array(z.enum([...]))` or `z.array(options({...}))`);
- objects only as `z.record(z.string(), z.string())`; nested objects, `null` and union types are not supported — `push` names the field.

## CLI

```bash
npx relay push --dry-run   # show the changes
npx relay push             # apply
npx relay push --prune     # apply and delete what was removed from the configuration
npx relay pull             # write relay.config.ts from Relay
```

| Flag | Command | Meaning |
|---|---|---|
| `--config <path>` | push | configuration file, `relay.config.ts` by default |
| `--out <path>` | pull | where to write, `relay.config.ts` by default |
| `--force` | pull | overwrite an existing file |
| `--env-file <path>` | both | environment file, `.env` by default if it exists |

`RELAY_SECRET_KEY` is the project secret key. Variables from the file are loaded into `process.env` before the configuration is read; variables already set in the environment win.

`relay.config.ts` is loaded as TypeScript: imports without extensions and `tsconfig.json` path aliases work. On error, the CLI writes it to stderr and exits with code 1.

### Moving from the panel: relay pull

For a project already set up in the panel, `relay pull` writes its configuration to code:

- schemas become zod code, templates become `defaultTemplate`;
- secrets, recipients, the webhook URL and headers, the auth of an `http` channel do not go into the file and stay in the panel — `pull` lists them;
- what looks different in code than in Relay, `pull` prints as a separate list.

After `pull`, `relay push --dry-run` shows what would change when switching to code.

### GitHub Actions

```yaml
- name: Relay — configuration changes
  if: github.event_name == 'pull_request'
  run: npx relay push --dry-run
  env:
    RELAY_SECRET_KEY: ${{ secrets.RELAY_SECRET_KEY }}
    CRM_URL: ${{ secrets.CRM_URL }}

- name: Relay — apply configuration
  if: github.ref == 'refs/heads/main'
  run: npx relay push
  env:
    RELAY_SECRET_KEY: ${{ secrets.RELAY_SECRET_KEY }}
    CRM_URL: ${{ secrets.CRM_URL }}
```

## Forms built from the Relay schema

If form fields are edited in the panel, the form can get the schema from Relay:

```ts
const schema = await relay.events.lead.fetchSchema({ fallback: lead });
```

It returns a zod schema; if Relay is unreachable — `fallback`. The schema converter is loaded on the first call and is not part of the main bundle.

## Verifying webhooks

A webhook channel signs every request with `X-Relay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. The secret is in the channel settings, «Подпись запросов». On your server:

```ts
import { verifyWebhook } from '@drugovlab/relay-sdk';

export async function POST(request: Request) {
  const body = await request.text(); // raw body, before JSON.parse
  const ok = await verifyWebhook({
    secret: process.env.RELAY_SIGNING_SECRET!,
    signature: request.headers.get('x-relay-signature'),
    body,
  });
  if (!ok) return new Response('invalid signature', { status: 401 });
  const event = JSON.parse(body);
  // ...
}
```

Signatures older than 5 minutes are rejected (`toleranceSec` changes it). In Express, read the raw body with `express.raw({ type: 'application/json' })`.

## Reference

### createRelay(options)

| Option | Type | |
|---|---|---|
| `publicKey` | `string` | browser key |
| `secretKey` | `string` | server key |
| `schemas` | `Record<string, ZodObject>` | schemas for validation before the request |
| `config` | result of `defineRelay` | configuration; only with `secretKey` |
| `env` | `Record<string, string>` | values for `env()`, `process.env` by default |
| `timeoutMs` | `number` | request timeout: 10 s for events, 60 s for `push` |
| `fetch` | `typeof fetch` | a custom `fetch` |

Exactly one key is required.

### relay.events.\<key>

| | |
|---|---|
| `send(data, { captchaToken?, idempotencyKey? })` | `Promise<{ id }>`, throws on error |
| `safeSend(data, { captchaToken?, idempotencyKey? })` | `Promise<{ ok: true, id } \| { ok: false, error }>` |
| `fetchSchema({ fallback? })` | `Promise<ZodObject>` — the type schema from Relay |
| `schema` | your own event schema or `undefined` |

### relay.push(options)

Only on a client with `secretKey` and `config`. Options: `dryRun`, `prune`. Returns `{ applied, changes, warnings }`.

### defineRelay, env, phone, options, pageMeta, file

- `defineRelay({ channels?, events })` — the configuration; suggests channel keys in `send`.
- `env(name)` — a reference to an environment variable for a secret.
- `phone()` — a zod schema for a phone number.
- `options({ value: 'Label' })` — a choice from a list with labels.
- `pageMeta()` — UTM tags, page and referrer for a key — value field; `{}` outside the browser.
- `file(accept?)` — a zod schema for a file field.

## Requirements

- Node.js 20.12 or newer — for the server and CLI.
- Browsers with ES2022 support.
- zod 4.

## License

[MIT](LICENSE)
