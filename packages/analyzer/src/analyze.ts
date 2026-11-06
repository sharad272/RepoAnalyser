import fs from 'fs/promises';
import path from 'path';
import { detectLanguage, IGNORED_DIRS, type LangInfo } from './languages.js';
import { extractWithRegex, extractWithTreeSitter } from './extract.js';
import { extractImports, ImportResolver } from './imports.js';
import { djangoIncludes, filePageLabel, fileRouteLabel, findEntryMarks, railsActionLabel, railsScope } from './routes.js';
import { classifyFile, externalHost, importsBackend, findClientCalls, findDbAccess, findRoutePrefix, isDataPath, joinPath, matchRoute, pathSegments, type RouteTarget } from './http.js';
import { assignIds, collapseDirs, makeNode, sumLoc, type TreeNode } from './tree.js';
import type { Flow, FlowKind, FlowStep, GEdge, Graph, Layer, RawSymbol } from './types.js';

const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 25_000;
const MAX_SOURCE_BYTES = 200_000;

interface ScannedFile { rel: string; abs: string; info: LangInfo }

async function scan(root: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  async function walk(dir: string) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
        await walk(abs);
      } else if (e.isFile()) {
        const info = detectLanguage(e.name);
        if (info) out.push({ rel: path.relative(root, abs).split(path.sep).join('/'), abs, info });
      }
    }
  }
  await walk(root);
  return out;
}

const ENTRY_FILE = /(?:^|\/)(?:main|index|server|app|cli|manage|run|start|wsgi|asgi|__main__|program|bootstrap)\.[a-z]+$/i;
// Example/sample/demo dirs only count near the repo root: `com/example/` and `samples/petclinic` are real Java packages.
const TEST_PATH = /^(?:[^/]+\/)?(?:examples?|samples?|demos?|tutorials?)\/|(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|fixtures?|benchmarks?|docs?|docs?_src|mocks?|__mocks__|stories)\/|[._-](?:test|spec|stories)\.[a-z]+$|(?:^|\/)test_[^/]+$/i;
const JS_LANGS = new Set(['javascript', 'typescript']);
const DATA_SYMBOL = /(?:Repository|Repo|Dao|DAO|Model|Entity|Schema|Store)$/;
const ROUTE_LABEL = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY|URL) (\/\S*)$/;
/** Names too generic to resolve across files; only same-file definitions count. */
const LOCAL_ONLY = new Set([
  'log', 'print', 'println', 'printf', 'push', 'pop', 'map', 'filter', 'reduce', 'forEach', 'get', 'set', 'has', 'add',
  'append', 'len', 'str', 'int', 'toString', 'join', 'split', 'then', 'catch', 'require', 'emit', 'on', 'send', 'json',
  'keys', 'values', 'items', 'format', 'error', 'info', 'warn', 'debug', 'assert', 'expect', 'describe', 'it', 'test',
  'String', 'Number', 'Object', 'Array', 'Promise', 'Error', 'parseInt', 'setTimeout', 'slice', 'replace', 'trim',
  'close', 'open', 'read', 'write', 'update', 'delete', 'remove', 'create', 'init', 'run', 'start', 'stop', 'next',
  'call', 'apply', 'bind', 'resolve', 'reject', 'list', 'dict', 'range', 'isinstance', 'super', 'Some', 'Ok', 'Err',
  'new', 'make', 'string', 'equals', 'hashCode', 'length', 'size', 'clear', 'copy', 'find', 'sort', 'value', 'render',
  'use', 'handle', 'process', 'execute', 'load', 'save', 'parse', 'validate', 'fetch', 'query', 'exec', 'config',
  'Fragment', 'Suspense', 'Provider', 'Link', 'Button', 'Box', 'Text', 'Flex', 'Input', 'Icon', 'Route', 'Routes',
]);

interface PendingRequest { from: TreeNode; method: string; url: string; line: number }
interface CallOut { t: TreeNode; line: number; http?: string }

export interface AnalyzeResult {
  graph: Graph;
  sources: Record<number, string>;
}

export async function analyze(rootDir: string, name: string, source: string, log = (_: string) => {}): Promise<AnalyzeResult> {
  const files = await scan(rootDir);
  log(`scanned ${files.length} files`);
  const resolver = new ImportResolver(files.map((f) => f.rel));

  // Framework routing config that lives in one file but prefixes routes declared in others.
  const readText = (f: ScannedFile) => fs.readFile(f.abs, 'utf8').catch(() => '');
  const routesRb = files.find((f) => /(?:^|\/)config\/routes\.rb$/.test(f.rel));
  const railsPrefix = routesRb ? railsScope(await readText(routesRb)) : null;
  const djangoPrefixes: Array<[string, string]> = [];
  for (const f of files) if (/(?:^|\/)urls\.py$/.test(f.rel)) djangoPrefixes.push(...djangoIncludes(await readText(f)));
  const externalPrefix = (rel: string) =>
    djangoPrefixes.find(([mod]) => rel === mod || rel.endsWith(`/${mod}`))?.[1] ?? (/(?:^|\/)routes\/api\.php$/.test(rel) ? 'api' : '');

  const root = makeNode('root', name, '', null);
  const dirNodes = new Map<string, TreeNode>([['', root]]);
  const dirFor = (rel: string): TreeNode => {
    const dir = path.posix.dirname(rel);
    if (dir === '.') return root;
    let node = dirNodes.get(dir);
    if (!node) {
      node = makeNode('dir', path.posix.basename(dir), dir, dirFor(dir));
      dirNodes.set(dir, node);
    }
    return node;
  };

  const languages: Record<string, number> = {};
  const layerCounts: Record<Layer, number> = { frontend: 0, api: 0, backend: 0, data: 0 };
  const parserUsed: Graph['meta']['parser'] = {};
  const fileNodes = new Map<string, TreeNode>();
  const fileSources = new Map<TreeNode, string>();
  const requests: PendingRequest[] = [];
  const perFile: Array<{ file: TreeNode; rel: string; symNodes: TreeNode[]; calls: Array<{ callee: string; line: number; from: TreeNode }>; imports: string[] }> = [];

  const jsServerFiles: string[] = [];
  let done = 0;
  for (const f of files) {
    if (++done % 500 === 0) log(`parsed ${done}/${files.length}`);
    let text: string;
    try {
      const stat = await fs.stat(f.abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      text = await fs.readFile(f.abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    const lang = f.info.lang;
    const isTest = TEST_PATH.test(f.rel);
    const fileLayer = classifyFile(f.rel, lang, text);
    if (JS_LANGS.has(lang) && !isTest && importsBackend(text)) jsServerFiles.push(f.rel);
    languages[lang] = (languages[lang] ?? 0) + 1;
    if (lang !== 'config' && lang !== 'css') layerCounts[fileLayer]++;
    const fileNode = makeNode('file', path.posix.basename(f.rel), f.rel, dirFor(f.rel), { lang, loc: text.split('\n').length, layer: fileLayer });
    fileNodes.set(f.rel, fileNode);
    fileSources.set(fileNode, text);

    const isMarkup = lang === 'html';
    if (f.info.noSymbols && !isMarkup) {
      parserUsed[lang] ??= 'none';
      continue;
    }

    const marks = isMarkup ? new Map() : findEntryMarks(text, lang);
    const clientCalls = isTest ? [] : findClientCalls(text, lang).filter((c) => marks.get(c.line)?.kind !== 'route');
    if (isMarkup && !clientCalls.length) {
      parserUsed[lang] ??= 'none';
      continue;
    }
    const dbLines = fileLayer === 'frontend' || isTest ? new Map<number, string>() : findDbAccess(text);
    const prefix = findRoutePrefix(text, lang) || externalPrefix(f.rel);

    let ex: { symbols: RawSymbol[]; calls: Array<{ callee: string; line: number; from: number }> } | null = null;
    if (isMarkup) ex = { symbols: [], calls: [] };
    else if (f.info.grammar) ex = await extractWithTreeSitter(text, f.info.grammar, marks);
    if (ex && !isMarkup) parserUsed[lang] = 'tree-sitter';
    if (!ex) {
      ex = extractWithRegex(text, marks);
      parserUsed[lang] ??= 'regex';
    }
    parserUsed[lang] ??= 'none';
    const { symbols, calls } = ex;

    // Decorator/annotation entry points apply to the next definition.
    for (const [line, mark] of marks) {
      if (!mark.decorator) continue;
      const target = symbols.find((s) => s.kind !== 'class' && !s.entry && s.start >= line && s.start <= line + 6);
      if (target) {
        target.entry = mark.kind === 'route' ? mark.label : `${mark.label} ${target.name}`;
        if (mark.kind === 'route') target.kind = 'route';
      }
    }
    for (const s of symbols) {
      const fr = s.kind !== 'class' && fileRouteLabel(f.rel, s.name);
      if (fr) { s.entry = fr; s.kind = 'route'; }
    }
    if (railsPrefix !== null && lang === 'ruby') {
      const privateAt = text.split('\n').findIndex((l) => /^\s*(?:private|protected)\s*$/.test(l)) + 1 || Infinity;
      for (const s of symbols) {
        if (s.kind !== 'function' || s.parent < 0 || symbols[s.parent].kind !== 'class' || s.start > privateAt || s.entry) continue;
        const label = railsActionLabel(f.rel, s.name, railsPrefix);
        if (label) { s.entry = label; s.kind = 'route'; }
      }
    }
    // Single-file components are referenced by file name (`<ArticleList>`, `import('@/views/Home')`).
    if (lang === 'vue' || lang === 'svelte') {
      const comp = path.posix.basename(f.rel).replace(/\.\w+$/, '');
      symbols.unshift({ name: comp, kind: 'function', start: 1, end: fileNode.loc, parent: -1 });
      for (const s of symbols.slice(1)) s.parent = s.parent >= 0 ? s.parent + 1 : 0;
      for (const c of calls) c.from = c.from >= 0 ? c.from + 1 : 0;
      const lines = text.split('\n');
      lines.forEach((l, i) => {
        for (const m of l.matchAll(/<([A-Z][\w]*|[a-z]+(?:-[a-z0-9]+)+)[\s/>]/g)) {
          const tag = m[1].includes('-') ? m[1].replace(/(^|-)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase()) : m[1];
          if (!/^(?:RouterLink|RouterView|Transition|KeepAlive|Teleport|Component|Slot)$/.test(tag)) calls.push({ callee: tag, line: i + 1, from: 0 });
        }
      });
    }
    const pageLabel = filePageLabel(f.rel);
    if (pageLabel) {
      const comp = symbols.find((s) => s.parent === -1 && s.kind === 'function' && /^[A-Z]/.test(s.name) && !s.entry);
      if (comp) comp.entry = pageLabel;
    }
    // Registrations that point at named handlers (routes, UI pages) become pseudo-symbols calling them.
    for (const [line, mark] of marks) {
      if (mark.decorator || (mark.kind !== 'route' && mark.kind !== 'page')) continue;
      if (symbols.some((s) => s.entry === mark.label && s.start >= line && s.start <= line + 3)) continue;
      if (!mark.handlers.length) continue;
      symbols.push({ name: mark.label, kind: 'route', start: line, end: line, parent: -1, entry: mark.label });
      const idx = symbols.length - 1;
      for (const h of mark.handlers) calls.push({ callee: h, line, from: idx });
    }
    if (prefix) {
      for (const s of symbols) {
        const m = s.entry?.match(ROUTE_LABEL);
        if (m && s.kind === 'route') s.entry = `${m[1]} ${joinPath(prefix, m[2])}`;
      }
    }

    const insideAny = (line: number) => symbols.some((s) => s.kind !== 'class' && line >= s.start && line <= s.end);
    let topIdx = -1;
    if (calls.some((c) => c.from === -1) || clientCalls.some((c) => !insideAny(c.line)) || [...dbLines.keys()].some((l) => !insideAny(l))) {
      const top: RawSymbol = { name: isMarkup ? '(page)' : '(top-level)', kind: 'toplevel', start: 1, end: fileNode.loc, parent: -1 };
      if (isMarkup) top.entry = `PAGE ${f.rel.replace(/^.*?(?:templates|pages|views|public)\//, '/').replace(/\.html?$/, '')}`;
      else if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(text)) top.entry = 'main';
      else if (ENTRY_FILE.test(f.rel) && !isTest) top.entry = 'script';
      symbols.push(top);
      topIdx = symbols.length - 1;
    }

    const symNodes: TreeNode[] = [];
    for (const s of symbols) {
      const parentNode = s.parent >= 0 && symNodes[s.parent] ? symNodes[s.parent] : fileNode;
      const node = makeNode(s.kind, s.name, `${f.rel}#${s.name}`, parentNode, { lang, start: s.start, end: s.end, loc: s.end - s.start + 1 });
      if (s.entry) {
        node.entry = s.entry;
        node.entryKind = s.entry === 'main' ? 'main' : s.entry === 'script' ? 'script' : s.entry.startsWith('PAGE') ? 'page' : s.entry.startsWith('JOB') ? 'job' : s.entry.startsWith('CLI') ? 'cli' : 'route';
      } else if (s.name === 'main' && s.kind === 'function' && !isTest) {
        node.entry = 'main';
        node.entryKind = 'main';
      }
      if (node.entryKind === 'page' || fileLayer === 'frontend') node.layer = 'frontend';
      else if (node.entryKind === 'route') node.layer = 'api';
      else if (fileLayer === 'data' || isDataPath(f.rel) || DATA_SYMBOL.test(s.name) || (parentNode !== fileNode && DATA_SYMBOL.test(parentNode.name))) node.layer = 'data';
      else node.layer = fileLayer;
      symNodes.push(node);
    }

    /** Innermost symbol whose range contains the line (methods win over their class). */
    const ownerOf = (line: number): TreeNode | null => {
      let best: TreeNode | null = null;
      for (const n of symNodes) {
        if (n.kind === 'toplevel' || n.start === undefined || line < n.start || line > n.end!) continue;
        if (!best || n.end! - n.start < best.end! - best.start!) best = n;
      }
      return best ?? (topIdx >= 0 ? symNodes[topIdx] : null);
    };
    for (const [line, model] of dbLines) {
      const owner = ownerOf(line);
      if (!owner) continue;
      (owner.db ??= new Set()).add(model);
      if (owner.layer === 'backend') owner.layer = 'data';
    }
    for (const c of clientCalls) {
      const owner = ownerOf(c.line);
      if (owner) requests.push({ from: owner, method: c.method, url: c.url, line: c.line });
    }

    perFile.push({
      file: fileNode,
      rel: f.rel,
      symNodes,
      calls: calls.map((c) => ({ callee: c.callee, line: c.line, from: c.from >= 0 ? symNodes[c.from] : symNodes[topIdx] })).filter((c) => c.from),
      imports: extractImports(text, lang).flatMap((spec) => resolver.resolve(spec, f.rel, lang)).filter((r) => r !== f.rel),
    });
  }
  // In a JS package with UI code and no server framework, leftover JS/TS (API clients, stores, utils) is frontend too.
  const jsDirs = new Set<string>();
  for (const pf of perFile) {
    if (!JS_LANGS.has(pf.file.lang ?? '')) continue;
    for (let d = path.posix.dirname(pf.rel); d !== '.' && !jsDirs.has(d); d = path.posix.dirname(d)) jsDirs.add(d);
  }
  jsDirs.add('');
  const pkgRoots = (
    await Promise.all([...jsDirs].map(async (d) => ((await fs.stat(path.join(rootDir, d, 'package.json')).catch(() => null)) ? d : null)))
  ).filter((d): d is string => d !== null);
  const pkgOf = (rel: string) => pkgRoots.filter((r) => !r || rel.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  const jsServerPkgs = new Set(jsServerFiles.map((r) => pkgOf(r)));
  const uiPkgs = new Set<string>();
  for (const pf of perFile) {
    const pkg = pkgOf(pf.rel);
    if (pkg !== undefined && pf.file.layer === 'frontend' && pf.file.lang !== 'html' && pf.file.lang !== 'css') uiPkgs.add(pkg);
  }
  for (const pkg of jsServerPkgs) uiPkgs.delete(pkg);
  if (uiPkgs.size) {
    for (const pf of perFile) {
      if (!JS_LANGS.has(pf.file.lang ?? '') || pf.file.layer !== 'backend' || !uiPkgs.has(pkgOf(pf.rel) ?? '\0')) continue;
      pf.file.layer = 'frontend';
      layerCounts.backend--;
      layerCounts.frontend++;
      for (const s of pf.symNodes) if (s.layer === 'backend') s.layer = 'frontend';
    }
  }
  log('resolving calls');

  collapseDirs(root);
  sumLoc(root);
  const order = assignIds(root);

  const byName = new Map<string, TreeNode[]>();
  for (const pf of perFile) {
    for (const s of pf.symNodes) {
      if (s.kind === 'toplevel' || (s.kind === 'route' && s.entry === s.name)) continue;
      const arr = byName.get(s.name);
      if (arr) arr.push(s);
      else byName.set(s.name, [s]);
    }
  }

  const edgeMap = new Map<string, GEdge>();
  const addEdge = (s: number, t: number, k: GEdge['k'], m?: string) => {
    if (s === t) return;
    const key = `${k}:${s}>${t}`;
    const e = edgeMap.get(key);
    if (e) e.w++;
    else edgeMap.set(key, m ? { s, t, k, w: 1, m } : { s, t, k, w: 1 });
  };
  const fileOf = (n: TreeNode): TreeNode => {
    let c: TreeNode | null = n;
    while (c && c.kind !== 'file') c = c.parent;
    return c ?? n;
  };
  const callsFrom = new Map<number, CallOut[]>();
  const pushCall = (from: TreeNode, out: CallOut) => {
    let arr = callsFrom.get(from.id);
    if (!arr) callsFrom.set(from.id, (arr = []));
    if (!arr.some((x) => x.t === out.t)) arr.push(out);
  };

  for (const pf of perFile) {
    const importedFiles = new Set(pf.imports.map((r) => fileNodes.get(r)).filter(Boolean) as TreeNode[]);
    for (const r of importedFiles) addEdge(pf.file.id, r.id, 'import');
    const fileDir = path.posix.dirname(pf.rel);
    for (const c of pf.calls) {
      const cands = byName.get(c.callee);
      if (!cands) continue;
      let targets = cands.filter((t) => fileOf(t) === pf.file);
      if (!targets.length && !LOCAL_ONLY.has(c.callee)) {
        targets = cands.filter((t) => importedFiles.has(fileOf(t)));
        if (!targets.length) {
          const sameDir = cands.filter((t) => path.posix.dirname(fileOf(t).path) === fileDir);
          targets = sameDir.length && sameDir.length <= 2 ? sameDir : cands.length <= 2 ? cands : [];
        }
      }
      // UI code only "calls" into backend code over HTTP, never directly.
      targets = targets.filter((t) => (c.from.layer === 'frontend') === (t.layer === 'frontend') || c.from.layer !== 'frontend');
      for (const t of targets.slice(0, 2)) {
        if (t === c.from) continue;
        addEdge(c.from.id, t.id, 'call');
        pushCall(c.from, { t, line: c.line });
      }
    }
  }

  // Connect outgoing requests to the endpoints that serve them.
  const routes: RouteTarget<TreeNode>[] = [];
  for (const n of order) {
    const m = n.entry?.match(ROUTE_LABEL);
    if (m && n.layer === 'api') routes.push({ method: m[1] === 'URL' ? 'ANY' : m[1], segs: pathSegments(m[2]), ref: n });
  }
  let httpEdges = 0;
  for (const r of requests) {
    const host = externalHost(r.url);
    const target = matchRoute(r.method, r.url, routes);
    if (target && target !== r.from) {
      const label = `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, '').replace(/^\$\{[^}]*\}/, '')}`;
      addEdge(r.from.id, target.id, 'http', label);
      pushCall(r.from, { t: target, line: r.line, http: label });
      httpEdges++;
    } else {
      (r.from.ext ??= new Set()).add(host ? `${r.method} ${host}` : `${r.method} ${r.url}`.slice(0, 80));
    }
  }
  for (const arr of callsFrom.values()) arr.sort((a, b) => a.line - b.line);
  const edges = [...edgeMap.values()];
  const callEdges = edges.filter((e) => e.k !== 'import');
  log(`${callEdges.length - httpEdges} call edges, ${httpEdges} frontend→backend requests, ${edges.length - callEdges.length} import edges`);

  const flows = buildFlows(order, callsFrom, callEdges);
  log(`${flows.length} flows (${flows.filter((f) => f.kind === 'e2e').length} end-to-end)`);

  const sources: Record<number, string> = {};
  for (const [node, text] of fileSources) if (text.length <= MAX_SOURCE_BYTES) sources[node.id] = text;

  const graph: Graph = {
    version: 1,
    meta: {
      name,
      source,
      generatedAt: new Date().toISOString(),
      languages,
      parser: parserUsed,
      layers: layerCounts,
      stats: {
        files: fileNodes.size,
        symbols: order.filter((n) => n.kind !== 'file' && n.kind !== 'dir' && n.kind !== 'root').length,
        calls: callEdges.length - httpEdges,
        imports: edges.length - callEdges.length,
        http: httpEdges,
        flows: flows.length,
        e2e: flows.filter((f) => f.kind === 'e2e').length,
        loc: root.loc,
      },
    },
    nodes: order.map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      path: n.path,
      parent: n.parent ? n.parent.id : -1,
      lang: n.lang,
      loc: n.loc,
      start: n.start,
      end: n.end,
      entry: n.entry,
      layer: n.layer,
      db: n.db ? [...n.db] : undefined,
      ext: n.ext ? [...n.ext] : undefined,
    })),
    edges,
    flows,
  };
  return { graph, sources };
}

const MAX_DEPTH = 14;
const MAX_STEPS = 400;
const MAX_KEPT_STEPS = 150;
const MAX_FLOWS = 150;
const KIND_RANK: Record<FlowKind, number> = { e2e: 0, page: 1, route: 2, main: 3, cli: 4, job: 5, script: 6, inferred: 7 };
const LAYER_ORDER: Layer[] = ['frontend', 'api', 'backend', 'data'];

/** Keeps the UI path that leads to each request plus everything that runs on the server; drops pure rendering branches. */
function pruneToRequests(steps: FlowStep[]): FlowStep[] {
  const keep = new Array<boolean>(steps.length).fill(false);
  const serverSide = new Array<boolean>(steps.length).fill(false);
  steps.forEach((s, i) => {
    serverSide[i] = !!s.h || (s.p >= 0 && serverSide[s.p]);
    if (serverSide[i]) keep[i] = true;
    if (s.h) for (let a = s.p; a >= 0 && !keep[a]; a = steps[a].p) keep[a] = true;
  });
  keep[0] = true;
  const remap = new Map<number, number>();
  const out: FlowStep[] = [];
  steps.forEach((s, i) => {
    if (!keep[i]) return;
    remap.set(i, out.length);
    out.push({ ...s, p: s.p >= 0 ? remap.get(s.p)! : -1 });
  });
  return out;
}

function buildFlows(order: TreeNode[], callsFrom: Map<number, CallOut[]>, callEdges: GEdge[]): Flow[] {
  const trace = (entry: TreeNode): FlowStep[] => {
    const steps: FlowStep[] = [];
    const seen = new Set<number>();
    const visit = (n: TreeNode, d: number, p: number, h?: string) => {
      if (steps.length >= MAX_STEPS || seen.has(n.id)) return;
      seen.add(n.id);
      steps.push(h ? { n: n.id, d, p, h } : { n: n.id, d, p });
      const idx = steps.length - 1;
      if (d >= MAX_DEPTH) return;
      const outs = callsFrom.get(n.id) ?? [];
      // Routing to a class (Django ViewSets, controllers) runs its methods.
      if (n.kind === 'class' && !outs.length) {
        for (const c of n.children) if (c.kind === 'function' || c.kind === 'route') visit(c, d + 1, idx);
        return;
      }
      // An API-client function's other calls are transport plumbing; the interesting path continues on the server.
      const transport = n.layer === 'frontend' && !/^[A-Z]/.test(n.name) && outs.some((o) => o.http);
      for (const o of outs) if (!transport || o.http) visit(o.t, d + 1, idx, o.http);
    };
    visit(entry, 0, -1);
    return steps;
  };

  const byId = new Map(order.map((n) => [n.id, n]));
  const layersOf = (steps: FlowStep[]): Layer[] => {
    const seen = new Set<Layer>();
    for (const s of steps) {
      const l = byId.get(s.n)!.layer;
      if (l) seen.add(l);
    }
    return LAYER_ORDER.filter((l) => seen.has(l));
  };
  const describe = (entryLabel: string, steps: FlowStep[]) => {
    const reqs = [...new Set(steps.filter((s) => s.h).map((s) => s.h!))];
    if (!reqs.length) return entryLabel;
    return reqs.length === 1 ? `${entryLabel} → ${reqs[0]}` : `${entryLabel} → ${reqs.length} API calls`;
  };

  const flows: Omit<Flow, 'id'>[] = [];
  const covered = new Set<number>();
  const coveredRequests = new Set<number>();
  const add = (entry: TreeNode, label: string, kind: FlowKind, traced: FlowStep[]) => {
    const e2e = traced.some((s) => s.h);
    const steps = (e2e ? pruneToRequests(traced) : traced).slice(0, MAX_KEPT_STEPS);
    steps.forEach((s) => {
      covered.add(s.n);
      if (e2e && s.h) coveredRequests.add(steps[s.p].n);
    });
    flows.push({ name: describe(label, steps), kind: e2e ? 'e2e' : kind, entry: entry.id, steps, layers: layersOf(steps) });
  };

  const entries = order
    .filter((n) => n.entry && !TEST_PATH.test(n.path))
    .sort((a, b) => (KIND_RANK[a.entryKind as FlowKind] ?? 9) - (KIND_RANK[b.entryKind as FlowKind] ?? 9));
  for (const e of entries) {
    if (flows.length >= MAX_FLOWS) break;
    const steps = trace(e);
    if (steps.length < 2 && e.entryKind !== 'route') continue;
    const file = e.path.split('#')[0];
    const label = e.entryKind === 'main' || e.entryKind === 'script' ? `${e.entryKind === 'main' ? 'main' : 'start'} · ${file}` : e.entry!;
    add(e, label, e.entryKind as FlowKind, steps);
  }

  // Every frontend request should appear in some end-to-end flow: climb from the caller to its UI root.
  const callers = new Map<number, TreeNode[]>();
  for (const [from, outs] of callsFrom) for (const o of outs) if (!o.http) (callers.get(o.t.id) ?? callers.set(o.t.id, []).get(o.t.id)!).push(byId.get(from)!);
  for (const [from, outs] of callsFrom) {
    if (flows.length >= MAX_FLOWS) break;
    if (coveredRequests.has(from) || !outs.some((o) => o.http)) continue;
    let rootNode = byId.get(from)!;
    const visited = new Set([rootNode.id]);
    for (let i = 0; i < 12; i++) {
      const ups = (callers.get(rootNode.id) ?? []).filter((c) => !visited.has(c.id) && !TEST_PATH.test(c.path));
      if (!ups.length) break;
      rootNode = ups.find((c) => /^[A-Z]/.test(c.name)) ?? ups[0];
      visited.add(rootNode.id);
    }
    const steps = trace(rootNode);
    if (!steps.some((s) => s.h)) continue;
    add(rootNode, `${rootNode.name} · ${rootNode.path.split('#')[0].split('/').pop()}`, 'e2e', steps);
  }

  // Inferred flows: uncalled symbols that kick off the biggest call trees.
  const inDeg = new Map<number, number>();
  for (const e of callEdges) inDeg.set(e.t, (inDeg.get(e.t) ?? 0) + 1);
  const candidates = order
    .filter((n) => (n.kind === 'function' || n.kind === 'toplevel') && !n.entry && !inDeg.get(n.id) && (callsFrom.get(n.id)?.length ?? 0) >= 2 && !TEST_PATH.test(n.path))
    .map((n) => ({ n, steps: trace(n) }))
    .filter((c) => c.steps.length >= 4 && c.steps.filter((s) => !covered.has(s.n)).length >= 3)
    .sort((a, b) => b.steps.length - a.steps.length);
  for (const c of candidates) {
    if (flows.length >= MAX_FLOWS) break;
    if (c.steps.filter((s) => !covered.has(s.n)).length < 3) continue;
    const file = c.n.path.split('#')[0];
    add(c.n, `${c.n.kind === 'toplevel' ? path.posix.basename(file) : c.n.name}() · ${file}`, 'inferred', c.steps);
  }

  return flows
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.layers.length - a.layers.length)
    .map((f, id) => ({ id, ...f }));
}
