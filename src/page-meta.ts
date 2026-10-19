const UTM_TAGS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
];
const STORAGE_KEY = 'relay:page-meta';
// Значение словаря в Relay — до 1000 символов.
const MAX_VALUE_LENGTH = 1000;

// Метаданные страницы для поля «ключ — значение»: UTM-метки, страница без
// query и внешний источник перехода. Метки есть в адресе только на странице
// входа, поэтому метки и источник запоминаются на сессию вкладки. Вне
// браузера — пустой объект.
export function pageMeta(): Record<string, string> {
  if (typeof location === 'undefined') return {};
  const stored = readStored();
  const params = new URLSearchParams(location.search);
  const tags = Object.fromEntries(
    UTM_TAGS.flatMap((name) => {
      const value = params.get(name);
      return value ? [[name, value]] : [];
    }),
  );
  const external = externalReferrer();
  const session: Record<string, string> = {
    ...stored,
    ...(Object.keys(tags).length > 0 && tags),
    ...(external && !stored.referrer && { referrer: external }),
  };
  writeStored(session);
  return Object.fromEntries(
    Object.entries({
      ...session,
      page: location.origin + location.pathname,
    }).map(([key, value]) => [key, value.slice(0, MAX_VALUE_LENGTH)]),
  );
}

// Переход с другого сайта; переходы внутри сайта источником не считаются.
function externalReferrer(): string | undefined {
  if (typeof document === 'undefined' || !document.referrer) return undefined;
  try {
    return new URL(document.referrer).host === location.host
      ? undefined
      : document.referrer;
  } catch {
    return undefined;
  }
}

// sessionStorage бывает недоступен (приватный режим, запрет cookie): тогда
// метки берутся только из текущего адреса.
function readStored(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? '{}',
    );
    return typeof value === 'object' && value !== null
      ? (value as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeStored(value: Record<string, string>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Без хранилища метки не переживут переход на другую страницу.
  }
}
