export type NodeKind = 'root' | 'dir' | 'file' | 'class' | 'function' | 'route' | 'toplevel';
export type Layer = 'frontend' | 'api' | 'backend' | 'data';

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
  entry?: string;
  layer?: Layer;
  db?: string[];
  ext?: string[];
}

export interface GEdge {
  s: number;
  t: number;
  k: 'call' | 'import' | 'http';
  w: number;
  m?: string;
}

export interface FlowStep {
  n: number;
  d: number;
  p: number;
  /** request label when this step is reached over HTTP */
  h?: string;
}

export type FlowKind = 'e2e' | 'page' | 'route' | 'main' | 'script' | 'job' | 'cli' | 'inferred';

export interface Flow {
  id: number;
  name: string;
  kind: FlowKind;
  entry: number;
  steps: FlowStep[];
  layers: Layer[];
}

export interface Graph {
  version: 1;
  meta: {
    name: string;
    source: string;
    generatedAt: string;
    languages: Record<string, number>;
    layers: Record<Layer, number>;
    stats: { files: number; symbols: number; calls: number; imports: number; http: number; flows: number; e2e: number; loc: number };
    parser: Record<string, string>;
  };
  nodes: GNode[];
  edges: GEdge[];
  flows: Flow[];
}

export interface RepoEntry {
  name: string;
  /** set for repositories analyzed on demand by the server; graphs live under `api/graphs/<key>` */
  key?: string;
  url?: string;
  source: string;
  generatedAt: string;
  stats: Graph['meta']['stats'];
  languages: Record<string, number>;
}
