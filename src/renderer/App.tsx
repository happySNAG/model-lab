import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { BRAND_MARK, TAGLINE } from '../shared/product';
import type { OllamaStatus, SessionProgress, BuildInfo, ScreenID } from '../shared/ipc';
import { isMac, here } from './components';
import { HomeView } from './views/Home';
import { ModelsView } from './views/Models';
import { ProvidersView } from './views/Providers';
import { BenchmarkView } from './views/Benchmark';
import { LiveRunView } from './views/LiveRun';
import { ResultsView } from './views/Results';
import { CampaignsView } from './views/Campaigns';
import { HistoryView } from './views/History';
import { SettingsView } from './views/Settings';

export type Screen = ScreenID;

// A menu action (or a second-instance activation) can arrive before React has mounted and subscribed.
// Capture the earliest request at module load so it is honoured instead of lost.
let earlyScreen: ScreenID | undefined;
const stopEarly = api.onNavigate((s) => { earlyScreen = s; });

const NAV: { id: Screen; label: string; icon: React.ReactNode }[] = [
  { id: 'home', label: 'Home', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v10h14V10" /></svg> },
  { id: 'models', label: 'Models', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /></svg> },
  { id: 'providers', label: 'Providers', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /><path d="M6.6 7.4 10 10.4M17.4 7.4 14 10.4M6.6 16.6 10 13.6M17.4 16.6 14 13.6" /></svg> },
  { id: 'benchmark', label: 'Benchmark', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 3h6" /><path d="M10 3v6.5L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3" /></svg> },
  { id: 'live', label: 'Live run', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg> },
  { id: 'results', label: 'Results', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20V9" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></svg> },
  { id: 'campaigns', label: 'Campaigns', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="M8 13h8" /><path d="M8 16.5h5" /></svg> },
  { id: 'history', label: 'History', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4v4.5h4.5" /><path d="M12 8v4.5l3 1.5" /></svg> },
  { id: 'settings', label: 'Settings', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg> },
];

export interface Shell {
  go: (screen: Screen, params?: Record<string, string>) => void;
  params: Record<string, string>;
  ollama?: OllamaStatus;
  refreshOllama: () => Promise<void>;
  progress?: SessionProgress;
  build?: BuildInfo;
  toast: (message: string) => void;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [params, setParams] = useState<Record<string, string>>({});
  const [ollama, setOllama] = useState<OllamaStatus>();
  const [progress, setProgress] = useState<SessionProgress>();
  const [build, setBuild] = useState<BuildInfo>();
  const [toastMessage, setToastMessage] = useState<string>();

  const refreshOllama = useCallback(async () => { setOllama(await api.getOllamaStatus()); }, []);
  const go = useCallback((next: Screen, nextParams: Record<string, string> = {}) => { setScreen(next); setParams(nextParams); }, []);
  const toast = useCallback((message: string) => { setToastMessage(message); setTimeout(() => setToastMessage(undefined), 4000); }, []);

  useEffect(() => {
    void api.getBuildInfo().then(setBuild);
    void refreshOllama();
    void api.getActiveProgress().then((p) => { if (p) setProgress(p); });
    const offProgress = api.onProgress((p) => setProgress(p));
    const offOllama = api.onOllamaStatus((s) => setOllama(s));
    const offNavigate = api.onNavigate((s) => go(s));
    stopEarly();
    if (earlyScreen) { go(earlyScreen); earlyScreen = undefined; }
    return () => { offProgress(); offOllama(); offNavigate(); };
  }, [refreshOllama, go]);

  // A benchmark that finished while another screen was showing: keep the sidebar badge honest.
  const shell: Shell = { go, params, ollama, refreshOllama, progress, build, toast };
  const running = progress?.state === 'running';
  const modifier = isMac ? '⌘' : 'Ctrl+';

  return (
    <div className={`shell${isMac ? ' mac' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>{BRAND_MARK}</div>
          <div><div className="brand-name">Cernum</div><div className="brand-sub">{TAGLINE}</div></div>
        </div>
        <nav aria-label="Screens">
          {NAV.map((item, index) => (
            <button key={item.id} className={`nav-item${screen === item.id ? ' active' : ''}`} onClick={() => go(item.id)} data-nav={item.id}
                    aria-current={screen === item.id ? 'page' : undefined} title={`${item.label} (${modifier}${index + 1})`}>
              {item.icon}<span>{item.label}</span>
              {item.id === 'live' && running && <span className="nav-badge">live</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {build ? `Version ${build.version}` : ''}<br />Results stay on {here}.<br /><span className="faint">{modifier}1–8 switch screens</span>
        </div>
      </aside>
      <main className="content" id="content">
        {screen === 'home' && <HomeView shell={shell} />}
        {screen === 'models' && <ModelsView shell={shell} />}
        {screen === 'providers' && <ProvidersView shell={shell} />}
        {screen === 'benchmark' && <BenchmarkView shell={shell} />}
        {screen === 'live' && <LiveRunView shell={shell} />}
        {screen === 'results' && <ResultsView shell={shell} />}
        {screen === 'campaigns' && <CampaignsView shell={shell} />}
        {screen === 'history' && <HistoryView shell={shell} />}
        {screen === 'settings' && <SettingsView shell={shell} />}
      </main>
      {toastMessage && <div className="toast" role="status">{toastMessage}</div>}
    </div>
  );
}
