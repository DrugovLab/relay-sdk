// (?ims) в начале шаблона Relay (RE2) — флаги JavaScript: (?i)abc → /abc/i.
// Отдельный модуль без zod: им пользуется relay pull.
export function splitFlags(pattern: string): { source: string; flags: string } {
  const match = /^\(\?([ims]+)\)/.exec(pattern);
  return match
    ? { source: pattern.slice(match[0].length), flags: match[1] }
    : { source: pattern, flags: '' };
}
