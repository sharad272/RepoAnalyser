const KEYWORDS = new Set(
  (
    'abstract async await break case catch class const continue def default defer delete do elif else enum export extends ' +
    'false final finally fn for from func function go if impl implements import in instanceof interface let match mod module ' +
    'new nil none null package private protected pub public raise return self static struct super switch this throw throws ' +
    'trait true try type typeof undefined use var void while with yield lambda pass not and or is as val override suspend ' +
    'select chan map range where namespace using virtual readonly sealed record end begin unless until elsif then'
  ).split(' '),
);

const TOKEN = /(\/\/.*$|#(?![\[{!]).*$|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d_.xXa-fA-F]*\b|@[\w.]+|\b[A-Za-z_]\w*\b)/gm;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tiny language-agnostic highlighter; good enough to make unfamiliar code scannable without shipping grammars. */
export function highlightLine(line: string, lang?: string): string {
  const hashComments = lang === 'python' || lang === 'ruby' || lang === 'shell' || lang === 'config' || lang === 'elixir';
  let out = '';
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const tok = m[0];
    const i = m.index!;
    out += esc(line.slice(last, i));
    last = i + tok.length;
    let cls = '';
    if (tok.startsWith('//') || tok.startsWith('/*')) cls = 'c';
    else if (tok.startsWith('#')) cls = hashComments ? 'c' : '';
    else if (/^["'`]/.test(tok)) cls = 's';
    else if (/^\d/.test(tok)) cls = 'n';
    else if (tok.startsWith('@')) cls = 'd';
    else if (KEYWORDS.has(tok)) cls = 'k';
    else if (/^[A-Z]/.test(tok)) cls = 't';
    else if (line[last] === '(') cls = 'f';
    out += cls ? `<span class="hl-${cls}">${esc(tok)}</span>` : esc(tok);
  }
  return out + esc(line.slice(last));
}
