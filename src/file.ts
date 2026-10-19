import { z } from 'zod';

// Метка проверки типа у file(): в схеме Relay она — contentMediaType.
// Symbol.for — как у phone(): схему создаёт копия пакета из проекта,
// переводит в схему Relay копия в CLI.
const FILE_ACCEPT = Symbol.for('@drugovlab/relay-sdk/file-accept');

export const FILE_TYPE_MESSAGE = 'File type is not allowed.';

// "image/*, application/pdf" принимает image/png и application/pdf.
export function acceptsType(accept: string, type: string): boolean {
  const actual = type.toLowerCase();
  return accept.split(',').some((item) => {
    const allowed = item.trim().toLowerCase();
    return allowed.endsWith('/*')
      ? actual.startsWith(allowed.slice(0, -1))
      : actual === allowed;
  });
}

// Разрешённые типы проверки file(); у другой проверки — undefined.
export function fileAccept(fn: unknown): string | undefined {
  return typeof fn === 'function' && FILE_ACCEPT in fn
    ? (fn as unknown as Record<symbol, string>)[FILE_ACCEPT]
    : undefined;
}

// Поле-файл. accept — разрешённые типы через запятую, как у
// <input type="file">: 'image/*, application/pdf'; без него — любые.
// В схеме Relay — { type: 'string', format: 'binary', contentMediaType }.
export function file(accept?: string) {
  if (accept === undefined) return z.file();
  const check = Object.assign(
    (value: File) => acceptsType(accept, value.type),
    { [FILE_ACCEPT]: accept },
  );
  return z.file().refine(check, {
    message: FILE_TYPE_MESSAGE,
    params: { code: 'contentMediaType' },
  });
}
