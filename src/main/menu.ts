// Cernum · the application menu. On macOS this is the menu bar (the only way a Mac app quits,
// hides, and exposes keyboard shortcuts natively); on Windows the same template backs the hidden
// menu bar so the accelerators (Ctrl+1…7, Ctrl+N, Ctrl+E) work identically.
//
// `menuTemplate` is pure so its shape can be tested without Electron; `installMenu` binds it.

import type { MenuItemConstructorOptions } from 'electron';
import { ScreenID } from '../shared/ipc';

export interface MenuActions {
  navigate(screen: ScreenID): void;
  newBenchmark(): void;
  exportEvidence(): void;
  openEvidenceFolder(): void;
  openDataFolder(): void;
  revealLog(): void;
  openOllamaDownload(): void;
  openReadme(): void;
  copyDiagnostics(): void;
  checkOllama(): void;
  about(): void;
}

export interface MenuOptions {
  platform: NodeJS.Platform;
  isDev: boolean;
  productName: string;
}

const SCREENS: { id: ScreenID; label: string }[] = [
  { id: 'home', label: 'Home' }, { id: 'models', label: 'Models' }, { id: 'providers', label: 'Providers' },
  { id: 'benchmark', label: 'Benchmark' }, { id: 'live', label: 'Live Run' },
  { id: 'results', label: 'Results' }, { id: 'history', label: 'History' }, { id: 'settings', label: 'Settings' },
];

export function menuTemplate(options: MenuOptions, actions: MenuActions): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (mac) {
    template.push({
      label: options.productName,
      submenu: [
        { label: `About ${options.productName}`, click: () => actions.about() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: () => actions.navigate('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  const fileItems: MenuItemConstructorOptions[] = [
    { label: 'New Benchmark…', accelerator: 'CmdOrCtrl+N', click: () => actions.newBenchmark() },
    { type: 'separator' },
    { label: 'Export Evidence Bundle…', accelerator: 'CmdOrCtrl+E', click: () => actions.exportEvidence() },
    { label: 'Open Evidence Folder', click: () => actions.openEvidenceFolder() },
    { label: 'Open Application Data Folder', click: () => actions.openDataFolder() },
    { type: 'separator' },
  ];
  if (mac) fileItems.push({ role: 'close' });
  else fileItems.push({ label: 'Settings', accelerator: 'Ctrl+,', click: () => actions.navigate('settings') }, { type: 'separator' }, { role: 'quit', label: 'Exit' });
  template.push({ label: 'File', submenu: fileItems });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ],
  });

  const viewItems: MenuItemConstructorOptions[] = SCREENS.map((screen, index) => ({
    label: screen.label, accelerator: `CmdOrCtrl+${index + 1}`, click: () => actions.navigate(screen.id),
  }));
  viewItems.push({ type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' });
  if (options.isDev) viewItems.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' });
  template.push({ label: 'View', submenu: viewItems });

  template.push({
    label: 'Ollama',
    submenu: [
      { label: 'Check Ollama Status', accelerator: 'CmdOrCtrl+R', click: () => actions.checkOllama() },
      { label: 'Open Models', click: () => actions.navigate('models') },
      { type: 'separator' },
      { label: 'Download Ollama (ollama.com)…', click: () => actions.openOllamaDownload() },
    ],
  });

  if (mac) template.push({ role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] });
  else template.push({ role: 'window', submenu: [{ role: 'minimize' }, { role: 'close' }] });

  const helpItems: MenuItemConstructorOptions[] = [
    { label: `${options.productName} Guide (README)`, click: () => actions.openReadme() },
    { label: 'Show Log File', click: () => actions.revealLog() },
    { label: 'Copy Diagnostics Report', click: () => actions.copyDiagnostics() },
  ];
  if (!mac) helpItems.push({ type: 'separator' }, { label: `About ${options.productName}`, click: () => actions.about() });
  template.push({ role: 'help', submenu: helpItems });

  return template;
}

/** Every accelerator in the template, for tests and for the in-app shortcut hint. */
export function accelerators(template: MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  const walk = (items: MenuItemConstructorOptions[]) => {
    for (const item of items) {
      if (item.accelerator) out.push(item.accelerator);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(template);
  return out;
}
