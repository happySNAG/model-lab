import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import { Card, Empty, Pill, Progress, caseLabel, duration, sessionStateLabel, statusLabel, statusTone } from '../components';

export function LiveRunView({ shell }: { shell: Shell }) {
  const progress = shell.progress;
  const [now, setNow] = useState(Date.now());
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (progress?.state !== 'running') setCancelling(false); }, [progress?.state]);

  if (!progress) {
    return (
      <div className="page">
        <div className="page-head"><div><h1>Live run</h1><p>Progress of the benchmark that is running right now.</p></div></div>
        <Card><Empty title="Nothing is running"><p>Start a benchmark to watch it here.</p><button className="btn primary" onClick={() => shell.go('benchmark')}>Set up a benchmark</button></Empty></Card>
      </div>
    );
  }

  const running = progress.state === 'running';
  const endedAt = progress.recent[0]?.finishedAt ? Date.parse(progress.recent[0].finishedAt) : Date.parse(progress.startedAt);
  const elapsed = (running ? now : Math.max(endedAt, Date.parse(progress.startedAt))) - Date.parse(progress.startedAt);
  const currentElapsed = progress.currentAttemptStartedAt ? now - Date.parse(progress.currentAttemptStartedAt) : 0;
  const counts = progress.statusCounts;
  const cancel = async () => { setCancelling(true); await api.cancelBenchmark(); };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Live run</h1>
          <p>{running ? 'Each model answers each prompt in turn. Every attempt is written to the evidence store the moment it finishes, so nothing is lost if you close the app.' : 'This benchmark has finished.'}</p>
        </div>
        {running ? <button className="btn danger" onClick={cancel} disabled={cancelling} data-testid="cancel-benchmark">{cancelling ? 'Finishing current prompt…' : 'Cancel benchmark'}</button>
                 : <button className="btn primary" onClick={() => shell.go('results', { sessionID: progress.sessionID })} data-testid="view-results">View results</button>}
      </div>

      <Card>
        <div className="stack" aria-live="polite">
          <div className="spread">
            <div className="row">
              <Pill tone={running ? 'accent' : statusTone(progress.state)} pulse={running}>{running ? (cancelling ? 'Cancelling' : 'Running') : sessionStateLabel(progress.state)}</Pill>
              <span className="muted">Elapsed {duration(Math.max(0, elapsed))}</span>
            </div>
            <span className="hero-number" data-testid="overall-progress">{progress.recordedAttempts}<span className="muted" style={{ fontSize: 16, fontWeight: 500 }}> / {progress.totalAttempts} attempts</span></span>
          </div>
          <Progress value={progress.recordedAttempts} max={progress.totalAttempts} />
          <div className="row small muted">
            <span>Suite {Math.min(progress.currentRunIndex + 1, progress.totalRuns)} of {progress.totalRuns}{progress.currentSuiteTitle ? ` · ${progress.currentSuiteTitle.replace(/^Skippy /, '').replace(/^Model Lab /, '')}` : ''}</span>
          </div>
          {running && progress.currentModelName && (
            <div className="note accent"><strong>{progress.currentModelName}</strong> is answering <em>{caseLabel(progress.currentCaseID ?? '')}</em>{currentElapsed > 0 ? ` · ${duration(currentElapsed)}` : ''}</div>
          )}
          {cancelling && running && <div className="note">Cancelling. The prompt in flight is abandoned and recorded as cancelled; everything already recorded is kept.</div>}
          {progress.failureDetail && <div className="note bad" role="alert">{progress.failureDetail}</div>}
          {!running && progress.state === 'cancelled' && <div className="note warn">Cancelled by you. The {progress.recordedAttempts} attempts recorded before that are kept as evidence and appear in Results and History.</div>}
        </div>
      </Card>

      <div className="grid-2">
        <Card title="By model">
          <div className="stack">
            {progress.perModel.map((m) => (
              <div key={m.candidateID} className="stack" style={{ gap: 4 }}>
                <div className="spread"><strong>{m.modelName}</strong><span className="small muted">{m.recorded} / {m.planned}</span></div>
                <Progress value={m.recorded} max={m.planned} thin />
                <div className="row small muted">
                  <span>{m.completed} answered</span><span>· {m.failed} failed</span><span>· {m.timedOut} timed out</span>
                  {m.governanceFailures > 0 && <Pill tone="bad">{m.governanceFailures} boundary violation{m.governanceFailures > 1 ? 's' : ''}</Pill>}
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Outcomes so far">
          <div className="row">
            {Object.entries(counts).length === 0 ? <span className="muted">No attempts recorded yet.</span> :
              Object.entries(counts).sort().map(([status, n]) => <Pill key={status} tone={statusTone(status)}>{statusLabel(status)} {n}</Pill>)}
          </div>
          <p className="small faint" style={{ marginTop: 10 }}>"Answered" means a reply arrived; whether it was a good reply is the judgment shown per attempt below and in Results.</p>
        </Card>
      </div>

      <Card title="Recent attempts">
        {progress.recent.length === 0 ? <p className="muted">Waiting for the first answer…</p> : (
          <div className="recent-list">
            {progress.recent.map((a) => (
              <div key={a.attemptID} className="recent-item">
                <span className={`dot`} style={{ color: `var(--${statusTone(a.terminalStatus ?? 'neutral')})` }} aria-hidden />
                <span><strong>{a.modelName}</strong> · {caseLabel(a.caseID)}</span>
                <span className="row">
                  <Pill tone={statusTone(a.terminalStatus ?? '')}>{statusLabel(a.terminalStatus ?? '')}</Pill>
                  {a.evaluationStatus && <Pill tone={a.governanceViolated ? 'bad' : statusTone(a.evaluationStatus)}>{a.governanceViolated ? 'Boundary violated' : statusLabel(a.evaluationStatus)}</Pill>}
                </span>
                <span className="small muted nowrap">{a.elapsedMilliseconds !== undefined ? duration(a.elapsedMilliseconds) : ''}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
