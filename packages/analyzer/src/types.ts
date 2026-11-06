export type NodeKind = 'root' | 'dir' | 'file' | 'class' | 'function' | 'route' | 'toplevel';
export interface GNode {
  id: number;
  kind: NodeKind;
  name: string;
  path: string;
  parent: number;
  lang?: string;
  loc: number;
  start?: number;
  end?: number;
  /** Route label / entry description, if this node is an entry point. */
  entry?: string;
  /** Which tier of the system this node belongs to. */
  layer?: Layer;
  /** Datastores/models this node reads or writes. */
  db?: string[];
  /** External services this node calls over HTTP. */
  ext?: string[];
}

export type Layer = 'frontend' | 'api' | 'backend' | 'data';

export interface GEdge {
  s: number;
  t: number;
  k: 'call' | 'import' | 'http';
  w: number;
  /** request label for http edges, e.g. `GET /api/v1/items/{id}` */
  m?: string;
}

export interface FlowStep {
  /** node id */
  n: number;
  /** depth in the call tree */
  d: number;
  /** index of parent step, -1 for the entry */
  p: number;
  /** set when this step is reached over the network (frontend → backend) */
  h?: string;
}

export type FlowKind = 'e2e' | 'page' | 'route' | 'main' | 'script' | 'job' | 'cli' | 'inferred';

export interface Flow {
  id: number;
  name: string;
  kind: FlowKind;
  entry: number;
  steps: FlowStep[];
  /** tiers this flow passes through, in order of first appearance */
  layers: Layer[];
}

export interface GraphMeta {
  name: string;
  source: string;
  generatedAt: string;
  languages: Record<string, number>;
  stats: { files: number; symbols: number; calls: number; imports: number; http: number; flows: number; e2e: number; loc: number };
  layers: Record<Layer, number>;
  parser: Record<string, 'tree-sitter' | 'regex' | 'none'>;
}

export interface Graph {
  version: 1;
  meta: GraphMeta;
  nodes: GNode[];
  edges: GEdge[];
  flows: Flow[];
}

export interface RawSymbol {
  name: string;
  kind: 'class' | 'function' | 'route' | 'toplevel';
  start: number;
  end: number;
  parent: number;
  entry?: string;
}

export interface RawCall {
  callee: string;
  line: number;
  from: number;
}

export interface FileExtract {
  symbols: RawSymbol[];
  calls: RawCall[];
  imports: string[];
}
