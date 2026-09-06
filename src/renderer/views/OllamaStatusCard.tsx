import React, { useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import { Card, Pill, here, isMac, machineNoun } from '../components';

export function OllamaStatusCard({ shell }: { shell: Shell }) {
  const [busy, setBusy] = useState(false);
  const status = shell.ollama;

  const [startFailed, setStartFailed] = useState(false);
  const start = async () => {
    setBusy(true);
    setStartFailed(false);
    try {
      const after = await api.startOllama();
      await shell.refreshOllama();
      if (after.state !== 'running') setStartFailed(true);
    } finally { setBusy(false); }
  };

  return (
    <Card title="Ollama" actions={<button className="btn small" onClick={() => shell.refreshOllama()} disabled={busy}>Check again</button>}>
      {!status ? <p className="muted">Checking…</p> : (
        <div className="stack">
          <div className="row">
            {status.state === 'running' && <Pill tone="ok">Running · {status.version}</Pill>}
            {status.state === 'installedNotRunning' && <Pill tone="warn">Installed, not running</Pill>}
            {status.state === 'notInstalled' && <Pill tone="bad">Not installed</Pill>}
            {status.state === 'unreachable' && <Pill tone="bad">Endpoint problem</Pill>}
            <span className="muted small mono">{status.endpoint}</span>
          </div>
          <p className="muted">{status.detail}</p>
          {status.state === 'installedNotRunning' && (
            <div className="row">
              <button className="btn primary" onClick={start} disabled={busy}>{busy ? 'Starting… (up to 30 s)' : 'Start Ollama'}</button>
              <span className="small faint">{isMac ? 'Opens the Ollama app you already installed (it lives in the menu bar), or starts its server directly. Nothing is downloaded.' : 'Launches the Ollama you already installed. Nothing is downloaded.'}</span>
            </div>
          )}
          {status.state === 'installedNotRunning' && startFailed && !busy && (
            <div className="note warn">Ollama did not answer at {status.endpoint} after being started. {isMac ? <>Open the Ollama app yourself (or run <code>ollama serve</code> in Terminal)</> : <>Open Ollama from the Start menu (or run <code>ollama serve</code>)</>}, then press <em>Check again</em>. If Ollama listens on another port, set it in Settings.</div>
          )}
          {status.state === 'notInstalled' && (
            <div className="stack">
              <div className="note">
                <strong>Guided setup.</strong> Model Lab needs Ollama, a free local runtime that runs language models on {here}.
                <ol className="list-plain" style={{ marginTop: 6 }}>
                  {isMac
                    ? <li>Download Ollama for macOS from ollama.com, open the download, and drag <em>Ollama</em> into Applications (no account needed).</li>
                    : <li>Download and install Ollama for Windows from ollama.com (one installer, no account).</li>}
                  <li>Open Ollama once so it runs in the background{isMac ? ' (it appears in the menu bar)' : ''}, then press <em>Check again</em>.</li>
                  <li>Add a model on the Models screen. Model Lab only downloads a model when you explicitly ask it to.</li>
                </ol>
              </div>
              <div className="row">
                <button className="btn primary" onClick={() => api.openOllamaDownload()}>Open ollama.com/download</button>
                <span className="small faint">Or benchmark the built-in reference model to try the lab on this {machineNoun} first.</span>
              </div>
            </div>
          )}
          {status.state === 'unreachable' && <div className="note bad">{status.endpointProblem ?? status.detail} Fix the endpoint in Settings.</div>}
        </div>
      )}
    </Card>
  );
}
