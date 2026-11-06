import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../store';
import { highlightLine } from './highlight';

const MAX_LINES = 400;

export function CodeView({ nodeId }: { nodeId: number }) {
  const index = useStore((s) => s.index)!;
  const sources = useStore((s) => s.sources);
  const loadSources = useStore((s) => s.loadSources);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  const node = index.nodes[nodeId];
  const fileId = index.fileOf(nodeId);
  const file = fileId >= 0 ? index.nodes[fileId] : null;

  const view = useMemo(() => {
    if (!sources || fileId < 0) return null;
    const text = sources[fileId];
    if (text === undefined) return { lines: [] as string[], first: 1, tooBig: true };
    const all = text.split('\n');
    const hiStart = node.start ?? 1;
    const hiEnd = node.end ?? all.length;
    const first = node.kind === 'file' ? 1 : Math.max(1, hiStart - 3);
    const last = Math.min(all.length, node.kind === 'file' ? MAX_LINES : Math.min(hiEnd + 3, first + MAX_LINES));
    return { lines: all.slice(first - 1, last), first, hiStart, hiEnd, tooBig: false, truncated: last < (node.kind === 'file' ? all.length : hiEnd) };
  }, [sources, fileId, node]);

  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [nodeId]);

  if (!file) return null;
  if (!view) return <div className="code-empty">Loading source…</div>;
  if (view.tooBig) return <div className="code-empty">Source not embedded (file too large).</div>;

  return (
    <div className="code" ref={ref}>
      {view.lines.map((line, i) => {
        const ln = view.first + i;
        const hot = node.kind !== 'file' && ln >= (view.hiStart ?? 0) && ln <= (view.hiEnd ?? 0);
        return (
          <div key={ln} className={hot ? 'code-line hot' : 'code-line'}>
            <span className="ln">{ln}</span>
            <span dangerouslySetInnerHTML={{ __html: highlightLine(line, file.lang) || ' ' }} />
          </div>
        );
      })}
      {view.truncated && <div className="code-empty">… truncated</div>}
    </div>
  );
}
