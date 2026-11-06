# Tesseract

See any codebase as an interactive, end-to-end workflow: **UI screens → API endpoints → services → data layer → datastores & external services**. Pick a flow and step through it, search for any file, class or function, and jump straight to the code. Works on desktop and mobile.

Tesseract parses the code statically with [tree-sitter](https://tree-sitter.github.io/) — nothing is executed — and understands JavaScript, TypeScript (incl. TSX), Python, Go, Java, Kotlin, Scala, Rust, Ruby, PHP, C#, C, C++, Objective-C, Swift, Elixir, OCaml, Solidity and Bash. It recognizes routes and HTTP calls for common frameworks (Express, Koa, NestJS, Next.js, FastAPI, Flask, Django/DRF, Rails, Laravel, Spring, ASP.NET, Gin and more), matches frontend calls to backend endpoints, and detects datastores (SQL, ORMs, Redis, Mongo, …) and third-party APIs.

There are three ways to use it:

| | Public repos | Private repos | Code leaves your machine? |
|---|---|---|---|
| **Website** (URL bar) | ✅ | ❌ | Downloaded from the public host by the server |
| **VS Code / Cursor extension** | ✅ | ✅ | No — fully local |
| **CLI + local web app** | ✅ | ✅ | No — fully local |

## Private repositories

The website can only see what is public, so for private code run Tesseract locally. Your code is parsed on your own machine and is never uploaded anywhere.

### Option 1 — VS Code / Cursor extension (recommended)

1. Build and install the extension (or install a `tesseract-workflow.vsix` someone shared with you):

   ```bash
   npm install
   npm run package:vscode
   code --install-extension apps/vscode/tesseract-workflow.vsix     # VS Code
   cursor --install-extension apps/vscode/tesseract-workflow.vsix   # Cursor
   ```

   Or in the editor: **Extensions → ⋯ → Install from VSIX…**

2. Open your private repo folder (cloned however you normally do — SSH, company Git, etc.).
3. Click **Workflow** in the status bar, run **Tesseract: Show Codebase Workflow** from the Command Palette, or right-click a folder in the Explorer.

The map refreshes automatically when you save (`tesseract.refreshOnSave`), and **Open in editor ↗** jumps to the selected function. Analysis runs in a background thread inside the editor; no network access is needed.

### Option 2 — CLI + local web app

```bash
npm install
npm run analyze D:/path/to/your-private-repo my-repo   # a local folder
npm run dev                                            # open http://localhost:5173 and pick "my-repo"
```

`npm run analyze` also accepts a git URL (`git@github.com:org/repo.git` or `https://...`). It clones with **your own** git credentials (SSH keys / credential manager), so private remotes work too. Results are written to `apps/web/public/graphs/` and stay on your machine.

### Option 3 — self-host for your team

Run the server on your own infrastructure (`npm run server`, or the `Dockerfile`). It clones with whatever git access the machine has, so on a host with read access to your organization's repos, teammates can paste private URLs into the bar. Restrict which hosts are accepted with `ALLOWED_HOSTS` and keep it behind your VPN/SSO.

## Public repositories — the website

Paste a URL such as `github.com/owner/repo` into the bar, or link directly: `https://<your-site>/?url=github.com/owner/repo`. Results are cached, so the shared link opens instantly for the next person.

Supported hosts: GitHub, Bitbucket and Codeberg on Vercel (GitLab.com blocks anonymous archive downloads; the self-hosted server supports it via `git clone`).

## Running locally

Requires Node 20+ (and `git` for the server/CLI).

```bash
npm install
npm run dev        # web app at http://localhost:5173, showing graphs you made with `npm run analyze`
npm run server     # web app + URL-bar analyzer at http://localhost:8787
```

## Deploying

### Vercel

The repo includes `vercel.json`; the build (`npm run build:vercel`) emits Vercel's prebuilt output: the static app plus one Node function for `/api/*` that downloads the repo archive and analyzes it.

1. Import the repo at [vercel.com/new](https://vercel.com/new) and deploy with the default settings.
2. **Storage → Create → Blob**, connect it to the project and redeploy. This caches results across requests (without it, results only live in the function's temporary storage).
3. Make sure **Fluid compute** is enabled (Settings → Functions) so analyses can run up to 5 minutes.

### Docker (Render, Fly.io, Railway, Cloud Run, your own server)

```bash
docker build -t tesseract .
docker run -p 8080:8080 -v tesseract-data:/data tesseract
```

`render.yaml` deploys the same image on Render with a persistent disk.

### Server configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` (`8080` in Docker) | HTTP port |
| `DATA_DIR` | `.cache/server` (`/data` in Docker) | Cache of analyzed repos |
| `ALLOWED_HOSTS` | `github.com,gitlab.com,bitbucket.org,codeberg.org` | Hosts accepted in the URL bar |
| `MAX_CONCURRENT` | `2` | Analyses running at once |
| `MAX_REPO_MB` | `400` (`150` on Vercel) | Largest repository accepted |
| `CACHE_TTL_HOURS` | `24` | How long a result is reused before re-analysis |
| `RATE_LIMIT_PER_HOUR` | `12` | New analyses per IP per hour |
| `CLONE_TIMEOUT_MS` / `ANALYZE_TIMEOUT_MS` | `120000` / `300000` | Time limits |

## Project layout

```
packages/analyzer   tree-sitter analysis → graph (files, symbols, calls, routes, HTTP edges, flows) + CLI
apps/web            React + React Flow workflow viewer (also embedded in the extension)
apps/server         Node server with the URL-bar API; vercel.ts / vercel-build.mts for Vercel
apps/vscode         VS Code / Cursor extension
```

## Limitations

Analysis is static, so behavior wired up at runtime — string-based dispatch (Redux/Vuex actions, event buses), dependency-injection containers, reflection — may show up as gaps in a flow. Runtime tracing (OpenTelemetry import) is planned.
