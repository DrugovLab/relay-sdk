import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageMeta } from './page-meta';

// Браузер без DOM-окружения: адрес, источник и хранилище сессии.
function visit(url: string, referrer = '') {
  const { origin, pathname, search, host } = new URL(url);
  vi.stubGlobal('location', { origin, pathname, search, host });
  vi.stubGlobal('document', { referrer });
}

describe('pageMeta', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('вне браузера — пустой объект', () => {
    vi.unstubAllGlobals();
    expect(pageMeta()).toEqual({});
  });

  it('UTM-метки, страница без query и внешний источник; метки помнятся на сессию', () => {
    visit(
      'https://site.ru/kursy?utm_source=yandex&utm_campaign=spring&x=1',
      'https://ya.ru/search',
    );
    expect(pageMeta()).toEqual({
      utm_source: 'yandex',
      utm_campaign: 'spring',
      referrer: 'https://ya.ru/search',
      page: 'https://site.ru/kursy',
    });
    visit('https://site.ru/zapis', 'https://site.ru/kursy');
    expect(pageMeta()).toEqual({
      utm_source: 'yandex',
      utm_campaign: 'spring',
      referrer: 'https://ya.ru/search',
      page: 'https://site.ru/zapis',
    });
  });

  it('без хранилища — только текущий адрес', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    visit('https://site.ru/?utm_source=vk');
    expect(pageMeta()).toEqual({
      utm_source: 'vk',
      page: 'https://site.ru/',
    });
  });
});
