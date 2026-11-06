import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { memo } from 'react';

export type Orientation = 'horizontal' | 'vertical';

export type StepData = {
  title: string;
  subtitle: string;
  badge?: string;
  chips?: string[];
  color: string;
  state: 'current' | 'done' | 'todo' | 'idle';
  orientation: Orientation;
  count?: number;
};

export type LaneData = { label: string; sub: string; color: string; orientation: Orientation };

const handles = (o: Orientation) =>
  o === 'horizontal' ? { target: Position.Left, source: Position.Right } : { target: Position.Top, source: Position.Bottom };

export const StepNode = memo(function StepNode({ data }: NodeProps<Node<StepData>>) {
  const h = handles(data.orientation);
  return (
    <div className={`wf-node wf-${data.state}`} style={{ '--lane': data.color } as React.CSSProperties}>
      <Handle type="target" position={h.target} className="wf-handle" />
      {data.badge && <div className="wf-badge">{data.badge}</div>}
      <div className="wf-title" title={data.title}>{data.title}</div>
      <div className="wf-sub" title={data.subtitle}>{data.subtitle}</div>
      {data.chips && data.chips.length > 0 && (
        <div className="wf-chips">
          {data.chips.slice(0, 3).map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
      {data.count !== undefined && <div className="wf-count">{data.count}</div>}
      <Handle type="source" position={h.source} className="wf-handle" />
    </div>
  );
});

export const StoreNode = memo(function StoreNode({ data }: NodeProps<Node<StepData>>) {
  const h = handles(data.orientation);
  return (
    <div className={`wf-store wf-${data.state}`} style={{ '--lane': data.color } as React.CSSProperties}>
      <Handle type="target" position={h.target} className="wf-handle" />
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <ellipse cx="12" cy="5" rx="8" ry="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
      <div>
        <div className="wf-title">{data.title}</div>
        <div className="wf-sub">{data.subtitle}</div>
      </div>
      <Handle type="source" position={h.source} className="wf-handle" />
    </div>
  );
});

export const LaneNode = memo(function LaneNode({ data }: NodeProps<Node<LaneData>>) {
  return (
    <div className={`wf-lane wf-lane-${data.orientation}`} style={{ '--lane': data.color } as React.CSSProperties}>
      <div className="wf-lane-label">
        <strong>{data.label}</strong>
        <span>{data.sub}</span>
      </div>
    </div>
  );
});

export const nodeTypes = { step: StepNode, store: StoreNode, lane: LaneNode };
