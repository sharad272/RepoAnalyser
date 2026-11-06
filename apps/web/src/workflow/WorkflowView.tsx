import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FLOW_KIND_LABEL, LANES } from '../colors';
import { useStore } from '../store';
import { FlowDiagram } from './FlowDiagram';
import { SystemMap } from './SystemMap';

function FlowHeader() {
  const index = useStore((s) => s.index)!;
  const flowId = useStore((s) => s.flowId)!;
  const flow = index.g.flows[flowId];
  const requests = [...new Set(flow.steps.filter((s) => s.h).map((s) => s.h!))];
  const touchesStore = flow.steps.some((s) => index.nodes[s.n].db?.length);
  const lanes = LANES.filter((l) => (flow.layers as string[]).includes(l.id) || (l.id === 'store' && touchesStore));
  return (
    <div className="wf-header">
      <button className="back" onClick={() => useStore.getState().setFlow(null)}>← System workflow</button>
      <div className="wf-header-title">
        <span className={`badge badge-${flow.kind}`}>{FLOW_KIND_LABEL[flow.kind]}</span>
        <span className="mono">{flow.name}</span>
      </div>
      <div className="wf-path">
        {lanes.map((l, i) => (
          <span key={l.id}>
            {i > 0 && <em>→</em>}
            <b style={{ color: l.color }}>{l.label}</b>
          </span>
        ))}
        {requests.map((r) => (
          <code key={r}>{r}</code>
        ))}
      </div>
    </div>
  );
}

export function WorkflowView() {
  const flowId = useStore((s) => s.flowId);
  return (
    <div className="workflow">
      {flowId !== null ? (
        <>
          <FlowHeader />
          <div className="wf-canvas">
            <ReactFlowProvider>
              <FlowDiagram />
            </ReactFlowProvider>
          </div>
        </>
      ) : (
        <ReactFlowProvider>
          <SystemMap />
        </ReactFlowProvider>
      )}
    </div>
  );
}
