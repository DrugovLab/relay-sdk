# @drugovlab/relay-sdk

[English](README.md) | Русский

TypeScript SDK для [Relay](https://relay.drugovlab.ru) — сервиса, который принимает события — заявки, заказы, регистрации — с сайтов, из приложений и с серверов и доставляет их в подключённые каналы: мессенджеры, почту, внешние системы.

- Отправка событий из браузера и с сервера с типами данных.
- Проверка данных zod-схемой до запроса.
- Описание каналов и типов событий в коде и применение из CI.
- Ошибки с кодами для показа в форме.

## Содержание

- [Установка](#установка)
- [Быстрый старт](#быстрый-старт): подготовка в панели, первое событие, подключение формы, отправка с сервера
- [Ключи](#ключи)
- [Отправка событий](#отправка-событий): значения полей, проверка, капча, повторы
- [Ошибки](#ошибки)
- [Конфигурация из кода](#конфигурация-из-кода)
- [CLI](#cli)
- [Формы по схеме из Relay](#формы-по-схеме-из-relay)
- [Справочник](#справочник)
- [Требования](#требования)

## Установка

```bash
npm install @drugovlab/relay-sdk zod
```

zod — peer-зависимость. Клиент без своих схем в бандл сайта zod не добавляет.

## Быстрый старт

### Подготовка в панели

1. В [панели Relay](https://relay.drugovlab.ru) создайте проект.
2. Создайте тип события и задайте его поля. Ключ типа виден под названием: `/v1/events/<ключ>` — по нему SDK отправляет события.
3. Подключите к типу каналы — куда уходят события.
4. На вкладке «Подключение» типа или в настройках проекта добавьте домен сайта в разрешённые, например `example.ru` и `localhost` для разработки. Схема и порт не важны, поддомены входят: `example.ru` разрешает и `www.example.ru`. Чтобы принимать события только с поддомена, укажите его: `shop.example.ru` не разрешает `example.ru`. Там же — публичный ключ `pk_…`.

Секретный ключ `sk_…` нужен только для отправки с сервера и для CLI. Панель показывает его один раз — при создании проекта; новый выпускается в настройках проекта, кнопкой «Перевыпустить».

### Первое событие

```ts
import { createRelay } from '@drugovlab/relay-sdk';

const relay = createRelay<{ lead: { name: string; phone: string } }>({
  publicKey: 'pk_…',
});

const result = await relay.events.lead.safeSend({
  name: 'Иван',
  phone: '+7 999 123-45-67',
});

if (result.ok) {
  console.log('Заявка отправлена', result.id);
}
```

Relay проверит данные по схеме типа и отправит событие в каналы, подключённые к типу. Результат виден в журнале проекта.

### Подключение формы

Разметка: `name` каждого поля — ключ поля в схеме типа.

```html
<form id="lead-form" novalidate>
  <input name="name" />
  <input name="phone" type="tel" />
  <label><input type="checkbox" name="services" value="Доставка" /> Доставка</label>
  <label><input type="checkbox" name="services" value="Сборка" /> Сборка</label>
  <label><input type="checkbox" name="consent" /> Согласен на обработку данных</label>
  <button type="submit">Отправить</button>
</form>
```

Отправка: значения собираются в объект нужных типов (см. [Значения полей](#значения-полей)), ошибки полей показываются по коду.

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
  required: 'Заполните поле',
  format: 'Проверьте формат',
  const: 'Нужно согласие',
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
    alert('Заявка отправлена');
  } else if (result.error.kind === 'validation') {
    showErrors(result.error.fields);
  } else {
    alert('Не удалось отправить, попробуйте позже');
  }
});

function showErrors(fields: FieldErrors) {
  for (const [name, { code }] of Object.entries(fields)) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) {
      input.setCustomValidity(MESSAGES[code] ?? 'Проверьте значение');
      input.reportValidity();
      input.addEventListener('input', () => input.setCustomValidity(''), {
        once: true,
      });
    }
  }
}
```

В React, Vue и других фреймворках порядок тот же: собрать объект из состояния формы, вызвать `safeSend`, показать `fields` у полей.

### Отправка с сервера

С бэкенда события отправляются секретным ключом: список разрешённых сайтов и капча не проверяются. Пример — обработчик Next.js:

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

## Ключи

| Ключ | Где | Что может |
|---|---|---|
| `publicKey` (`pk_…`) | браузер | отправлять события с доменов из списка разрешённых |
| `secretKey` (`sk_…`) | сервер, CLI | отправлять события и применять конфигурацию |

Секретный ключ в браузере не работает: `createRelay` с ним бросает ошибку, если видит `window`. Храните его в переменных окружения сервера и CI.

## Отправка событий

Клиент события — `relay.events.<ключ события>`:

```ts
await relay.events.lead.send(data);              // { id } или исключение
const result = await relay.events.lead.safeSend(data); // { ok: true, id } | { ok: false, error }
```

### Значения полей

События уходят в JSON. Relay не приводит типы: число строкой не пройдёт проверку.

| Поле в панели | zod | Значение |
|---|---|---|
| Текст | `z.string()` | `'Иван'` |
| Email, ссылка | `z.email()`, `z.url()` | `'ivan@example.ru'`, `'https://example.ru'` |
| Телефон | `phone()` | строка в любом виде: `'8 (999) 123-45-67'` |
| Число, целое число | `z.number()`, `z.int()` | число: `2.5`, `3` |
| Дата | `z.iso.date()` | `'2026-10-15'` |
| Дата и время | `z.iso.datetime()` | `'2026-10-15T12:30:00+03:00'`; без пояса — время пояса проекта |
| Время | `z.iso.time()` | `'15:30'` или `'15:30:00'`, без пояса |
| Да/нет | `z.boolean()` | `true` или `false` |
| Выбор из списка | `z.enum([...])` | один вариант, как он записан в списке |
| Несколько из списка | `z.array(z.enum([...]))` | массив вариантов: `['Доставка', 'Сборка']` |
| Варианты с подписями | `options({ pro: 'Тариф Про' })` | значение (`'pro'`); люди видят подпись |
| Ключ — значение | `z.record(z.string(), z.string())` | объект строк: `{ utm_source: 'yandex' }` |

С `options()` сайт отправляет постоянное значение, а форма, Telegram, почта и журнал Relay показывают подпись: переименование варианта не меняет код сайта. Вебхук получает значение. Для нескольких из списка — `z.array(options({...}))`.

Поле «ключ — значение» принимает метки и метаданные сайта: до 50 ключей от 1 до 100 символов, значения — строки до 1000 символов. В браузере `pageMeta()` собирает UTM-метки, страницу без query и внешний источник перехода; метки хранятся на сессию вкладки и не теряются при переходе на другую страницу:

```ts
import { pageMeta } from '@drugovlab/relay-sdk';

await relay.events.lead.safeSend({ name, phone, meta: pageMeta() });
```

- Необязательное поле без значения не передавайте: пустая строка — тоже значение, Relay проверит её длину и формат.
- Поля, которых нет в схеме типа, Relay отбрасывает.
- Обязательная галочка («Должно быть отмечено») — `true`; `false` даёт ошибку `const`.

### Проверка до запроса

Передайте zod-схемы — данные проверяются до запроса, а типы берутся из схем:

```ts
import { createRelay, phone } from '@drugovlab/relay-sdk';
import { z } from 'zod';

const lead = z.object({
  name: z.string().min(1),
  phone: phone(),
  comment: z.string().max(1000).optional(),
});

const relay = createRelay({ publicKey: 'pk_…', schemas: { lead } });

relay.events.lead.schema; // та же схема — для формы
```

`phone()` принимает номер в любом виде: `8 (999) 123-45-67`, `+7 999 1234567`, `380501234567`. До запроса проверяются символы и число цифр, по правилам стран номер проверяет Relay и хранит в формате E.164: `+79991234567`.

Без схем данные проверяет только Relay. Типы тогда задаются явно, как в быстром старте, или берутся из конфигурации: `createRelay<typeof config>` — см. [Фронтенд](#фронтенд).

### Капча

Если у типа события включена капча, передайте токен из её виджета, например Яндекс SmartCaptcha:

```ts
await relay.events.lead.send(data, { captchaToken });
```

### Повторы

Каждый `send` получает ключ идемпотентности. При сетевой ошибке или ответе 5xx SDK повторяет запрос дважды с тем же ключом: если первый запрос дошёл до Relay и потерялся только ответ, повтор вернёт id того же события, а не создаст второе.

Если посетитель отправляет форму ещё раз после ошибки `network`, передайте тот же ключ сами — один на заполненную форму:

```ts
const idempotencyKey = crypto.randomUUID();
// при каждой отправке этой формы
await relay.events.lead.safeSend(data, { idempotencyKey });
```

## Ошибки

`send` бросает, а `safeSend` возвращает ошибку с полем `kind`:

| kind | Класс | Причина | Что делать |
|---|---|---|---|
| `validation` | `RelayValidationError` | данные не прошли проверку | показать ошибки из `fields` |
| `captcha` | `RelayCaptchaError` | нет токена капчи (`code: 'captcha_required'`) или она не пройдена (`'captcha_failed'`) | сбросить виджет и попросить пройти её снова |
| `rate_limit` | `RelayRateLimitError` | превышен лимит запросов | повторить через `retryAfter` секунд |
| `network` | `RelayNetworkError` | Relay недоступен или не ответил после повторов SDK | сохранить введённые данные, предложить отправить ещё раз |
| `config` | `RelayConfigError` | неверный ключ, домен не разрешён, нет такого типа; `code` — код ошибки сервера | исправить настройку |

Проверка `kind` уточняет тип ошибки в TypeScript: после `error.kind === 'validation'` доступно `error.fields`.

Данные, которые не переводятся в JSON (`BigInt`, циклические ссылки), — ошибка в коде: её бросает и `safeSend`.

### Ошибки полей

`fields` — первая ошибка каждого поля: `{ phone: { code: 'format', message: '…' } }`. Коды одинаковые для проверки своей схемой и проверки в Relay:

| code | Когда |
|---|---|
| `required` | поле не передано |
| `type` | значение другого типа |
| `format` | неверный email, ссылка, дата или телефон |
| `pattern` | не подходит под `regex`, `startsWith` и другие шаблоны |
| `minLength`, `maxLength` | длина строки вне границ |
| `minimum`, `maximum` | число вне границ |
| `exclusiveMinimum`, `exclusiveMaximum` | число вне строгих границ (`gt`, `lt`) |
| `minItems`, `maxItems` | выбрано меньше или больше допустимого |
| `enum` | значение не из списка, в том числе в мультивыборе |
| `const` | обязательная галочка не отмечена |
| `custom` | не прошёл свой `refine` |

`message` предназначено разработчику. Текст для посетителя сайта подбирайте по коду:

```ts
const MESSAGES: Record<string, string> = {
  required: 'Заполните поле',
  format: 'Проверьте формат',
  const: 'Нужно согласие на обработку данных',
};

const result = await relay.events.lead.safeSend(data);

if (!result.ok && result.error.kind === 'validation') {
  for (const [field, { code }] of Object.entries(result.error.fields)) {
    form.setError(field, MESSAGES[code] ?? 'Проверьте значение');
  }
}
```

## Конфигурация из кода

Каналы, типы событий и маршруты между ними можно описать в коде вместо панели. Конфигурация хранится в репозитории, проходит ревью и применяется из CI. В панели описанное получает пометку «Из кода».

### Схемы

Схемы держите в отдельном файле: их импортируют и конфигурация, и формы на сайте.

```ts
// schemas.ts
import { phone } from '@drugovlab/relay-sdk';
import { z } from 'zod';

export const lead = z.object({
  name: z.string().min(1).meta({ title: 'Имя' }),
  phone: phone().meta({ title: 'Телефон' }),
  consent: z.literal(true).meta({ title: 'Согласие на обработку данных' }),
});
```

`.meta({ title })` — подпись поля в панели и в сообщениях.

### relay.config.ts

```ts
// relay.config.ts
import { defineRelay, env } from '@drugovlab/relay-sdk';
import { lead } from './schemas';

export default defineRelay({
  channels: {
    sales: { type: 'relay_telegram', name: 'Отдел продаж' },
    crm: { type: 'webhook', url: env('CRM_URL') },
  },
  events: {
    lead: {
      name: 'Заявка с сайта',
      schema: lead,
      send: {
        sales: { defaultTemplate: '<b>Заявка #{{_number}}</b>\nИмя: {{name}}' },
        crm: { template: '{"name": {{name}}, "phone": {{phone}}}' },
      },
    },
  },
});
```

Ключ события (`lead`) — адрес приёма: после применения его не меняют. Ключ канала (`sales`) — постоянный идентификатор канала в проекте.

### Каналы

| type | Поля | Назначение |
|---|---|---|
| `relay_telegram` | `recipients?` | бот Relay, токен не нужен |
| `telegram` | `botToken?`, `recipients?` | свой бот |
| `email` | `host`, `port`, `secure`, `user?`, `pass?`, `from`, `to?` | почта через SMTP |
| `webhook` | `url?`, `method?`, `headers?` | HTTP-запрос во внешнюю систему |

У любого канала есть `name` — название в панели; без него название равно ключу.

Получатель Telegram — `{ chatId, name?, threadId? }` или `{ chatId, projectTopic: true }`: своя тема проекта в личном чате, её создаёт Relay.

Чего нет в коде, то ведётся в панели: получатели, токен бота, пароль почты, адрес и заголовки вебхука. Так секреты не попадают в репозиторий. Если секрет нужен в коде, передайте его через `env('ИМЯ')`: значение берётся из переменной окружения при применении. В отличие от `process.env.ИМЯ`, пропущенная переменная останавливает применение ошибкой со списком всех недостающих. С `process.env` поле молча не попадёт в запрос, и Relay оставит прежнее значение из панели.

Новый канал без обязательного поля Relay не создаст и вернёт ошибку с путём, например `channels.crm.config.url`.

### Маршруты

`send` — каналы, в которые уходит событие, и шаблон сообщения:

| Значение | Шаблон |
|---|---|
| `true` | стандартное сообщение: название типа, номер и поля |
| `{ template }` | задаёт код; правка в панели сбрасывается при следующем применении |
| `{ defaultTemplate }` | начальный; правка в панели сохраняется |

Шаблоны — Mustache: `{{name}}`, номер события `{{_number}}`, id `{{_id}}`. Значения экранируются по каналу: HTML для Telegram, JSON для вебхука. Поле «несколько из списка» подставляется как «a, b», а `{{#services}}…{{/services}}` перебирает его варианты. В `send` можно указать и канал, созданный в панели, — по его ключу.

Без `send` маршруты типа ведутся в панели.

### Применение

Из CI или локально — командой [`relay push`](#cli). Из кода бэкенда — методом `push`:

```ts
import { createRelay } from '@drugovlab/relay-sdk';
import config from './relay.config';

const relay = createRelay({ secretKey: process.env.RELAY_SECRET_KEY!, config });

const { changes, warnings } = await relay.push({ dryRun: true });
await relay.push();
```

- Применение — одной транзакцией: всё или ничего.
- `dryRun: true` — список изменений без применения. Ломающие изменения схемы, например новое обязательное поле, отмечены в `breaking`.
- Канал или тип, убранный из конфигурации, не удаляется, а снова ведётся в панели. Удалить его — `prune: true`.
- `warnings` — проверки zod, которые Relay не переносит: `refine`, `transform`, `pipe`. Они работают только в SDK.

Такой клиент проверяет отправляемые события схемами конфигурации. В его типах только события из конфигурации; событие типа, который ещё ведётся в панели, отправляйте клиентом без `config`.

### Фронтенд

Во фронтенд конфигурация не попадает: в ней каналы и шаблоны, а `defineRelay` в браузере бросает ошибку. Импортируйте только тип:

```ts
import type config from './relay.config';

const relay = createRelay<typeof config>({ publicKey: 'pk_…' });
```

Для проверки до запроса — схемы из `schemas.ts`:

```ts
import { lead } from './schemas';

const relay = createRelay({ publicKey: 'pk_…', schemas: { lead } });
```

### Поддерживаемые схемы

Relay хранит схему типа в подмножестве JSON Schema. SDK переводит в неё:

| zod | В Relay |
|---|---|
| `z.string()`, `.min()`, `.max()`, `.regex()`, `.startsWith()` | строка с длиной и шаблоном |
| `z.email()`, `z.url()`, `z.iso.date()`, `z.iso.datetime()`, `z.iso.time()` | форматы email, ссылка, дата, дата и время, время |
| `phone()` | телефон |
| `z.number()`, `z.int()`, `.min()`, `.max()`, `.gt()`, `.lt()` | число и целое с границами, в том числе строгими |
| `z.boolean()`, `z.literal(true)` | да/нет и обязательная галочка |
| `z.enum([...])` | выбор из списка |
| `options({ значение: 'Подпись' })` | выбор из списка с подписями (`oneOf` из `const` и `title`) |
| `z.record(z.string(), z.string())`, значения `.max()` | ключ — значение (объект строк) |
| `z.array(z.enum([...]))`, `.min()`, `.max()` | несколько из списка |
| `.optional()`, `.default(value)` | необязательное поле и значение по умолчанию |
| `.meta({ title })` | подпись поля |

Ограничения:

- у поля один шаблон проверки; флаги `i`, `m`, `s` переносятся, флаг `v` — нет;
- массив — только значений из списка (`z.array(z.enum([...]))` или `z.array(options({...}))`);
- объект — только `z.record(z.string(), z.string())`; вложенные объекты, `null` и объединения типов не поддерживаются — `push` укажет поле.

## CLI

```bash
npx relay push --dry-run   # показать изменения
npx relay push             # применить
npx relay push --prune     # применить и удалить убранное из конфигурации
npx relay pull             # записать relay.config.ts из Relay
```

| Флаг | Команда | Значение |
|---|---|---|
| `--config <path>` | push | файл конфигурации, по умолчанию `relay.config.ts` |
| `--out <path>` | pull | куда записать, по умолчанию `relay.config.ts` |
| `--force` | pull | перезаписать существующий файл |
| `--env-file <path>` | обе | файл переменных, по умолчанию `.env`, если есть |

`RELAY_SECRET_KEY` — секретный ключ проекта. Переменные из файла загружаются в `process.env` до чтения конфигурации; заданные в окружении главнее.

`relay.config.ts` загружается как TypeScript: работают импорты без расширений и алиасы из `tsconfig.json`. При ошибке CLI пишет её в stderr и завершается с кодом 1.

### Переход с панели: relay pull

Для проекта, который уже настроен в панели, `relay pull` записывает его конфигурацию в код:

- схемы становятся zod-кодом, шаблоны — `defaultTemplate`;
- секреты, получатели, адрес и заголовки вебхука в файл не попадают и остаются в панели — `pull` перечисляет их;
- то, что в коде выглядит иначе, чем в Relay, `pull` выводит отдельным списком.

После `pull` команда `relay push --dry-run` показывает, что изменится при переходе на код.

### GitHub Actions

```yaml
- name: Relay — изменения конфигурации
  if: github.event_name == 'pull_request'
  run: npx relay push --dry-run
  env:
    RELAY_SECRET_KEY: ${{ secrets.RELAY_SECRET_KEY }}
    CRM_URL: ${{ secrets.CRM_URL }}

- name: Relay — применение конфигурации
  if: github.ref == 'refs/heads/main'
  run: npx relay push
  env:
    RELAY_SECRET_KEY: ${{ secrets.RELAY_SECRET_KEY }}
    CRM_URL: ${{ secrets.CRM_URL }}
```

## Формы по схеме из Relay

Если поля формы правят в панели, форма может получать схему из Relay:

```ts
const schema = await relay.events.lead.fetchSchema({ fallback: lead });
```

Возвращается zod-схема. Если Relay недоступен, — `fallback`. Код перевода схемы загружается при первом вызове и в основной бандл не входит.

## Справочник

### createRelay(options)

| Опция | Тип | |
|---|---|---|
| `publicKey` | `string` | ключ для браузера |
| `secretKey` | `string` | ключ для сервера |
| `schemas` | `Record<string, ZodObject>` | схемы для проверки до запроса |
| `config` | результат `defineRelay` | конфигурация; только с `secretKey` |
| `env` | `Record<string, string>` | значения для `env()`, по умолчанию `process.env` |
| `timeoutMs` | `number` | таймаут запроса: 10 с для событий, 60 с для `push` |
| `fetch` | `typeof fetch` | своя реализация `fetch` |

Нужен ровно один ключ.

### relay.events.\<ключ>

| | |
|---|---|
| `send(data, { captchaToken?, idempotencyKey? })` | `Promise<{ id }>`, при ошибке бросает |
| `safeSend(data, { captchaToken?, idempotencyKey? })` | `Promise<{ ok: true, id } \| { ok: false, error }>` |
| `fetchSchema({ fallback? })` | `Promise<ZodObject>` — схема типа из Relay |
| `schema` | своя схема события или `undefined` |

### relay.push(options)

Только у клиента с `secretKey` и `config`. Опции: `dryRun`, `prune`. Возвращает `{ applied, changes, warnings }`.

### defineRelay, env, phone, options, pageMeta

- `defineRelay({ channels?, events })` — конфигурация; подсказывает ключи каналов в `send`.
- `env(name)` — ссылка на переменную окружения для секрета.
- `phone()` — zod-схема телефона.
- `options({ значение: 'Подпись' })` — выбор из списка с подписями.
- `pageMeta()` — UTM-метки, страница и источник для поля «ключ — значение»; вне браузера — `{}`.

## Требования

- Node.js 20.12 и новее — для сервера и CLI.
- Браузеры с поддержкой ES2022.
- zod 4.

## Лицензия

[MIT](LICENSE)
