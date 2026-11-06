import Parser from 'web-tree-sitter';
import { createRequire } from 'module';
import path from 'path';
import type { FileExtract, RawCall, RawSymbol } from './types.js';
import type { EntryMark } from './routes.js';

type SyntaxNode = Parser.SyntaxNode;

let grammarDir: string | null = null;
let runtimeWasm: string | null = null;

/** Where to load wasm from when not running out of node_modules (e.g. a bundled editor extension). */
export function configureParsers(opts: { grammarDir: string; runtimeWasm: string }) {
  grammarDir = opts.grammarDir;
  runtimeWasm = opts.runtimeWasm;
}

function wasmDir() {
  return (grammarDir ??= path.join(path.dirname(createRequire(import.meta.url).resolve('tree-sitter-wasms/package.json')), 'out'));
}

let parser: Parser | null = null;
const languages = new Map<string, Parser.Language | null>();

async function getParser(grammar: string): Promise<Parser | null> {
  if (!parser) {
    const wasm = runtimeWasm;
    await Parser.init(wasm ? { locateFile: () => wasm } : undefined);
    parser = new Parser();
    parser.setTimeoutMicros(3_000_000);
  }
  if (!languages.has(grammar)) {
    try {
      languages.set(grammar, await Parser.Language.load(path.join(wasmDir(), `tree-sitter-${grammar}.wasm`)));
    } catch {
      languages.set(grammar, null);
    }
  }
  const lang = languages.get(grammar);
  if (!lang) return null;
  parser.setLanguage(lang);
  return parser;
}

const DEF_TYPES = new Set([
  'function_declaration', 'function_definition', 'function_item', 'method_definition', 'method_declaration',
  'method', 'singleton_method', 'class_declaration', 'class_definition', 'class', 'class_specifier',
  'struct_specifier', 'interface_declaration', 'struct_item', 'enum_item', 'trait_item', 'impl_item',
  'enum_declaration', 'constructor_declaration', 'record_declaration', 'struct_declaration', 'object_declaration',
  'protocol_declaration', 'type_spec', 'module', 'object_definition', 'trait_definition', 'contract_declaration',
  'generator_function_declaration', 'abstract_class_declaration', 'value_definition',
]);
const DEF_RE = /(^|_)(function|method|class|struct|interface|trait|enum|impl|protocol|contract)_(definition|declaration|item|specifier)$/;
const CLASS_LIKE = /class|struct|interface|trait|enum|impl|protocol|object|record|contract|type_spec|^module$/;
const NEEDS_BODY = new Set(['struct_specifier', 'class_specifier', 'enum_item', 'type_spec']);
const ANON_FN = new Set(['arrow_function', 'function_expression', 'function', 'lambda', 'func_literal', 'closure_expression', 'anonymous_function', 'lambda_expression', 'anonymous_function_creation_expression']);
const FN_VALUE = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const CALL_TYPES = new Set([
  'call_expression', 'call', 'method_invocation', 'invocation_expression', 'function_call', 'function_call_expression',
  'member_call_expression', 'scoped_call_expression', 'nullsafe_member_call_expression', 'object_creation_expression',
  'new_expression', 'method_call_expression', 'function_call_statement',
]);
const CALL_RE = /(^|_)(call|invocation)(_expression)?$/;
const NAME_LIKE = /identifier|^name$|^constant$|^word$/;
const LAST_IDENT = /([A-Za-z_$][\w$]*)[\s?!]*(?:<[^<>]*>)?\s*$/;

function lastSegment(name: string): string {
  const parts = name.split(/::|\.|->|#/);
  return parts[parts.length - 1].trim().slice(0, 80);
}

function declaratorName(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node;
  for (let i = 0; i < 8 && cur; i++) {
    if (NAME_LIKE.test(cur.type) || cur.type === 'qualified_identifier' || cur.type === 'destructor_name' || cur.type === 'operator_name') return cur.text;
    cur = cur.childForFieldName('declarator') ?? cur.childForFieldName('name') ?? cur.namedChild(0);
  }
  return null;
}

function defName(node: SyntaxNode): string | null {
  let n = node.childForFieldName('name');
  if (!n && node.type === 'impl_item') {
    const t = node.childForFieldName('type');
    const tr = node.childForFieldName('trait');
    return t ? `impl ${tr ? tr.text + ' for ' : ''}${t.text}`.slice(0, 80) : null;
  }
  if (!n) {
    const d = node.childForFieldName('declarator');
    if (d) {
      const dn = declaratorName(d);
      return dn ? lastSegment(dn) : null;
    }
  }
  if (!n) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i)!;
      if (NAME_LIKE.test(c.type) || c.type === 'type_identifier') { n = c; break; }
    }
  }
  return n ? lastSegment(n.text) : null;
}

function calleeName(node: SyntaxNode): string | null {
  const callee =
    node.childForFieldName('function') ?? node.childForFieldName('method') ?? node.childForFieldName('name') ??
    node.childForFieldName('constructor') ?? node.childForFieldName('type') ?? node.namedChild(0);
  if (!callee) return null;
  let text = callee.text;
  if (text.length > 160) text = text.slice(-160);
  const m = text.match(LAST_IDENT);
  return m ? m[1] : null;
}

/** Call node row for an anonymous function passed as an argument, e.g. `app.get('/x', (req, res) => ...)`. */
function enclosingCallRow(node: SyntaxNode): number | null {
  let cur = node.parent;
  for (let i = 0; i < 3 && cur; i++) {
    if (CALL_TYPES.has(cur.type) || CALL_RE.test(cur.type)) return cur.startPosition.row;
    cur = cur.parent;
  }
  return null;
}

export async function extractWithTreeSitter(source: string, grammar: string, marks: Map<number, EntryMark>): Promise<Omit<FileExtract, 'imports'> | null> {
  const p = await getParser(grammar);
  if (!p) return null;
  let tree: Parser.Tree;
  try {
    tree = p.parse(source);
  } catch {
    return null;
  }
  const symbols: RawSymbol[] = [];
  const calls: RawCall[] = [];
  const usedMarks = new Set<number>();
  const stack: Array<[SyntaxNode, number]> = [[tree.rootNode, -1]];

  while (stack.length) {
    const [node, ctx] = stack.pop()!;
    const type = node.type;
    let next = ctx;

    let isDef = DEF_TYPES.has(type) || DEF_RE.test(type);
    if (isDef && NEEDS_BODY.has(type) && !node.childForFieldName('body') && !node.childForFieldName('type')) isDef = false;
    if (isDef && type === 'type_spec') {
      const t = node.childForFieldName('type');
      isDef = !!t && (t.type === 'struct_type' || t.type === 'interface_type');
    }

    let name: string | null = null;
    let kind: RawSymbol['kind'] = 'function';
    let entry: string | undefined;

    if (isDef) {
      name = defName(node);
      kind = CLASS_LIKE.test(type) ? 'class' : 'function';
    } else if ((type === 'variable_declarator' || type === 'public_field_definition' || type === 'field_definition' || type === 'pair') && node.childForFieldName('value')) {
      const v = node.childForFieldName('value')!;
      if (FN_VALUE.has(v.type)) {
        // `{ all: page => requests.get(...) }` — API clients are often object literals of functions.
        const n = node.childForFieldName('name') ?? node.childForFieldName('property') ?? node.childForFieldName('key');
        name = n ? lastSegment(n.text.replace(/^['"`]|['"`]$/g, '')) : null;
      }
    } else if (type === 'assignment_expression' && FN_VALUE.has(node.childForFieldName('right')?.type ?? '')) {
      // `exports.getLogin = (req, res) => ...`, `Foo.prototype.bar = function () {...}`
      const left = node.childForFieldName('left')?.text ?? '';
      if (/^[\w$.]+$/.test(left)) name = lastSegment(left);
    } else if (ANON_FN.has(type)) {
      const row = enclosingCallRow(node);
      if (row !== null) {
        const mark = marks.get(row + 1);
        if (mark && mark.kind !== 'page' && !usedMarks.has(row + 1)) {
          usedMarks.add(row + 1);
          name = mark.label;
          kind = mark.kind === 'route' ? 'route' : 'function';
          entry = mark.label;
        }
      }
    }

    if (name) {
      symbols.push({ name, kind, start: node.startPosition.row + 1, end: node.endPosition.row + 1, parent: ctx, entry });
      next = symbols.length - 1;
    } else if (CALL_TYPES.has(type) || CALL_RE.test(type)) {
      const callee = calleeName(node);
      if (callee) calls.push({ callee, line: node.startPosition.row + 1, from: ctx });
    } else if (type === 'jsx_opening_element' || type === 'jsx_self_closing_element') {
      // Rendering <Component /> is how UI code "calls" other UI code.
      const tag = node.childForFieldName('name')?.text ?? '';
      const comp = tag.split('.').pop() ?? '';
      if (/^[A-Z]/.test(comp)) calls.push({ callee: comp, line: node.startPosition.row + 1, from: ctx });
    }

    for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push([node.namedChild(i)!, next]);
  }
  tree.delete();
  return { symbols, calls };
}

const REGEX_DEFS: Array<[RegExp, RawSymbol['kind']]> = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+|sealed\s+|data\s+|final\s+|public\s+|private\s+|internal\s+)*(?:class|struct|interface|trait|enum|protocol|record|object|module|mixin|extension)\s+([A-Za-z_]\w*)/, 'class'],
  [/^\s*(?:export\s+)?(?:pub(?:\([\w ]+\))?\s+)?(?:async\s+)?(?:local\s+)?(?:fn|func|function|def|defp|sub|proc|fun)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w.:]*[!?]?)/, 'function'],
  [/^\s*(?:(?:public|private|protected|static|final|override|async|virtual|Future<[^>]*>|void|int|bool|String|double|dynamic|[A-Z]\w*(?:<[^>]*>)?)\s+)+([a-z_]\w*)\s*\([^;{]*\)\s*(?:async\s*)?\{/, 'function'],
  [/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
  [/^\s*([A-Za-z_][\w.]*)\s*(?:<-|=)\s*function\s*\(/, 'function'],
];
const CALL_SCAN = /([A-Za-z_$][\w$]*)\s*\(/g;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'def', 'fn', 'func', 'elif', 'when', 'match', 'sizeof', 'typeof', 'new', 'await', 'super', 'this', 'print', 'and', 'or', 'not']);

/** Language-agnostic fallback: indentation/brace aware regex extraction of definitions and calls. */
export function extractWithRegex(source: string, marks: Map<number, EntryMark>): Omit<FileExtract, 'imports'> {
  const lines = source.split('\n');
  const symbols: RawSymbol[] = [];
  const calls: RawCall[] = [];
  const indentOf = (l: string) => l.match(/^\s*/)![0].replace(/\t/g, '    ').length;
  const open: Array<{ idx: number; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    while (open.length && ind <= open[open.length - 1].indent && !/^\s*[}\])]/.test(line)) {
      const o = open.pop()!;
      symbols[o.idx].end = Math.max(symbols[o.idx].start, i);
    }
    if (/^\s*[}\]]/.test(line) && open.length && ind <= open[open.length - 1].indent) {
      const o = open.pop()!;
      symbols[o.idx].end = i + 1;
      continue;
    }
    let defined = false;
    for (const [re, kind] of REGEX_DEFS) {
      const m = line.match(re);
      if (m && !KEYWORDS.has(m[1])) {
        const mark = marks.get(i + 1) ?? marks.get(i);
        symbols.push({ name: lastSegment(m[1]), kind, start: i + 1, end: lines.length, parent: open.length ? open[open.length - 1].idx : -1, entry: mark?.decorator ? mark.label : undefined });
        open.push({ idx: symbols.length - 1, indent: ind });
        defined = true;
        break;
      }
    }
    if (defined || line.length > 400) continue;
    const from = open.length ? open[open.length - 1].idx : -1;
    CALL_SCAN.lastIndex = 0;
    for (const m of line.matchAll(CALL_SCAN)) if (!KEYWORDS.has(m[1])) calls.push({ callee: m[1], line: i + 1, from });
  }
  for (const o of open) symbols[o.idx].end = lines.length;
  return { symbols, calls };
}
