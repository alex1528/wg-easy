import { describe, expect, test } from 'vitest';

import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';

type Messages = { [key: string]: string | Messages };

function flatten(messages: Messages, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix + key;
    if (typeof value === 'string') {
      result.set(path, value);
    } else {
      for (const [k, v] of flatten(value, `${path}.`)) result.set(k, v);
    }
  }
  return result;
}

function placeholders(text: string) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const enMessages = flatten(en as Messages);
const zhMessages = flatten(zhCN as Messages);

describe('zh-CN translation', () => {
  test('has every key of en', () => {
    const missing = [...enMessages.keys()].filter((k) => !zhMessages.has(k));
    expect(missing).toEqual([]);
  });

  test('has no keys that en does not have', () => {
    const extra = [...zhMessages.keys()].filter((k) => !enMessages.has(k));
    expect(extra).toEqual([]);
  });

  test('uses the same placeholders', () => {
    const mismatched = [...enMessages]
      .filter(
        ([k, v]) =>
          zhMessages.has(k) &&
          placeholders(v).join(',') !== placeholders(zhMessages.get(k)!).join(',')
      )
      .map(([k]) => k);
    expect(mismatched).toEqual([]);
  });

  test('no empty messages', () => {
    const empty = [...zhMessages].filter(([, v]) => v.trim() === '');
    expect(empty).toEqual([]);
  });
});
