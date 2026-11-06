import path from 'path';

const PATTERNS: Record<string, RegExp[]> = {
  javascript: [/\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /\bexport\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g],
  python: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
  go: [/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm, /^\s+(?:\w+\s+)?"([^"]+)"\s*$/gm],
  java: [/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm],
  kotlin: [/^\s*import\s+([\w.]+)/gm],
  scala: [/^\s*import\s+([\w.]+)/gm],
  csharp: [/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm],
  rust: [/^\s*(?:pub\s+)?use\s+([\w:]+)/gm, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm],
  ruby: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm],
  php: [/^\s*use\s+([\w\\]+)/gm, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g],
  c: [/^\s*#\s*include\s+"([^"]+)"/gm],
  swift: [/^\s*import\s+(\w+)/gm],
  dart: [/^\s*import\s+['"]([^'"]+)['"]/gm],
  lua: [/\brequire\s*\(?\s*['"]([^'"]+)['"]/g],
  elixir: [/^\s*(?:alias|import|use)\s+([\w.]+)/gm],
  shell: [/^\s*(?:source|\.)\s+['"]?([\w./-]+)/gm],
};
PATTERNS.typescript = PATTERNS.javascript;
PATTERNS.vue = PATTERNS.javascript;
PATTERNS.svelte = PATTERNS.javascript;
PATTERNS.cpp = PATTERNS.c;
PATTERNS.objc = [/^\s*#\s*(?:import|include)\s+"([^"]+)"/gm];

export function extractImports(source: string, lang: string): string[] {
  const pats = PATTERNS[lang];
  if (!pats) return [];
  const out = new Set<string>();
  for (const re of pats) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.php', '.dart', '.lua', '.vue', '.svelte', '.h', '.hpp', '.c', '.cpp', '.sh'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', '__init__.py', 'mod.rs', 'init.lua'];

/** Resolves import specifiers to repository files using relative paths and path-suffix matching. */
export class ImportResolver {
  private files = new Set<string>();
  private bySuffix = new Map<string, string[]>();
  private dirFiles = new Map<string, string[]>();
  private dirBySuffix = new Map<string, string[]>();

  constructor(relPaths: string[]) {
    for (const p of relPaths) {
      this.files.add(p);
      const noExt = p.replace(/\.[^./]+$/, '');
      this.addSuffixes(this.bySuffix, noExt, p);
      const base = path.posix.basename(p).replace(/\.[^.]+$/, '');
      const dir = path.posix.dirname(p);
      if (['index', '__init__', 'mod'].includes(base) && dir !== '.') this.addSuffixes(this.bySuffix, dir, p);
      if (!this.dirFiles.has(dir)) {
        this.dirFiles.set(dir, []);
        if (dir !== '.') this.addSuffixes(this.dirBySuffix, dir, dir);
      }
      this.dirFiles.get(dir)!.push(p);
    }
  }

  private addSuffixes(map: Map<string, string[]>, key: string, value: string) {
    const segs = key.split('/');
    for (let i = 0; i < segs.length; i++) {
      const suf = segs.slice(i).join('/');
      const arr = map.get(suf);
      if (!arr) map.set(suf, [value]);
      else if (arr.length < 8 && !arr.includes(value)) arr.push(value);
    }
  }

  resolve(spec: string, fromFile: string, lang: string): string[] {
    const fromDir = path.posix.dirname(fromFile);
    if (lang === 'python' && spec.startsWith('.')) {
      const dots = spec.match(/^\.+/)![0].length;
      let dir = fromDir;
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      const rest = spec.slice(dots).replace(/\./g, '/');
      return this.tryRelative(rest ? path.posix.join(dir, rest) : dir);
    }
    if (spec.startsWith('./') || spec.startsWith('../') || ((lang === 'c' || lang === 'cpp' || lang === 'objc' || lang === 'ruby' || lang === 'shell') && !spec.startsWith('/'))) {
      const rel = this.tryRelative(path.posix.normalize(path.posix.join(fromDir, spec)));
      if (rel.length || spec.startsWith('.')) return rel;
    }
    let key = spec
      .replace(/^(?:@\/|~\/|#\/|package:[\w-]+\/)/, '')
      .replace(/^(?:crate|self|super)::/, '')
      .replace(/\\/g, '/');
    if (['python', 'java', 'kotlin', 'scala', 'csharp', 'elixir', 'lua'].includes(lang)) key = key.replace(/\./g, '/');
    if (lang === 'rust') key = key.replace(/::/g, '/');
    if (lang === 'elixir') key = key.replace(/[A-Z]/g, (c, i) => (i && key[i - 1] !== '/' ? '_' : '') + c.toLowerCase());
    key = key.replace(/\.[jt]sx?$/, '');

    const segs = key.split('/').filter(Boolean);
    // Go module paths (and other URL-like specs) carry a repo prefix that is not part of the tree.
    const stripPrefix = lang === 'go' || (segs.length > 1 && segs[0].includes('.'));
    for (let drop = 0; drop < Math.min(3, segs.length); drop++) {
      const kept = segs.slice(0, segs.length - drop);
      for (let lead = 0; lead < (stripPrefix ? kept.length : 1); lead++) {
        const k = kept.slice(lead).join('/');
        if (!k) break;
        const multi = kept.length - lead > 1 || lead > 0;
        const hits = this.bySuffix.get(k);
        if (hits && hits.length <= 3 && (multi || drop === 0) && lang !== 'go') return hits;
        const dirs = this.dirBySuffix.get(k);
        if (dirs && dirs.length === 1 && multi) return (this.dirFiles.get(dirs[0]) ?? []).slice(0, 6);
      }
    }
    return [];
  }

  private tryRelative(base: string): string[] {
    for (const ext of RESOLVE_EXTS) if (this.files.has(base + ext)) return [base + ext];
    // ESM TypeScript imports name the emitted file: `./foo.js` means `./foo.ts`.
    const stripped = base.replace(/\.(?:m|c)?jsx?$/, '');
    if (stripped !== base) for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (this.files.has(stripped + ext)) return [stripped + ext];
    for (const idx of INDEX_FILES) {
      const p = path.posix.join(base, idx);
      if (this.files.has(p)) return [p];
    }
    return [];
  }
}
