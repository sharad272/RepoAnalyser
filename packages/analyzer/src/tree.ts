import type { Layer, NodeKind } from './types.js';

export interface TreeNode {
  kind: NodeKind;
  name: string;
  path: string;
  lang?: string;
  loc: number;
  start?: number;
  end?: number;
  entry?: string;
  entryKind?: 'route' | 'main' | 'script' | 'job' | 'cli' | 'page';
  layer?: Layer;
  db?: Set<string>;
  ext?: Set<string>;
  children: TreeNode[];
  parent: TreeNode | null;
  id: number;
}

export function makeNode(kind: NodeKind, name: string, path: string, parent: TreeNode | null, extra: Partial<TreeNode> = {}): TreeNode {
  const n: TreeNode = { kind, name, path, loc: 0, children: [], parent, id: -1, ...extra };
  parent?.children.push(n);
  return n;
}

/** Merges single-child directory chains like `src/main/java/com/acme` into one node. */
export function collapseDirs(node: TreeNode) {
  for (const c of node.children) collapseDirs(c);
  if (node.kind !== 'dir') return;
  while (node.children.length === 1 && node.children[0].kind === 'dir') {
    const only = node.children[0];
    node.name = `${node.name}/${only.name}`;
    node.path = only.path;
    node.children = only.children;
    for (const c of node.children) c.parent = node;
  }
}

export function assignIds(root: TreeNode): TreeNode[] {
  const order: TreeNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    n.id = order.length;
    order.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return order;
}

export function sumLoc(node: TreeNode): number {
  if (node.kind === 'root' || node.kind === 'dir') node.loc = node.children.reduce((s, c) => s + sumLoc(c), 0);
  else for (const c of node.children) sumLoc(c);
  return node.loc;
}
