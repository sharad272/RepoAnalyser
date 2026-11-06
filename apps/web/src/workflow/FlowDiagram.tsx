import { Background, Controls, MarkerType, MiniMap, ReactFlow, useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { LANES, LANE_COLOR, type LaneId } from '../colors';
import { useStore } from '../store';
import type { Flow, GNode } from '../types';
import { nodeTypes, type LaneData, type Orientation, type StepData } from './nodes';

const H = { colW: 250, nodeW: 210, nodeH: 78, laneH: 130, labelW: 190 };
const V = { rowH: 120, nodeW: 170, nodeH: 84, laneW: 200, labelH: 64 };

export function laneOf(n: GNode): LaneId {
  return (n.layer ?? 'backend') as LaneId;
}

function badgeFor(n: GNode): string | undefined {
  if (n.entry?.startsWith('PAGE')) return n.entry;
  if (n.entry && /^[A-Z]+ \//.test(n.entry)) return n.entry;
  if (n.entry) return n.entry.toUpperCase();
  if (n.kind === 'class') return 'CLASS';
  return undefined;
}

function location(n: GNode) {
  const file = n.path.split('#')[0];
  const short = file.split('/').slice(-2).join('/');
  return n.start ? `${short}:${n.start}` : short;
}

/**
 * Lays out a flow as a swimlane diagram: one lane per tier, one column (or row) per step in execution order,
 * so a request reads left-to-right from the UI through the API down to the database.
 */
function buildDiagram(flow: Flow, nodes: GNode[], step: number, orientation: Orientation) {
  const steps = flow.steps;
  const hasStore = steps.some((s) => nodes[s.n].db?.length || nodes[s.n].ext?.length);
  const used = new Set<LaneId>(steps.map((s) => laneOf(nodes[s.n])));
  if (hasStore) used.add('store');
  const lanes = LANES.filter((l) => used.has(l.id));
  const laneIndex = new Map(lanes.map((l, i) => [l.id, i]));
  const horizontal = orientation === 'horizontal';

  const place = (col: number, lane: LaneId) => {
    const li = laneIndex.get(lane)!;
    return horizontal
      ? { x: H.labelW + col * H.colW, y: li * H.laneH + (H.laneH - H.nodeH) / 2 }
      : { x: li * V.laneW + (V.laneW - V.nodeW) / 2, y: V.labelH + col * V.rowH };
  };

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];
  const span = horizontal ? H.labelW + steps.length * H.colW + 40 : V.labelH + steps.length * V.rowH + 40;

  lanes.forEach((l, i) => {
    rfNodes.push({
      id: `lane-${l.id}`,
      type: 'lane',
      position: horizontal ? { x: 0, y: i * H.laneH } : { x: i * V.laneW, y: 0 },
      data: { label: l.label, sub: l.sub, color: l.color, orientation } satisfies LaneData,
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
      style: horizontal ? { width: span, height: H.laneH - 6 } : { width: V.laneW - 6, height: span },
    });
  });

  steps.forEach((s, i) => {
    const n = nodes[s.n];
    const lane = laneOf(n);
    const state: StepData['state'] = i === step ? 'current' : i < step ? 'done' : 'todo';
    const chips = [...(n.db ?? []).map((d) => `db: ${d}`), ...(n.ext ?? []).map((e) => `→ ${e}`)];
    rfNodes.push({
      id: `s-${i}`,
      type: 'step',
      position: place(i, lane),
      data: { title: n.name, subtitle: location(n), badge: badgeFor(n), chips, color: LANE_COLOR[lane], state, orientation } satisfies StepData,
      style: { width: horizontal ? H.nodeW : V.nodeW },
    });
    if (s.p >= 0) {
      const done = i <= step;
      rfEdges.push({
        id: `e-${i}`,
        source: `s-${s.p}`,
        target: `s-${i}`,
        type: 'smoothstep',
        animated: !!s.h || i === step,
        label: s.h,
        className: s.h ? 'wf-edge-http' : undefined,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
        style: { stroke: s.h ? '#fbbf24' : done ? '#e2e8f0' : '#475569', strokeWidth: s.h ? 2.6 : done ? 2 : 1.3 },
        markerEnd: { type: MarkerType.ArrowClosed, color: s.h ? '#fbbf24' : done ? '#e2e8f0' : '#475569', width: 16, height: 16 },
      });
    }
    const stores = [...(n.db ?? []).map((d) => ({ title: d === 'db' ? 'Database' : d === 'cache' ? 'Cache' : d, sub: d === 'db' || d === 'cache' ? 'query' : 'table / model' })), ...(n.ext ?? []).map((e) => ({ title: e.split(' ').slice(1).join(' ') || e, sub: `external ${e.split(' ')[0]}` }))];
    stores.slice(0, 3).forEach((st, k) => {
      const pos = place(i, 'store');
      rfNodes.push({
        id: `db-${i}-${k}`,
        type: 'store',
        position: horizontal ? { x: pos.x + k * 18, y: pos.y + k * 14 } : { x: pos.x + k * 14, y: pos.y + k * 18 },
        data: { title: st.title, subtitle: st.sub, color: LANE_COLOR.store, state: i <= step ? 'done' : 'todo', orientation } satisfies StepData,
        style: { width: horizontal ? H.nodeW - 30 : V.nodeW - 20 },
      });
      rfEdges.push({
        id: `edb-${i}-${k}`,
        source: `s-${i}`,
        target: `db-${i}-${k}`,
        type: 'smoothstep',
        style: { stroke: '#f472b6', strokeDasharray: '5 4', strokeWidth: 1.6, opacity: i <= step ? 1 : 0.45 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#f472b6' },
      });
    });
  });

  return { rfNodes, rfEdges };
}

function useOrientation(): Orientation {
  const [mobile] = useMemo(() => [matchMedia('(max-width: 768px)').matches], []);
  return mobile ? 'vertical' : 'horizontal';
}

function Follow({ orientation }: { orientation: Orientation }) {
  const step = useStore((s) => s.step);
  const flowId = useStore((s) => s.flowId);
  const follow = useStore((s) => s.follow);
  const rf = useReactFlow();
  useEffect(() => {
    if (!follow) return;
    const node = rf.getNode(`s-${step}`);
    if (!node) return;
    const w = (node.style?.width as number) ?? 200;
    const zoom = Math.max(rf.getZoom(), orientation === 'vertical' ? 0.85 : 0.8);
    rf.setCenter(node.position.x + w / 2, node.position.y + 40, { zoom, duration: 450 });
  }, [step, flowId, follow, rf, orientation]);
  return null;
}

export function FlowDiagram() {
  const index = useStore((s) => s.index)!;
  const flowId = useStore((s) => s.flowId)!;
  const step = useStore((s) => s.step);
  const orientation = useOrientation();
  const flow = index.g.flows[flowId];
  const { rfNodes, rfEdges } = useMemo(() => buildDiagram(flow, index.nodes, step, orientation), [flow, index, step, orientation]);

  return (
    <ReactFlow
      key={flowId}
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.15}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        const m = node.id.match(/^(?:s|db)-(\d+)/);
        if (m) useStore.getState().setStep(Number(m[1]));
      }}
    >
      <Background gap={28} size={1} color="#1e293b" />
      <Controls showInteractive={false} position="bottom-right" />
      {orientation === 'horizontal' && <MiniMap pannable zoomable nodeColor={(n) => ((n.data as StepData).color ?? '#334155')} maskColor="rgba(2,6,23,0.7)" />}
      <Follow orientation={orientation} />
    </ReactFlow>
  );
}
