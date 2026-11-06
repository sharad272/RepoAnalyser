export class UserError extends Error {}

export interface RepoRecord {
  name: string;
  key: string;
  url: string;
  source: string;
  generatedAt: string;
  stats: unknown;
  languages: unknown;
}

export interface RepoRef {
  host: string;
  /** Path segments after the host, e.g. `['owner', 'repo']`. */
  path: string[];
  url: string;
  key: string;
  name: string;
}

export const DEFAULT_HOSTS = 'github.com,gitlab.com,bitbucket.org,codeberg.org';

export function allowedHosts(env = process.env.ALLOWED_HOSTS ?? DEFAULT_HOSTS) {
  return new Set(env.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

/** `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo(.git)(/tree/...)` → canonical https URL. */
export function parseRepoUrl(input: string, hosts: Set<string>): RepoRef {
  let s = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) s = `github.com/${s}`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new UserError('That does not look like a repository URL.');
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UserError('Only https repository URLs are supported.');
  if (!hosts.has(host)) throw new UserError(`Only repositories on ${[...hosts].join(', ')} are supported.`);
  if (u.username || u.password) throw new UserError('URLs with credentials are not accepted. Only public repositories can be analyzed here.');
  // GitLab nests groups (`group/sub/repo`); everything else is `owner/repo`. Drop `/-/tree/...`, `/tree/...`, `/blob/...`.
  const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  const cut = parts.findIndex((p) => p === '-' || p === 'tree' || p === 'blob' || p === 'src');
  const repoPath = (cut > 0 ? parts.slice(0, cut) : parts).slice(0, host === 'gitlab.com' ? 6 : 2);
  if (repoPath.length < 2 || !repoPath.every((p) => /^[\w.-]+$/.test(p) && p !== '.' && p !== '..')) throw new UserError('Expected a URL like https://github.com/owner/repo');
  const url = `https://${host}/${repoPath.join('/')}`;
  const key = `${host.split('.')[0]}__${repoPath.join('__')}`.toLowerCase().replace(/[^\w.-]/g, '_');
  return { host, path: repoPath, url, key, name: repoPath[repoPath.length - 1] };
}

export function toRecord(repo: RepoRef, meta: { generatedAt: string; stats: unknown; languages: unknown }): RepoRecord {
  return { name: repo.name, key: repo.key, url: repo.url, source: repo.url, generatedAt: meta.generatedAt, stats: meta.stats, languages: meta.languages };
}

const hits = new Map<string, number[]>();
export function allowRequest(ip: string, perHour: number) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= perHour) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

export function clientIp(headers: Record<string, string | string[] | undefined>, fallback = 'unknown') {
  return String(headers['x-forwarded-for'] ?? '').split(',')[0].trim() || fallback;
}
