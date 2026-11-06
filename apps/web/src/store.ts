import { create } from 'zustand';
import { GraphIndex } from './graph';
import { inEditor, onHostMessage, postToHost } from './host';
import type { Graph, RepoEntry } from './types';

interface State {
  repos: RepoEntry[];
  repo: string | null;
  index: GraphIndex | null;
  sources: Record<number, string> | null;
  loading: boolean;
  /** what the analyzer is doing right now (editor extension or server analysis) */
  progress: string | null;
  error: string | null;

  selected: number | null;

  flowId: number | null;
  step: number;
  playing: boolean;
  speed: number;
  follow: boolean;

  sheet: 'flows' | 'details' | null;

  /** true when a Tesseract server is available to analyze repositories by URL */
  server: boolean;
  /** false until the initial checks in loadRepos finish, so the first screen does not flash */
  ready: boolean;

  loadRepos(): Promise<void>;
  loadRepo(id: string): Promise<void>;
  analyzeUrl(url: string, refresh?: boolean): Promise<void>;
  loadSources(): Promise<void>;
  select(id: number | null): void;
  setFlow(id: number | null): void;
  setStep(step: number): void;
  togglePlay(): void;
  setSpeed(speed: number): void;
  setFollow(follow: boolean): void;
  setSheet(sheet: State['sheet']): void;
}

const base = import.meta.env.BASE_URL;
let sourcesRequestedFor: GraphIndex | null = null;
let analysis: AbortController | null = null;

export const repoId = (r: RepoEntry) => r.key ?? r.name;

function graphUrl(repos: RepoEntry[], id: string, kind: 'graph' | 'src') {
  const remote = repos.find((r) => repoId(r) === id)?.key;
  return `${base}${remote ? 'api/graphs' : 'graphs'}/${encodeURIComponent(id)}.${kind}.json`;
}

/** Parses a `text/event-stream` body into events. */
async function* readEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = chunk.match(/^event: (.*)$/m)?.[1] ?? 'message';
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (data !== undefined) yield { event, data: JSON.parse(data) as unknown };
    }
  }
}

export const useStore = create<State>((set, get) => ({
  repos: [],
  repo: null,
  index: null,
  sources: null,
  loading: false,
  progress: null,
  error: null,
  server: false,
  ready: false,
  selected: null,
  flowId: null,
  step: 0,
  playing: false,
  speed: 1,
  follow: true,
  sheet: null,

  async loadRepos() {
    if (inEditor) {
      // The extension analyzes the open workspace and pushes the graph; nothing is fetched.
      set({ loading: true });
      onHostMessage((m) => {
        if (m.type === 'progress') set({ progress: m.message, loading: true, error: null });
        else if (m.type === 'error') set({ error: m.message, loading: false, progress: null });
        else if (m.type === 'sources') set({ sources: m.sources });
        else if (m.type === 'graph') {
          const keepFlow = get().repo === m.graph.meta.name ? get().flowId : null;
          const index = new GraphIndex(m.graph);
          set({ index, repo: m.graph.meta.name, sources: null, loading: false, progress: null, error: null, playing: false });
          if (keepFlow !== null && keepFlow < index.g.flows.length) get().setFlow(keepFlow);
          else set({ flowId: null, selected: null });
        }
      });
      postToHost({ type: 'ready' });
      return;
    }
    try {
      // Only graphs the user generated locally with the CLI live under graphs/; the site starts empty otherwise.
      const isJson = (r: Response) => r.ok && !!r.headers.get('content-type')?.includes('json');
      const [local, server] = await Promise.all([
        fetch(`${base}graphs/index.json`).then((r) => (isJson(r) ? (r.json() as Promise<RepoEntry[]>) : [])).catch(() => []),
        fetch(`${base}api/health`).then(isJson).catch(() => false),
      ]);
      set({ repos: local, server, ready: true });
      const params = new URLSearchParams(location.search);
      const remote = params.get('url');
      if (remote) {
        if (server) return get().analyzeUrl(remote);
        set({ error: 'This copy of Tesseract has no analyzer server, so it cannot analyze repositories by URL.' });
      }
      const pick = local.find((r) => repoId(r) === params.get('repo')) ?? (server ? undefined : local[0]);
      if (pick) await get().loadRepo(repoId(pick));
    } catch (e) {
      set({ error: String(e), ready: true });
    }
  },

  async loadRepo(id) {
    analysis?.abort();
    analysis = null;
    set({ loading: true, error: null, progress: null, repo: id, sources: null, flowId: null, playing: false, selected: null });
    try {
      const res = await fetch(graphUrl(get().repos, id, 'graph'));
      if (!res.ok) throw new Error(`Could not load ${id} (${res.status})`);
      const graph: Graph = await res.json();
      if (get().repo !== id) return;
      set({ index: new GraphIndex(graph), loading: false });
      const entry = get().repos.find((r) => repoId(r) === id);
      const url = new URL(location.href);
      url.searchParams.delete('view');
      if (entry?.url) {
        url.searchParams.set('url', entry.url);
        url.searchParams.delete('repo');
      } else {
        url.searchParams.set('repo', id);
        url.searchParams.delete('url');
      }
      history.replaceState(null, '', url);
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  async analyzeUrl(input, refresh = false) {
    analysis?.abort();
    const ctrl = new AbortController();
    analysis = ctrl;
    set({ loading: true, error: null, progress: 'Starting analysis…' });
    try {
      const res = await fetch(`${base}api/analyze?url=${encodeURIComponent(input)}${refresh ? '&refresh=1' : ''}`, { signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Analyzer unavailable (${res.status})`);
      }
      for await (const { event, data } of readEvents(res.body)) {
        if (event === 'progress') set({ progress: (data as { message: string }).message });
        else if (event === 'failed') throw new Error((data as { message: string }).message);
        else if (event === 'done') {
          const rec = data as RepoEntry & { key: string };
          set({ repos: [rec, ...get().repos.filter((r) => repoId(r) !== rec.key)] });
          analysis = null;
          await get().loadRepo(rec.key);
          return;
        }
      }
      throw new Error('The analyzer stopped responding.');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      set({ loading: false, progress: null, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (analysis === ctrl) analysis = null;
    }
  },

  async loadSources() {
    const { repo, sources } = get();
    if (!repo || sources) return;
    if (inEditor) {
      if (sourcesRequestedFor !== get().index) postToHost({ type: 'sources' });
      sourcesRequestedFor = get().index;
      return;
    }
    const res = await fetch(graphUrl(get().repos, repo, 'src'));
    if (res.ok && get().repo === repo) set({ sources: await res.json() });
  },

  select(id) {
    set({ selected: id, sheet: id !== null ? 'details' : get().sheet });
  },

  setFlow(id) {
    const { index } = get();
    if (!index) return;
    set({ flowId: id, step: 0, playing: false });
    if (id !== null) set({ selected: index.g.flows[id].steps[0].n });
  },

  setStep(step) {
    const { index, flowId } = get();
    if (!index || flowId === null) return;
    const flow = index.g.flows[flowId];
    const s = Math.max(0, Math.min(flow.steps.length - 1, step));
    set({ step: s, selected: flow.steps[s].n });
  },

  togglePlay() {
    const { playing, flowId, index, step } = get();
    if (flowId === null || !index) return;
    if (!playing && step >= index.g.flows[flowId].steps.length - 1) get().setStep(0);
    set({ playing: !playing });
  },

  setSpeed(speed) {
    set({ speed });
  },
  setFollow(follow) {
    set({ follow });
  },
  setSheet(sheet) {
    set({ sheet });
  },
}));
