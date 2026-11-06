import type { GNode } from './types';

export const LANG_COLORS: Record<string, string> = {
  typescript: '#3b9cff',
  javascript: '#f7d84a',
  python: '#4ade80',
  java: '#f89820',
  go: '#22d3ee',
  rust: '#e8a87c',
  ruby: '#f43f5e',
  php: '#a5b4fc',
  csharp: '#c084fc',
  cpp: '#f472b6',
  c: '#cbd5e1',
  objc: '#93c5fd',
  kotlin: '#a78bfa',
  swift: '#fb923c',
  scala: '#ef4444',
  dart: '#38bdf8',
  elixir: '#d8b4fe',
  shell: '#a3e635',
  lua: '#818cf8',
  vue: '#34d399',
  svelte: '#fb7185',
  sql: '#fbbf24',
  html: '#f97316',
  css: '#8b5cf6',
  config: '#64748b',
};

export const KIND_COLORS: Record<string, string> = {
  root: '#38bdf8',
  dir: '#38bdf8',
  class: '#c084fc',
  function: '#67e8f9',
  route: '#fbbf24',
  toplevel: '#f472b6',
};

export function nodeColor(n: GNode): string {
  if (n.kind === 'file') return LANG_COLORS[n.lang ?? ''] ?? '#94a3b8';
  return KIND_COLORS[n.kind] ?? '#94a3b8';
}

export const LANES = [
  { id: 'frontend', label: 'Frontend', sub: 'pages · components · API client', color: '#3b9cff' },
  { id: 'api', label: 'API', sub: 'HTTP endpoints', color: '#fbbf24' },
  { id: 'backend', label: 'Backend', sub: 'services · business logic', color: '#a78bfa' },
  { id: 'data', label: 'Data access', sub: 'repositories · ORM · queries', color: '#4ade80' },
  { id: 'store', label: 'Datastores & external', sub: 'tables · caches · 3rd-party APIs', color: '#f472b6' },
] as const;

export type LaneId = (typeof LANES)[number]['id'];

export const LANE_COLOR: Record<string, string> = Object.fromEntries(LANES.map((l) => [l.id, l.color]));

export const FLOW_KIND_LABEL: Record<string, string> = {
  e2e: 'E2E',
  page: 'PAGE',
  route: 'API',
  main: 'MAIN',
  script: 'START',
  job: 'JOB',
  cli: 'CLI',
  inferred: 'INFERRED',
};
