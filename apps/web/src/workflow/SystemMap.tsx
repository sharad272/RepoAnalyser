import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useMemo } from 'react';
import { FLOW_KIND_LABEL, LANES, LANE_COLOR } from '../colors';
import type { GraphIndex } from '../graph';
import { useStore } from '../store';
import type { GNode } from '../types';
import { nodeTypes, type LaneData, type StepData } from './nodes';

const COL_W = 330;
const CARD_W = 260;
const ROW_H = 66;
const TOP = 76;
const MAX_PER_COLUMN = 120;
const COLUMNS = ['frontend', 'api', 'backend', 'data', 'store'] as const;
type Col = (typeof COLUMNS)[number];
type LinkKind = 'http' | 'call' | 'db';

interface Card {
  key: string;
  col: Col;
  title: string;
  subtitle: string;
  badge?: string;
  /** node to open when clicked */
  target: number;
  links: Set<string>;
  order: number;
  weight: number;
}

const HTTP_ENTRY = /^[A-Z]+ \//;
const dirOf = (p: string) => p.split('/').slice(-3, -1).join('/') || '/';

/**
 * Architecture-level workflow, built from whatever the repo has: UI screens, HTTP endpoints, CLI commands,
 * jobs and `main` functions as starting points, the modules they run, and the datastores/services they reach.
 * Repos with no detectable entry points fall back to a module map of the most connected files.
 */
function buildSystem(index: GraphIndex) {
  const nodes = index.nodes;
  const cards = new Map<string, Card>();
  const edges = new Map<string, { a: string; b: string; kind: LinkKind; w: number }>();
  const card = (key: string, init: Omit<Card, 'key' | 'links' | 'order' | 'weight'>) => {
    let c = cards.get(key);
    if (!c) cards.set(key, (c = { key, links: new Set(), order: 0, weight: 0, ...init }));
    c.weight++;
    return c;
  };
  const link = (a: Card, b: Card, kind: LinkKind) => {
    if (a === b) return;
    a.links.add(b.key);
    b.links.add(a.key);
    const k = `${a.key}>${b.key}`;
    const e = edges.get(k);
    if (e) e.w++;
    else edges.set(k, { a: a.key, b: b.key, kind, w: 1 });
  };
  const fileNode = (id: number) => {
    const f = index.fileOf(id);
    return f >= 0 ? nodes[f] : nodes[id];
  };
  const uiCard = (id: number) => {
    const file = fileNode(id);
    return card(`fe-${file.id}`, { col: 'frontend', title: file.name.replace(/\.[^.]+$/, ''), subtitle: dirOf(file.path), target: file.id });
  };
  const moduleCard = (f: GNode) =>
    card(`${f.layer === 'data' ? 'da' : 'be'}-${f.id}`, { col: f.layer === 'data' ? 'data' : 'backend', title: f.name, subtitle: dirOf(f.path), target: f.id });
  const storeCards = (n: GNode) => [
    ...(n.db ?? []).map((db) =>
      card(`db-${db}`, { col: 'store', title: db === 'db' ? 'Database (raw query)' : db === 'cache' ? 'Cache' : db, subtitle: db === 'db' || db === 'cache' ? 'datastore' : 'table / model', target: n.id }),
    ),
    ...(n.ext ?? []).map((ext) => {
      const [method, ...rest] = ext.split(' ');
      const where = rest.join(' ');
      // Relative URLs that match no route here go to a backend that lives outside this repo.
      if (!where || /^[/$`{]/.test(where)) return card('ext-api', { col: 'store', title: 'External API', subtitle: 'backend not in this repo', badge: 'HTTP', target: n.id });
      return card(`ext-${where}`, { col: 'store', title: where, subtitle: 'external service', badge: method, target: n.id });
    }),
  ];

  /** What a server-side entry point runs: the first modules outside its own file, and every datastore within reach. */
  const expand = (from: Card, entry: number) => {
    const entryFile = index.fileOf(entry);
    const seen = new Set<number>([entry]);
    let frontier = [entry];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const s of storeCards(nodes[id])) link(from, s, 'db');
        for (const e of index.out.get(id) ?? []) {
          if (e.k !== 'call' || seen.has(e.t) || nodes[e.t].layer === 'frontend') continue;
          seen.add(e.t);
          const f = index.fileOf(e.t);
          if (f >= 0 && f !== entryFile && index.fileOf(id) === entryFile) link(from, moduleCard(nodes[f]), 'call');
          next.push(e.t);
        }
      }
      frontier = next;
    }
  };

  // HTTP endpoints, sorted by path.
  const endpoints = nodes.filter((n) => n.layer === 'api' && n.entry && HTTP_ENTRY.test(n.entry)).sort((a, b) => a.entry!.split(' ')[1].localeCompare(b.entry!.split(' ')[1]));
  const endpointCard = (n: GNode) => {
    const [method, ...rest] = n.entry!.split(' ');
    return card(`api-${n.id}`, { col: 'api', title: rest.join(' '), subtitle: `${n.name.startsWith(method) ? '' : `${n.name} · `}${n.path.split('#')[0].split('/').pop()}`, badge: method, target: n.id });
  };
  for (const ep of endpoints.slice(0, MAX_PER_COLUMN)) expand(endpointCard(ep), ep.id);

  // Screens: each UI entry links to the endpoints and external APIs its flow reaches.
  const flows = index.g.flows;
  // Libraries have few declared entry points; their busiest uncalled functions (the public API) stand in.
  const hasRealEntries = flows.filter((f) => f.kind !== 'inferred').length >= 6;
  const reachedFromUi = new Set<number>();
  for (const f of flows) {
    const entry = nodes[f.entry];
    if (entry.layer !== 'frontend' || (f.kind === 'inferred' && hasRealEntries)) continue;
    let ui: Card;
    if (entry.entry?.startsWith('PAGE ')) {
      // Route tables register many pages in one file, so a page is its path, not its file.
      const comp = f.steps[1] ? nodes[f.steps[1].n] : entry;
      ui = card(`pg-${entry.entry}`, { col: 'frontend', title: entry.entry.slice(5), subtitle: `${comp.name} · ${fileNode(comp.id).name}`, badge: 'PAGE', target: entry.id });
    } else ui = uiCard(entry.id);
    for (const s of f.steps) {
      const n = nodes[s.n];
      reachedFromUi.add(s.n);
      if (s.h) link(ui, endpointCard(n), 'http');
      else if (n.layer === 'frontend') for (const st of storeCards(n)) link(ui, st, 'http');
    }
  }

  // Requests and external calls made by UI code that no screen flow reaches, attributed to the calling components.
  for (const e of index.g.edges) {
    if (e.k !== 'http' || reachedFromUi.has(e.s)) continue;
    const ep = endpointCard(nodes[e.t]);
    const callers = (index.in.get(e.s) ?? []).filter((c) => c.k === 'call' && nodes[c.s].layer === 'frontend').map((c) => c.s);
    for (const o of (callers.length ? callers : [e.s]).slice(0, 6)) link(uiCard(o), ep, 'http');
  }
  for (const n of nodes) if (n.layer === 'frontend' && n.ext?.length && !reachedFromUi.has(n.id)) for (const st of storeCards(n)) link(uiCard(n.id), st, 'http');

  // Other entry points: CLI commands, jobs, scripts, main functions.
  for (const f of flows) {
    if (f.kind === 'route' || (f.kind === 'inferred' && hasRealEntries)) continue;
    const entry = nodes[f.entry];
    if (entry.layer === 'frontend') continue;
    if (HTTP_ENTRY.test(entry.entry ?? '')) continue;
    const file = fileNode(entry.id);
    const named = !!entry.entry && !['main', 'script'].includes(entry.entry);
    // A script's top-level code and its main() are one entry point.
    const c = named || f.kind === 'inferred'
      ? card(`en-${entry.id}`, { col: 'api', title: named ? entry.entry!.replace(/^(?:CLI|JOB)\s*/, '') || entry.name : `${entry.name}()`, subtitle: file.path, badge: FLOW_KIND_LABEL[f.kind], target: entry.id })
      : card(`en-f${file.id}`, { col: 'api', title: file.name, subtitle: file.path.split('/').slice(0, -1).join('/') || '/', badge: FLOW_KIND_LABEL[f.kind], target: entry.id });
    expand(c, entry.id);
  }

  // Nothing to start from: show how the most connected files depend on each other.
  const fallback = !cards.size;
  if (fallback) {
    const degree = new Map<number, number>();
    const fileEdges = new Map<string, { a: number; b: number; w: number }>();
    for (const e of index.g.edges) {
      const a = index.fileOf(e.s);
      const b = index.fileOf(e.t);
      if (a < 0 || b < 0 || a === b) continue;
      degree.set(a, (degree.get(a) ?? 0) + e.w);
      degree.set(b, (degree.get(b) ?? 0) + e.w);
      const k = `${a}>${b}`;
      const fe = fileEdges.get(k);
      if (fe) fe.w += e.w;
      else fileEdges.set(k, { a, b, w: e.w });
    }
    const files = nodes.filter((n) => n.kind === 'file' && n.lang !== 'config' && n.lang !== 'css');
    const top = files.sort((x, y) => (degree.get(y.id) ?? 0) - (degree.get(x.id) ?? 0) || y.loc - x.loc).slice(0, 60);
    const fileCard = (f: GNode) => {
      const c = f.layer === 'frontend' ? uiCard(f.id) : moduleCard(f);
      for (const s of storeCards(f)) link(c, s, 'db');
      return c;
    };
    const chosen = new Map(top.map((f) => [f.id, fileCard(f)]));
    for (const id of chosen.keys()) for (let i = id + 1; i < index.subtreeEnd[id]; i++) for (const s of storeCards(nodes[i])) link(chosen.get(id)!, s, 'db');
    for (const fe of fileEdges.values()) {
      const a = chosen.get(fe.a);
      const b = chosen.get(fe.b);
      if (a && b) link(a, b, 'call');
    }
  }

  // Order each column by the average position of what it connects to, starting from the busiest column.
  const byCol = (col: Col) => [...cards.values()].filter((c) => c.col === col);
  const anchor = (['api', 'backend', 'frontend', 'data', 'store'] as const).find((c) => byCol(c).length)!;
  const ordered = new Set<string>();
  if (anchor) {
    // Endpoints keep path order; other entry points go busiest first.
    const rank = (c: Card) => (c.key.startsWith('api-') ? 1e9 : c.links.size);
    byCol(anchor)
      .sort((a, b) => (anchor === 'api' && a.key.startsWith('api-') && b.key.startsWith('api-') ? 0 : rank(b) - rank(a)))
      .forEach((c, i) => {
        c.order = i;
        ordered.add(c.key);
      });
    const ai = COLUMNS.indexOf(anchor);
    const rest = COLUMNS.filter((c) => c !== anchor).sort((a, b) => Math.abs(COLUMNS.indexOf(a) - ai) - Math.abs(COLUMNS.indexOf(b) - ai));
    for (const col of rest) {
      const cs = byCol(col);
      cs.forEach((c, i) => {
        const pos = [...c.links].filter((k) => ordered.has(k)).map((k) => cards.get(k)!.order);
        c.order = pos.length ? pos.reduce((s, v) => s + v, 0) / pos.length : 1e6 + i;
      });
      cs.forEach((c) => ordered.add(c.key));
    }
  }
  return { cards, edges, fallback };
}

const COL_TEXT: Record<Col, [string, string]> = {
  frontend: ['UI screen', 'UI screens'],
  api: ['entry point', 'entry points'],
  backend: ['service', 'services'],
  data: ['data module', 'data modules'],
  store: ['datastore / service', 'datastores & services'],
};

export function SystemMap() {
  const index = useStore((s) => s.index)!;
  const { rfNodes, rfEdges, summary, targets, fallback, onlyApi } = useMemo(() => {
    const { cards, edges, fallback } = buildSystem(index);
    const targets = new Map([...cards.values()].map((c) => [c.key, c.target]));
    const rfNodes: Node[] = [];
    const columns = COLUMNS.map((col) => ({ col, cards: [...cards.values()].filter((c) => c.col === col).sort((a, b) => a.order - b.order).slice(0, MAX_PER_COLUMN) }))
      .filter((c) => c.cards.length);
    const shown = new Set(columns.flatMap((c) => c.cards.map((x) => x.key)));
    const apiCards = columns.find((c) => c.col === 'api')?.cards ?? [];
    const allHttp = apiCards.every((c) => c.key.startsWith('api-'));
    const height = Math.max(...columns.map((c) => c.cards.length), 1) * ROW_H + TOP + 30;
    const summary: Array<{ col: Col; text: string }> = [];
    columns.forEach(({ col, cards: list }, ci) => {
      const lane = LANES.find((l) => l.id === col)!;
      const label = col === 'api' ? (allHttp ? 'API' : apiCards.some((c) => c.key.startsWith('api-')) ? 'API & entry points' : 'Entry points') : col === 'backend' && fallback ? 'Modules' : lane.label;
      const sub = col === 'api' && !allHttp ? 'endpoints · commands · jobs · main' : lane.sub;
      const [one, many] = col === 'api' && allHttp ? ['endpoint', 'endpoints'] : col === 'backend' && fallback ? ['module', 'modules'] : COL_TEXT[col];
      summary.push({ col, text: `${list.length} ${list.length === 1 ? one : many}` });
      rfNodes.push({
        id: `lane-${col}`,
        type: 'lane',
        position: { x: ci * COL_W, y: 0 },
        data: { label, sub: `${list.length} · ${sub}`, color: lane.color, orientation: 'vertical' } satisfies LaneData,
        draggable: false,
        selectable: false,
        zIndex: -1,
        style: { width: COL_W - 20, height },
      });
      list.forEach((c, ri) => {
        rfNodes.push({
          id: c.key,
          type: col === 'store' ? 'store' : 'step',
          position: { x: ci * COL_W + (COL_W - 20 - CARD_W) / 2, y: TOP + ri * ROW_H },
          data: { title: c.title, subtitle: c.subtitle, badge: c.badge, color: LANE_COLOR[col], state: 'idle', orientation: 'horizontal', count: col === 'api' ? undefined : c.links.size } satisfies StepData,
          style: { width: CARD_W },
        });
      });
    });
    const colIndex = new Map(columns.map((c, i) => [c.col, i]));
    const rfEdges: Edge[] = [...edges.values()]
      .filter((e) => shown.has(e.a) && shown.has(e.b))
      .map((e, i) => {
        const color = e.kind === 'http' ? '#fbbf24' : e.kind === 'db' ? '#f472b6' : '#a78bfa';
        const a = cards.get(e.a)!;
        const b = cards.get(e.b)!;
        // Keep arrows flowing left to right even for same-column or backwards links.
        const flip = colIndex.get(a.col)! > colIndex.get(b.col)!;
        return {
          id: `se-${i}`,
          source: flip ? e.b : e.a,
          target: flip ? e.a : e.b,
          animated: e.kind === 'http',
          style: { stroke: color, strokeWidth: Math.min(1 + Math.log2(e.w + 1) * 0.6, 3), opacity: 0.7, strokeDasharray: e.kind === 'db' ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
      });
    return { rfNodes, rfEdges, summary, targets, fallback, onlyApi: !columns.some((c) => c.col === 'frontend') && apiCards.some((c) => c.key.startsWith('api-')) };
  }, [index]);

  /** Screens and entry points open the flow they take part in; everything else opens its details. */
  const openFor = (key: string) => {
    const id = targets.get(key);
    if (id === undefined) return;
    const st = useStore.getState();
    if (/^(?:api|en|fe|pg)-/.test(key)) {
      const byFile = key.startsWith('fe-') || key.startsWith('en-f');
      const matches = (n: number) => (byFile ? index.fileOf(n) === index.fileOf(id) : n === id);
      const flows = index.g.flows;
      const f =
        flows.find((fl) => fl.entry === id) ??
        flows.find((fl) => fl.kind === 'e2e' && fl.steps.some((s) => matches(s.n))) ??
        flows.find((fl) => fl.steps.some((s) => matches(s.n)));
      if (f) return st.setFlow(f.id);
    }
    st.select(id);
  };

  if (!rfNodes.length) {
    return (
      <div className="system-map">
        <div className="system-summary">
          <em>No source code was found in this repository.</em>
        </div>
      </div>
    );
  }

  return (
    <div className="system-map">
      <div className="system-summary">
        {summary.map((s, i) => (
          <span key={s.col} style={{ color: LANE_COLOR[s.col] }}>
            {i > 0 && <b className="sep">→</b>}
            {s.text}
          </span>
        ))}
        {onlyApi && <em>No UI code calling these endpoints was found in this repo.</em>}
        {fallback && <em>No entry points detected, so this shows how the most connected files depend on each other.</em>}
      </div>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
        minZoom={0.1}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => openFor(n.id)}
      >
        <Background gap={28} size={1} color="#1e293b" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
