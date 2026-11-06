export type Layer = 'frontend' | 'api' | 'backend' | 'data';

const FRONTEND_IMPORT = /(?:from\s+|require\(\s*|import\s+)['"](?:react|react-dom|react-native|vue|@angular\/[\w-]+|svelte|next\/[\w/-]+|@tanstack\/react-[\w-]+|solid-js|preact|@remix-run\/react|expo[\w/-]*)['"]/;
const BACKEND_IMPORT = /(?:from\s+|require\(\s*|import\s+)['"](?:express|fastify|koa|@nestjs\/[\w-]+|@hapi\/hapi|hono|@prisma\/client|mongoose|typeorm|sequelize|pg|mysql2?|knex|drizzle-orm[\w/-]*|redis|ioredis|@trpc\/server|apollo-server[\w-]*|socket\.io)['"]/;
const FRONTEND_DIR = /(?:^|\/)(?:frontend|client|web|webapp|ui|www|mobile|app-ui|public|static|templates|components|pages|views|screens|hooks|stores?)\//i;
const BACKEND_DIR = /(?:^|\/)(?:backend|server|api|services?|controllers?|handlers?|routes|routers|middlewares?|internal|cmd|src\/main\/java)\//i;
const DATA_PATH = /(?:^|\/)(?:models?|entities|entity|repositor(?:y|ies)|dao|db|database|migrations?|schemas?|prisma|crud|orm|persistence|store)(?:\/|\.[a-z]+$|_)/i;
const BACKEND_LANGS = new Set(['python', 'go', 'java', 'kotlin', 'csharp', 'ruby', 'php', 'rust', 'elixir', 'scala', 'c', 'cpp']);

/** Which side of the system a file lives on. Imports are the strongest signal, then directories, then language. */
export function classifyFile(rel: string, lang: string, text: string): Layer {
  if (lang === 'vue' || lang === 'svelte' || lang === 'html' || lang === 'css' || lang === 'dart' || lang === 'swift' || lang === 'objc') return 'frontend';
  if (/\.(?:tsx|jsx)$/.test(rel) && !BACKEND_IMPORT.test(text)) return 'frontend';
  if (FRONTEND_IMPORT.test(text)) return 'frontend';
  if (BACKEND_IMPORT.test(text)) return DATA_PATH.test(rel) ? 'data' : 'backend';
  if (BACKEND_LANGS.has(lang)) return DATA_PATH.test(rel) ? 'data' : 'backend';
  const fe = rel.match(FRONTEND_DIR)?.index ?? Infinity;
  const be = rel.match(BACKEND_DIR)?.index ?? Infinity;
  if (fe < be) return 'frontend';
  if (be < fe) return DATA_PATH.test(rel) ? 'data' : 'backend';
  return 'backend';
}

export function isDataPath(rel: string) {
  return DATA_PATH.test(rel);
}

export interface ClientCall {
  line: number;
  method: string;
  /** raw URL as written, e.g. `${API}/users/${id}` */
  url: string;
}

const CLIENT_OBJ = '(?:axios|http|https|api|apiClient|client|httpClient|this\\.http|this\\.httpClient|\\$http|ky|request|instance|fetcher|service|superagent|\\$axios|useFetch|\\$fetch|ofetch|got|needle|requests|httpx|session|resty|req)';
const CLIENT_METHOD_CALL = new RegExp(`\\b${CLIENT_OBJ}\\s*\\.\\s*(get|post|put|patch|delete|head)\\s*(?:<[^>()]*>)?\\s*\\(\\s*f?([\`'"])(.*?)\\2`, 'i');
const FETCH_CALL = /\b(?:fetch|\$fetch|useFetch|ofetch|useSWR|axios)\s*(?:<[^>()]*>)?\(\s*([`'"])(.*?)\1/;
const URL_PROP = /\burl\s*:\s*([`'"])(\/[^`'"]*|https?:\/\/[^`'"]*|\$\{[^}]+\}[^`'"]*)\1/;
const METHOD_PROP = /\bmethod\s*:\s*['"`](get|post|put|patch|delete|head)['"`]/i;
const NEARBY_VERB = /\.\s*(get|post|put|patch|delete|head)\s*(?:<[^>()]*>)?\s*\(/i;
const HTML_ATTR = /\b(?:action|th:action|hx-get|hx-post|hx-put|hx-delete|hx-patch|data-url)\s*=\s*["']@?\{?([^"'{}]+)\}?["']/i;
const HTML_LINK = /\b(?:th:)?href\s*=\s*["']@?\{?(\/[^"'{}#]*)\}?["']/i;
const GO_HTTP = /\bhttp\.(Get|Post|Head)\(\s*"([^"]+)"/;
const NEW_REQUEST = /\bhttp\.NewRequest(?:WithContext)?\([^,]*?"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*"([^"]+)"/;
const JAVA_REST = /\b(?:restTemplate|webClient|RestClient)\b[^;]*?\.(getForObject|getForEntity|postForObject|postForEntity|put|delete|exchange|get|post)\s*\(\s*"([^"]+)"/i;

function looksLikeUrl(u: string) {
  return u.startsWith('/') || /^https?:\/\//.test(u) || u.startsWith('${') || u.startsWith('{');
}

/**
 * Finds outgoing HTTP requests in source (frontend API clients, HTML forms, service-to-service calls).
 * Lines that register routes are excluded by the caller.
 */
export function findClientCalls(text: string, lang: string): ClientCall[] {
  const out: ClientCall[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 500) continue;
    let m: RegExpMatchArray | null;
    if (lang === 'html') {
      if ((m = line.match(HTML_ATTR))) {
        const verb = line.match(/hx-(get|post|put|delete|patch)/i)?.[1] ?? line.match(/method\s*=\s*["'](\w+)/i)?.[1] ?? lines.slice(Math.max(0, i - 3), i + 1).join(' ').match(/method\s*=\s*["'](\w+)/i)?.[1] ?? 'POST';
        if (looksLikeUrl(m[1])) out.push({ line: i + 1, method: verb.toUpperCase(), url: m[1] });
      } else if ((m = line.match(HTML_LINK)) && m[1].length > 1) {
        out.push({ line: i + 1, method: 'GET', url: m[1] });
      }
      continue;
    }
    if ((m = line.match(CLIENT_METHOD_CALL)) && looksLikeUrl(m[3])) {
      out.push({ line: i + 1, method: m[1].toUpperCase(), url: concatTail(m[3], line) });
    } else if ((m = line.match(FETCH_CALL)) && looksLikeUrl(m[2])) {
      const ctx = lines.slice(i, i + 8).join(' ');
      out.push({ line: i + 1, method: (ctx.match(METHOD_PROP)?.[1] ?? 'GET').toUpperCase(), url: concatTail(m[2], line) });
    } else if ((m = line.match(URL_PROP))) {
      const ctx = lines.slice(Math.max(0, i - 8), i + 6).join('\n');
      const verb = ctx.match(METHOD_PROP)?.[1] ?? lines.slice(Math.max(0, i - 8), i + 1).reverse().join('\n').match(NEARBY_VERB)?.[1];
      if (verb) out.push({ line: i + 1, method: verb.toUpperCase(), url: m[2] });
    } else if (lang === 'go' && ((m = line.match(NEW_REQUEST)) || (m = line.match(GO_HTTP)))) {
      out.push({ line: i + 1, method: m[1].toUpperCase(), url: m[2] });
    } else if ((lang === 'java' || lang === 'kotlin') && (m = line.match(JAVA_REST))) {
      const v = m[1].toLowerCase();
      out.push({ line: i + 1, method: v.startsWith('post') ? 'POST' : v === 'put' ? 'PUT' : v === 'delete' ? 'DELETE' : 'GET', url: m[2] });
    }
  }
  return out.filter((c) => !STATIC_ASSET.test(c.url));
}

/** Stylesheets, scripts, fonts and images are page assets, not API calls. */
const STATIC_ASSET = /^\/\/|\.(?:css|s[ac]ss|less|m?js|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|map|webmanifest|pdf|mp4|webm)(?:[?#].*)?$|fonts\.(?:googleapis|gstatic)\.com/i;

/** JS/TS that pulls in a server framework or database driver. */
export function importsBackend(text: string) {
  return BACKEND_IMPORT.test(text);
}

/** `'/api/users/' + id` → `/api/users/{}` so the trailing parameter still lines up with a route. */
function concatTail(url: string, line: string) {
  const idx = line.indexOf(url);
  if (idx >= 0 && /^['"`]\s*\+/.test(line.slice(idx + url.length))) return url.replace(/\/?$/, '/{}');
  return url;
}

/** Router-level prefixes that apply to every route in the file (FastAPI, Flask, Spring, NestJS, Express Router). */
export function findRoutePrefix(text: string, lang: string): string {
  let m: RegExpMatchArray | null;
  if (lang === 'python') {
    if ((m = text.match(/APIRouter\([^)]*?prefix\s*=\s*['"]([^'"]*)['"]/))) return m[1];
    if ((m = text.match(/Blueprint\([^)]*?url_prefix\s*=\s*['"]([^'"]*)['"]/))) return m[1];
  }
  if (lang === 'java' || lang === 'kotlin') {
    m = text.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|open\s+|abstract\s+)*(?:class|interface)\b/);
    if (m) return m[1];
  }
  if ((lang === 'typescript' || lang === 'javascript') && (m = text.match(/@Controller\(\s*['"`]([^'"`]*)['"`]/))) return m[1];
  if (lang === 'csharp' && (m = text.match(/\[Route\(\s*"([^"]*)"\s*\)\][\s\S]{0,200}?class\s+(\w+?)Controller/))) {
    return m[1].replace(/\[controller\]/i, m[2].toLowerCase());
  }
  return '';
}

export function joinPath(prefix: string, path: string) {
  if (!prefix) return path;
  return `/${prefix.replace(/^\/|\/$/g, '')}/${path.replace(/^\//, '')}`.replace(/\/+$/, '') || '/';
}

/** Path → comparable segments; every parameter style (`:id`, `{id}`, `<int:id>`, `${id}`, `[id]`) becomes `*`. */
export function pathSegments(raw: string): string[] {
  let p = raw.trim();
  p = p.replace(/^https?:\/\/[^/]+/, '');
  p = p.replace(/^(?:\$\{[^}]*\}|\{\{[^}]*\}\})+/, '');
  p = p.split(/[?#]/)[0];
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => (/^(?::|\{|<|\$\{|\[|\*)/.test(s) || /\$\{[^}]*\}/.test(s) ? '*' : s.toLowerCase()));
}

export function externalHost(raw: string): string | null {
  const m = raw.match(/^https?:\/\/([^/'"`]+)/);
  return m ? m[1] : null;
}

export interface RouteTarget<T> {
  method: string;
  segs: string[];
  ref: T;
}

/**
 * Matches a client URL to a backend route. Either side may carry an extra mount prefix
 * (e.g. client `/api/v1/items/{}` vs route `/items/{id}`), so we compare aligned suffixes.
 */
export function matchRoute<T>(method: string, url: string, routes: RouteTarget<T>[]): T | null {
  const c = pathSegments(url);
  if (!c.length) return null;
  let best: { ref: T; score: number } | null = null;
  for (const r of routes) {
    if (r.method !== 'ANY' && r.method !== method) continue;
    if (!r.segs.length) continue;
    const clientLonger = c.length >= r.segs.length;
    const off = Math.abs(c.length - r.segs.length);
    const n = Math.min(c.length, r.segs.length);
    let literal = 0;
    let wild = 0;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const cs = clientLonger ? c[off + i] : c[i];
      const rs = clientLonger ? r.segs[i] : r.segs[off + i];
      if (cs === '*' && rs !== '*') { ok = false; break; }
      if (rs === '*') { wild++; continue; }
      if (cs !== rs) { ok = false; break; }
      literal++;
    }
    if (!ok || literal === 0) continue;
    const score = literal * 10 - wild + n * 2 - off + (r.method === method ? 1 : 0);
    if (!best || score > best.score) best = { ref: r.ref, score };
  }
  return best?.ref ?? null;
}

/** [pattern, capture group holding the model/table, whether that capture must look like a class name] */
const DB_PATTERNS: Array<[RegExp, number, boolean]> = [
  [/\bprisma\.(\w+)\.(?:find\w*|create\w*|update\w*|delete\w*|upsert|count|aggregate|groupBy)\b/, 1, false],
  [/\b(\w+?)(?:Repository|Repo|Dao|DAO)\.(?:find\w*|save\w*|delete\w*|exists\w*|count\w*|get\w*|insert\w*|update\w*)\s*\(/, 1, false],
  [/\b(\w+)\.objects\.(?:filter|get|create|all|exclude|update|delete|bulk_create|get_or_create)\b/, 1, false],
  [/\bselect\(\s*(\w+)\s*\)/, 1, true],
  [/['"`]\s*(?:SELECT\b[\s\S]*?\bFROM|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?(\w+)/, 1, false],
  [/['"`]\s*(?:select\b[\s\S]*?\bfrom|insert\s+into|delete\s+from)\s+["`]?(\w+)/, 1, false],
  [/\b(\w+)\.(?:findOne|findMany|findById|findAll|findByPk|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|countDocuments)\s*\(/, 1, true],
  [/\b(?:session|db|database|conn|connection|cursor|tx|transaction)\.(?:add|commit|exec|execute|query|scalars?|get|delete|refresh|merge|flush|select|insert|update|collection|run|prepare|Exec|Query|QueryRow|Where|First|Find|Create|Save|Delete|Model|Preload|Table)\s*\(\s*&?(\w*)/, 1, true],
  [/\b(?:redis|cache)\.(?:get|set|hget|hset|del|incr|expire)\s*\(/, 0, false],
  // Entity Framework: `_context.Articles.Where(...)`
  [/\b_?(?:context|db|dbContext|ctx)\.([A-Z]\w+)\.(?:Where|Find\w*|First\w*|Single\w*|Add\w*|Remove\w*|Update\w*|Include|Any\w*|Count\w*|To\w+Async|AsNoTracking)\b/, 1, true],
  [/\bDB::(?:table|select|insert|update|delete|statement)\(\s*['"]?(\w*)/, 1, false],
  // Active Record / Eloquent / Sequelize-style static model queries: `Article.where(...)`, `User::findOrFail(...)`
  [/\b([A-Z][a-z]\w*)(?:\.|::)(?:all|where|find|find_by\w*|findOrFail|firstOrCreate|firstOrFail|create!?|first|last|includes|joins|order|paginate|pluck|exists\??|whereIn|with|query|findAndCountAll)\b(?!\s*=)/, 1, true],
];
const NOT_MODELS = /^(?:Promise|Object|Array|Math|JSON|Date|Route|Auth|Response|Request|Http|Str|Arr|Log|Config|App|Rails|File|Dir|Time|Set|Map|String|Number|Reflect|Symbol|Enum|Collections|Arrays|Stream|Optional|List|Task|Observable|Validator|Hash|Vue|React|Path|Paths|URI|URL|Base64|Regex|Pattern|Session|Storage|Event|Gate|Mail|Queue|Schema|Artisan|View|Redirect|Cookie|Lang|Crypt|Bus|Notification|Broadcast|Process)$/;

/** Lines that touch a datastore, with the model/table name when one is visible. */
export function findDbAccess(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400 || /^\s*(?:\/\/|#|\*|import\b|from\b)/.test(line)) continue;
    for (const [re, g, needsCap] of DB_PATTERNS) {
      const m = line.match(re);
      if (m) {
        const cap = g ? m[g] : '';
        if (needsCap && (NOT_MODELS.test(cap) || /(?:Service|Client|Api|API|Factory|Helper|Utils?|Manager|Controller|Module|Builder)$/.test(cap))) continue;
        const valid = cap && (!needsCap || /^[A-Z]/.test(cap)) && !/^(?:self|this|s|r|q|result|stmt|query|db|session)$/i.test(cap);
        const name = valid ? cap : /redis|cache/i.test(m[0]) ? 'cache' : 'db';
        out.set(i + 1, name);
        break;
      }
    }
  }
  return out;
}
