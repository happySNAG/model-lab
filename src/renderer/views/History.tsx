import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { HistoryEntry, SessionComparison } from '../../shared/ipc';
import { Card, Empty, Modal, Pill, here, ms, pct, sessionStateLabel, statusTone, when } from '../components';

const FULL_LAB = 14;

function suitesText(titles: string[]): string {
  if (titles.length >= FULL_LAB) return `Full lab · ${titles.length} suites`;
  if (titles.length <= 3) return titles.join(', ');
  return `${titles.slice(0, 2).join(', ')} + ${titles.length - 2} more`;
}

export function HistoryView({ shell }: { shell: Shell }) {
  const [entries, setEntries] = useState<HistoryEntry[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<SessionComparison>();
  const [error, setError] = useState<string>();

  useEffect(() => { void api.getHistory().then(setEntries).catch((e) => setError(String(e))); }, [shell.progress?.state]);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));
  const compare = async () => {
    try { setComparison(await api.compareSessions(selected[0], selected[1])); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const open = (id?: string) => { if (id) shell.go('results', { sessionID: id }); };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>History</h1><p>Every benchmark ever run on {here}, with the machine and models it ran on. Results are never deleted or overwritten. Tick two to compare them.</p></div>
        <button className="btn primary" disabled={selected.length !== 2} title={selected.length !== 2 ? 'Tick exactly two benchmarks' : undefined} onClick={compare}>Compare selected</button>
      </div>
      {error && <div className="note bad">{error}</div>}
      <Card>
        {entries === undefined ? <p className="muted">Loading…</p> : entries.length === 0 ? (
          <Empty title="No history yet"><p>Benchmarks you run will appear here.</p><button className="btn primary" onClick={() => shell.go('benchmark')}>Set up a benchmark</button></Empty>
        ) : (
          <div className="table-wrap"><table className="table" data-testid="history-table">
            <thead><tr><th><span className="sr-only">Select</span></th><th>Benchmark</th><th>When</th><th>Suites</th><th className="num">Attempts</th><th>State</th></tr></thead>
            <tbody>{entries.map((e) => {
              const id = e.session?.sessionID;
              return (
                <tr key={id ?? e.runs[0]?.runID} className={id ? 'clickable' : ''} tabIndex={id ? 0 : -1} onClick={() => open(id)} onKeyDown={(ev) => { if (ev.key === 'Enter') open(id); }}>
                  <td onClick={(ev) => ev.stopPropagation()}>{id && <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} aria-label={`Select ${e.label} for comparison`} />}</td>
                  <td>
                    <strong>{e.label}</strong>
                    <div className="sub">{e.modelNames.join(', ')}</div>
                    <div className="sub">{e.session ? `${e.session.machine.hostname} · ${e.session.machine.cpuLabel}${e.session.runtimeVersion ? ` · Ollama ${e.session.runtimeVersion}` : ''}` : 'machine not recorded (run written outside a session)'}</div>
                  </td>
                  <td className="muted nowrap">{when(e.createdAt)}</td>
                  <td className="muted small" title={e.suiteTitles.join(', ')}>{suitesText(e.suiteTitles)}</td>
                  <td className="num">{e.attemptCount}{e.governanceFailureCount > 0 && <div><Pill tone="bad">{e.governanceFailureCount} violated</Pill></div>}</td>
                  <td><Pill tone={statusTone(e.state)}>{sessionStateLabel(e.state)}</Pill></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>

      {comparison && (
        <Modal title="Compare two benchmarks" wide onClose={() => setComparison(undefined)} actions={<button className="btn" onClick={() => setComparison(undefined)}>Close</button>}>
          <div className="stack">
            <div className="row">
              {comparison.directlyComparable ? <Pill tone="ok">Directly comparable</Pill> : <Pill tone="warn">Not like-for-like</Pill>}
            </div>
            <dl className="kv small">
              <dt>A</dt><dd><strong>{comparison.a.session.label}</strong><br /><span className="faint">{comparison.a.session.machine.hostname} · {comparison.a.session.machine.cpuLabel} · {when(comparison.a.session.createdAt)}</span></dd>
              <dt>B</dt><dd><strong>{comparison.b.session.label}</strong><br /><span className="faint">{comparison.b.session.machine.hostname} · {comparison.b.session.machine.cpuLabel} · {when(comparison.b.session.createdAt)}</span></dd>
            </dl>
            {!comparison.directlyComparable && (
              <div className="note warn">These benchmarks differ in {comparison.reasons.length > 0 ? comparison.reasons.join(', ') : 'the suites they ran'}. Numbers are shown as historical context, not as a ranking.</div>
            )}
            {comparison.sharedModelNames.length === 0 ? <p className="muted">No model appears in both benchmarks, so there is nothing to place side by side.</p> : (
              <div className="table-wrap"><table className="table">
                <thead>
                  <tr><th rowSpan={2}>Model</th><th className="group" colSpan={2}>Quality</th><th className="group" colSpan={2}>Median latency</th><th className="group" colSpan={2}>Boundaries crossed</th></tr>
                  <tr><th className="num">A</th><th className="num">B</th><th className="num">A</th><th className="num">B</th><th className="num">A</th><th className="num">B</th></tr>
                </thead>
                <tbody>{comparison.perModel.map((m) => (
                  <tr key={m.modelName}><td><strong>{m.modelName}</strong></td><td className="num">{pct(m.qualityA)}</td><td className="num">{pct(m.qualityB)}</td><td className="num">{ms(m.latencyA)}</td><td className="num">{ms(m.latencyB)}</td><td className="num">{m.governanceA}</td><td className="num">{m.governanceB}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
