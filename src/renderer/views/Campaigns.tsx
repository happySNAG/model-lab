import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { CampaignDetail, CampaignRow, CampaignVerification, ModelRow } from '../../shared/ipc';
import { Card, Empty, Modal, Pill, when } from '../components';

// A campaign is a long benchmark with a frozen manifest and a durable ledger. It can be driven from
// here or from the `cernum` terminal command; both write the same directory, so this screen shows a
// terminal-driven campaign exactly as it shows one started here. The screen never claims to own a
// campaign it is not running — that is what the "running in this window" distinction is for.

function stateTone(state: string): 'ok' | 'warn' | 'bad' | 'neutral' | 'accent' {
  if (state === 'complete') return 'ok';
  if (state === 'running') return 'accent';
  if (state === 'aborted' || state === 'unreadable') return 'bad';
  if (state === 'paused') return 'warn';
  return 'neutral';
}

function ratePercent(milli?: number): string {
  return milli === undefined ? 'no rate' : `${(milli / 10).toFixed(1)}%`;
}

export function CampaignsView({ shell }: { shell: Shell }) {
  const [rows, setRows] = useState<CampaignRow[]>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<CampaignDetail>();
  const [verification, setVerification] = useState<CampaignVerification>();
  const [root, setRoot] = useState<string>('');
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRows(await api.listCampaigns());
      setRoot(await api.campaignRoot());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  // Refreshing the detail must NOT discard a verification the person just asked for: this view
  // re-reads every three seconds, and clearing it here made the result vanish before it was read.
  // A verification belongs to the campaign it was run against, so the selection is what clears it.
  const loadDetail = useCallback(async (name: string) => {
    try { setDetail(await api.campaignDetail(name)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setVerification(undefined); if (selected) void loadDetail(selected); }, [selected, loadDetail]);

  // A campaign the terminal is running has no object in this process, so the screen polls rather
  // than waiting for an event that will never arrive.
  useEffect(() => {
    const timer = setInterval(() => { void refresh(); if (selected) void loadDetail(selected); }, 3000);
    return () => clearInterval(timer);
  }, [refresh, loadDetail, selected]);

  useEffect(() => api.onCampaignProgress(() => { void refresh(); if (selected) void loadDetail(selected); }), [refresh, loadDetail, selected]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); void refresh(); if (selected) void loadDetail(selected); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p>
            A campaign freezes exactly what will be run — every prompt, every scoring rule, every model — and records each
            attempt as it lands, so it survives an interruption and can be resumed without losing or repeating a single one.
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>New campaign</button>
      </div>

      {error && <div className="note bad">{error}</div>}

      <Card>
        {rows === undefined ? <p className="muted">Loading…</p> : rows.length === 0 ? (
          <Empty title="No campaigns yet">
            <p>Campaigns are for long comparisons you expect to interrupt. For a quick one-off, use Benchmark instead.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>New campaign</button>
            <p className="muted">You can also start one from a terminal: <code>npm run cernum -- create my-run --models gemma3:4b</code></p>
          </Empty>
        ) : (
          <div className="table-wrap"><table className="table" data-testid="campaign-table">
            <thead><tr><th>Campaign</th><th>State</th><th className="num">Recorded</th><th>Created</th><th>Manifest</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.name} className="clickable" tabIndex={0}
                  onClick={() => setSelected(row.name)}
                  onKeyDown={(event) => { if (event.key === 'Enter') setSelected(row.name); }}>
                <td>
                  <strong>{row.label}</strong>
                  <div className="muted small">{row.name}</div>
                  {row.problem && <div className="note bad small">{row.problem}</div>}
                </td>
                <td>
                  <Pill tone={stateTone(row.state)} pulse={row.state === 'running'}>{row.state}</Pill>
                  {row.running && <span className="muted small"> in this window</span>}
                  {!row.balances && row.state !== 'created' && <div className="muted small">ledger does not balance</div>}
                </td>
                <td className="num">{row.terminalCount}/{row.slotCount}{row.blockedCount > 0 ? ` · ${row.blockedCount} blocked` : ''}</td>
                <td>{when(row.createdAt)}</td>
                <td className="mono small">{row.manifestID.replace('manifest:', '')}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {root && <p className="muted small">Campaigns live in <code>{root}</code>. The terminal command writes here too, so a run started there appears above while it is running.</p>}
      </Card>

      {selected && detail && (
        <Modal title={detail.status.label} wide onClose={() => { setSelected(undefined); setDetail(undefined); }}
               actions={<>
                 <button className="btn" disabled={busy} onClick={() => void act(async () => setVerification(await api.verifyCampaign(selected)))}>Verify manifest</button>
                 {detail.status.state === 'complete'
                   ? <button className="btn" disabled={busy} onClick={() => void act(async () => setDetail(await api.finalizeCampaign(selected)))}>Finalize</button>
                   : rows?.find((row) => row.name === selected)?.running
                     ? <button className="btn" disabled={busy} onClick={() => void act(() => api.pauseCampaign())}>Pause</button>
                     : <button className="btn primary" disabled={busy} onClick={() => void act(() => api.startCampaign(selected))}>
                         {detail.status.terminalCount > 0 ? 'Resume' : 'Start'}
                       </button>}
                 <button className="btn" onClick={() => { setSelected(undefined); setDetail(undefined); }}>Close</button>
               </>}>
          <p className="mono small">{detail.manifest.seal}</p>
          <p className="muted small">
            Frozen {when(detail.manifest.frozenAt)} over {detail.manifest.promptCount} prompt(s) and {detail.manifest.candidateCount} model(s).
            {detail.manifest.retestOf && <> Derived from <span className="mono">{detail.manifest.retestOf}</span> for different hardware — quality is comparable with it, latency is not.</>}
          </p>

          <p>
            <strong>{detail.status.terminalCount} of {detail.status.slotCount}</strong> attempts recorded, {detail.status.remaining} remaining.
            {detail.status.candidatesComplete.length > 0 && <> Finished: {detail.status.candidatesComplete.join(', ')}.</>}
          </p>

          {detail.status.standingAbort && (
            <div className="note bad">
              <strong>Stopped at {detail.status.standingAbort.stage}.</strong> {detail.status.standingAbort.reason}
              <p>{detail.status.standingAbort.blockedSlotCount} attempt(s) were blocked. They were never made and carry no result — resolve what stopped it, then resume, and they run normally.</p>
            </div>
          )}

          {detail.anomalies.length > 0 && (
            <div className="note warn">
              <strong>The ledger noticed something.</strong>
              <ul>{detail.anomalies.map((anomaly, index) => <li key={index}>{anomaly.kind}{anomaly.why ? ` — ${anomaly.why}` : ''}</li>)}</ul>
            </div>
          )}

          {verification && (
            <div className={`note ${verification.intact ? 'ok' : 'bad'}`}>
              {verification.intact ? 'Intact — every binding still matches what was frozen.' : (
                <>
                  <strong>{verification.drifts.length} thing(s) moved since this was frozen{verification.hardwareOnly ? ' — hardware only' : ''}.</strong>
                  <ul>{verification.drifts.map((drift) => <li key={drift.field}><strong>{drift.field}</strong> — {drift.meaning}</li>)}</ul>
                </>
              )}
            </div>
          )}

          {detail.report && (
            <>
              <h3>Rankings</h3>
              {detail.report.provisional && (
                <div className="note warn">
                  <strong>Provisional.</strong>
                  <ul>{detail.report.provisionalBecause.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
                </div>
              )}
              <div className="table-wrap"><table className="table">
                <thead><tr><th className="num">#</th><th>Model</th><th className="num">Pass rate</th><th className="num">Scored</th><th>Suited to</th></tr></thead>
                <tbody>{detail.report.rankings.map((ranking) => (
                  <tr key={ranking.candidate}>
                    <td className="num">{ranking.rank}</td>
                    <td>{ranking.candidate}{ranking.disqualified && <> <Pill tone="bad">disqualified</Pill></>}</td>
                    <td className="num">{ratePercent(ranking.passRateMilli)}</td>
                    <td className="num">{ranking.scoredCount}</td>
                    <td>{ranking.roles.length > 0 ? ranking.roles.join(', ') : <span className="muted">no role cleared</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>

              <h3>{detail.report.retentionHeading}</h3>
              <ul>{detail.report.retention.map((recommendation) => <li key={recommendation.candidate}>{recommendation.statement}</li>)}</ul>

              {detail.report.awaitingHumanReview > 0 && (
                <div className="note">
                  <strong>{detail.report.awaitingHumanReview} answer(s) need a person to judge them.</strong>
                  <p>
                    They are excluded from every rate above until you do. A blinded packet has been written with the model
                    names removed and the answers shuffled, so you can judge them without knowing who wrote what
                    {detail.report.packetClean === false && <> — but the leak audit did not come back clean, so read it before sharing it</>}.
                  </p>
                  {detail.report.packetPath && <button className="btn" onClick={() => void api.revealPath(detail.report!.packetPath!)}>Show the packet</button>}
                </div>
              )}
            </>
          )}

          <h3>Latest attempts</h3>
          {detail.recentAttempts.length === 0 ? <p className="muted">Nothing recorded yet.</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Attempt</th><th>Outcome</th><th className="num">Latency</th><th>Notes</th></tr></thead>
              <tbody>{detail.recentAttempts.map((attempt) => (
                <tr key={attempt.slotKey}>
                  <td className="mono small">{attempt.slotKey}</td>
                  <td>{attempt.status}</td>
                  <td className="num">{attempt.latencyMilliseconds === undefined ? 'not reported' : `${attempt.latencyMilliseconds} ms`}</td>
                  <td className="small">
                    {attempt.identityState !== 'verified' && <div className="muted">identity {attempt.identityState}</div>}
                    {attempt.suppliedContextState !== 'intact' && attempt.suppliedContextState !== 'notSupplied' && <div className="muted">context {attempt.suppliedContextState}</div>}
                    {attempt.detail}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          <p className="muted small">Same campaign in a terminal: <code>{detail.terminalHint}</code></p>
        </Modal>
      )}

      {creating && <CreateCampaign onClose={() => setCreating(false)} onCreated={(rows_) => { setRows(rows_); setCreating(false); }} onError={setError} />}
    </div>
  );
}

function CreateCampaign({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (rows: CampaignRow[]) => void; onError: (message: string) => void }) {
  const [models, setModels] = useState<ModelRow[]>();
  const [suites, setSuites] = useState<{ id: string; title: string; caseCount: number }[]>();
  const [name, setName] = useState('');
  const [chosenModels, setChosenModels] = useState<string[]>([]);
  const [chosenSuites, setChosenSuites] = useState<string[]>([]);
  const [repeats, setRepeats] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.listModels().then((rows) => setModels(rows.filter((row) => row.kind === 'ollama')));
    void api.campaignSuites().then((rows) => { setSuites(rows); setChosenSuites(rows.map((row) => row.id)); });
  }, []);

  const toggle = (list: string[], value: string, set: (next: string[]) => void) =>
    set(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const ready = safeName.length > 0 && chosenModels.length > 0 && chosenSuites.length > 0;

  const create = async () => {
    setBusy(true);
    try {
      onCreated(await api.createCampaign({
        name: safeName, label: name.trim() || safeName, modelNames: chosenModels,
        suiteIDs: chosenSuites, repeatsPerCase: repeats, runtimeVersion: 'ollama-unreported',
      }));
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const attempts = (suites ?? []).filter((suite) => chosenSuites.includes(suite.id)).reduce((sum, suite) => sum + suite.caseCount, 0) * repeats * chosenModels.length;

  return (
    <Modal title="New campaign" wide onClose={onClose}
           actions={<>
             <button className="btn" onClick={onClose}>Cancel</button>
             <button className="btn primary" disabled={!ready || busy} onClick={() => void create()}>Freeze and create</button>
           </>}>
      <p>Creating a campaign freezes what will be run. Nothing is asked of a model until you start it.</p>

      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="September cohort" />
        {safeName && <span className="muted small">Directory: {safeName}</span>}
      </label>

      <h3>Models</h3>
      {models === undefined ? <p className="muted">Loading…</p> : models.length === 0 ? <p className="muted">No models are installed.</p> : (
        <div className="check-list">{models.map((model) => (
          <label key={model.key} className="check">
            <input type="checkbox" checked={chosenModels.includes(model.name)} onChange={() => toggle(chosenModels, model.name, setChosenModels)} />
            <span>{model.name} <span className="muted small">{model.parameterSize} {model.quantization}</span></span>
          </label>
        ))}</div>
      )}

      <h3>Suites</h3>
      {suites === undefined ? <p className="muted">Loading…</p> : (
        <div className="check-list">{suites.map((suite) => (
          <label key={suite.id} className="check">
            <input type="checkbox" checked={chosenSuites.includes(suite.id)} onChange={() => toggle(chosenSuites, suite.id, setChosenSuites)} />
            <span>{suite.title} <span className="muted small">{suite.caseCount} case(s)</span></span>
          </label>
        ))}</div>
      )}

      <label className="field">
        <span>Passes per case</span>
        <input type="number" min={1} max={10} value={repeats} onChange={(event) => setRepeats(Math.max(1, Number(event.target.value) || 1))} />
        <span className="muted small">More passes measure how consistent a model is, at proportional cost.</span>
      </label>

      <p className={attempts > 0 ? 'note' : 'muted'}>{attempts > 0 ? `${attempts} attempt(s) will be planned.` : 'Choose at least one model and one suite.'}</p>
    </Modal>
  );
}
