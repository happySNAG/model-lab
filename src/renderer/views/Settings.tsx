import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { Diagnostics, Settings } from '../../shared/ipc';
import { Card, Here, here, isMac, measurementText } from '../components';

export function SettingsView({ shell }: { shell: Shell }) {
  const [settings, setSettings] = useState<Settings>();
  const [draft, setDraft] = useState<Settings>();
  const [diagnostics, setDiagnostics] = useState<Diagnostics>();
  const [message, setMessage] = useState<string>();
  const [messageTone, setMessageTone] = useState<'ok' | 'bad'>('ok');
  const [exporting, setExporting] = useState(false);

  const load = () => { void api.getSettings().then((s) => { setSettings(s); setDraft(s); }); void api.getDiagnostics().then(setDiagnostics); };
  useEffect(load, []);

  const save = async () => {
    if (!draft) return;
    try { const saved = await api.saveSettings(draft); setSettings(saved); setDraft(saved); setMessageTone('ok'); setMessage('Settings saved.'); await shell.refreshOllama(); void api.getDiagnostics().then(setDiagnostics); }
    catch (e) { setMessageTone('bad'); setMessage(e instanceof Error ? e.message : String(e)); }
  };
  const exportBundle = async () => {
    setExporting(true);
    try { const r = await api.exportEvidence(); if (!r.cancelled) shell.toast(`Exported to ${r.path} (digest ${r.digest})`); }
    catch (e) { shell.toast(e instanceof Error ? e.message : String(e)); }
    finally { setExporting(false); }
  };
  const copyDiagnostics = async () => { await api.copyDiagnostics(); shell.toast('Diagnostics report copied to the clipboard as JSON.'); };
  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);
  const hw = diagnostics?.machine.environment.hardware;
  const running = shell.progress?.state === 'running';

  return (
    <div className="page">
      <div className="page-head"><div><h1>Settings & diagnostics</h1><p>Where Model Lab talks to Ollama, where it keeps evidence, and what it knows about {here} and itself.</p></div></div>

      <div className="grid-2">
        <Card title="Ollama">
          {draft && (
            <div className="stack">
              <div className="field"><label htmlFor="endpoint">Endpoint</label><input id="endpoint" className="input mono" value={draft.ollamaEndpoint} onChange={(e) => setDraft({ ...draft, ollamaEndpoint: e.target.value })} spellCheck={false} /></div>
              <p className="small faint">Must be a loopback address (127.0.0.1, localhost, or ::1). Model Lab benchmarks the runtime on {here} so that the hardware evidence stays truthful. Ollama's default is <code>http://127.0.0.1:11434</code>.</p>
              <div className="field"><label htmlFor="thinking">Model thinking</label>
                <select id="thinking" className="input" value={draft.thinkingMode} onChange={(e) => setDraft({ ...draft, thinkingMode: e.target.value as Settings['thinkingMode'] })} data-testid="thinking-mode">
                  <option value="disabled">Disabled on every request (recommended)</option>
                  <option value="enabled">Enabled — only the final answer is judged; reasoning is never stored</option>
                  <option value="runtimeDefault">Leave to Ollama's default (recorded as such)</option>
                </select>
              </div>
              <p className="small faint">Some models reason before answering. Model Lab states this setting explicitly on every request so it is never an unknown variable in the evidence.</p>
            </div>
          )}
        </Card>
        <Card title="Storage">
          {draft && diagnostics && (
            <div className="stack">
              <dl className="kv">
                <dt>Evidence store</dt><dd className="mono small">{diagnostics.evidenceRoot}</dd>
                <dt>Records</dt><dd>{diagnostics.integrity.totalRecords} ({diagnostics.integrity.corruptRecords === 0 ? 'all intact' : `${diagnostics.integrity.corruptRecords} corrupt — surfaced, never hidden`})</dd>
                <dt>Runs / benchmarks</dt><dd>{diagnostics.runCount} / {diagnostics.sessionCount}</dd>
                <dt>Application data</dt><dd className="mono small">{diagnostics.build.userDataPath}</dd>
              </dl>
              <div className="field"><label htmlFor="root">Custom evidence folder (optional, absolute path)</label><input id="root" className="input mono" value={draft.evidenceRootOverride} onChange={(e) => setDraft({ ...draft, evidenceRootOverride: e.target.value })} placeholder="leave empty for the default" disabled={running} spellCheck={false} /></div>
              {running && <p className="small faint">The evidence folder cannot change while a benchmark is running.</p>}
              <div className="row">
                <button className="btn" onClick={() => api.openPath(diagnostics.evidenceRoot)}>Open evidence folder</button>
                <button className="btn" onClick={() => api.openPath(diagnostics.build.userDataPath)}>Open application data</button>
                <button className="btn" onClick={exportBundle} disabled={exporting}>{exporting ? 'Exporting…' : 'Export evidence bundle…'}</button>
              </div>
              <p className="small faint">The store is append-only JSON: nothing is ever overwritten or deleted. {isMac ? 'Removing Model Lab from Applications leaves this folder in place.' : 'Uninstalling Model Lab leaves this folder in place.'}</p>
            </div>
          )}
        </Card>
      </div>

      <div className="row">
        <button className="btn primary" onClick={save} disabled={!dirty} data-testid="save-settings">Save settings</button>
        {dirty && <button className="btn" onClick={() => setDraft(settings)}>Discard changes</button>}
        {message && <span className="small" style={{ color: messageTone === 'bad' ? 'var(--bad)' : 'var(--text-2)' }} role="status">{message}</span>}
      </div>

      <div className="grid-2">
        <Card title={Here}>
          {diagnostics && (
            <dl className="kv small">
              <dt>Name</dt><dd>{diagnostics.machine.hostname}</dd>
              <dt>System</dt><dd>{diagnostics.machine.platformLabel}</dd>
              <dt>Model</dt><dd>{measurementText(diagnostics.machine.environment.hardwareModel, (v) => v)}</dd>
              <dt>Processor</dt><dd>{hw ? measurementText(hw.chipBrand, (v) => v) : '—'}</dd>
              <dt>Architecture</dt><dd>{hw ? measurementText(hw.architecture, (v) => v) : '—'}</dd>
              <dt>Cores</dt><dd>{measurementText(diagnostics.machine.environment.cpuCoreCount, (v) => `${v} logical`)}{hw && 'measured' in hw.performanceCoreCount && 'measured' in hw.efficiencyCoreCount ? ` (${hw.performanceCoreCount.measured} performance + ${hw.efficiencyCoreCount.measured} efficiency)` : ''}</dd>
              <dt>Memory</dt><dd>{diagnostics.machine.memoryLabel}{hw && 'measured' in hw.unifiedMemoryArchitecture && hw.unifiedMemoryArchitecture.measured ? ' unified' : ''}</dd>
              <dt>Graphics</dt><dd>{diagnostics.machine.gpuLabel}</dd>
              <dt>Captured</dt><dd>{diagnostics.machine.capturedAt}</dd>
            </dl>
          )}
        </Card>
        <Card title="About Model Lab" actions={<button className="btn small" onClick={copyDiagnostics}>Copy diagnostics</button>}>
          {diagnostics && (
            <dl className="kv small">
              <dt>Version</dt><dd>{diagnostics.build.version} <span className="faint">(build {diagnostics.build.commit})</span></dd>
              <dt>Built</dt><dd>{diagnostics.build.builtAt}</dd>
              <dt>Runtime</dt><dd>Electron {diagnostics.build.electron} · Chromium {diagnostics.build.chrome} · Node {diagnostics.build.node}</dd>
              <dt>Platform</dt><dd>{diagnostics.build.platform === 'darwin' ? 'macOS' : diagnostics.build.platform === 'win32' ? 'Windows' : diagnostics.build.platform} · {diagnostics.build.arch}</dd>
              <dt>Benchmark catalog</dt><dd>{diagnostics.catalog.suites} suites · {diagnostics.catalog.cases} cases · {diagnostics.catalog.policies} scoring policies<div className="mono faint">{diagnostics.catalog.catalogDigest}</div></dd>
              <dt>Log file</dt><dd><span className="mono small">{diagnostics.build.logPath}</span> <button className="btn link small" onClick={() => api.revealPath(diagnostics.build.logPath)}>{isMac ? 'Show in Finder' : 'Show in Explorer'}</button></dd>
            </dl>
          )}
          <p className="small faint" style={{ marginTop: 10 }}>Model Lab measures; it never decides for you. Benchmark results are evidence, not authorization: nothing here changes how any model is used anywhere. Diagnostics stay on {here} unless you copy them somewhere yourself.</p>
        </Card>
      </div>
    </div>
  );
}
