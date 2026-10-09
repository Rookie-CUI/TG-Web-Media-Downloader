import { defaultSettings, type AppSettings, type DownloadTask, type MediaItem } from '../types';

const HISTORY_KEY = 'downloadHistory';
const SETTINGS_KEY = 'settings';

export async function getSettings(): Promise<AppSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...defaultSettings, ...(stored[SETTINGS_KEY] ?? {}) };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function getHistory(): Promise<DownloadTask[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return stored[HISTORY_KEY] ?? [];
}

export async function saveTask(task: DownloadTask): Promise<void> {
  const current = await getHistory();
  const index = current.findIndex((item) => item.id === task.id);
  if (index >= 0) current[index] = task;
  else current.unshift(task);
  await chrome.storage.local.set({ [HISTORY_KEY]: current.slice(0, 150) });
}

export async function getPageMedia(tabId: number): Promise<MediaItem[]> {
  const key = `media:${tabId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? [];
}

export async function savePageMedia(tabId: number, items: MediaItem[]): Promise<void> {
  await chrome.storage.local.set({ [`media:${tabId}`]: items.slice(-300) });
}
