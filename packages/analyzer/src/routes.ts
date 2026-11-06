export interface EntryMark {
  label: string;
  kind: 'route' | 'job' | 'cli' | 'page';
  /** Named handler references found on the same line, e.g. `router.get('/x', auth, ctrl.list)` */
  handlers: string[];
  /** true for decorators/annotations that apply to the next definition */
  decorator: boolean;
}

const HTTP_CALL =
  /\b(?:app|router|routes?|server|api|r|e|g|v\d|mux|fastify|srv|group|engine|blueprint|bp)\.(get|post|put|delete|patch|all|head|options|route|handle|handlefunc|GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch|Any|HandleFunc|Handle)\(\s*["'`](\/[^"'`]*)["'`]([^)]*)/;
const SPRING = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b(?:\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)")?/;
const ASPNET = /\[Http(Get|Post|Put|Delete|Patch)(?:\(\s*"([^"]*)"\s*\))?\]/;
const RAILS = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/;
const LARAVEL = /Route::(get|post|put|delete|patch|any)\(\s*['"]([^'"]+)['"]/;
const DJANGO = /\b(?:path|re_path|url)\(\s*r?['"]([^'"]*)['"]\s*,\s*([\w.]+)/;
const DRF_ROUTER = /\brouter\.register\(\s*r?['"]([^'"]*)['"]\s*,\s*(\w+)/;
const LAZY_COMPONENT = /\bimport\(\s*['"`][^'"`]*\/([A-Z][\w-]*)(?:\.\w+)?['"`]\s*\)/;
const JOB = /@(?:shared_task|(?:app|celery)\.task|KafkaListener|RabbitListener|Scheduled|EventListener|SqsListener)\b/;
const CLI_DECORATOR = /@(?:click\.command|click\.group|(?:app|cli)\.command)\b/;
const COMMANDER = /\.command\(\s*['"]([\w:-]+)/;
const NEST = /^\s*@(Get|Post|Put|Delete|Patch|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/;
const TANSTACK_PAGE = /createFileRoute\(\s*['"`]([^'"`]+)['"`]\s*\)/;
const JSX_ROUTE = /<Route\b[^>]*?\bpath=["'{`]+([^"'}`]+)["'}`]+[^>]*?(?:element=\{\s*<\s*([A-Z][\w.]*)|component=\{\s*([A-Z][\w.]*))/;
const TABLE_ROUTE = /(?:^|\{)\s*path:\s*['"`]([^'"`]*)['"`]/;
const COMPONENT_REF = /\b(?:component|element|Component)\s*:\s*<?\s*([A-Z][\w.]*)/;

function pagePath(p: string) {
  const cleaned = p.split('/').filter((s) => s && !s.startsWith('_') && !/^\(.*\)$/.test(s)).join('/');
  return `/${cleaned}`;
}

const IDENT_RE = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;
const NOT_HANDLER = new Set(['function', 'async', 'await', 'req', 'res', 'next', 'ctx', 'true', 'false', 'null', 'new', 'methods', 'name']);

function handlersFrom(rest: string): string[] {
  const out: string[] = [];
  for (const m of rest.matchAll(IDENT_RE)) {
    const last = m[0].split('.').pop()!;
    if (!NOT_HANDLER.has(last) && !/^[A-Z_]+$/.test(last)) out.push(last);
  }
  return out;
}

function methodLabel(m: string): string {
  const u = m.toUpperCase();
  return ['ROUTE', 'HANDLE', 'HANDLEFUNC', 'ALL', 'ANY', 'REQUEST'].includes(u) ? 'ANY' : u;
}

/** Every route label has the form `METHOD /path`, whatever the framework wrote. */
function routeLabel(method: string, p: string): string {
  return `${methodLabel(method)} /${p.trim().replace(/^\/+/, '')}`;
}

/** `^articles/(?P<slug>[-\w]+)/?$` → `articles/{slug}` */
function djangoPath(p: string): string {
  return p
    .replace(/^\^/, '')
    .replace(/\/?\??\$$/, '')
    .replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}')
    .replace(/<(?:\w+:)?(\w+)>/g, '{$1}');
}

const RAILS_ACTIONS: Record<string, [string, string]> = {
  index: ['GET', ''], show: ['GET', '/:id'], create: ['POST', ''], update: ['PUT', '/:id'], destroy: ['DELETE', '/:id'], new: ['GET', '/new'], edit: ['GET', '/:id/edit'],
};

/** Rails controllers follow REST conventions: `ArticlesController#show` serves `GET /articles/:id`. */
export function railsActionLabel(relPath: string, action: string, scope: string): string | null {
  const m = relPath.match(/(?:^|\/)app\/controllers\/(.*)_controller\.rb$/);
  if (!m || m[1] === 'application' || m[1].endsWith('/application')) return null;
  const [method, suffix] = RAILS_ACTIONS[action] ?? ['ANY', `/${action}`];
  const base = m[1].includes('/') || !scope ? m[1] : `${scope}/${m[1]}`;
  return `${method} /${base}${suffix}`;
}

/** Scans source lines for framework entry points (HTTP routes, jobs, CLI commands). Keys are 1-based lines. */
export function findEntryMarks(source: string, lang: string): Map<number, EntryMark> {
  const marks = new Map<number, EntryMark>();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length > 400 || /^\s*(?:\/\/|\/?\*|#(?!\[)|--|;)/.test(line)) continue;
    // Decorators/registrations often wrap: `@router.get(\n    "/",\n    response_model=...`
    if (/\(\s*$/.test(line) || (line.split('(').length > line.split(')').length && /,\s*$/.test(line))) {
      line = `${line.trimEnd()}${(lines[i + 1] ?? '').trim()} ${(lines[i + 2] ?? '').trim()}`;
    }
    let m: RegExpMatchArray | null;
    const jsLike = lang === 'javascript' || lang === 'typescript' || lang === 'vue' || lang === 'svelte';
    if (jsLike && (m = line.match(TANSTACK_PAGE))) {
      const comp = lines.slice(i, i + 10).join('\n').match(COMPONENT_REF)?.[1];
      marks.set(i + 1, { label: `PAGE ${pagePath(m[1])}`, kind: 'page', handlers: comp ? [comp.split('.').pop()!] : [], decorator: false });
    } else if (jsLike && (m = line.match(JSX_ROUTE))) {
      const comp = (m[2] ?? m[3]).split('.').pop()!;
      marks.set(i + 1, { label: `PAGE ${pagePath(m[1])}`, kind: 'page', handlers: [comp], decorator: false });
    } else if (jsLike && (m = line.match(TABLE_ROUTE))) {
      const near = lines.slice(i - 2 < 0 ? 0 : i - 2, i + 4).join('\n');
      const comp = near.match(COMPONENT_REF)?.[1] ?? near.match(LAZY_COMPONENT)?.[1];
      if (comp) marks.set(i + 1, { label: `PAGE ${pagePath(m[1])}`, kind: 'page', handlers: [comp.split('.').pop()!], decorator: false });
    } else if (jsLike && (m = line.match(NEST))) {
      marks.set(i + 1, { label: routeLabel(m[1], m[2] ?? ''), kind: 'route', handlers: [], decorator: true });
    } else if ((m = line.match(HTTP_CALL))) {
      const decorator = line.trimStart().startsWith('@');
      marks.set(i + 1, { label: routeLabel(m[1], m[2]), kind: 'route', handlers: decorator ? [] : handlersFrom(m[3] ?? ''), decorator });
    } else if ((m = line.match(SPRING))) {
      // A class-level @RequestMapping is a prefix (handled by findRoutePrefix), not an endpoint.
      if (m[1] === 'Request' && /\b(?:class|interface)\s+\w+/.test(lines.slice(i + 1, i + 4).join(' '))) continue;
      marks.set(i + 1, { label: routeLabel(m[1], m[2] ?? ''), kind: 'route', handlers: [], decorator: true });
    } else if (lang === 'csharp' && (m = line.match(ASPNET))) {
      marks.set(i + 1, { label: routeLabel(m[1], m[2] ?? ''), kind: 'route', handlers: [], decorator: true });
    } else if (lang === 'ruby' && (m = line.match(RAILS))) {
      const to = line.match(/(?:to:\s*|=>\s*)['"]([\w/]+)#(\w+)['"]/);
      marks.set(i + 1, { label: routeLabel(m[1], m[2]), kind: 'route', handlers: to ? [to[2]] : [], decorator: false });
    } else if (lang === 'php' && (m = line.match(LARAVEL))) {
      marks.set(i + 1, { label: routeLabel(m[1], m[2]), kind: 'route', handlers: handlersFrom(line.slice(m.index! + m[0].length)), decorator: false });
    } else if (lang === 'python' && (m = line.match(DRF_ROUTER))) {
      marks.set(i + 1, { label: routeLabel('ANY', djangoPath(m[1])), kind: 'route', handlers: [m[2]], decorator: false });
    } else if (lang === 'python' && (m = line.match(DJANGO))) {
      const handler = m[2].replace(/\.as_view$/, '').split('.').pop()!;
      if (handler !== 'include' && !/\badmin\.site\b/.test(m[2])) marks.set(i + 1, { label: routeLabel('ANY', djangoPath(m[1])), kind: 'route', handlers: [handler], decorator: false });
    } else if (JOB.test(line)) {
      marks.set(i + 1, { label: 'JOB', kind: 'job', handlers: [], decorator: true });
    } else if (CLI_DECORATOR.test(line)) {
      marks.set(i + 1, { label: 'CLI', kind: 'cli', handlers: [], decorator: true });
    } else if ((lang === 'javascript' || lang === 'typescript') && (m = line.match(COMMANDER))) {
      marks.set(i + 1, { label: `CLI ${m[1]}`, kind: 'cli', handlers: [], decorator: false });
    }
  }
  return marks;
}

/** First `scope :api` / `namespace :api` in a Rails routes file; applies to controllers outside a namespace dir. */
export function railsScope(routesRb: string): string {
  return routesRb.match(/^\s*(?:scope|namespace)\s+[:'"]\/?(\w+)/m)?.[1] ?? '';
}

/** Django `include()` prefixes: module path (`conduit/apps/articles/urls.py`) → URL prefix (`api`). */
export function djangoIncludes(urlsPy: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of urlsPy.matchAll(/\b(?:path|re_path|url)\(\s*r?['"]([^'"]*)['"]\s*,\s*include\(\s*\(?\s*['"]([\w.]+)['"]/g)) {
    out.push([`${m[2].replace(/\./g, '/')}.py`, djangoPath(m[1]).replace(/\/$/, '')]);
  }
  return out;
}

const NEXT_APP_ROUTE = /(?:^|\/)app\/(.*?)\/?route\.[jt]sx?$/;
const NEXT_PAGES_API = /(?:^|\/)pages\/api\/(.*)\.[jt]sx?$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

const NEXT_PAGE = /(?:^|\/)(?:app\/(.*?)\/?page|pages\/(?!api\/)(.*?))\.[jt]sx$/;

/** Next.js-style page files: the component they export is the page entry. */
export function filePageLabel(relPath: string): string | null {
  const m = relPath.match(NEXT_PAGE);
  if (!m || /(?:^|\/)_(?:app|document|error)\.[jt]sx$/.test(relPath)) return null;
  return `PAGE ${pagePath((m[1] ?? m[2] ?? '').replace(/\/?index$/, ''))}`;
}

/** File-system based routing (Next.js). Returns a label for a symbol, or null. */
export function fileRouteLabel(relPath: string, symbolName: string): string | null {
  let m = relPath.match(NEXT_APP_ROUTE);
  if (m && HTTP_METHODS.has(symbolName)) return `${symbolName} /${m[1].replace(/\([^)]*\)\/?/g, '')}`;
  m = relPath.match(NEXT_PAGES_API);
  if (m && (symbolName === 'handler' || symbolName === 'default')) return `ANY /api/${m[1].replace(/\/index$/, '')}`;
  return null;
}
