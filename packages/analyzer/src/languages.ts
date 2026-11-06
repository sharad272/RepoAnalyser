export interface LangInfo {
  lang: string;
  /** tree-sitter-wasms grammar name, if a working one exists */
  grammar?: string;
  /** markup/config files are shown but not parsed for symbols */
  noSymbols?: boolean;
}

const L = (lang: string, grammar?: string, noSymbols = false): LangInfo => ({ lang, grammar, noSymbols });

const BY_EXT: Record<string, LangInfo> = {
  '.js': L('javascript', 'javascript'),
  '.mjs': L('javascript', 'javascript'),
  '.cjs': L('javascript', 'javascript'),
  '.jsx': L('javascript', 'javascript'),
  '.ts': L('typescript', 'typescript'),
  '.mts': L('typescript', 'typescript'),
  '.cts': L('typescript', 'typescript'),
  '.tsx': L('typescript', 'tsx'),
  '.py': L('python', 'python'),
  '.pyi': L('python', 'python'),
  '.go': L('go', 'go'),
  '.java': L('java', 'java'),
  '.kt': L('kotlin', 'kotlin'),
  '.kts': L('kotlin', 'kotlin'),
  '.scala': L('scala', 'scala'),
  '.rs': L('rust', 'rust'),
  '.rb': L('ruby', 'ruby'),
  '.php': L('php', 'php'),
  '.cs': L('csharp', 'c_sharp'),
  '.c': L('c', 'c'),
  '.h': L('c', 'c'),
  '.cpp': L('cpp', 'cpp'),
  '.cc': L('cpp', 'cpp'),
  '.cxx': L('cpp', 'cpp'),
  '.hpp': L('cpp', 'cpp'),
  '.hh': L('cpp', 'cpp'),
  '.hxx': L('cpp', 'cpp'),
  '.m': L('objc', 'objc'),
  '.mm': L('objc', 'objc'),
  '.swift': L('swift', 'swift'),
  '.ex': L('elixir', 'elixir'),
  '.exs': L('elixir', 'elixir'),
  '.ml': L('ocaml', 'ocaml'),
  '.sol': L('solidity', 'solidity'),
  '.sh': L('shell', 'bash'),
  '.bash': L('shell', 'bash'),
  // Code without a working tree-sitter grammar here: regex fallback extractor.
  '.dart': L('dart'),
  '.lua': L('lua'),
  '.vue': L('vue'),
  '.svelte': L('svelte'),
  '.elm': L('elm'),
  '.zig': L('zig'),
  '.groovy': L('groovy'),
  '.gradle': L('groovy'),
  '.r': L('r'),
  '.jl': L('julia'),
  '.pl': L('perl'),
  '.pm': L('perl'),
  '.hs': L('haskell'),
  '.erl': L('erlang'),
  '.clj': L('clojure'),
  '.fs': L('fsharp'),
  '.vb': L('vb'),
  '.ps1': L('powershell'),
  '.nim': L('nim'),
  '.cr': L('crystal'),
  '.v': L('v'),
  '.sql': L('sql', undefined, true),
  '.proto': L('protobuf', undefined, true),
  '.graphql': L('graphql', undefined, true),
  '.gql': L('graphql', undefined, true),
  '.tf': L('terraform', undefined, true),
  '.html': L('html', undefined, true),
  '.css': L('css', undefined, true),
  '.scss': L('css', undefined, true),
  '.yml': L('config', undefined, true),
  '.yaml': L('config', undefined, true),
  '.toml': L('config', undefined, true),
};

const BY_NAME: Record<string, LangInfo> = {
  dockerfile: L('config', undefined, true),
  makefile: L('config', undefined, true),
  jenkinsfile: L('groovy'),
};

/** tree-sitter grammars the analyzer loads; anything shipping the analyzer needs these `.wasm` files. */
export const GRAMMARS = [...new Set(Object.values(BY_EXT).flatMap((l) => (l.grammar ? [l.grammar] : [])))];

export function detectLanguage(fileName: string): LangInfo | null {
  const lower = fileName.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.endsWith('.min.js') || lower.endsWith('.d.ts') && lower.includes('generated')) return null;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXT[lower.slice(dot)] ?? null;
}

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '__pycache__', '.next', '.nuxt',
  'coverage', '.venv', 'venv', 'env', '.tox', '.idea', '.vscode', 'bin', 'obj', '.gradle', '.cache',
  'Pods', 'DerivedData', '.dart_tool', 'site-packages', '.mypy_cache', '.pytest_cache', 'bower_components',
]);
