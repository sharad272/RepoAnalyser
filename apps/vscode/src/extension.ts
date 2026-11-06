import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Worker } from 'worker_threads';
import type { Graph } from '../../../packages/analyzer/src/types.ts';
import type { WorkerInput, WorkerOutput } from './worker.ts';

type FromWebview =
  | { type: 'ready' }
  | { type: 'sources' }
  | { type: 'open'; path: string; line?: number }
  | { type: 'reanalyze' };

const SAVE_DEBOUNCE_MS = 2000;

/** One workflow panel per analyzed folder. Analysis runs in a worker so large repos never block the editor. */
class WorkflowPanel {
  static readonly byFolder = new Map<string, WorkflowPanel>();
  static active: WorkflowPanel | undefined;

  private graph: Graph | null = null;
  private sources: Record<number, string> | null = null;
  private ready = false;
  private worker: Worker | null = null;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, folder: vscode.Uri) {
    const existing = WorkflowPanel.byFolder.get(folder.fsPath);
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel('tesseract.workflow', `Workflow · ${path.basename(folder.fsPath)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    const p = new WorkflowPanel(ctx, folder, panel);
    WorkflowPanel.byFolder.set(folder.fsPath, p);
    return p;
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly folder: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
  ) {
    WorkflowPanel.active = this;
    void vscode.commands.executeCommand('setContext', 'tesseract.panelOpen', true);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) WorkflowPanel.active = this;
      }),
      panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (!vscode.workspace.getConfiguration('tesseract').get<boolean>('refreshOnSave', true)) return;
        if (!doc.uri.fsPath.startsWith(this.folder.fsPath)) return;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => void this.analyze(true), SAVE_DEBOUNCE_MS);
      }),
    );
    void this.render().then(() => this.analyze(false));
  }

  private async render() {
    const webDir = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'web');
    const html = await fs.readFile(vscode.Uri.joinPath(webDir, 'index.html').fsPath, 'utf8');
    this.panel.webview.html = webviewHtml(html, this.panel.webview, webDir);
  }

  private post(message: unknown) {
    void this.panel.webview.postMessage(message);
  }

  private onMessage(m: FromWebview) {
    if (m.type === 'ready') {
      this.ready = true;
      if (this.graph) this.post({ type: 'graph', graph: this.graph });
    } else if (m.type === 'sources') {
      if (this.sources) this.post({ type: 'sources', sources: this.sources });
    } else if (m.type === 'open') {
      void openAt(vscode.Uri.joinPath(this.folder, ...m.path.split('/')), m.line);
    } else if (m.type === 'reanalyze') {
      void this.analyze(false);
    }
  }

  /** Runs the analyzer over the folder; `quiet` refreshes in the background without a progress notification. */
  analyze(quiet: boolean): Promise<void> {
    this.worker?.terminate();
    const input: WorkerInput = {
      dir: this.folder.fsPath,
      name: path.basename(this.folder.fsPath),
      grammarDir: vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'wasm').fsPath,
      runtimeWasm: vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'wasm', 'tree-sitter.wasm').fsPath,
    };
    const worker = new Worker(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'worker.js').fsPath, { workerData: input });
    this.worker = worker;

    const run = new Promise<void>((resolve) => {
      const finish = () => {
        if (this.worker === worker) this.worker = null;
        void worker.terminate();
        resolve();
      };
      worker.on('message', (m: WorkerOutput) => {
        if (this.worker !== worker) return;
        if (m.type === 'progress') {
          if (!quiet) this.post({ type: 'progress', message: `Analyzing ${input.name}: ${m.message}` });
          this.progress?.report({ message: m.message });
        } else if (m.type === 'done') {
          this.graph = m.result.graph;
          this.sources = m.result.sources;
          if (this.ready) this.post({ type: 'graph', graph: this.graph });
          finish();
        } else {
          this.post({ type: 'error', message: `Analysis failed: ${m.message}` });
          void vscode.window.showErrorMessage(`Tesseract: analysis failed: ${m.message}`);
          finish();
        }
      });
      worker.on('error', (e) => {
        if (this.worker === worker) {
          this.post({ type: 'error', message: `Analysis failed: ${e.message}` });
          void vscode.window.showErrorMessage(`Tesseract: analysis failed: ${e.message}`);
        }
        finish();
      });
      worker.on('exit', () => resolve());
    });

    if (quiet) return run;
    return Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Tesseract: analyzing ${input.name}` }, (progress) => {
        this.progress = progress;
        return run.finally(() => (this.progress = undefined));
      }),
    );
  }

  private progress: vscode.Progress<{ message?: string }> | undefined;

  private dispose() {
    clearTimeout(this.saveTimer);
    void this.worker?.terminate();
    this.worker = null;
    WorkflowPanel.byFolder.delete(this.folder.fsPath);
    if (WorkflowPanel.active === this) WorkflowPanel.active = [...WorkflowPanel.byFolder.values()][0];
    if (!WorkflowPanel.byFolder.size) void vscode.commands.executeCommand('setContext', 'tesseract.panelOpen', false);
    for (const d of this.disposables) d.dispose();
  }
}

/** Points the built web app's relative asset URLs at webview resources and locks it down with a CSP. */
function webviewHtml(html: string, webview: vscode.Webview, webDir: vscode.Uri): string {
  const nonce = randomBytes(16).toString('hex');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return html
    .replace(/<link rel="manifest"[^>]*>\s*/g, '')
    .replace(/\s+crossorigin(?=[\s>])/g, '')
    .replace(/(src|href)="\.\/([^"]+)"/g, (_, attr: string, rel: string) => `${attr}="${webview.asWebviewUri(vscode.Uri.joinPath(webDir, ...rel.split('/')))}"`)
    .replace(/<script /g, `<script nonce="${nonce}" `)
    .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
}

async function openAt(uri: vscode.Uri, line?: number) {
  const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
  await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos), preview: true });
}

async function pickFolder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri) {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type & vscode.FileType.Directory ? uri : vscode.Uri.joinPath(uri, '..');
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeDoc = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeDoc && vscode.workspace.getWorkspaceFolder(activeDoc);
  if (folders.length === 1) return folders[0].uri;
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, uri: f.uri, picked: f === activeFolder })),
      { placeHolder: 'Which folder should Tesseract analyze?' },
    );
    return pick?.uri;
  }
  const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Analyze folder' });
  return chosen?.[0];
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('tesseract.showWorkflow', async (uri?: vscode.Uri) => {
      const folder = await pickFolder(uri instanceof vscode.Uri ? uri : undefined);
      if (folder) WorkflowPanel.show(ctx, folder);
    }),
    vscode.commands.registerCommand('tesseract.reanalyze', () => WorkflowPanel.active?.analyze(false)),
  );

  const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  button.text = '$(type-hierarchy) Workflow';
  button.tooltip = 'Tesseract: show this codebase as an end-to-end workflow';
  button.command = 'tesseract.showWorkflow';
  const syncButton = () =>
    vscode.workspace.getConfiguration('tesseract').get<boolean>('showStatusBarButton', true) && vscode.workspace.workspaceFolders?.length ? button.show() : button.hide();
  syncButton();
  ctx.subscriptions.push(
    button,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('tesseract.showStatusBarButton') && syncButton()),
    vscode.workspace.onDidChangeWorkspaceFolders(syncButton),
  );
}

export function deactivate() {}
