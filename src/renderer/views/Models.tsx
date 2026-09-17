import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { ModelRow, PullProgress } from '../../shared/ipc';
import { Card, Empty, Modal, Pill, Progress, bytes, here, when } from '../components';
import { OllamaStatusCard } from './OllamaStatusCard';

export function ModelsView({ shell }: { shell: Shell }) {
  const [models, setModels] = useState<ModelRow[]>();
  const [pullName, setPullName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pull, setPull] = useState<PullProgress>();
  const [error, setError] = useState<string>();

  const reload = () => api.listModels().then(setModels);
  useEffect(() => { void reload(); }, [shell.ollama?.state]);
  useEffect(() => api.onPullProgress((p) => { setPull(p); if (p.done) void reload(); }), []);

  const startPull = async () => {
    setConfirming(false);
    setError(undefined);
    setPull({ model: pullName.trim(), status: 'starting', done: false });
    try { await api.pullModel(pullName.trim()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const ollamaModels = models?.filter((m) => m.kind === 'ollama') ?? [];
  const reference = models?.find((m) => m.kind === 'reference');
  const running = shell.ollama?.state === 'running';
  const pulling = pull !== undefined && !pull.done;

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Models</h1><p>Every model Ollama has installed on {here}, plus the built-in reference model. Choose which to benchmark on the Benchmark screen.</p></div>
        <div className="row">
          <button className="btn" onClick={reload}>Refresh</button>
          <button className="btn primary" onClick={() => shell.go('benchmark')} disabled={models === undefined}>Benchmark…</button>
        </div>
      </div>

      {shell.ollama && shell.ollama.state !== 'running' && <OllamaStatusCard shell={shell} />}

      <Card title={`Installed in Ollama${models ? ` · ${ollamaModels.length}` : ''}`}>
        {models === undefined ? <p className="muted">Loading…</p> : ollamaModels.length === 0 ? (
          <Empty title={running ? 'No models installed yet' : 'Ollama is not running'}>
            <p>{running ? <>Add a model below. Popular small choices: <code>llama3.2:3b</code>, <code>gemma3:4b</code>, <code>qwen3:4b</code>, <code>phi4-mini</code>.</> : 'Start Ollama to see its models. Until then, the built-in reference model can run any benchmark.'}</p>
          </Empty>
        ) : (
          <div className="table-wrap"><table className="table" data-testid="models-table">
            <thead><tr><th>Model</th><th>Size</th><th>Parameters</th><th>Quantization</th><th>Family</th><th>Modified</th><th>Status</th><th className="num">Runs</th></tr></thead>
            <tbody>
              {ollamaModels.map((m) => (
                <tr key={m.key}>
                  <td><strong>{m.name}</strong><div className="sub mono">{m.digest ? m.digest.replace('sha256:', '').slice(0, 12) : 'no digest reported'}</div></td>
                  <td className="nowrap">{bytes(m.sizeBytes)}</td><td>{m.parameterSize ?? '—'}</td><td>{m.quantization ?? '—'}</td><td>{m.family ?? '—'}</td>
                  <td className="muted nowrap">{when(m.modifiedAt)}</td>
                  <td><Pill tone="ok">Ready</Pill></td>
                  <td className="num">{m.runsInHistory}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Add a model">
          <div className="stack">
            <p className="muted small">Type an Ollama model name (for example <code>llama3.2:3b</code>). Cernum asks Ollama to download it only after you confirm. Downloads are often several gigabytes.</p>
            <div className="row">
              <input className="input" style={{ flex: 1 }} placeholder="model name, e.g. gemma3:4b" value={pullName} onChange={(e) => setPullName(e.target.value)} disabled={!running || pulling} aria-label="Model name to download"
                     onKeyDown={(e) => { if (e.key === 'Enter' && running && pullName.trim() && !pulling) setConfirming(true); }} />
              <button className="btn primary" disabled={!running || pullName.trim().length === 0 || pulling} onClick={() => setConfirming(true)}>Download…</button>
            </div>
            {!running && <p className="small faint">Start Ollama first.</p>}
            {pull && (
              <div className="stack">
                <div className="spread"><span>{pull.model} · {pull.status}</span>{!pull.done && <button className="btn small danger" onClick={() => api.cancelPull()}>Cancel</button>}</div>
                {pull.totalBytes ? <Progress value={pull.completedBytes ?? 0} max={pull.totalBytes} /> : null}
                {pull.totalBytes ? <span className="small faint">{bytes(pull.completedBytes ?? 0)} of {bytes(pull.totalBytes)}</span> : null}
                {pull.error && <div className="note bad">{pull.error}</div>}
              </div>
            )}
            {error && <div className="note bad">{error}</div>}
          </div>
        </Card>
        <Card title="Built-in reference model">
          {reference && (
            <div className="stack">
              <div className="row"><strong>{reference.name}</strong><Pill tone="accent">Always available</Pill></div>
              <p className="muted small">{reference.readinessDetail}</p>
              <p className="small faint">Benchmarks of the reference model: {reference.runsInHistory}</p>
            </div>
          )}
        </Card>
      </div>

      {confirming && (
        <Modal title={`Download ${pullName.trim()}?`} onClose={() => setConfirming(false)}
          actions={<><button className="btn" onClick={() => setConfirming(false)}>Cancel</button><button className="btn primary" onClick={startPull}>Download</button></>}>
          <p>Cernum will ask Ollama on {here} to download <strong>{pullName.trim()}</strong> from the Ollama library. This can be several gigabytes and may take a while. You can cancel at any time; nothing else is installed or changed.</p>
        </Modal>
      )}
    </div>
  );
}
