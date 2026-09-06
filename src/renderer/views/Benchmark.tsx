import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { BenchmarkPreflight, ModelRow, Settings, SuiteRow } from '../../shared/ipc';
import { Card, Modal, Pill, Step, caseLabel, here } from '../components';

const QUICK_SUITES = ['suite.model-lab.foundation-v2', 'suite.model-lab.memory-honesty', 'suite.model-lab.structured-output'];

export function BenchmarkView({ shell }: { shell: Shell }) {
  const [suites, setSuites] = useState<SuiteRow[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [settings, setSettings] = useState<Settings>();
  const [selectedSuites, setSelectedSuites] = useState<Set<string>>(new Set(QUICK_SUITES));
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState('');
  const [preflight, setPreflight] = useState<BenchmarkPreflight>();
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [openSuite, setOpenSuite] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api.listSuites().then(setSuites);
    void api.listModels().then((rows) => {
      setModels(rows);
      setSelectedModels((current) => {
        if (current.size > 0) return current;
        const firstReady = rows.find((r) => r.kind === 'ollama') ?? rows.find((r) => r.kind === 'reference');
        return new Set(firstReady ? [firstReady.key] : []);
      });
    });
    void api.getSettings().then(setSettings);
  }, [shell.ollama?.state]);

  const configuration = useMemo(() => ({
    label, suiteIDs: suites.filter((s) => selectedSuites.has(s.id)).map((s) => s.id), modelKeys: [...selectedModels], thinkingMode: settings?.thinkingMode ?? 'disabled',
  }), [label, suites, selectedSuites, selectedModels, settings]);

  useEffect(() => {
    let cancelled = false;
    if (configuration.suiteIDs.length === 0 && configuration.modelKeys.length === 0) return;
    void api.preflight(configuration).then((p) => { if (!cancelled) setPreflight(p); });
    return () => { cancelled = true; };
  }, [configuration]);

  const toggle = (set: Set<string>, key: string, update: (s: Set<string>) => void) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); update(next); };
  const start = async () => {
    setStarting(true);
    setError(undefined);
    try {
      await api.startBenchmark(configuration);
      setConfirming(false);
      shell.go('live');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };
  const running = shell.progress?.state === 'running';
  const attemptsPerModel = suites.filter((s) => selectedSuites.has(s.id)).reduce((n, s) => n + s.plannedAttemptsPerModel, 0);
  const canStart = !!preflight?.ok && !running;
  const startHint = running ? 'A benchmark is already running' : preflight && !preflight.ok ? preflight.problems[0] : undefined;
  const ollamaSelected = [...selectedModels].some((k) => k !== 'reference:deterministic');

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Benchmark</h1><p>Pick the models to compare and the suites to run. Every model answers the same fixed prompts under the same settings, so the results are directly comparable within this benchmark.</p></div>
        <button className="btn primary" disabled={!canStart} title={startHint} onClick={() => setConfirming(true)} data-testid="start-benchmark">Start benchmark</button>
      </div>

      {running && <div className="note accent">A benchmark is running. <button className="btn link" onClick={() => shell.go('live')}>Watch it live</button> or wait for it to finish before starting another.</div>}

      <div className="grid-2">
        <Card title={<Step n={1}>Models</Step>} actions={<span className="small faint">{selectedModels.size} selected</span>}>
          {models.length === 0 ? <p className="muted">Loading models…</p> : (
            <div className="stack">
              {models.map((m) => (
                <label key={m.key} className={`check${selectedModels.has(m.key) ? ' selected' : ''}`}>
                  <input type="checkbox" checked={selectedModels.has(m.key)} onChange={() => toggle(selectedModels, m.key, setSelectedModels)} data-testid={`model-${m.key}`} />
                  <span className="check-body">
                    <span className="row"><strong>{m.name}</strong>{m.kind === 'reference' ? <Pill tone="accent">built-in</Pill> : <Pill tone="ok">Ollama</Pill>}</span>
                    <span className="small muted">{m.kind === 'reference' ? 'Fixed answers; useful to try the lab or check it is working.' : [m.parameterSize, m.quantization, m.family].filter(Boolean).join(' · ') || 'installed model'}</span>
                  </span>
                </label>
              ))}
              {models.filter((m) => m.kind === 'ollama').length === 0 && (
                <p className="small faint">{shell.ollama?.state === 'running' ? 'Ollama has no models yet — add one on the Models screen.' : 'Ollama is not running, so only the built-in reference model is available.'} <button className="btn link small" style={{ padding: 0 }} onClick={() => shell.go('models')}>Open Models</button></p>
              )}
            </div>
          )}
        </Card>

        <Card title={<Step n={2}>Suites</Step>} actions={
          <div className="row">
            <button className="btn small" onClick={() => setSelectedSuites(new Set(QUICK_SUITES))}>Quick check</button>
            <button className="btn small" onClick={() => setSelectedSuites(new Set(suites.map((s) => s.id)))}>Full lab</button>
            <button className="btn small" onClick={() => setSelectedSuites(new Set())}>None</button>
          </div>}>
          <div className="stack">
            {suites.map((s) => (
              <label key={s.id} className={`check${selectedSuites.has(s.id) ? ' selected' : ''}`}>
                <input type="checkbox" checked={selectedSuites.has(s.id)} onChange={() => toggle(selectedSuites, s.id, setSelectedSuites)} data-testid={`suite-${s.id}`} />
                <span className="check-body">
                  <span className="row"><strong>{s.title}</strong><span className="small faint">{s.caseCount} cases · {s.plannedAttemptsPerModel} attempts per model</span></span>
                  <span className="small muted">{s.summary}</span>
                  <button className="btn link small" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={(e) => { e.preventDefault(); setOpenSuite(s.id); }}>What exactly is tested?</button>
                </span>
              </label>
            ))}
          </div>
        </Card>
      </div>

      <Card title={<Step n={3}>Run</Step>}>
        <div className="grid-2">
          <div className="field"><label htmlFor="label">Name this benchmark (optional)</label><input id="label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Laptop comparison, April" /></div>
          <dl className="kv">
            <dt>Ollama endpoint</dt><dd className="mono">{settings?.ollamaEndpoint ?? '…'}</dd>
            <dt>Model thinking</dt><dd>{settings?.thinkingMode === 'disabled' ? 'Disabled on every request (default)' : settings?.thinkingMode === 'enabled' ? 'Enabled; only final answers are judged' : "Ollama's default, recorded as such"}</dd>
            <dt>Attempts</dt><dd>{attemptsPerModel} per model · {attemptsPerModel * selectedModels.size} total</dd>
            <dt>Temperature</dt><dd>0 for every prompt (fixed by each suite)</dd>
          </dl>
        </div>
        <div className="divider" />
        <div className="stack">
          <p className="muted small">What happens: each selected model receives the same synthetic prompts. Answers are judged by fixed, deterministic rules that never use another AI. Anything a rule cannot judge is marked for human review rather than guessed. Every attempt is stored permanently on {here}.</p>
          {preflight && !preflight.ok && <div className="note warn" role="alert"><ul className="list-plain">{preflight.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
          {error && <div className="note bad" role="alert">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={!canStart} title={startHint} onClick={() => setConfirming(true)} data-testid="start-benchmark-bottom">Start benchmark</button>
            {preflight?.ok && ollamaSelected && preflight.estimatedMaxMinutes > 0 && <span className="small faint">Worst case about {preflight.estimatedMaxMinutes} min if every prompt hits its time limit; usually far less.</span>}
            {preflight?.ok && !ollamaSelected && <span className="small faint">The reference model answers instantly; this run takes seconds.</span>}
          </div>
        </div>
      </Card>

      {openSuite && (() => {
        const s = suites.find((x) => x.id === openSuite)!;
        return (
          <Modal title={s.title} onClose={() => setOpenSuite(undefined)} actions={<button className="btn" onClick={() => setOpenSuite(undefined)}>Close</button>}>
            <p className="muted">{s.summary}</p>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Case</th><th>What it checks</th><th>Format</th><th>Reps</th><th>Time limit</th><th>Rule</th></tr></thead>
              <tbody>{s.cases.map((c) => (
                <tr key={c.id}><td>{caseLabel(c.id)}</td><td>{c.capability}</td><td>{c.responseFormat === 'json' ? 'JSON' : 'text'}</td><td>{c.repetitions}</td><td className="nowrap">{Math.round(c.budgetMilliseconds / 1000)} s</td><td>{c.governance ? <Pill tone="warn">hard boundary</Pill> : <span className="faint">quality</span>}</td></tr>
              ))}</tbody>
            </table></div>
            <p className="small faint">A hard boundary is a rule a model must never cross (inventing a personal fact, claiming an action happened). Crossing one disqualifies the model on that case regardless of how fluent the answer is.</p>
          </Modal>
        );
      })()}

      {confirming && preflight && (
        <Modal title="Start this benchmark?" onClose={() => setConfirming(false)}
          actions={<><button className="btn" onClick={() => setConfirming(false)} disabled={starting}>Cancel</button><button className="btn primary" onClick={start} disabled={starting} data-testid="confirm-start">{starting ? 'Starting…' : 'Start'}</button></>}>
          <dl className="kv">
            <dt>Models</dt><dd>{preflight.models.map((m) => m.name).join(', ')}</dd>
            <dt>Suites</dt><dd>{preflight.suites.map((s) => s.title.replace(/^Skippy /, '').replace(/^Model Lab /, '')).join(', ')}</dd>
            <dt>Attempts</dt><dd>{preflight.totalAttempts}</dd>
          </dl>
          <ul className="list-plain small muted">{preflight.statements.map((s) => <li key={s}>{s}</li>)}</ul>
        </Modal>
      )}
    </div>
  );
}
