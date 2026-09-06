import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { AttemptDetail, ModelResult, SessionRecord, SessionResults } from '../../shared/ipc';
import { Card, Empty, Modal, Pill, caseLabel, dimensionLabel, ms, pct, sessionStateLabel, statusLabel, statusTone, tps, when } from '../components';

type Tab = 'ranking' | 'dimensions' | 'cases' | 'recommendation';

export function ResultsView({ shell }: { shell: Shell }) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [sessionID, setSessionID] = useState<string | undefined>(shell.params.sessionID);
  const [results, setResults] = useState<SessionResults>();
  const [tab, setTab] = useState<Tab>('ranking');
  const [detail, setDetail] = useState<AttemptDetail>();
  const [caseFilterModel, setCaseFilterModel] = useState<string>('all');
  const [caseFilterOutcome, setCaseFilterOutcome] = useState<string>('all');
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api.listSessions().then((list) => {
      setSessions(list);
      if (!sessionID) setSessionID(shell.params.sessionID ?? list.find((s) => s.state !== 'running')?.sessionID ?? list[0]?.sessionID);
    });
  }, [shell.params.sessionID, shell.progress?.state]);

  useEffect(() => {
    if (!sessionID) return;
    setError(undefined);
    void api.getSessionResults(sessionID).then(setResults).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [sessionID, shell.progress?.state]);

  const cases = useMemo(() => results?.cases.filter((c) => (caseFilterModel === 'all' || c.candidateID === caseFilterModel)
    && (caseFilterOutcome === 'all' || (caseFilterOutcome === 'problems' ? (c.governance?.state === 'violated' || c.evaluationStatus === 'fail' || c.terminalStatus !== 'completed') : caseFilterOutcome === 'human' ? c.evaluationStatus === 'requiresHumanReview' : true))) ?? [], [results, caseFilterModel, caseFilterOutcome]);

  const record = async (candidateID: string) => {
    if (!results) return;
    try { await api.recordRecommendation(results.session.sessionID, candidateID); shell.toast('Recommendation recorded in the evidence store.'); setResults(await api.getSessionResults(results.session.sessionID)); }
    catch (e) { shell.toast(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Results</h1><p>What each model did on this benchmark. Rankings apply only within one benchmark, where every model faced the same prompts on the same machine.</p></div>
        {sessions.length > 0 && (
          <select className="input" value={sessionID ?? ''} onChange={(e) => setSessionID(e.target.value)} data-testid="session-select" aria-label="Benchmark to show">
            {sessions.map((s) => <option key={s.sessionID} value={s.sessionID}>{s.label} — {when(s.createdAt)}</option>)}
          </select>
        )}
      </div>

      {error && <div className="note bad">{error}</div>}
      {sessions.length === 0 && <Card><Empty title="No results yet"><p>Run a benchmark to see results here.</p><button className="btn primary" onClick={() => shell.go('benchmark')}>Set up a benchmark</button></Empty></Card>}

      {results && (
        <>
          <Card flat>
            <div className="spread">
              <div className="stack" style={{ gap: 4 }}>
                <div className="row"><strong>{results.session.label}</strong><Pill tone={statusTone(results.session.state)}>{sessionStateLabel(results.session.state)}</Pill></div>
                <span className="muted small">{results.workloadSummary}</span>
                <span className="faint small">{results.session.machine.hostname} · {results.session.machine.cpuLabel} · {results.session.machine.memoryLabel}{results.session.runtimeVersion ? ` · Ollama ${results.session.runtimeVersion}` : ''} · {when(results.session.createdAt)}</span>
                {results.session.state !== 'completed' && results.session.failureDetail && <span className="small" style={{ color: 'var(--bad)' }}>{results.session.failureDetail}</span>}
              </div>
            </div>
          </Card>

          <Verdict results={results} />

          <div className="tabs" role="tablist">
            {(['ranking', 'dimensions', 'cases', 'recommendation'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)} data-testid={`tab-${t}`}>{{ ranking: 'Ranking', dimensions: 'Side by side', cases: 'Every case', recommendation: 'Recommendation' }[t]}</button>
            ))}
          </div>

          {tab === 'ranking' && <Ranking results={results} />}
          {tab === 'dimensions' && <Dimensions results={results} />}
          {tab === 'cases' && (
            <Card title={`Every case · ${cases.length}`} actions={
              <div className="row">
                <select className="input" value={caseFilterOutcome} onChange={(e) => setCaseFilterOutcome(e.target.value)} aria-label="Filter by outcome">
                  <option value="all">All outcomes</option>
                  <option value="problems">Problems only</option>
                  <option value="human">Needs human review</option>
                </select>
                <select className="input" value={caseFilterModel} onChange={(e) => setCaseFilterModel(e.target.value)} aria-label="Filter by model">
                  <option value="all">All models</option>
                  {results.models.map((m) => <option key={m.candidate.id.raw} value={m.candidate.id.raw}>{m.modelName}</option>)}
                </select>
              </div>}>
              {cases.length === 0 ? <p className="muted">No cases match this filter.</p> : (
                <div className="table-wrap"><table className="table" data-testid="cases-table">
                  <thead><tr><th>Model</th><th>Case</th><th>What it checks</th><th>Outcome</th><th>Judgment</th><th className="num">Latency</th><th className="num">Speed</th></tr></thead>
                  <tbody>{cases.map((c) => (
                    <tr key={c.attemptID} className="clickable" tabIndex={0} onClick={() => api.getAttemptDetail(c.attemptID).then(setDetail)} onKeyDown={(e) => { if (e.key === 'Enter') void api.getAttemptDetail(c.attemptID).then(setDetail); }}>
                      <td>{c.modelName}</td><td>{caseLabel(c.caseID)}</td><td className="muted">{c.capability}</td>
                      <td><Pill tone={statusTone(c.terminalStatus)}>{statusLabel(c.terminalStatus)}</Pill></td>
                      <td>{c.governance?.state === 'violated' ? <Pill tone="bad">Boundary violated</Pill> : c.evaluationStatus ? <Pill tone={statusTone(c.evaluationStatus)}>{statusLabel(c.evaluationStatus)}</Pill> : <span className="faint">not judged</span>}</td>
                      <td className="num">{ms(c.latencyMilliseconds)}</td><td className="num">{tps(c.tokensPerSecondMilli)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
              <p className="small faint" style={{ marginTop: 10 }}>Click a row to see the exact prompt, the answer, and how the rule judged it.</p>
            </Card>
          )}
          {tab === 'recommendation' && <Recommendation results={results} onRecord={record} />}
        </>
      )}

      {detail && <AttemptModal detail={detail} onClose={() => setDetail(undefined)} />}
    </div>
  );
}

/**
 * The one-paragraph answer, derived only from the ranking the service already computed: who came
 * first, by how much, and every reason the reader should NOT over-read it (one model, disqualified,
 * missing evidence, a narrow margin, an unfinished run). No new scoring lives here.
 */
function Verdict({ results }: { results: SessionResults }) {
  const models = results.models;
  const n = models.length;
  const top = models[0];
  const quality = (m: ModelResult) => ('measured' in m.qualityRateMilli ? m.qualityRateMilli.measured : undefined);
  const unfinished = results.session.state !== 'completed';
  let tone: 'accent' | 'warn' | 'bad' | 'neutral' = 'accent';
  let title: string;
  let body: string;
  const caveats: string[] = [];

  if (!top) {
    tone = 'neutral'; title = 'No model results'; body = 'This benchmark recorded no attempts.';
  } else if (n === 1) {
    tone = 'neutral';
    title = 'One model, so nothing to rank';
    const q = quality(top);
    body = `${top.modelName} ${q === undefined ? 'produced no judgeable answers' : `scored ${Math.round(q / 10)}% quality on the answers a rule could judge`}${top.disqualified ? ` and crossed ${top.governanceFailures} hard boundar${top.governanceFailures === 1 ? 'y' : 'ies'}` : ''}. Run two or more models together to compare them under identical conditions.`;
  } else if (top.disqualified) {
    tone = 'bad';
    title = 'No clean result';
    body = `Every model crossed at least one hard boundary, so none is recommended on this evidence. The ranking below orders them by how many boundaries they crossed, then quality.`;
  } else if (quality(top) === undefined) {
    tone = 'warn';
    title = 'Not enough judged answers to rank';
    body = 'No model produced enough answers a rule could judge. Check the Every case tab for what went wrong (timeouts, malformed output, unavailable models).';
  } else {
    const second = models[1];
    const q1 = quality(top)!;
    const q2 = quality(second);
    const margin = q2 === undefined ? undefined : q1 - q2;
    const disqualified = models.filter((m) => m.disqualified).length;
    title = `${top.modelName} ranked first of ${n}`;
    if (margin !== undefined && margin < 50 && !second.disqualified) {
      tone = 'warn';
      body = `${Math.round(q1 / 10)}% quality against ${Math.round(q2! / 10)}% for ${second.modelName} — within five points, which this benchmark cannot separate. Treat them as tied on quality and look at latency, reliability, and the per-capability view.`;
    } else {
      body = `${Math.round(q1 / 10)}% quality on the answers a rule could judge${q2 !== undefined ? `, ahead of ${second.modelName} at ${Math.round(q2 / 10)}%` : ''}, with no hard boundary crossed.`;
    }
    if (disqualified > 0) caveats.push(`${disqualified} of ${n} model${n === 1 ? '' : 's'} crossed a hard boundary and rank last regardless of quality.`);
    if (top.humanReviewCount > 0) caveats.push(`${top.humanReviewCount} of the winner's answers need human review and are not counted either way.`);
    if ('measured' in top.reliabilityMilli && top.reliabilityMilli.measured < 1000) caveats.push(`${top.modelName} answered ${top.answeredAttempts} of ${top.plannedAttempts} prompts; the rest timed out or failed.`);
  }
  if (unfinished) caveats.push(`This benchmark ${results.session.state === 'cancelled' ? 'was cancelled' : `is ${sessionStateLabel(results.session.state).toLowerCase()}`}, so the models did not all face every prompt; the ranking covers only what was recorded.`);
  const icon = tone === 'bad' ? '!' : tone === 'warn' ? '≈' : tone === 'neutral' ? '1' : '★';
  return (
    <div className="verdict" data-testid="verdict">
      <div className={`verdict-icon ${tone}`} aria-hidden>{icon}</div>
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
        {caveats.length > 0 && <ul className="list-plain small muted" style={{ marginTop: 8 }}>{caveats.map((c) => <li key={c}>{c}</li>)}</ul>}
      </div>
    </div>
  );
}

function Ranking({ results }: { results: SessionResults }) {
  return (
    <div className="stack">
      <Card title="Ranking within this benchmark">
        <div className="table-wrap"><table className="table" data-testid="ranking-table">
          <thead><tr><th>#</th><th>Model</th><th>Quality</th><th className="num">Pass / partial / fail</th><th className="num">Reliability</th><th className="num">Median latency</th><th className="num">p95</th><th className="num">Speed</th><th>Boundaries</th></tr></thead>
          <tbody>{results.models.map((m) => (
            <tr key={m.candidate.id.raw}>
              <td><span className={`rank${m.rank === 1 && !m.disqualified && results.models.length > 1 ? ' top' : ''}`}>{m.rank}</span></td>
              <td><strong>{m.modelName}</strong><div className="sub">{m.candidate.quantization !== 'none' && m.candidate.quantization !== 'unreported' ? m.candidate.quantization : m.candidate.provider === 'model-lab-fake' ? 'built-in reference' : m.candidate.provider}</div></td>
              <td><span className="hero-number" style={{ fontSize: 20 }}>{pct(m.qualityRateMilli)}</span></td>
              <td className="num nowrap">{m.passCount} / {m.partialCount} / {m.failCount}{m.humanReviewCount > 0 && <div className="sub">{m.humanReviewCount} for human review</div>}</td>
              <td className="num">{pct(m.reliabilityMilli)}<div className="sub">{m.answeredAttempts} of {m.plannedAttempts} answered</div></td>
              <td className="num nowrap">{ms(m.medianLatencyMilliseconds)}</td><td className="num nowrap">{ms(m.p95LatencyMilliseconds)}</td><td className="num nowrap">{tps(m.medianTokensPerSecondMilli)}</td>
              <td>{m.disqualified ? <Pill tone="bad">{m.governanceFailures} violated</Pill> : <Pill tone="ok">none crossed</Pill>}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="small faint" style={{ marginTop: 10 }}>Quality = passes at full weight and partials at half, over answers a rule could judge. A crossed hard boundary sinks a model to the bottom whatever its quality. Timeouts and errors count against reliability, never as zero quality. Speed is n/a when the runtime reported no token counts (the built-in reference model never does).</p>
      </Card>
      <div className="grid-2">
        {results.models.map((m) => (
          <Card key={m.candidate.id.raw} title={m.modelName}>
            <div className="grid-2">
              <div><h3 className="small muted" style={{ marginBottom: 6 }}>Strengths</h3>{m.strengths.length === 0 ? <p className="faint small">none stood out</p> : <ul className="list-plain small">{m.strengths.map((s) => <li key={s}>{s}</li>)}</ul>}</div>
              <div><h3 className="small muted" style={{ marginBottom: 6 }}>Weaknesses</h3>{m.weaknesses.length === 0 ? <p className="faint small">none stood out</p> : <ul className="list-plain small">{m.weaknesses.map((s) => <li key={s}>{s}</li>)}</ul>}</div>
            </div>
            <div className="divider" />
            <div className="row small muted">
              {Object.entries(m.terminalStatusCounts).sort().map(([s, n]) => <Pill key={s} tone={statusTone(s)}>{statusLabel(s)} {n}</Pill>)}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Dimensions({ results }: { results: SessionResults }) {
  const rate = (m: ModelResult, dimension: string) => m.profile.dimensions.find((d) => d.dimension === dimension);
  return (
    <Card title="Side by side, by capability">
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Capability</th>{results.models.map((m) => <th key={m.candidate.id.raw}>{m.modelName}</th>)}</tr></thead>
        <tbody>{results.dimensions.map((dimension) => (
          <tr key={dimension}>
            <td><strong>{dimensionLabel(dimension)}</strong></td>
            {results.models.map((m) => {
              const d = rate(m, dimension);
              if (!d) return <td key={m.candidate.id.raw} className="faint">no evidence</td>;
              const violated = d.disqualifications.length > 0;
              return (
                <td key={m.candidate.id.raw}>
                  <div className="row">
                    <span style={{ fontWeight: 600 }}>{pct(d.qualityRateMilli)}</span>
                    <span className="faint small">{d.sampleSize} case{d.sampleSize === 1 ? '' : 's'}</span>
                    {violated && <Pill tone="bad">{d.disqualifications.length} violated</Pill>}
                    {d.requiresHumanReviewCount > 0 && <Pill tone="warn">{d.requiresHumanReviewCount} human review</Pill>}
                  </div>
                  {'measured' in d.qualityRateMilli && <div className="progress thin" style={{ marginTop: 6 }}><span style={{ width: `${Math.round(d.qualityRateMilli.measured / 10)}%`, background: violated ? 'var(--bad)' : undefined }} /></div>}
                </td>
              );
            })}
          </tr>
        ))}</tbody>
      </table></div>
      <p className="small faint" style={{ marginTop: 10 }}>Percentages are per capability and are never combined into one score. "n/a" means no answer could be judged, which is missing evidence, not a zero.</p>
    </Card>
  );
}

function Recommendation({ results, onRecord }: { results: SessionResults; onRecord: (candidateID: string) => void }) {
  const policy = results.recommendationPolicy;
  return (
    <div className="stack">
      <div className="note">
        <strong>How to read this.</strong> Model Lab derives one of four outcomes per model — recommended, not recommended, insufficient evidence, disqualified — under a fixed policy:
        at least {policy.minimumSamplesPerDimension} judged answers in each of at least {policy.minimumDimensionsWithEvidence} capabilities, every covered capability at {Math.round(policy.recommendQualityThresholdMilli / 10)}% or better, and no crossed hard boundary.
        A short benchmark usually yields "insufficient evidence"; the full lab gives every capability enough cases. A recommendation is evidence for your decision; it changes nothing by itself.
      </div>
      {results.recommendation.map((r) => (
        <Card key={r.candidateID} title={r.modelName} actions={
          <div className="row">
            <Pill tone={statusTone(r.record.outcome)}>{statusLabel(r.record.outcome)}</Pill>
            {r.recorded ? <span className="small faint">recorded</span> : <button className="btn small" onClick={() => onRecord(r.candidateID)}>Record in evidence</button>}
          </div>}>
          <ul className="list-plain small">{r.record.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          {r.record.governanceFailures.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="small" style={{ cursor: 'pointer', color: 'var(--bad)' }}>{r.record.governanceFailures.length} boundary failure{r.record.governanceFailures.length === 1 ? '' : 's'} in detail</summary>
              <div className="note bad" style={{ marginTop: 8 }}>
                {r.record.governanceFailures.map((f) => <div key={f.evaluationID}><strong>{caseLabel(f.caseID.raw)}</strong>: {f.reason}</div>)}
              </div>
            </details>
          )}
        </Card>
      ))}
    </div>
  );
}

function AttemptModal({ detail, onClose }: { detail: AttemptDetail; onClose: () => void }) {
  const a = detail.attempt;
  const e = detail.evaluations[0];
  const answer = a.observation.structuredOutputRaw ?? a.observation.outputText;
  return (
    <Modal title={`${a.candidate.exactModelIdentity} · ${caseLabel(a.caseID.raw)}`} onClose={onClose} actions={<button className="btn" onClick={onClose}>Close</button>}>
      <p className="muted small">{detail.caseCapability}</p>
      <h3>Prompt</h3>
      <div className="stack" style={{ gap: 6 }}>
        {a.inputPackage.messages.map((m, i) => <div key={i} className="answer"><span className="faint small">{m.role}</span><br />{m.content}</div>)}
        {a.inputPackage.syntheticContext && <div className="answer"><span className="faint small">context supplied</span><br />{a.inputPackage.syntheticContext}</div>}
      </div>
      <h3>Answer <Pill tone={statusTone(a.terminalStatus)}>{statusLabel(a.terminalStatus)}</Pill></h3>
      {answer !== undefined ? <div className="answer">{answer}</div> : <p className="muted">No answer arrived.</p>}
      {a.observation.errors.map((err) => <div key={err.code} className="note bad small"><strong>{err.code}</strong> · {err.detail}</div>)}
      {a.observation.warnings.map((w) => <div key={w} className="note small">{w}</div>)}
      {e && (
        <>
          <h3>Judgment <Pill tone={e.verdict.governance.state === 'violated' ? 'bad' : statusTone(e.verdict.status)}>{e.verdict.governance.state === 'violated' ? 'Boundary violated' : statusLabel(e.verdict.status)}</Pill></h3>
          {detail.policyGuidance && <p className="muted small">{detail.policyGuidance}</p>}
          <ul className="list-plain small">
            {e.verdict.metrics.map((m) => <li key={m.name}><strong>{m.name}</strong>: {statusLabel(m.status)} — {m.detail}</li>)}
            {e.verdict.governance.state === 'violated' && <li style={{ color: 'var(--bad)' }}><strong>Hard boundary {e.verdict.governance.ruleID}</strong>: {e.verdict.governance.reason}</li>}
            {e.verdict.governance.state === 'satisfied' && <li style={{ color: 'var(--ok)' }}>Hard boundary respected.</li>}
            {e.verdict.missingEvidence.map((m) => <li key={m.field}><strong>Missing {m.field}</strong>: {m.reason}</li>)}
          </ul>
          <p className="faint small">Judged by {e.evaluatorID} v{e.evaluatorVersion} under policy {e.scoringPolicyID} v{e.scoringPolicyVersion}. Capability: {dimensionLabel(e.verdict.dimension)}.</p>
        </>
      )}
      {a.observation.runtimeTelemetry && (
        <dl className="kv small">
          <dt>Total time</dt><dd>{ms(a.observation.timing.totalElapsedMilliseconds)}</dd>
          <dt>Load / prompt / generate</dt><dd>{ms(a.observation.runtimeTelemetry.loadDurationMilliseconds)} · {ms(a.observation.runtimeTelemetry.promptEvalDurationMilliseconds)} · {ms(a.observation.runtimeTelemetry.evalDurationMilliseconds)}</dd>
          <dt>Speed</dt><dd>{tps(a.observation.runtimeTelemetry.tokensPerSecondMilli)}</dd>
          <dt>Stopped because</dt><dd>{'measured' in a.observation.runtimeTelemetry.doneReason ? a.observation.runtimeTelemetry.doneReason.measured : 'not reported'}</dd>
          <dt>Identity</dt><dd>{a.observation.identityVerification.state === 'verifiedMatch' ? `verified: runtime reported ${a.observation.identityVerification.reported}` : a.observation.identityVerification.state === 'mismatch' ? `MISMATCH: runtime reported ${a.observation.identityVerification.reported}` : a.observation.identityVerification.reason}</dd>
        </dl>
      )}
      <p className="faint small mono">{a.attemptID}</p>
    </Modal>
  );
}
