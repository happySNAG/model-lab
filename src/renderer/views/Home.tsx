import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { MachineSummary, ModelRow, SessionRecord } from '../../shared/ipc';
import { Card, Empty, Here, Pill, here, sessionStateLabel, when } from '../components';
import { OllamaStatusCard } from './OllamaStatusCard';

export function HomeView({ shell }: { shell: Shell }) {
  const [machine, setMachine] = useState<MachineSummary>();
  const [models, setModels] = useState<ModelRow[]>();
  const [sessions, setSessions] = useState<SessionRecord[]>();

  useEffect(() => {
    void api.getMachine().then(setMachine);
    void api.listModels().then(setModels);
    void api.listSessions().then(setSessions);
  }, [shell.ollama?.state, shell.progress?.state]);

  const ollamaModels = models?.filter((m) => m.kind === 'ollama') ?? [];
  const running = shell.progress?.state === 'running';
  const ollamaRunning = shell.ollama?.state === 'running';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Home</h1>
          <p>Model Lab runs fixed, synthetic benchmark suites against the language models installed on {here} and keeps every result as permanent evidence. Nothing leaves this machine.</p>
        </div>
        <button className="btn primary" onClick={() => shell.go(running ? 'live' : 'benchmark')} data-testid="quick-benchmark">
          {running ? 'View live run' : 'New benchmark'}
        </button>
      </div>

      <div className="grid-2">
        <Card title={Here} actions={<button className="btn small" onClick={() => api.getMachine(true).then(setMachine)}>Refresh</button>}>
          {machine ? (
            <dl className="kv">
              <dt>Name</dt><dd>{machine.hostname}</dd>
              <dt>System</dt><dd>{machine.platformLabel}</dd>
              <dt>Processor</dt><dd>{machine.cpuLabel}</dd>
              <dt>Memory</dt><dd>{machine.memoryLabel}</dd>
              <dt>Graphics</dt><dd>{machine.gpuLabel}</dd>
            </dl>
          ) : <p className="muted">Reading hardware…</p>}
          <p className="faint small" style={{ marginTop: 10 }}>Anything the system did not report is shown as not reported. Model Lab never estimates hardware facts.</p>
        </Card>
        <OllamaStatusCard shell={shell} />
      </div>

      <div className="grid-2">
        <Card title="Models" actions={<button className="btn small" onClick={() => shell.go('models')}>Open</button>}>
          {models === undefined ? <p className="muted">Looking for models…</p> : ollamaModels.length === 0 ? (
            <div className="stack">
              <p className="muted">{ollamaRunning ? 'Ollama is running but has no models installed yet.' : 'No Ollama models are visible right now.'}</p>
              <p className="small faint">The built-in reference model is always available, so you can try a full benchmark without installing anything.</p>
            </div>
          ) : (
            <div className="stack">
              <div className="hero-number">{ollamaModels.length}</div>
              <p className="muted">{ollamaModels.length === 1 ? 'model installed in Ollama' : 'models installed in Ollama'}</p>
              <div className="chips">{ollamaModels.slice(0, 6).map((m) => <span key={m.key} className="pill neutral">{m.name}</span>)}{ollamaModels.length > 6 && <span className="pill neutral">+{ollamaModels.length - 6} more</span>}</div>
            </div>
          )}
        </Card>
        <Card title="Recent runs" actions={<button className="btn small" onClick={() => shell.go('history')}>All history</button>}>
          {sessions === undefined ? <p className="muted">Loading…</p> : sessions.length === 0 ? (
            <Empty title="No benchmarks yet">
              <div className="guide" style={{ textAlign: 'left', width: '100%' }}>
                <div className="guide-item"><span className="step-n" aria-hidden>1</span><span><strong>Have a model ready</strong>{ollamaRunning ? 'Ollama is running; add a model on the Models screen.' : 'Start Ollama, or use the built-in reference model to try the lab.'}</span></div>
                <div className="guide-item"><span className="step-n" aria-hidden>2</span><span><strong>Choose what to test</strong>Pick models and suites on the Benchmark screen.</span></div>
                <div className="guide-item"><span className="step-n" aria-hidden>3</span><span><strong>Start</strong>Watch it live; results and history stay on {here}.</span></div>
              </div>
            </Empty>
          ) : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Benchmark</th><th>When</th><th>State</th></tr></thead>
              <tbody>
                {sessions.slice(0, 5).map((s) => (
                  <tr key={s.sessionID} className="clickable" tabIndex={0} onClick={() => shell.go('results', { sessionID: s.sessionID })} onKeyDown={(e) => { if (e.key === 'Enter') shell.go('results', { sessionID: s.sessionID }); }}>
                    <td>{s.label}</td><td className="muted nowrap">{when(s.createdAt)}</td>
                    <td><Pill tone={s.state === 'completed' ? 'ok' : s.state === 'running' ? 'accent' : s.state === 'failed' ? 'bad' : 'warn'} pulse={s.state === 'running'}>{sessionStateLabel(s.state)}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>
    </div>
  );
}
