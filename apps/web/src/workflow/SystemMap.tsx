import { Background, Controls, MarkerType, ReactFlow, useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FLOW_KIND_LABEL, LANES, LANE_COLOR } from '../colors';
import type { GraphIndex } from '../graph';
import { useStore } from '../store';
import type { GNode } from '../types';
import { nodeTypes, type GroupData, type LaneData, type StepData } from './nodes';

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
  /** section header the card is listed under in its column */
  group?: string;
}

const HTTP_ENTRY = /^[A-Z]+ \//;
const dirOf = (p: string) => p.split('/').slice(-3, -1).join('/') || '/';

/** `/api/v1/articles/:slug` → `/articles`: the resource an endpoint belongs to, ignoring version prefixes and params. */
function resourceOf(p: string) {
  const segs = p.split('/').filter(Boolean);
  while (segs.length > 1 && /^(?:api|rest|v\d+(?:\.\d+)?)$/i.test(segs[0])) segs.shift();
  const first = segs[0];
  return !first || /^[:{[<*]/.test(first) ? '/' : `/${first}`;
}

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
  const colOf = (f: GNode): Col => (f.layer === 'data' ? 'data' : 'backend');
  const moduleCard = (f: GNode) => card(`${f.layer === 'data' ? 'da' : 'be'}-${f.id}`, { col: colOf(f), title: f.name, subtitle: dirOf(f.path), target: f.id });
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

  /**
   * What a server-side entry point runs: the first module outside its own file, then any deeper tier (e.g. a
   * repository in the data layer). Each datastore is linked to the card whose code touches it, so the map reads
   * as a chain (endpoint → service → table) instead of every endpoint pointing straight at every table.
   */
  const expand = (from: Card, entry: number) => {
    const entryFile = index.fileOf(entry);
    const via = new Map<number, Card>([[entry, from]]);
    let frontier = [entry];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        const owner = via.get(id)!;
        for (const s of storeCards(nodes[id])) link(owner, s, 'db');
        for (const e of index.out.get(id) ?? []) {
          if (e.k !== 'call' || via.has(e.t) || nodes[e.t].layer === 'frontend') continue;
          const f = index.fileOf(e.t);
          let to = owner;
          if (f >= 0 && f !== entryFile && (owner === from || COLUMNS.indexOf(colOf(nodes[f])) > COLUMNS.indexOf(owner.col))) {
            to = moduleCard(nodes[f]);
            link(owner, to, 'call');
          }
          via.set(e.t, to);
          next.push(e.t);
        }
      }
      frontier = next;
    }
  };

  // HTTP endpoints, grouped by resource and sorted by path.
  const pathOf = (n: GNode) => n.entry!.split(' ')[1];
  const endpoints = nodes
    .filter((n) => n.layer === 'api' && n.entry && HTTP_ENTRY.test(n.entry))
    .sort((a, b) => resourceOf(pathOf(a)).localeCompare(resourceOf(pathOf(b))) || pathOf(a).localeCompare(pathOf(b)));
  const endpointCard = (n: GNode) => {
    const [method, ...rest] = n.entry!.split(' ');
    const p = rest.join(' ');
    return card(`api-${n.id}`, { col: 'api', title: p, subtitle: `${n.name.startsWith(method) ? '' : `${n.name} · `}${n.path.split('#')[0].split('/').pop()}`, badge: method, target: n.id, group: resourceOf(p) });
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
      ? card(`en-${entry.id}`, { col: 'api', title: named ? entry.entry!.replace(/^(?:CLI|JOB)\s*/, '') || entry.name : `${entry.name}()`, subtitle: file.path, badge: FLOW_KIND_LABEL[f.kind], target: entry.id, group: FLOW_KIND_LABEL[f.kind] })
      : card(`en-f${file.id}`, { col: 'api', title: file.name, subtitle: file.path.split('/').slice(0, -1).join('/') || '/', badge: FLOW_KIND_LABEL[f.kind], target: entry.id, group: FLOW_KIND_LABEL[f.kind] });
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
    // Endpoints keep their resource/path order; other entry points are grouped by kind, busiest first.
    const isEndpoint = (c: Card) => c.key.startsWith('api-');
    byCol(anchor)
      .sort((a, b) =>
        anchor !== 'api'
          ? b.links.size - a.links.size
          : isEndpoint(a) || isEndpoint(b)
            ? Number(isEndpoint(b)) - Number(isEndpoint(a))
            : (a.group ?? '').localeCompare(b.group ?? '') || b.links.size - a.links.size,
      )
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

const GROUP_H = 30;
const MIN_FOR_GROUPS = 6;

/** Everything upstream and downstream of `key`, following edges in their drawn direction. */
function pathThrough(key: string, out: Map<string, string[]>, inc: Map<string, string[]>) {
  const keep = new Set([key]);
  for (const adj of [out, inc]) {
    const stack = [key];
    while (stack.length) for (const k of adj.get(stack.pop()!) ?? []) if (!keep.has(k)) keep.add(k), stack.push(k);
  }
  return keep;
}

export function SystemMap() {
  const index = useStore((s) => s.index)!;
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const mobile = useMemo(() => matchMedia('(max-width: 768px)').matches, []);

  const { rfNodes, rfEdges, summary, targets, fallback, onlyApi, size, out, inc } = useMemo(() => {
    const { cards, edges, fallback } = buildSystem(index);
    const targets = new Map([...cards.values()].map((c) => [c.key, c.target]));
    const rfNodes: Node[] = [];
    const columns = COLUMNS.map((col) => ({ col, cards: [...cards.values()].filter((c) => c.col === col).sort((a, b) => a.order - b.order).slice(0, MAX_PER_COLUMN) }))
      .filter((c) => c.cards.length);
    const shown = new Set(columns.flatMap((c) => c.cards.map((x) => x.key)));
    const apiCards = columns.find((c) => c.col === 'api')?.cards ?? [];
    const allHttp = apiCards.every((c) => c.key.startsWith('api-'));

    // Rows per column, with a section header wherever the group changes in a long, multi-group column.
    const rows = columns.map(({ cards: list }) => {
      const groups = new Set(list.map((c) => c.group).filter(Boolean));
      const headed = list.length >= MIN_FOR_GROUPS && groups.size >= 2;
      let y = TOP;
      return list.map((c, i) => {
        const header = headed && c.group && c.group !== list[i - 1]?.group ? c.group : undefined;
        if (header) y += GROUP_H;
        const row = { c, y, header, headerY: y - GROUP_H + 4 };
        y += ROW_H;
        return row;
      });
    });
    const height = Math.max(...rows.map((r) => (r.length ? r[r.length - 1].y + ROW_H : TOP)), TOP) + 30;

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
      const x = ci * COL_W + (COL_W - 20 - CARD_W) / 2;
      for (const { c, y, header, headerY } of rows[ci]) {
        if (header) {
          rfNodes.push({
            id: `grp-${col}-${header}`,
            type: 'section',
            position: { x, y: headerY },
            data: { label: header, color: LANE_COLOR[col] } satisfies GroupData,
            draggable: false,
            selectable: false,
            style: { width: CARD_W },
          });
        }
        rfNodes.push({
          id: c.key,
          type: col === 'store' ? 'store' : 'step',
          position: { x, y },
          data: { title: c.title, subtitle: c.subtitle, badge: c.badge, color: LANE_COLOR[col], state: 'idle', orientation: 'horizontal', count: col === 'api' ? undefined : c.links.size } satisfies StepData,
          style: { width: CARD_W },
        });
      }
    });

    const colIndex = new Map(columns.map((c, i) => [c.col, i]));
    const out = new Map<string, string[]>();
    const inc = new Map<string, string[]>();
    const rfEdges: Edge[] = [...edges.values()]
      .filter((e) => shown.has(e.a) && shown.has(e.b))
      .map((e, i) => {
        const color = e.kind === 'http' ? '#fbbf24' : e.kind === 'db' ? '#f472b6' : '#a78bfa';
        const a = cards.get(e.a)!;
        const b = cards.get(e.b)!;
        // Keep arrows flowing left to right even for same-column or backwards links.
        const flip = colIndex.get(a.col)! > colIndex.get(b.col)!;
        const source = flip ? e.b : e.a;
        const target = flip ? e.a : e.b;
        out.set(source, [...(out.get(source) ?? []), target]);
        inc.set(target, [...(inc.get(target) ?? []), source]);
        return {
          id: `se-${i}`,
          source,
          target,
          animated: e.kind === 'http',
          style: { stroke: color, strokeWidth: Math.min(1 + Math.log2(e.w + 1) * 0.6, 3), opacity: 0.7, strokeDasharray: e.kind === 'db' ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
      });
    const size = { w: columns.length * COL_W - 20, h: height };
    return { rfNodes, rfEdges, summary, targets, fallback, onlyApi: !columns.some((c) => c.col === 'frontend') && apiCards.some((c) => c.key.startsWith('api-')), size, out, inc };
  }, [index]);

  // Hovering a card traces everything it connects to and fades the rest.
  const { nodes, edges } = useMemo(() => {
    if (!hover) return { nodes: rfNodes, edges: rfEdges };
    const keep = pathThrough(hover, out, inc);
    return {
      nodes: rfNodes.map((n) => (n.type === 'lane' || n.type === 'section' || keep.has(n.id) ? n : { ...n, className: 'wf-dim' })),
      edges: rfEdges.map((e) =>
        keep.has(e.source) && keep.has(e.target)
          ? { ...e, style: { ...e.style, opacity: 1, strokeWidth: Number(e.style?.strokeWidth ?? 1) + 0.8 }, zIndex: 1 }
          : { ...e, animated: false, style: { ...e.style, opacity: 0.06 } },
      ),
    };
  }, [hover, rfNodes, rfEdges, out, inc]);

  // Open at a zoom where card text is readable: fit the width and let tall maps scroll, rather than shrinking everything to fit.
  const fit = useCallback(() => {
    const el = wrap.current?.querySelector('.react-flow');
    if (!el) return;
    const { clientWidth: W, clientHeight: H } = el;
    const zoom = Math.min(1, Math.max(mobile ? 0.5 : 0.65, (W - 32) / size.w));
    if (size.h * zoom <= H) return void rf.fitView({ padding: 0.06, maxZoom: 1 });
    void rf.setViewport({ x: Math.max(16, (W - size.w * zoom) / 2), y: 12, zoom });
  }, [rf, size, mobile]);
  useEffect(() => {
    const t = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(t);
  }, [fit]);

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
    <div className="system-map" ref={wrap}>
      <div className="system-summary">
        <div className="system-chain">
          {summary.map((s, i) => (
            <span key={s.col} style={{ color: LANE_COLOR[s.col] }}>
              {i > 0 && <b className="sep">→</b>}
              {s.text}
            </span>
          ))}
        </div>
        <div className="system-guide">
          <span>Read left to right: where requests come in, the code that handles them, and the data they reach.</span>
          <span>{mobile ? 'Tap a card to step through its flow.' : 'Hover a card to trace its path · click to step through it · scroll to move.'}</span>
          <span className="legend-key">
            <i className="k-http" /> HTTP request <i className="k-call" /> calls <i className="k-db" /> reads / writes
          </span>
        </div>
        {onlyApi && <em>No UI code calling these endpoints was found in this repo.</em>}
        {fallback && <em>No entry points detected, so this shows how the most connected files depend on each other.</em>}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        minZoom={0.1}
        panOnScroll
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => openFor(n.id)}
        onNodeMouseEnter={(_, n) => !mobile && n.type !== 'lane' && n.type !== 'section' && setHover(n.id)}
        onNodeMouseLeave={() => setHover(null)}
      >
        <Background gap={28} size={1} color="#1e293b" />
        <Controls showInteractive={false} position="bottom-right" onFitView={fit} />
      </ReactFlow>
    </div>
  );
}

