import { z } from 'zod';

// Метка подписей в определении схемы. Определение общее у копий схемы
// (.meta(), .describe()), поэтому подписи не теряются. Symbol.for — как у
// phone(): схему создаёт копия пакета из проекта, переводит копия в CLI.
const OPTION_TITLES = Symbol.for('@drugovlab/relay-sdk/option-titles');

type Titles = Record<string, string>;

// Выбор из списка с подписями: ключ — значение, которое отправляет сайт,
// значение — подпись, которую видят люди в форме и сообщениях.
// В схеме Relay — oneOf из const и title.
export function options<const T extends Titles>(titles: T) {
  const values = Object.keys(titles) as [
    Extract<keyof T, string>,
    ...Extract<keyof T, string>[],
  ];
  const schema = z.enum(values);
  Object.defineProperty(schema._zod.def, OPTION_TITLES, {
    value: { ...titles },
  });
  return schema;
}

// Подписи вариантов из options(); у обычного z.enum — undefined.
export function optionTitles(schema: z.ZodType): Titles | undefined {
  return (schema._zod.def as unknown as Record<symbol, Titles | undefined>)[
    OPTION_TITLES
  ];
}
