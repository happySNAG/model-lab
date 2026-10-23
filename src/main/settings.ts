// Cernum · settings and application paths. Settings are a small JSON file in the user-data
// directory (Windows: %APPDATA%\Cernum). The evidence store lives beside it unless overridden.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Settings } from '../shared/ipc';
import { validateLoopbackEndpoint } from '../core/ollama-http';

export const DEFAULT_SETTINGS: Settings = { ollamaEndpoint: 'http://127.0.0.1:11434', thinkingMode: 'disabled', evidenceRootOverride: '' };

export class SettingsStore {
  private current: Settings;
  constructor(private readonly file: string) {
    this.current = { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
      this.current = normalize({ ...DEFAULT_SETTINGS, ...parsed });
    } catch { /* first launch or unreadable: defaults */ }
  }
  get(): Settings {
    return { ...this.current };
  }
  save(next: Settings): Settings {
    this.current = normalize(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.current, null, 2), 'utf8');
    return this.get();
  }
}

function normalize(settings: Settings): Settings {
  const endpoint = (settings.ollamaEndpoint ?? '').trim() || DEFAULT_SETTINGS.ollamaEndpoint;
  try { validateLoopbackEndpoint(endpoint); } catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
  const thinkingMode = ['disabled', 'enabled', 'runtimeDefault'].includes(settings.thinkingMode) ? settings.thinkingMode : 'disabled';
  return { ollamaEndpoint: endpoint.replace(/\/+$/, ''), thinkingMode, evidenceRootOverride: (settings.evidenceRootOverride ?? '').trim() };
}

export function evidenceRootFor(userData: string, settings: Settings): string {
  return settings.evidenceRootOverride && path.isAbsolute(settings.evidenceRootOverride) ? settings.evidenceRootOverride : path.join(userData, 'evidence');
}
