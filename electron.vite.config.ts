import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function commit(): string {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; }
}
const version = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version;
const defines = {
  __BUILD_COMMIT__: JSON.stringify(commit()),
  __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  __APP_VERSION__: JSON.stringify(version),
};
const alias = { '@core': resolve(__dirname, 'src/core'), '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], define: defines, resolve: { alias }, build: { sourcemap: true } },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias } },
  renderer: { plugins: [react()], define: defines, resolve: { alias }, build: { sourcemap: true } },
});
