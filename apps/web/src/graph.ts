import type { Flow, GEdge, GNode, Graph } from './types';

/**
 * How a flow is listed: flows that call the backend are named after the request they make
 * (`POST /login/access-token`, from `useAuth.ts`) rather than the often anonymous function they start in.
 */
export function flowLabel(flow: Flow): { title: string; sub: string } {
  const requests = [...new Set(flow.steps.flatMap((s) => (s.h ? [s.h] : [])))];
  if (!requests.length) return { title: flow.name, sub: '' };
  const from = flow.name.split(' · ').pop()!;
  return { title: requests.length > 1 ? `${requests[0]} +${requests.length - 1}` : requests[0], sub: `from ${from}` };
}

/** Precomputed lookups over a graph. Node ids are DFS preorder, so every subtree is a contiguous id range. */
export class GraphIndex {
  readonly nodes: GNode[];
  readonly children: number[][];
  readonly depth: Int32Array;
  readonly subtreeEnd: Int32Array;
  readonly out = new Map<number, GEdge[]>();
  readonly in = new Map<number, GEdge[]>();

  constructor(readonly g: Graph) {
    const n = g.nodes.length;
    this.nodes = g.nodes;
    this.children = Array.from({ length: n }, () => []);
    this.depth = new Int32Array(n);
    this.subtreeEnd = new Int32Array(n);
    for (const node of g.nodes) {
      if (node.parent >= 0) {
        this.children[node.parent].push(node.id);
        this.depth[node.id] = this.depth[node.parent] + 1;
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      const kids = this.children[i];
      this.subtreeEnd[i] = kids.length ? this.subtreeEnd[kids[kids.length - 1]] : i + 1;
    }
    for (const e of g.edges) {
      (this.out.get(e.s) ?? this.out.set(e.s, []).get(e.s)!).push(e);
      (this.in.get(e.t) ?? this.in.set(e.t, []).get(e.t)!).push(e);
    }
  }

  isContainer(id: number) {
    return this.children[id].length > 0;
  }

  isDescendant(id: number, ancestor: number) {
    return id >= ancestor && id < this.subtreeEnd[ancestor];
  }

  ancestorAtDepth(id: number, d: number) {
    let c = id;
    while (this.depth[c] > d) c = this.nodes[c].parent;
    return c;
  }

  pathTo(id: number): number[] {
    const out: number[] = [];
    for (let c = id; c >= 0; c = this.nodes[c].parent) out.unshift(c);
    return out;
  }

  fileOf(id: number): number {
    for (let c = id; c >= 0; c = this.nodes[c].parent) if (this.nodes[c].kind === 'file') return c;
    return -1;
  }

  search(q: string, limit = 30): GNode[] {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const scored: Array<[number, GNode]> = [];
    for (const n of this.nodes) {
      if (n.kind === 'root') continue;
      const name = n.name.toLowerCase();
      const i = name.indexOf(s);
      if (i >= 0) scored.push([(i === 0 ? 0 : 1) + (name.length - s.length) / 100 + (n.kind === 'dir' ? 0.5 : 0), n]);
      else if (n.path.toLowerCase().includes(s)) scored.push([3, n]);
    }
    return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
  }
}
