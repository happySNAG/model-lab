// Cernum · Ollama runtime detection, guided setup, and the explicit model-pull workflow.
//
// This module is deliberately SEPARATE from the benchmark transport (`core/ollama-http.ts`):
// benchmark execution can only read, describe, and generate. Downloading a model is a separate,
// user-initiated, user-confirmed act that streams the runtime's own progress and can be cancelled.
// Nothing here ever installs Ollama itself or pulls a model without a person asking for it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { isoSeconds } from '../core/digest';
import { LiveExecutionAuthorization, OllamaHTTPTransport, validateLoopbackEndpoint } from '../core/ollama-http';
import { OllamaInstalledModel } from '../core/ollama';
import { OllamaStatus, PullProgress } from '../shared/ipc';

const execFileAsync = promisify(execFile);
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

/** The transport used only for STATUS and LISTING (read-only); benchmark runs mint their own on Start. */
export function statusTransport(endpoint: string): OllamaHTTPTransport {
  return new OllamaHTTPTransport(endpoint, LiveExecutionAuthorization.explicit(true, true)!);
}

export async function findOllamaExecutable(): Promise<string | undefined> {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) candidates.push(path.join(local, 'Programs', 'Ollama', 'ollama.exe'));
    const programFiles = process.env.ProgramFiles;
    if (programFiles) candidates.push(path.join(programFiles, 'Ollama', 'ollama.exe'));
    try {
      const { stdout } = await execFileAsync('where.exe', ['ollama'], { timeout: 4_000, windowsHide: true });
      for (const line of stdout.split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
    } catch { /* not on PATH */ }
  } else {
    candidates.push('/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama', path.join(os.homedir(), '.local/bin/ollama'));
    if (process.platform === 'darwin') candidates.push('/Applications/Ollama.app/Contents/Resources/ollama');
    try {
      const { stdout } = await execFileAsync('which', ['ollama'], { timeout: 4_000 });
      if (stdout.trim()) candidates.push(stdout.trim());
    } catch { /* not on PATH */ }
  }
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return undefined;
}

export async function detectOllama(endpoint: string): Promise<OllamaStatus> {
  const checkedAt = isoSeconds(new Date());
  try {
    validateLoopbackEndpoint(endpoint);
  } catch (error) {
    return { state: 'unreachable', endpoint, endpointValid: false, endpointProblem: error instanceof Error ? error.message : String(error),
             detail: 'The configured endpoint is not a loopback address. Cernum benchmarks the local runtime on this PC only.', checkedAt };
  }
  try {
    const version = await statusTransport(endpoint).version();
    return { state: 'running', endpoint, endpointValid: true, version: version.version, detail: `Ollama ${version.version} is running at ${endpoint}.`, checkedAt };
  } catch (error) {
    const executablePath = await findOllamaExecutable();
    if (executablePath) {
      return { state: 'installedNotRunning', endpoint, endpointValid: true, executablePath,
               detail: `Ollama is installed (${executablePath}) but nothing answered at ${endpoint}. Start it, then check again.`, checkedAt };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { state: 'notInstalled', endpoint, endpointValid: true,
             detail: `Nothing answered at ${endpoint} (${detail}) and no Ollama installation was found on this PC.`, checkedAt };
  }
}

/**
 * Launches the installed runtime and waits for it to answer. macOS: the Ollama app is opened first
 * (it lives in the menu bar and keeps its own server); if nothing answers within a few seconds — an
 * app that will not launch, or a CLI-only install — `ollama serve` is started detached from the
 * command-line binary instead. Windows: the tray application, then `ollama serve`. Polls up to ~25 s
 * in total; whatever state is reached is reported truthfully. Nothing is ever downloaded here.
 */
export async function startOllama(endpoint: string, log: (line: string) => void = () => undefined): Promise<OllamaStatus> {
  const executable = await findOllamaExecutable();
  if (!executable) return detectOllama(endpoint);
  const spawnDetached = (command: string, args: string[]): boolean => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (error) => log(`ollama launch via ${command} failed: ${error.message}`));
      child.unref();
      return true;
    } catch (error) {
      log(`ollama launch via ${command} threw: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const waitForRuntime = async (attempts: number): Promise<OllamaStatus | undefined> => {
    for (let i = 0; i < attempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const status = await detectOllama(endpoint);
      if (status.state === 'running') return status;
    }
    return undefined;
  };

  // 1 · The desktop application, where one is installed.
  let launchedApp = false;
  if (process.platform === 'win32') {
    const trayApp = path.join(path.dirname(executable), 'ollama app.exe');
    if (fs.existsSync(trayApp)) launchedApp = spawnDetached(trayApp, []);
  } else if (process.platform === 'darwin' && fs.existsSync('/Applications/Ollama.app')) {
    launchedApp = spawnDetached('open', ['-a', 'Ollama']);
  }
  if (launchedApp) {
    const status = await waitForRuntime(16); // ~8 s
    if (status) return status;
    log('the Ollama application did not answer within 8 s; falling back to `ollama serve`');
  }

  // 2 · The command-line server, detached so it outlives this process.
  spawnDetached(executable, ['serve']);
  const status = await waitForRuntime(launchedApp ? 30 : 40); // ~15–20 s more
  return status ?? detectOllama(endpoint);
}

export async function openDownloadPage(): Promise<void> {
  await shell.openExternal(OLLAMA_DOWNLOAD_URL);
}

export async function listInstalledModels(endpoint: string): Promise<OllamaInstalledModel[]> {
  return statusTransport(endpoint).installedModels();
}

/**
 * Explicit model download. Streams `/api/pull` progress lines to the listener; aborts on cancel.
 * This is the ONLY place in the application that can ask the runtime to download anything, and it
 * runs only after the person confirmed the download in the Models screen.
 */
export class ModelPuller {
  private controller?: AbortController;

  get active(): boolean {
    return this.controller !== undefined;
  }

  async pull(endpoint: string, model: string, onProgress: (p: PullProgress) => void): Promise<void> {
    if (this.controller) throw new Error('a model download is already in progress');
    const url = new URL('api/pull', endpoint.endsWith('/') ? endpoint : endpoint + '/');
    validateLoopbackEndpoint(endpoint);
    this.controller = new AbortController();
    try {
      const response = await fetch(url, { method: 'POST', body: JSON.stringify({ model, stream: true }), signal: this.controller.signal });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        throw new Error(`the runtime refused the download (${response.status}): ${text.slice(0, 200)}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastError: string | undefined;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
            if (event.error) lastError = event.error;
            onProgress({ model, status: event.error ?? event.status ?? '', completedBytes: event.completed, totalBytes: event.total, done: false, error: event.error });
          } catch { /* partial line */ }
        }
      }
      if (lastError) throw new Error(lastError);
      onProgress({ model, status: 'success', done: true });
    } catch (error) {
      const aborted = this.controller?.signal.aborted;
      onProgress({ model, status: aborted ? 'cancelled' : 'failed', done: true, error: aborted ? 'download cancelled' : (error instanceof Error ? error.message : String(error)) });
      if (!aborted) throw error;
    } finally {
      this.controller = undefined;
    }
  }

  cancel(): void {
    this.controller?.abort();
  }
}
