import { useMemo, useState } from 'react';
import { FLOW_KIND_LABEL, LANE_COLOR, nodeColor } from '../colors';
import { inEditor, postToHost } from '../host';
import { flowLabel } from '../graph';
import { useStore } from '../store';
import type { GNode } from '../types';
import { CodeView } from './CodeView';

function NodeLink({ node, onClick }: { node: GNode; onClick?: () => void }) {
  return (
    <button
      className="node-link"
      onClick={() => {
        onClick?.();
        useStore.getState().select(node.id);
      }}
      title={node.path}
    >
      <i style={{ background: nodeColor(node) }} />
      <span className="node-link-name">{node.entry && node.entry !== node.name ? `${node.entry} · ` : ''}{node.name}</span>
      <span className="node-link-path">{node.path.split('#')[0]}</span>
    </button>
  );
}

function FlowName({ label }: { label: { title: string; sub: string } }) {
  return (
    <span className="flow-name">
      <span className="flow-name-title">{label.title}</span>
      {label.sub && <span className="flow-name-sub">{label.sub}</span>}
    </span>
  );
}

export function FlowsPanel() {
  const index = useStore((s) => s.index)!;
  const flowId = useStore((s) => s.flowId);
  const step = useStore((s) => s.step);
  const setFlow = useStore((s) => s.setFlow);
  const setStep = useStore((s) => s.setStep);
  const [q, setQ] = useState('');
  const flows = useMemo(() => {
    const needle = q.toLowerCase();
    return index.g.flows.map((f) => ({ f, label: flowLabel(f) })).filter(({ f, label }) => `${f.name} ${label.title}`.toLowerCase().includes(needle));
  }, [index, q]);

  if (flowId !== null) {
    const flow = index.g.flows[flowId];
    return (
      <div className="panel-body">
        <button className="back" onClick={() => setFlow(null)}>← All flows</button>
        <h3 className="flow-title">
          <span className={`badge badge-${flow.kind}`}>{FLOW_KIND_LABEL[flow.kind]}</span> {flowLabel(flow).title}
        </h3>
        <ol className="steps">
          {flow.steps.map((s, i) => {
            const n = index.nodes[s.n];
            return (
              <li key={i} className={i === step ? 'active' : i < step ? 'done' : ''} style={{ paddingLeft: 8 + s.d * 14 }} onClick={() => setStep(i)}>
                {s.h && <span className="step-http">HTTP</span>}
                <i style={{ background: LANE_COLOR[n.layer ?? 'backend'] }} />
                <span className="step-name">{n.name}</span>
                <span className="step-file">{n.path.split('#')[0].split('/').pop()}:{n.start ?? ''}</span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  return (
    <div className="panel-body">
      <input className="filter" placeholder={`Filter ${index.g.flows.length} flows…`} value={q} onChange={(e) => setQ(e.target.value)} />
      {!flows.length && <p className="muted">No entry points detected. Explore the structure, or pick a function and follow its calls.</p>}
      <ul className="flows">
        {flows.map(({ f, label }) => (
          <li key={f.id} onClick={() => setFlow(f.id)} title={f.name}>
            <span className={`badge badge-${f.kind}`}>{FLOW_KIND_LABEL[f.kind]}</span>
            <FlowName label={label} />
            <span className="flow-lanes" title={f.layers.join(' → ')}>
              {(f.layers ?? []).map((l) => (
                <i key={l} style={{ background: LANE_COLOR[l] }} />
              ))}
            </span>
            <span className="flow-count">{f.steps.length}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DetailsPanel() {
  const index = useStore((s) => s.index)!;
  const id = useStore((s) => s.selected) ?? 0;
  const node = index.nodes[id];

  const { callers, callees, flows } = useMemo(() => {
    const callers = new Map<number, GNode>();
    const callees = new Map<number, GNode>();
    const end = Math.min(index.subtreeEnd[id], id + 2000);
    for (let i = id; i < end; i++) {
      for (const e of index.in.get(i) ?? []) if (e.k !== 'import' && !index.isDescendant(e.s, id)) callers.set(e.s, index.nodes[e.s]);
      for (const e of index.out.get(i) ?? []) if (e.k !== 'import' && !index.isDescendant(e.t, id)) callees.set(e.t, index.nodes[e.t]);
    }
    const flows = index.g.flows.filter((f) => f.steps.some((s) => index.isDescendant(s.n, id)));
    return { callers: [...callers.values()].slice(0, 60), callees: [...callees.values()].slice(0, 60), flows: flows.slice(0, 20) };
  }, [index, id]);

  const entryFlow = flows.find((f) => f.entry === id);
  const childCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const k of index.children[id]) c[index.nodes[k].kind] = (c[index.nodes[k].kind] ?? 0) + 1;
    return c;
  }, [index, id]);

  return (
    <div className="panel-body">
      <div className="detail-head">
        <i className="dot" style={{ background: nodeColor(node) }} />
        <div>
          <h3>{node.name}</h3>
          <div className="muted mono">{node.path.split('#')[0] || index.g.meta.source}</div>
        </div>
      </div>
      <div className="chips">
        <span className="chip">{node.kind}</span>
        {node.layer && <span className="chip" style={{ color: LANE_COLOR[node.layer] }}>{node.layer}</span>}
        {node.lang && <span className="chip">{node.lang}</span>}
        {node.db?.map((d) => <span className="chip chip-db" key={d}>db: {d}</span>)}
        {node.ext?.map((d) => <span className="chip chip-db" key={d}>→ {d}</span>)}
        <span className="chip">{node.loc.toLocaleString()} loc</span>
        {node.start && <span className="chip">L{node.start}–{node.end}</span>}
        {node.entry && <span className="chip chip-entry">entry: {node.entry}</span>}
        {Object.entries(childCounts).map(([k, v]) => (
          <span className="chip" key={k}>{v} {k}{v > 1 ? 's' : ''}</span>
        ))}
      </div>
      {(entryFlow || (inEditor && node.path)) && (
        <div className="actions">
          {entryFlow && <button className="primary" onClick={() => useStore.getState().setFlow(entryFlow.id)}>▶ Play flow</button>}
          {inEditor && node.path && node.kind !== 'dir' && (
            <button onClick={() => postToHost({ type: 'open', path: node.path.split('#')[0], line: node.start })}>Open in editor ↗</button>
          )}
        </div>
      )}

      {flows.length > 0 && (
        <section>
          <h4>Part of {flows.length} flow{flows.length > 1 ? 's' : ''}</h4>
          <ul className="flows compact">
            {flows.map((f) => (
              <li key={f.id} onClick={() => useStore.getState().setFlow(f.id)}>
                <span className={`badge badge-${f.kind}`}>{FLOW_KIND_LABEL[f.kind]}</span>
                <FlowName label={flowLabel(f)} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {callers.length > 0 && (
        <section>
          <h4><i className="legend-line in" /> Called by ({callers.length})</h4>
          {callers.map((n) => <NodeLink key={n.id} node={n} />)}
        </section>
      )}
      {callees.length > 0 && (
        <section>
          <h4><i className="legend-line out" /> Calls ({callees.length})</h4>
          {callees.map((n) => <NodeLink key={n.id} node={n} />)}
        </section>
      )}
      {node.kind !== 'dir' && node.kind !== 'root' && (
        <section>
          <h4>Source</h4>
          <CodeView nodeId={id} />
        </section>
      )}
    </div>
  );
}
