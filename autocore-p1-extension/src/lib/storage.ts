// TARGET: autocore-p1-extension/src/lib/storage.ts
// Thin promise wrappers over chrome.storage.local + settings accessor.
import { K_SETTINGS, DEFAULT_SETTINGS, Settings } from '../config';

export function getLocal<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (obj) => resolve(obj[key] as T | undefined));
  });
}

export function setLocal(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

export function removeLocal(key: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => resolve());
  });
}

export async function getSettings(): Promise<Settings> {
  const s = await getLocal<Partial<Settings>>(K_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await setLocal(K_SETTINGS, next);
  return next;
}
