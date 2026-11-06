import { useEffect, useMemo, useState } from 'react';
import { nodeColor } from './colors';
import { inEditor, postToHost } from './host';
import { repoId, useStore } from './store';
import { DetailsPanel, FlowsPanel } from './ui/Panels';
import { WorkflowView } from './workflow/WorkflowView';

function useIsMobile() {
  const query = '(max-width: 768px)';
  const [mobile, setMobile] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

function Search() {
  const index = useStore((s) => s.index);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const results = useMemo(() => (index ? index.search(q, 25) : []), [index, q]);
  return (
    <div className="search">
      <input
        placeholder="Search files, classes, functions…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) {
            useStore.getState().select(results[0].id);
            setOpen(false);
          }
        }}
      />
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((n) => (
            <li
              key={n.id}
              onMouseDown={() => {
                useStore.getState().select(n.id);
                setQ('');
                setOpen(false);
              }}
            >
              <i style={{ background: nodeColor(n) }} />
              <span className="sr-name">{n.name}</span>
              <span className="sr-kind">{n.kind}</span>
              <span className="sr-path">{n.path.split('#')[0]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Paste a public repository URL to have the server clone and analyze it. */
function AnalyzeBar() {
  const analyzeUrl = useStore((s) => s.analyzeUrl);
  const busy = useStore((s) => s.loading && s.progress !== null);
  const [url, setUrl] = useState('');
  const [open, setOpen] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    void analyzeUrl(url.trim());
    setOpen(false);
  };
  return (
    <>
      <button className="analyze-toggle" onClick={() => setOpen(!open)} aria-expanded={open} title="Analyze a repository by URL">＋ Repo</button>
      <form className={`analyze-bar ${open ? 'open' : ''}`} onSubmit={submit}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a public repo URL, e.g. github.com/owner/repo"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Repository URL"
        />
        <button type="submit" disabled={busy || !url.trim()}>{busy ? 'Analyzing…' : 'Analyze'}</button>
      </form>
    </>
  );
}

function TopBar() {
  const repos = useStore((s) => s.repos);
  const repo = useStore((s) => s.repo);
  const index = useStore((s) => s.index);
  const loadRepo = useStore((s) => s.loadRepo);
  const server = useStore((s) => s.server);
  const stats = index?.g.meta.stats;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">◈</span>
        <span className="brand-name">Tesseract</span>
      </div>
      {inEditor ? (
        <>
          <span className="repo-name" title={index?.g.meta.source}>{repo}</span>
          <button className="reanalyze" onClick={() => postToHost({ type: 'reanalyze' })} title="Analyze the workspace again">↻ Re-analyze</button>
        </>
      ) : (
        <>
          <select value={repo ?? ''} onChange={(e) => loadRepo(e.target.value)} aria-label="Repository">
            {repos.map((r) => (
              <option key={repoId(r)} value={repoId(r)}>{r.url ? `${r.name} · ${r.url.replace(/^https:\/\//, '').split('/')[0]}` : r.name}</option>
            ))}
          </select>
          {server && <AnalyzeBar />}
        </>
      )}
      <Search />
      {stats && (
        <div className="stats">
          <span>{stats.files.toLocaleString()} files</span>
          <span>{stats.loc.toLocaleString()} loc</span>
          <span>{stats.e2e ?? 0} end-to-end</span>
          <span>{stats.flows} flows</span>
        </div>
      )}
    </header>
  );
}

function Player() {
  const index = useStore((s) => s.index)!;
  const flowId = useStore((s) => s.flowId);
  const step = useStore((s) => s.step);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const follow = useStore((s) => s.follow);
  const st = useStore.getState();
  if (flowId === null) return null;
  const flow = index.g.flows[flowId];
  return (
    <div className="player">
      <button onClick={() => st.setStep(0)} title="Restart">⏮</button>
      <button onClick={() => st.setStep(step - 1)} title="Previous (←)">◀</button>
      <button className="play" onClick={() => st.togglePlay()} title="Play/pause (Space)">{playing ? '❚❚' : '▶'}</button>
      <button onClick={() => st.setStep(step + 1)} title="Next (→)">▶|</button>
      <input type="range" min={0} max={flow.steps.length - 1} value={step} onChange={(e) => st.setStep(Number(e.target.value))} />
      <span className="player-step">{step + 1}/{flow.steps.length}</span>
      <select value={speed} onChange={(e) => st.setSpeed(Number(e.target.value))}>
        {[0.5, 1, 2, 4].map((s) => (
          <option key={s} value={s}>{s}×</option>
        ))}
      </select>
      <label className="follow">
        <input type="checkbox" checked={follow} onChange={(e) => st.setFollow(e.target.checked)} /> follow
      </label>
      <button onClick={() => st.setFlow(null)} title="Close flow">✕</button>
    </div>
  );
}

function usePlayback() {
  const playing = useStore((s) => s.playing);
  const step = useStore((s) => s.step);
  const speed = useStore((s) => s.speed);
  const flowId = useStore((s) => s.flowId);
  useEffect(() => {
    if (!playing || flowId === null) return;
    const st = useStore.getState();
    const total = st.index!.g.flows[flowId].steps.length;
    const t = setTimeout(() => {
      if (step >= total - 1) useStore.setState({ playing: false });
      else st.setStep(step + 1);
    }, 1500 / speed);
    return () => clearTimeout(t);
  }, [playing, step, speed, flowId]);
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      const st = useStore.getState();
      if (e.key === 'Escape') st.flowId !== null ? st.setFlow(null) : st.select(null);
      else if (e.key === ' ' && st.flowId !== null) {
        e.preventDefault();
        st.togglePlay();
      } else if (e.key === 'ArrowRight' && st.flowId !== null) st.setStep(st.step + 1);
      else if (e.key === 'ArrowLeft' && st.flowId !== null) st.setStep(st.step - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const index = useStore((s) => s.index);
  const error = useStore((s) => s.error);
  const loading = useStore((s) => s.loading);
  const progress = useStore((s) => s.progress);
  const sheet = useStore((s) => s.sheet);
  const setSheet = useStore((s) => s.setSheet);
  const mobile = useIsMobile();

  useEffect(() => {
    useStore.getState().loadRepos();
  }, []);
  usePlayback();
  useKeyboard();

  return (
    <div className="app">
      <TopBar />
      {error && <div className="notice">{error}</div>}
      {loading && !error && <div className="notice">{progress ?? 'Loading graph…'}</div>}
      {index && (
        <>
          <WorkflowView />
          <Player />
          {mobile ? (
            <div className={`sheet ${sheet ? 'open' : ''}`}>
              <div className="sheet-tabs">
                <button className={sheet === 'flows' ? 'on' : ''} onClick={() => setSheet(sheet === 'flows' ? null : 'flows')}>Flows</button>
                <button className={sheet === 'details' ? 'on' : ''} onClick={() => setSheet(sheet === 'details' ? null : 'details')}>Details</button>
              </div>
              {sheet === 'flows' && <FlowsPanel />}
              {sheet === 'details' && <DetailsPanel />}
            </div>
          ) : (
            <>
              <aside className="panel left">
                <h2>Flows</h2>
                <FlowsPanel />
              </aside>
              <aside className="panel right">
                <DetailsPanel />
              </aside>
            </>
          )}
        </>
      )}
    </div>
  );
}
