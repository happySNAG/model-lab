import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import { Card, Empty, Pill } from '../components';
import { RoutingView as RoutingViewModel, routingViewOf } from '../routing-status-view';

// READ-ONLY. The advisory fallback chain for every task type at every tier, as the cse1 status export
// states it, with every regressed or stale route marked. A fallback chain is not a selection; this screen
// has no action: it changes nothing, contacts nothing and routes nothing.

export function RoutingScreen({ view }: { view: RoutingViewModel }) {
  if (view.state === 'unreadable') {
    return <Card><Empty title="The routing evidence could not be read"><p>{view.message}</p></Empty></Card>;
  }
  return (
    <>
      {view.corrupt && (
        <div className="note bad">
          {view.corrupt.message}
          <ul className="small">{view.corrupt.files.map((file) => <li key={file.filePath}><code>{file.filePath}</code>: {file.reason}</li>)}</ul>
        </div>
      )}
      <Card title="Regressions and stale routes">
        {view.marked.length === 0 ? <p className="muted">No route has regressed and no qualification is stale.</p> : (
          <div className="table-wrap"><table className="table" data-testid="routing-marks-table">
            <thead><tr><th>Route</th><th>Mark</th><th>Findings</th></tr></thead>
            <tbody>{view.marked.map((mark) => (
              <tr key={mark.routeKey}>
                <td><strong>{mark.routeKey}</strong></td>
                <td><Pill tone={mark.regressed ? 'bad' : 'warn'}>{mark.label}</Pill></td>
                <td className="small">{mark.findings.join(' ')}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {view.state === 'empty' && <div className="note warn">{view.message}</div>}
      {view.tasks.map((task) => (
        <Card key={task.taskType} title={<>{task.taskType} <span className="faint small">{task.capability}</span></>}>
          <div className="stack">
            {task.tiers.map((tier) => (
              <div key={tier.tier}>
                <h3 className="small">{tier.tier}</h3>
                {tier.emptyMessage ? <p className="muted small">{tier.emptyMessage}</p> : (
                  <div className="table-wrap"><table className="table">
                    <thead><tr><th className="num">#</th><th>Route</th><th>Standing</th><th>Mark</th></tr></thead>
                    <tbody>{tier.entries.map((entry) => (
                      <tr key={entry.routeKey}>
                        <td className="num">{entry.position}</td>
                        <td>
                          <strong>{entry.routeKey}</strong>
                          {entry.fallsThroughBecause.length > 0 && <div className="sub">{entry.fallsThroughBecause.join('; ')}</div>}
                        </td>
                        <td><Pill tone={entry.inChain ? 'ok' : 'neutral'}>{entry.standingLabel}</Pill></td>
                        <td>{entry.markLabel ? <Pill tone={entry.regressed ? 'bad' : 'warn'}>{entry.markLabel}</Pill> : <span className="muted small">None</span>}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
                {tier.excludedCount > 0 && <p className="faint small">{tier.excludedCount} route{tier.excludedCount === 1 ? '' : 's'} excluded at this tier.</p>}
              </div>
            ))}
          </div>
        </Card>
      ))}
      {view.disclosure && <p className="faint small">{view.disclosure}</p>}
    </>
  );
}

export function RoutingView({ shell: _shell }: { shell: Shell }) {
  const [view, setView] = useState<RoutingViewModel>();

  useEffect(() => {
    void api.getRoutingStatus().then((result) => setView(routingViewOf(result)))
      .catch((error) => setView(routingViewOf({ ok: false, root: 'the campaign root', reason: error instanceof Error ? error.message : String(error) })));
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Routing</h1>
          <p>The advisory fallback chain for each task type at each tier, with regressed and stale routes marked. A chain is not a selection. Read from the evidence on disk; this screen changes nothing.</p>
        </div>
        {view && view.state !== 'unreadable' && <Pill tone={view.regressedCount > 0 ? 'bad' : view.staleCount > 0 ? 'warn' : 'neutral'}>{view.regressedCount} regressed · {view.staleCount} stale</Pill>}
      </div>
      {view === undefined ? <Card><p className="muted">Reading the routing evidence…</p></Card> : <RoutingScreen view={view} />}
    </div>
  );
}
