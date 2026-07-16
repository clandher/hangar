import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

type Commit = { sha: string; author: string; ts: number; message: string };

type Project = {
  name: string;
  path: string;
  hangar: string;
  group: string;
  subgroup: string | null;
  mtime: number;
  lastOpened: number;
  hasGit: boolean;
  branch: string | null;
  stack: string | null;
  remoteUrl: string | null;
  // populated async
  sizeKb: number | null;
  commits: Commit[] | null;
  isDirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  abRef: string | null;
};

type Recents = Record<string, number>;
type Hangar = { name: string; path: string };

type RunnerResultType = 'count' | 'pass-fail' | 'json-count' | 'json-field' | 'text';
type Runner = {
  name: string;
  command: string;
  resultType: RunnerResultType;
  field?: string;
  label?: string;
  warnAt?: number;
  errorAt?: number;
  stacks?: string[];
};

const RECENTS_KEY = 'recents';
const THEME_KEY = 'theme';
const HANGARS_KEY = 'hangars';
const FAVORITES_KEY = 'favorites';
const UI_STATE_KEY = 'uiState';
const PROJECT_BRANCHES_KEY = 'projectBranches';
const DEFAULT_THEME = 'terminal';
const CONCURRENCY = 8;
const ENRICH_TIMEOUT = 4000;

let _activated = false;
let _panel: vscode.WebviewPanel | undefined;
let _statusBar: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext) {
  if (_activated) return;
  _activated = true;

  // migrate legacy single-dir setting
  const legacyDir = context.globalState.get<string>('projectsDir');
  if (legacyDir && !context.globalState.get<Hangar[]>(HANGARS_KEY)) {
    const name = path.basename(legacyDir);
    await context.globalState.update(HANGARS_KEY, [{ name, path: legacyDir }]);
    await context.globalState.update('projectsDir', undefined);
  }

  _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  _statusBar.command = 'hangar.open';
  _statusBar.tooltip = 'Open Hangar';
  context.subscriptions.push(_statusBar);

  updateStatusBar(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('hangar.open', () => openDashboard(context)),
    vscode.commands.registerCommand('hangar.resetStorage', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Reset all Hangar data? (hangars, recents, favorites, theme)', { modal: true }, 'Reset'
      );
      if (confirm !== 'Reset') return;
      await Promise.all([
        context.globalState.update(HANGARS_KEY, undefined),
        context.globalState.update(RECENTS_KEY, undefined),
        context.globalState.update(FAVORITES_KEY, undefined),
        context.globalState.update(THEME_KEY, undefined),
        context.globalState.update(UI_STATE_KEY, undefined),
      ]);
      updateStatusBar(context);
      vscode.window.showInformationMessage('Hangar storage cleared. Reload window to restart.');
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('hangar') && _panel) {
        // re-render open panel when settings change
        (_panel as any)._hangarRender?.();
      }
      if (e.affectsConfiguration('hangar')) updateStatusBar(context);
    })
  );

  const showOnStartup = vscode.workspace.getConfiguration('hangar').get<boolean>('showOnStartup', true);
  if (showOnStartup) {
    openDashboard(context);
  }
}

function updateStatusBar(context: vscode.ExtensionContext) {
  if (!_statusBar) return;
  const show = vscode.workspace.getConfiguration('hangar').get<boolean>('showStatusBar', true);
  if (!show) { _statusBar.hide(); return; }
  _statusBar.show();
  const hangars = context.globalState.get<Hangar[]>(HANGARS_KEY) ?? [];
  if (!hangars.length) {
    _statusBar.text = '⊹ hangar';
    return;
  }
  let count = 0;
  for (const h of hangars) {
    try { count += fs.readdirSync(h.path).filter(n => !n.startsWith('.')).length; } catch { /* ignore */ }
  }
  _statusBar.text = `⊹ ${count} projects`;
}

async function openDashboard(context: vscode.ExtensionContext) {

  const reuse = vscode.workspace.getConfiguration('hangar').get<boolean>('reusePanel', true);
  if (reuse && _panel) {
    _panel.reveal();
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'dashboard',
    'Hangar',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media')
      ]
    }
  );
  _panel = panel;

  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'styles.css')
  );

  let currentProjects: Project[] = [];
  let enrichCancel = { cancelled: false };

  const render = () => {
    enrichCancel.cancelled = true;
    enrichCancel = { cancelled: false };

    const hangars = context.globalState.get<Hangar[]>(HANGARS_KEY) ?? [];
    if (!hangars.length) {
      const extVersion = context.extension.packageJSON.version as string;
      const hotkey = process.platform === 'darwin' ? '⌘⇧R' : 'Ctrl+Shift+R';
      panel.webview.html = getNoHangarHtml(styleUri.toString(), extVersion, hotkey);
      return;
    }
    const recents = context.globalState.get<Recents>(RECENTS_KEY, {});
    const favorites = context.globalState.get<string[]>(FAVORITES_KEY, []);
    const theme = context.globalState.get<string>(THEME_KEY, DEFAULT_THEME);
    const uiState = context.globalState.get<object>(UI_STATE_KEY, {});
    const cfg = vscode.workspace.getConfiguration('hangar');
    const config = {
      chipAction: cfg.get<string>('chipAction', 'new-window'),
      clickAction: cfg.get<string>('clickAction', 'replace'),
      maxRecents: cfg.get<number>('maxRecents', 6),
      cardSize: cfg.get<string>('cardSize', 'normal'),
      showGitInfo: cfg.get<boolean>('showGitInfo', true),
      baseBranch: cfg.get<string>('baseBranch', ''),
    };
    const runners = cfg.get<Runner[]>('runners', []);
    const projects = hangars.flatMap(h => getProjects(h.path, recents, h.name));
    currentProjects = projects;
    const extVersion = context.extension.packageJSON.version as string;
    const projectBranches = context.globalState.get<Record<string, string>>(PROJECT_BRANCHES_KEY, {});
    panel.webview.html = getHtml(projects, hangars, favorites, uiState, theme, styleUri.toString(), config, extVersion, vscode.workspace.name, projectBranches, runners);
    updateStatusBar(context);
    enrichProjects(projects, panel, enrichCancel, projectBranches);
  };

  // expose render for onDidChangeConfiguration hook
  (panel as any)._hangarRender = render;

  panel.onDidDispose(() => {
    enrichCancel.cancelled = true;
    if (_panel === panel) _panel = undefined;
    (panel as any)._hangarRender = undefined;
  });

  render();

  panel.webview.onDidReceiveMessage(async msg => {

    if (msg.command === 'openProject') {
      const recents = context.globalState.get<Recents>(RECENTS_KEY, {});
      recents[msg.path] = Date.now();
      await context.globalState.update(RECENTS_KEY, trimRecents(recents));
      vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.path), msg.newWindow === true);
    }

    if (msg.command === 'addHangar') {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Agregar hangar'
      });
      if (!selected || !selected[0]) return;
      const p = selected[0].fsPath;
      const hangars = context.globalState.get<Hangar[]>(HANGARS_KEY) ?? [];
      if (hangars.some(h => h.path === p)) return;
      await context.globalState.update(HANGARS_KEY, [...hangars, { name: path.basename(p), path: p }]);
      render();
    }

    if (msg.command === 'removeHangar') {
      const hangars = context.globalState.get<Hangar[]>(HANGARS_KEY) ?? [];
      if (hangars.length <= 1) return;
      const target = hangars[msg.index];
      const confirm = await vscode.window.showWarningMessage(
        `Remove hangar "${target.name}"?`, { modal: true }, 'Remove'
      );
      if (confirm !== 'Remove') return;
      await context.globalState.update(HANGARS_KEY, hangars.filter((_, i) => i !== msg.index));
      render();
    }

    if (msg.command === 'refresh') { render(); }

    if (msg.command === 'clearRecents') {
      await context.globalState.update(RECENTS_KEY, {});
      render();
    }

    if (msg.command === 'revealInFinder') {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
    }

    if (msg.command === 'openRemote') {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    }

    if (msg.command === 'openIntelliJ') {
      const p = msg.path.replace(/"/g, '\\"');
      const cmd = process.platform === 'win32'
        ? `start "" "IntelliJ IDEA" "${p}"`
        : `open -a "IntelliJ IDEA" "${p}"`;
      cp.exec(cmd);
    }

    if (msg.command === 'openInTerminal') {
      const terminal = vscode.window.createTerminal({ name: path.basename(msg.path), cwd: msg.path });
      terminal.show();
    }

    if (msg.command === 'syncProject') {
      const projectBranches = context.globalState.get<Record<string, string>>(PROJECT_BRANCHES_KEY, {});
      const baseBranch = vscode.workspace.getConfiguration('hangar').get<string>('baseBranch', '');
      const branchForProject = projectBranches[msg.path] ?? baseBranch;
      // fetch first, then re-enrich this single project
      panel.webview.postMessage({ command: 'syncStart', path: msg.path });
      await run('git fetch origin', msg.path);
      const [sizeKb, commits, isDirty, aheadBehind] = await Promise.all([
        getSizeKb(msg.path),
        getCommits(msg.path),
        getIsDirty(msg.path),
        getAheadBehind(msg.path, branchForProject)
      ]);
      const ahead  = aheadBehind?.ahead  ?? null;
      const behind = aheadBehind?.behind ?? null;
      const abRef  = aheadBehind?.ref    ?? null;
      try { panel.webview.postMessage({ command: 'enrich', path: msg.path, sizeKb, commits, isDirty, ahead, behind, abRef }); } catch { /* panel disposed */ }
    }

    if (msg.command === 'cloneRepo') {
      const rawUrl = (msg.url as string).trim().replace(/^git\s+clone\s+/i, '').trim();
      if (!rawUrl) return;

      const repoName = rawUrl.split('/').pop()?.replace(/\.git$/i, '') ?? 'repo';
      const hangars = context.globalState.get<Hangar[]>(HANGARS_KEY) ?? [];
      if (!hangars.length) { vscode.window.showErrorMessage('No hay hangars configurados.'); return; }

      let targetHangar: Hangar;
      if (hangars.length === 1) {
        targetHangar = hangars[0];
      } else {
        const pick = await vscode.window.showQuickPick(
          hangars.map(h => ({ label: h.name, description: h.path, hangar: h })),
          { placeHolder: `¿En qué hangar clonar "${repoName}"?` }
        );
        if (!pick) { panel.webview.postMessage({ command: 'cloneDone' }); return; }
        targetHangar = pick.hangar;
      }

      const dest = path.join(targetHangar.path, repoName);
      if (fs.existsSync(dest)) {
        vscode.window.showErrorMessage(`"${repoName}" ya existe en ${targetHangar.name}.`);
        panel.webview.postMessage({ command: 'cloneDone' });
        return;
      }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Clonando ${repoName}…`, cancellable: false },
          () => new Promise<void>((resolve, reject) => {
            cp.execFile('git', ['clone', rawUrl, dest], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
              (err, _out, stderr) => err ? reject(new Error(stderr || err.message)) : resolve()
            );
          })
        );
        render();
        vscode.window.showInformationMessage(`Clonado ${repoName} en "${targetHangar.name}"`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Clone falló: ${e.message}`);
      }
      panel.webview.postMessage({ command: 'cloneDone' });
    }

    if (msg.command === 'openHangarIgnore') {
      const filePath = path.join(msg.hangarPath, '.hangarignore');
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '# .hangarignore — one folder name per line\n# Lines starting with # are comments\n');
      }
      vscode.window.showTextDocument(vscode.Uri.file(filePath));
    }

    if (msg.command === 'setBaseBranch') {
      const branches = context.globalState.get<Record<string, string>>(PROJECT_BRANCHES_KEY, {});
      const input = await vscode.window.showInputBox({
        prompt: `Compare ${path.basename(msg.path)} against branch`,
        value: branches[msg.path] ?? '',
        placeHolder: 'develop, main, origin/develop… (empty = use upstream)'
      });
      if (input === undefined) return;
      if (input === '') {
        const updated = { ...branches };
        delete updated[msg.path];
        await context.globalState.update(PROJECT_BRANCHES_KEY, updated);
      } else {
        await context.globalState.update(PROJECT_BRANCHES_KEY, { ...branches, [msg.path]: input });
      }
      render();
    }

    if (msg.command === 'toggleFavorite') {
      const favs = context.globalState.get<string[]>(FAVORITES_KEY, []);
      const next = favs.includes(msg.path)
        ? favs.filter(f => f !== msg.path)
        : [...favs, msg.path];
      await context.globalState.update(FAVORITES_KEY, next);
      panel.webview.postMessage({ command: 'favoritesUpdated', favorites: next });
    }

    if (msg.command === 'saveState') {
      await context.globalState.update(UI_STATE_KEY, msg.state);
    }

    if (msg.command === 'setTheme') {
      await context.globalState.update(THEME_KEY, msg.theme);
      render();
    }

    if (msg.command === 'runScanner') {
      const runner = msg.runner as Runner;
      const allPaths = msg.paths as string[];
      const queue = allPaths.filter(p => {
        if (!runner.stacks?.length) { return true; }
        const proj = currentProjects.find(pr => pr.path === p);
        return proj && runner.stacks!.includes(proj.stack ?? '');
      }).slice();
      async function scanWorker() {
        while (queue.length) {
          const projPath = queue.shift();
          if (!projPath) { break; }
          const cmd = runner.command.replace(/\{path\}/g, projPath.replace(/"/g, '\\"'));
          const { out, code } = await runWithCode(cmd, projPath);
          const { display, status, detail } = parseRunnerResult(runner, out, code);
          try {
            panel.webview.postMessage({ command: 'scanResult', path: projPath, runnerName: runner.name, display, status, detail });
          } catch { break; }
        }
      }
      await Promise.all(Array(CONCURRENCY).fill(0).map(() => scanWorker()));
      try { panel.webview.postMessage({ command: 'scanDone', runnerName: runner.name }); } catch { /* disposed */ }
    }

  });
}

function trimRecents(recents: Recents): Recents {
  return Object.fromEntries(
    Object.entries(recents).sort((a, b) => b[1] - a[1]).slice(0, 20)
  );
}

function readHangarIgnore(projectsDir: string): Set<string> {
  try {
    const raw = fs.readFileSync(path.join(projectsDir, '.hangarignore'), 'utf8');
    return new Set(raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  } catch { return new Set(); }
}

function getProjects(projectsDir: string, recents: Recents, hangarName: string = ''): Project[] {

  let dirs: string[];
  try { dirs = fs.readdirSync(projectsDir); } catch { return []; }

  const ignored = readHangarIgnore(projectsDir);

  return dirs
    .map(name => {
      const fullPath = path.join(projectsDir, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { return null; }
      if (!stat.isDirectory() || name.startsWith('.')) return null;
      if (ignored.has(name)) return null;

      const parts = name.split(/[-_]/);
      const group = parts.length >= 2 ? parts[0] : 'misc';
      const subgroup = parts.length > 2 ? parts[1] : null;

      const gitPath = path.join(fullPath, '.git');
      const hasGit = fs.existsSync(gitPath);

      return {
        name,
        path: fullPath,
        hangar: hangarName,
        group,
        subgroup,
        mtime: stat.mtimeMs,
        lastOpened: recents[fullPath] || 0,
        hasGit,
        branch: hasGit ? readBranch(gitPath) : null,
        stack: detectStack(fullPath),
        remoteUrl: hasGit ? readRemoteUrl(gitPath) : null,
        sizeKb: null, commits: null, isDirty: null, ahead: null, behind: null, abRef: null
      } as Project;
    })
    .filter((p): p is Project => p !== null);
}

function readBranch(gitPath: string): string | null {
  try {
    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 7);
  } catch { return null; }
}

function readRemoteUrl(gitPath: string): string | null {
  try {
    const cfg = fs.readFileSync(path.join(gitPath, 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^\[]*?url\s*=\s*([^\s\n]+)/);
    if (!m) return null;
    const raw = m[1].trim().replace(/\.git$/, '');
    const ssh = raw.match(/^[\w-]+@([^:]+):(.+)$/);
    if (ssh) return 'https://' + ssh[1] + '/' + ssh[2];
    return raw;
  } catch { return null; }
}

function detectStack(p: string): string | null {
  const checks: Array<[string, string]> = [
    ['package.json', 'node'], ['Cargo.toml', 'rust'], ['go.mod', 'go'],
    ['pyproject.toml', 'python'], ['requirements.txt', 'python'], ['Pipfile', 'python'],
    ['Gemfile', 'ruby'], ['pom.xml', 'java'], ['build.gradle', 'gradle'],
    ['build.gradle.kts', 'gradle'], ['composer.json', 'php'], ['pubspec.yaml', 'flutter'],
    ['mix.exs', 'elixir'], ['Package.swift', 'swift'], ['deno.json', 'deno'],
    ['bun.lockb', 'bun'], ['Dockerfile', 'docker']
  ];
  for (const [file, label] of checks) {
    if (fs.existsSync(path.join(p, file))) return label;
  }
  return null;
}

function run(cmd: string, cwd: string, timeout = ENRICH_TIMEOUT): Promise<string> {
  return new Promise(resolve => {
    cp.exec(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 },
      (err: Error | null, stdout: string) => resolve(err ? '' : stdout)
    );
  });
}

function runWithCode(cmd: string, cwd: string, timeout = 30000): Promise<{out: string; code: number}> {
  return new Promise(resolve => {
    cp.exec(cmd, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err: any, stdout: string) => resolve({ out: stdout || '', code: err?.code ?? 0 })
    );
  });
}

function buildDetail(runner: Runner, out: string): string[] {
  const MAX = 15;
  const rawLines = out.trim().split('\n').filter(Boolean).slice(0, MAX);
  try {
    if (runner.resultType === 'json-count') {
      const parsed = JSON.parse(out.trim() || '{}');
      if (Array.isArray(parsed)) {
        return parsed.slice(0, MAX).map((p: any) =>
          `${p.name ?? p.package ?? '?'}: ${p.version ?? '?'} → ${p.latest_version ?? p.latest ?? '?'}`
        );
      }
      return Object.entries(parsed).slice(0, MAX).map(([name, info]: [string, any]) =>
        `${name}: ${info.current ?? '?'} → ${info.latest ?? info.wanted ?? '?'}`
      );
    }
    if (runner.resultType === 'json-field') {
      const parsed = JSON.parse(out.trim() || '{}');
      const parentParts = (runner.field ?? '').split('.').slice(0, -1);
      let parent: any = parsed;
      for (const p of parentParts) { parent = parent?.[p]; }
      if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
        const lines = Object.entries(parent)
          .filter(([k]) => k !== 'total')
          .map(([k, v]) => `${k}: ${v}`)
          .filter(Boolean);
        if (lines.length) { return lines; }
      }
    }
  } catch { /* ignore */ }
  return rawLines;
}

function parseRunnerResult(runner: Runner, out: string, code: number): { display: string; status: 'ok' | 'warn' | 'error' | 'neutral'; detail: string[] } {
  const label = runner.label ?? '';
  const detail = buildDetail(runner, out);
  try {
    if (runner.resultType === 'pass-fail') {
      return { display: code === 0 ? '✓ pass' : '✗ fail', status: code === 0 ? 'ok' : 'error', detail };
    }
    if (runner.resultType === 'text') {
      return { display: out.trim().split('\n')[0].trim() || '—', status: 'neutral', detail };
    }
    let numVal = 0;
    if (runner.resultType === 'count') {
      numVal = parseInt(out.trim(), 10);
      if (isNaN(numVal)) { numVal = out.trim().split('\n').filter(Boolean).length; }
    } else if (runner.resultType === 'json-count') {
      const parsed = JSON.parse(out.trim() || '{}');
      numVal = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
    } else if (runner.resultType === 'json-field') {
      const parsed = JSON.parse(out.trim() || '{}');
      const parts = (runner.field ?? '').split('.');
      let v: any = parsed;
      for (const part of parts) { v = v?.[part]; }
      numVal = typeof v === 'number' ? v : parseInt(String(v), 10);
      if (isNaN(numVal)) { numVal = 0; }
    }
    const display = `${numVal}${label ? ' ' + label : ''}`;
    if (runner.errorAt !== undefined && numVal >= runner.errorAt) { return { display, status: 'error', detail }; }
    if (runner.warnAt !== undefined && numVal >= runner.warnAt) { return { display, status: 'warn', detail }; }
    return { display, status: 'ok', detail };
  } catch {
    return { display: 'err', status: 'error', detail: [] };
  }
}

async function getSizeKb(p: string): Promise<number | null> {
  const escaped = p.replace(/"/g, '\\"');
  const cmd = process.platform === 'win32'
    ? `powershell -Command "(Get-ChildItem -Recurse -Force '${p.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum"`
    : `du -sk "${escaped}"`;
  const out = await run(cmd, p);
  if (process.platform === 'win32') {
    const n = parseInt(out.trim(), 10);
    return isNaN(n) ? null : Math.round(n / 1024);
  }
  const m = out.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function getCommits(p: string): Promise<Commit[] | null> {
  const fmt = '%H\x1f%an\x1f%at\x1f%s';
  // prefer upstream tracking branch (remote state); fall back to HEAD
  const upstream = (await run('git rev-parse --abbrev-ref "@{u}"', p)).trim();
  const ref = upstream || 'HEAD';
  const out = await run(`git log "${ref}" -n 5 --format="${fmt}"`, p);
  if (!out.trim()) return null;
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [sha, author, ts, ...rest] = line.split('\x1f');
    return { sha: sha.slice(0, 7), author, ts: parseInt(ts, 10) * 1000, message: rest.join('\x1f') };
  });
}

async function getIsDirty(p: string): Promise<boolean> {
  const out = await run('git status --short', p);
  return out.trim().length > 0;
}

async function getAheadBehind(p: string, baseBranch: string): Promise<{ ahead: number; behind: number; ref: string } | null> {
  let ref = baseBranch;
  if (!ref) {
    ref = (await run('git rev-parse --abbrev-ref @{u}', p)).trim();
    if (!ref || ref.includes('fatal')) return null;
  } else if (!ref.startsWith('origin/')) {
    // local branch may be stale — prefer the remote-tracking counterpart if it exists
    const remoteRef = `origin/${ref}`;
    const verified = (await run(`git rev-parse --verify --quiet refs/remotes/${remoteRef}`, p)).trim();
    if (verified) ref = remoteRef;
  }
  const out = await run(`git rev-list --left-right --count HEAD...${ref}`, p);
  const m = out.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { ahead: parseInt(m[1], 10), behind: parseInt(m[2], 10), ref };
}

async function enrichProjects(projects: Project[], panel: vscode.WebviewPanel, cancel: { cancelled: boolean } = { cancelled: false }, projectBranches: Record<string, string> = {}) {
  const baseBranch = vscode.workspace.getConfiguration('hangar').get<string>('baseBranch', '');
  const queue = projects.slice();

  async function worker() {
    while (queue.length) {
      if (cancel.cancelled) break;
      const p = queue.shift();
      if (!p) break;
      if (p.hasGit) await run('git fetch origin', p.path);
      if (cancel.cancelled) break;
      const [sizeKb, commits, isDirty, aheadBehind] = await Promise.all([
        getSizeKb(p.path),
        p.hasGit ? getCommits(p.path) : Promise.resolve(null),
        p.hasGit ? getIsDirty(p.path) : Promise.resolve(false),
        p.hasGit ? getAheadBehind(p.path, projectBranches[p.path] ?? baseBranch) : Promise.resolve(null)
      ]);
      if (cancel.cancelled) break;
      const ahead  = aheadBehind?.ahead  ?? null;
      const behind = aheadBehind?.behind ?? null;
      const abRef  = aheadBehind?.ref    ?? null;
      try { panel.webview.postMessage({ command: 'enrich', path: p.path, sizeKb, commits, isDirty, ahead, behind, abRef }); } catch { break; }
    }
  }

  await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

type HangarConfig = { chipAction: string; clickAction: string; maxRecents: number; cardSize: string; showGitInfo: boolean; baseBranch: string };

function getNoHangarHtml(styleUri: string, version: string, hotkey: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Hangar</title>
<link rel="stylesheet" href="${styleUri}">
</head>
<body data-theme="terminal">
<div class="topbar">
  <div class="header">
    <div class="brand"><span class="prompt">~/</span>hangar<span class="cursor"></span></div>
  </div>
</div>
<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60vh;gap:1rem;text-align:center;">
  <div style="font-size:1.1rem;opacity:0.6;">no hangar selected</div>
  <div style="opacity:0.4;font-size:0.85rem;max-width:340px;line-height:1.5;">
    Select the folder where you keep your projects.<br>Hangar will list everything inside it as a project.<br><br>
    You can add multiple hangars to organize different project groups.<br>
    Open anytime with <kbd>${hotkey}</kbd>.
  </div>
  <button onclick="addHangar()" style="margin-top:0.5rem;">+ select projects folder</button>
  <div style="opacity:0.25;font-size:0.75rem;margin-top:1rem;">v${version}</div>
</div>
<script>
const vscode = acquireVsCodeApi();
function addHangar() { vscode.postMessage({ command: 'addHangar' }); }
</script>
</body>
</html>`;
}

function getHtml(projects: Project[], hangars: Hangar[], favorites: string[], uiState: object, theme: string, styleUri: string, config: HangarConfig, version: string, workspaceName?: string, projectBranches: Record<string, string> = {}, runners: Runner[] = []): string {

  const displayName = workspaceName ?? 'hangar';
  const groups = Array.from(new Set(projects.map(p => p.group))).sort();
  const recentProjects = projects
    .filter(p => p.lastOpened > 0)
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .slice(0, config.maxRecents);

  const HANGARS_JSON = JSON.stringify(hangars);
  const FAVORITES_JSON = JSON.stringify(favorites);
  const UI_STATE_JSON = JSON.stringify(uiState);
  const PROJECT_BRANCHES_JSON = JSON.stringify(projectBranches);
  const RUNNERS_JSON = JSON.stringify(runners);

  // passed to webview JS as data
  const THEMES_JSON = JSON.stringify(['terminal', 'amber', 'synthwave', 'paper']);
  const SORTS_JSON  = JSON.stringify(['recent', 'modified', 'name', 'size', 'group', 'dirty']);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(displayName)}</title>
<link rel="stylesheet" href="${styleUri}">
</head>
<body data-theme="${esc(theme)}" data-card-size="${esc(config.cardSize)}">

<div class="topbar">
  <div class="header">
    <div class="brand">
      <span class="prompt">~/</span>${esc(displayName)}<span class="cursor"></span>
    </div>
    <div class="meta">
      <span class="path">${projects.length} projects</span>
      <button onclick="refresh()" title="Recargar la lista de proyectos">↺</button>
      <button id="theme-cycle" class="cycle-btn" title="Cambiar el tema de colores">theme: ${esc(theme)} ▸</button>
      <button onclick="toggleCloneBar()" title="Clonar un repositorio git dentro de un hangar">+ clone</button>
      <div class="runner-wrap" id="runner-wrap">
        <button id="runner-btn" onclick="toggleRunnerMenu()" title="Ejecutar un comando de escaneo sobre los proyectos seleccionados">scan ▾</button>
        <div id="runner-menu" class="runner-menu" style="display:none"></div>
      </div>
      <button id="select-toggle" onclick="toggleSelectMode()" title="Activar modo selección para actuar sobre varios proyectos a la vez">select</button>
      <span id="select-status" class="select-status"></span>
    </div>
  </div>
  <div class="hangar-tabs" id="hangar-tabs"></div>
  <div class="controls">
    <div class="search">
      <span class="sigil">$</span>
      <input id="q" type="text" placeholder="filter projects..." />
      <span class="count" id="count"></span>
    </div>
    <button id="sort-cycle" class="cycle-btn" title="Cambiar el orden de la lista (reciente, modificado, nombre, tamaño, grupo, cambios)">sort: recent ▸</button>
    <button id="git-toggle" title="Mostrar solo proyectos que son repositorios git">git only</button>
    <button id="attention-toggle" title="Mostrar solo proyectos que requieren atención (cambios sin confirmar o commits por bajar)">⚠ attention</button>
  </div>
</div>

<div id="clone-bar" style="display:none;padding:0.4rem 1rem;gap:0.5rem;align-items:center;background:var(--bg2,#1a1a1a);border-bottom:1px solid var(--border,#333);">
  <span style="opacity:0.5;font-size:0.8rem;white-space:nowrap;">git clone</span>
  <input id="clone-url" type="text" placeholder="https://user@bitbucket.org/workspace/repo.git" style="flex:1;min-width:0;font-family:inherit;font-size:0.85rem;" />
  <button id="clone-submit-btn" onclick="submitClone()">clonar</button>
  <button onclick="toggleCloneBar()" style="opacity:0.5;">✕</button>
</div>

<div class="chips" id="chips"></div>
<main id="main"></main>

<div class="footer">
  <div>
    <span class="kbd">/</span> search &nbsp;
    <span class="kbd">esc</span> clear &nbsp;
    <span class="kbd">r</span> refresh &nbsp;
    <span class="kbd">click</span> ${config.chipAction === 'new-window' ? 'new window' : 'replace'} &nbsp;
    <span class="kbd">⌘+click</span> ${config.clickAction === 'new-window' ? 'new window' : 'replace'}
  </div>
  <div id="stats"></div>
  <div class="muted-time">v${version}</div>
</div>

<!-- global tooltip (JS-positioned) -->
<div class="g-tooltip" id="g-tooltip"></div>

<script>
const vscode = acquireVsCodeApi();

const allProjects = ${JSON.stringify(projects)};
const recentProjects = ${JSON.stringify(recentProjects)};
const groups = ${JSON.stringify(groups)};
const THEMES = ${THEMES_JSON};
const SORTS  = ${SORTS_JSON};
const HANGARS = ${HANGARS_JSON};
const favSet = new Set(${FAVORITES_JSON});
const _saved = ${UI_STATE_JSON};
const CONFIG = ${JSON.stringify(config)};
const PROJECT_BRANCHES = ${PROJECT_BRANCHES_JSON};
const RUNNERS = ${RUNNERS_JSON};

// working copies with async enrichment fields
const projects = allProjects.map(p => Object.assign({}, p, { sizeKb: null, commits: null, isDirty: null, ahead: null, behind: null, abRef: null }));
const recents  = recentProjects.map(p => Object.assign({}, p, { sizeKb: null, commits: null, isDirty: null, ahead: null, behind: null, abRef: null }));

const byPath = {};
projects.forEach(p => { byPath[p.path] = p; });
recents.forEach(p => { byPath[p.path] = byPath[p.path] || p; });

const state = {
  query: _saved.query || '',
  sort: _saved.sort || 'recent',
  activeGroup: _saved.activeGroup || null,
  gitOnly: _saved.gitOnly || false,
  attentionOnly: _saved.attentionOnly || false,
  hangarFilter: _saved.hangarFilter || null
};
const hangarStates = _saved.hangarStates || {};

let selectMode = false;
const selected = new Set();
const scanResults = {};

function saveState() {
  vscode.postMessage({ command: 'saveState', state: {
    query: state.query,
    sort: state.sort,
    activeGroup: state.activeGroup,
    gitOnly: state.gitOnly,
    attentionOnly: state.attentionOnly,
    hangarFilter: state.hangarFilter,
    hangarStates
  }});
}

const $q         = document.getElementById('q');
const $count     = document.getElementById('count');
const $chips     = document.getElementById('chips');
const $main      = document.getElementById('main');
const $stats     = document.getElementById('stats');
const $gitToggle = document.getElementById('git-toggle');
const $sortCycle = document.getElementById('sort-cycle');
const $themeCycle= document.getElementById('theme-cycle');
const $tooltip   = document.getElementById('g-tooltip');

// ── icons (inline SVG, uniform 24-viewBox so every glyph is the same size) ──
function svg(inner, filled) {
  return '<svg viewBox="0 0 24 24" fill="' + (filled ? 'currentColor' : 'none') +
    '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    inner + '</svg>';
}
const ICON = {
  star:     svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', false),
  starOn:   svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>', true),
  refresh:  svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>', false),
  terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', false),
  branch:   svg('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>', false),
  link:     svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>', false),
};

// ── time formatting ─────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h';
  const d = Math.floor(h / 24); if (d < 30) return d + 'd';
  const mo = Math.floor(d / 30); if (mo < 12) return mo + 'mo';
  return Math.floor(mo / 12) + 'y';
}

function fmtSize(kb) {
  if (kb == null) return '';

  if (kb < 1024) {
    return Math.round(kb) + 'KB';
  }

  const mb = kb / 1024;

  if (mb < 1024) {
    return mb.toFixed(mb < 10 ? 1 : 0) + 'MB';
  }

  const gb = mb / 1024;

  return gb.toFixed(1) + 'GB';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Safe to inline inside a JS string literal that itself lives in an HTML attribute
// (e.g. onclick="fn('...')"). Doubles backslashes so Windows paths like
// C:\\Users\\... don't get mangled by JS escape parsing (\\U, \\r → CR, etc),
// then HTML-escapes quotes/angles. Use this — not esc — for onclick arguments.
function jsstr(s) {
  return esc(String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"));
}

function highlight(name, q) {
  if (!q) return esc(name);
  const tokens = q.trim().split(/\\s+/).filter(Boolean);
  if (!tokens.length) return esc(name);
  // mark ranges to highlight
  const lower = name.toLowerCase();
  const marks = new Uint8Array(name.length);
  tokens.forEach(t => {
    let pos = 0;
    while ((pos = lower.indexOf(t.toLowerCase(), pos)) !== -1) {
      marks.fill(1, pos, pos + t.length);
      pos += t.length;
    }
  });
  let out = '', inMark = false;
  for (let i = 0; i < name.length; i++) {
    if (marks[i] && !inMark)  { out += '<span class="match">'; inMark = true; }
    if (!marks[i] && inMark)  { out += '</span>'; inMark = false; }
    out += esc(name[i]);
  }
  if (inMark) out += '</span>';
  return out;
}

// ── tooltip ─────────────────────────────────────────────────
let tooltipHideTimer = null;

function showTooltip(el, commits) {
  clearTimeout(tooltipHideTimer);
  if (!commits || !commits.length) return;

  const lines = commits.map(c =>
    '<div class="tip-commit">' +
    '<span class="tip-sha">' + esc(c.sha) + '</span>' +
    '<span class="tip-msg">' + esc(c.message) + '</span>' +
    '<div class="tip-meta"><span class="tip-who">' + esc(c.author) + '</span><span>' + fmtTime(c.ts) + '</span></div>' +
    '</div>'
  ).join('');

  $tooltip.innerHTML = '<div class="tip-head">last ' + commits.length + ' commits</div>' + lines;
  $tooltip.classList.add('visible');

  const rect = el.getBoundingClientRect();
  const tw = Math.min(480, window.innerWidth - 20);
  let left = rect.left;
  if (left + tw > window.innerWidth - 10) left = window.innerWidth - tw - 10;
  $tooltip.style.left = left + 'px';
  $tooltip.style.top  = (rect.bottom + 6) + 'px';
  $tooltip.style.minWidth = '300px';
}

function hideTooltip() {
  tooltipHideTimer = setTimeout(() => $tooltip.classList.remove('visible'), 80);
}

// ── unified text tooltip (replaces flaky native title="") ────
let textTipTimer = null;
let textTipEl = null;

function showTextTip(el) {
  const msg = el.getAttribute('data-tip');
  if (!msg) return;
  clearTimeout(tooltipHideTimer);
  $tooltip.innerHTML = '<div class="tip-text">' + esc(msg) + '</div>';
  $tooltip.style.minWidth = '0';
  $tooltip.style.maxWidth = '320px';
  $tooltip.classList.add('visible');

  const rect = el.getBoundingClientRect();
  const tw = $tooltip.offsetWidth;
  const th = $tooltip.offsetHeight;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  // prefer below; flip above if it would overflow the viewport bottom
  let top = rect.bottom + 6;
  if (top + th > window.innerHeight - 8) top = rect.top - th - 6;
  $tooltip.style.left = left + 'px';
  $tooltip.style.top = top + 'px';
}

function hideTextTip() {
  clearTimeout(textTipTimer);
  textTipEl = null;
  tooltipHideTimer = setTimeout(() => $tooltip.classList.remove('visible'), 60);
}

// delegate: any [title] element gets a uniform, instant-ish custom tooltip.
// The native title is stripped on first hover so the OS tooltip never fires.
document.addEventListener('mouseover', function (e) {
  const el = e.target.closest('[title], [data-tip]');
  if (!el || el.classList.contains('commits-badge')) return;  // commits has its own rich tooltip
  if (el.hasAttribute('title')) {
    const t = el.getAttribute('title');
    if (t) el.setAttribute('data-tip', t);
    el.removeAttribute('title');
  }
  if (textTipEl === el) return;
  textTipEl = el;
  clearTimeout(textTipTimer);
  textTipTimer = setTimeout(() => { if (textTipEl === el) showTextTip(el); }, 110);
});

document.addEventListener('mouseout', function (e) {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  const to = e.relatedTarget;
  if (to && el.contains(to)) return;                      // still inside same element
  if (to && to.closest && to.closest('[data-tip], [title]')) return; // moving to another tip; its mouseover takes over
  hideTextTip();
});

// ── PR url helper ────────────────────────────────────────────
function getPrUrl(remoteUrl, branch) {
  if (!remoteUrl || !branch) { return null; }
  if (remoteUrl.includes('bitbucket.org')) {
    return remoteUrl + '/pull-requests/new?source=' + encodeURIComponent(branch);
  }
  if (remoteUrl.includes('github.com')) {
    return remoteUrl + '/compare/' + encodeURIComponent(branch);
  }
  return null;
}

// ── card html ────────────────────────────────────────────────
function cardHtml(p, q) {
  const pa = esc(p.path);       // for data-path attrs (read via getAttribute)
  const paj = jsstr(p.path);    // for inline onclick JS-string args

  // tags row
  const stack = p.stack ? '<span class="stack" title="Tecnología detectada del proyecto: ' + esc(p.stack) + '">' + esc(p.stack) + '</span>' : '';

  // action buttons
  const isFav = favSet.has(p.path);
  const starBtn = '<button class="star-btn' + (isFav ? ' starred' : '') + '" onclick="event.stopPropagation(); toggleFavorite(\\'' + paj + '\\')" title="' + (isFav ? 'Quitar de favoritos' : 'Marcar como favorito') + '">' + (isFav ? ICON.starOn : ICON.star) + '</button>';
  const termBtn = '<button class="term-btn" onclick="event.stopPropagation(); openInTerminal(\\'' + paj + '\\')" title="Abrir este proyecto en una terminal">' + ICON.terminal + '</button>';
  const syncBtn = p.hasGit ? '<button class="sync-btn" data-path="' + pa + '" onclick="event.stopPropagation(); syncProject(\\'' + paj + '\\')" title="Actualizar estado git (git fetch + recalcular adelante/atrás y cambios)">' + ICON.refresh + '</button>' : '';
  const isJava = p.stack === 'java' || p.stack === 'gradle';
  const openBtn = isJava
    ? '<button title="Abrir en IntelliJ IDEA" onclick="event.stopPropagation(); openIntelliJ(\\'' + paj + '\\')">ij</button><button title="Abrir en VS Code" onclick="event.stopPropagation(); openCard(event, \\'' + paj + '\\')">vsc</button>'
    : '<button title="Abrir en VS Code (⌘/Ctrl+clic = ventana nueva)" onclick="event.stopPropagation(); openCard(event, \\'' + paj + '\\')">open</button>';

  // git status badges — explicit labels, no arrows
  const dirtyDot = p.isDirty === true
    ? '<span class="dirty-dot" title="Trabajo sin guardar en git: hay archivos nuevos o modificados que todavía no forman parte de ningún commit. Haz commit (o descártalos) antes de cambiar de rama o hacer pull para no perderlos.">●</span>'
    : '';

  const abBase = p.abRef || CONFIG.baseBranch || '';
  const pullTip = abBase ? 'Debes hacer pull: hay ' + p.behind + ' commit' + (p.behind > 1 ? 's' : '') + ' en ' + abBase + ' que aún no tienes en local' : '';
  const pushTip = abBase ? 'Debes hacer push: tienes ' + p.ahead  + ' commit' + (p.ahead  > 1 ? 's' : '') + ' en local que aún no subes a ' + abBase : '';
  const needPull = p.behind > 0  ? '<span class="need-pull" title="' + esc(pullTip) + '">pull</span>' : '';
  const needPush = p.ahead  > 0  ? '<span class="need-push" title="' + esc(pushTip) + '">push</span>' : '';

  // branch + compare button
  const branchOverride = PROJECT_BRANCHES[p.path];
  const branchBtnTip = branchOverride ? 'Comparando adelante/atrás contra la rama "' + branchOverride + '" (clic para cambiarla)' : 'Elegir contra qué rama comparar adelante/atrás (por defecto la rama base)';
  const branchBtn = p.hasGit
    ? '<button class="branch-btn' + (branchOverride ? ' active' : '') + '" onclick="event.stopPropagation(); setBaseBranch(\\'' + paj + '\\')" title="' + esc(branchBtnTip) + '">' + ICON.branch + '</button>'
    : '';
  const branchName = p.branch ? '<span class="branch" title="Rama git actual: ' + esc(p.branch) + '">⎇ ' + esc(p.branch) + '</span>' : '';

  // remote link
  const remoteBtn = p.remoteUrl
    ? '<button class="remote-btn" onclick="event.stopPropagation(); openRemote(\\'' + jsstr(p.remoteUrl) + '\\')" title="Abrir el repositorio remoto en el navegador: ' + esc(p.remoteUrl) + '">' + ICON.link + '</button>'
    : '';

  // PR link
  const prUrl = getPrUrl(p.remoteUrl, p.branch);
  const prBtn = prUrl
    ? '<button class="pr-btn" onclick="event.stopPropagation(); openRemote(\\'' + jsstr(prUrl) + '\\')" title="Abrir en el navegador un pull request de esta rama">PR</button>'
    : '';

  // meta: time + size
  const timeVal = p.lastOpened
    ? fmtTime(p.lastOpened)
    : fmtTime(p.mtime);
  const sizeVal = p.sizeKb != null ? fmtSize(p.sizeKb) : '…';

  // commits badge (hover tooltip)
  const commitsBadge = p.hasGit && CONFIG.showGitInfo
    ? '<span class="commits-badge" data-path="' + pa + '">commits</span>'
    : '';

  // last commit line
  let commitRow = '';
  if (p.hasGit && CONFIG.showGitInfo) {
    if (p.commits && p.commits.length) {
      const c = p.commits[0];
      commitRow = '<div class="commit-row">' +
        '<span class="commit-sha">' + esc(c.sha) + '</span>' +
        '<span class="commit-msg">' + esc(c.message) + '</span>' +
        '<span class="commit-meta">' + esc(c.author) + ' · ' + fmtTime(c.ts) + '</span>' +
        '</div>';
    } else {
      commitRow = '<div class="commit-row pending" title="Leyendo el historial git de este proyecto…">cargando info git (último commit, estado)…</div>';
    }
  }

  return \`
    <div class="card" data-path="\${pa}">
      <div class="card-header">
        <div class="card-tags">
          <span class="tag" title="Carpeta contenedora (hangar / subcarpeta): \${esc(p.group)}">\${esc(p.group)}</span>
          \${stack}
        </div>
      </div>
      <div class="name" title="\${esc(p.name)} — \${esc(p.path)}">\${highlight(p.name, q)}</div>
      <div class="card-git">
        \${branchName}
        \${dirtyDot}
        \${needPull}
        \${needPush}
      </div>
      \${commitRow}
      <div class="scan-results" data-path="\${pa}"></div>
      <div class="card-footer">
        \${commitsBadge}
        <span class="spacer"></span>
        <span class="meta-time" title="\${p.lastOpened ? 'Última vez que lo abriste' : 'Última modificación de archivos'}">\${timeVal}</span>
        <span class="meta-size" title="Tamaño en disco del proyecto">\${sizeVal}</span>
      </div>
      <div class="actions">\${starBtn}\${syncBtn}\${termBtn}\${branchBtn}\${remoteBtn}\${prBtn}\${openBtn}</div>
    </div>
  \`;
}

// ── filtering + sorting ──────────────────────────────────────
function filtered() {
  const tokens = state.query.toLowerCase().trim().split(/\\s+/).filter(Boolean);
  return projects.filter(p => {
    if (state.gitOnly && !p.hasGit) return false;
    if (state.attentionOnly && !(p.isDirty === true || (p.behind !== null && p.behind > 0))) return false;
    if (state.hangarFilter && p.hangar !== state.hangarFilter) return false;
    if (state.activeGroup && p.group !== state.activeGroup) return false;
    if (tokens.length && !tokens.every(t => p.name.toLowerCase().includes(t))) return false;
    return true;
  });
}

function sorted(list) {
  const arr = list.slice();
  if (state.sort === 'name')     arr.sort((a,b) => a.name.localeCompare(b.name));
  else if (state.sort === 'modified') arr.sort((a,b) => b.mtime - a.mtime);
  else if (state.sort === 'size')     arr.sort((a,b) => (b.sizeKb||0) - (a.sizeKb||0));
  else if (state.sort === 'recent') {
    arr.sort((a,b) => a.lastOpened !== b.lastOpened ? b.lastOpened - a.lastOpened : b.mtime - a.mtime);
  } else if (state.sort === 'group') {
    arr.sort((a,b) => {
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      if ((a.subgroup||'') !== (b.subgroup||'')) return (a.subgroup||'').localeCompare(b.subgroup||'');
      return a.name.localeCompare(b.name);
    });
  } else if (state.sort === 'dirty') {
    arr.sort((a,b) => {
      const da = a.isDirty === true ? 0 : a.isDirty === null ? 1 : 2;
      const db = b.isDirty === true ? 0 : b.isDirty === null ? 1 : 2;
      if (da !== db) return da - db;
      return b.lastOpened - a.lastOpened;
    });
  }
  return arr;
}

// ── render ───────────────────────────────────────────────────
function renderChips() {
  const scoped = state.hangarFilter ? projects.filter(p => p.hangar === state.hangarFilter) : projects;
  const counts = {};
  scoped.forEach(p => { counts[p.group] = (counts[p.group]||0) + 1; });
  const scopedGroups = Array.from(new Set(scoped.map(p => p.group))).sort();
  $chips.innerHTML =
    '<div class="chip ' + (state.activeGroup === null ? 'active' : '') + '" data-group="">all<span class="n">' + scoped.length + '</span></div>' +
    scopedGroups.map(g => '<div class="chip ' + (state.activeGroup === g ? 'active' : '') + '" data-group="' + esc(g) + '">' + esc(g) + '<span class="n">' + (counts[g]||0) + '</span></div>').join('');

  $chips.querySelectorAll('.chip').forEach(el => {
    el.addEventListener('click', () => {
      state.activeGroup = el.getAttribute('data-group') || null;
      saveState();
      renderChips();
      render();
    });
  });
}

function gridWithSubgroups(list, q) {
  // insert subgroup-label divs between groups of cards in the same subgroup
  let html = '';
  let lastSub = '<<none>>';
  list.forEach(p => {
    const sub = p.subgroup || '';
    if (sub !== lastSub) {
      if (sub) html += '<div class="subgroup-label">' + esc(sub) + '</div>';
      else if (lastSub) html += '<div class="subgroup-label">—</div>';
      lastSub = sub;
    }
    html += cardHtml(p, q);
  });
  return html;
}

function render() {
  const q = state.query.trim();
  const f = filtered();
  const s = sorted(f);

  $count.textContent = s.length + '/' + projects.length;

  let html = '';

  // favorites section
  const favProjects = projects
    .filter(p => favSet.has(p.path) && (!state.hangarFilter || p.hangar === state.hangarFilter))
    .map(p => byPath[p.path] || p);
  if (favProjects.length && !state.query && !state.activeGroup && !state.gitOnly) {
    html += '<section><div class="section-head"><h2>★ favorites</h2><span class="dim">' + favProjects.length + '</span></div>';
    html += '<div class="grid">' + favProjects.map(p => cardHtml(p, '')).join('') + '</div></section>';
  }

  // recents section
  const visibleRecents = recents.filter(p => !state.hangarFilter || p.hangar === state.hangarFilter);
  if (visibleRecents.length && !state.query && !state.activeGroup && !state.gitOnly) {
    html += '<section><div class="section-head"><h2>recents</h2><span class="dim">' + visibleRecents.length + '</span><div class="spacer"></div><span class="action" onclick="clearRecents()">clear</span></div>';
    html += '<div class="grid">' + visibleRecents.map(p => cardHtml(p, '')).join('') + '</div></section>';
  }

  const title = state.activeGroup || (state.gitOnly ? 'git-tracked' : 'all projects');
  html += '<section><div class="section-head"><h2>' + esc(title) + '</h2><span class="dim">' + s.length + '</span></div>';

  if (!s.length) {
    html += '<div class="empty">no matches<div class="hint">try clearing filters or search</div></div></section>';
  } else if (state.sort === 'group' && !state.activeGroup) {
    // group by group, then subgroup labels inside
    const byGroup = {};
    s.forEach(p => { (byGroup[p.group] = byGroup[p.group]||[]).push(p); });
    html += '</section>';
    Object.keys(byGroup).forEach(g => {
      html += '<section><div class="section-head"><h2>' + esc(g) + '</h2><span class="dim">' + byGroup[g].length + '</span></div>';
      html += '<div class="grid">' + gridWithSubgroups(byGroup[g], q) + '</div></section>';
    });
  } else {
    html += '<div class="grid">' + s.map(p => cardHtml(p, q)).join('') + '</div></section>';
  }

  $main.innerHTML = html;

  if (selectMode) {
    $main.querySelectorAll('.card').forEach(card => {
      if (selected.has(card.getAttribute('data-path'))) { card.classList.add('selected'); }
    });
  }
  Object.keys(scanResults).forEach(p => updateCardScanResults(p));

  const gitCount = projects.filter(p => p.hasGit).length;
  const totalKb  = projects.reduce((a, p) => a + (p.sizeKb||0), 0);
  $stats.textContent = projects.length + ' projects · ' + gitCount + ' git · ' + groups.length + ' groups' + (totalKb ? ' · ' + fmtSize(totalKb) : '');

  // tooltip events — delegate to $main
  $main.querySelectorAll('.commits-badge').forEach(el => {
    el.addEventListener('mouseenter', () => {
      const p = byPath[el.getAttribute('data-path')];
      if (p) showTooltip(el, p.commits);
    });
    el.addEventListener('mouseleave', hideTooltip);
  });
}

// ── enrichment ───────────────────────────────────────────────
window.addEventListener('message', ev => {
  const msg = ev.data;
  if (msg && msg.command === 'enrich') {
    const p = byPath[msg.path];
    if (p) { p.sizeKb = msg.sizeKb; p.commits = msg.commits; p.isDirty = msg.isDirty ?? null; p.ahead = msg.ahead ?? null; p.behind = msg.behind ?? null; p.abRef = msg.abRef ?? null; }
    const r = recents.find(x => x.path === msg.path);
    if (r) { r.sizeKb = msg.sizeKb; r.commits = msg.commits; r.isDirty = msg.isDirty ?? null; r.ahead = msg.ahead ?? null; r.behind = msg.behind ?? null; r.abRef = msg.abRef ?? null; }
    render();
  }
  if (msg && msg.command === 'syncStart') {
    const btn = document.querySelector('.sync-btn[data-path="' + msg.path + '"]');
    if (btn) { btn.classList.add('syncing'); btn.textContent = '…'; }
  }
  if (msg && msg.command === 'cloneDone') {
    const btn = document.getElementById('clone-submit-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'clonar'; }
    const bar = document.getElementById('clone-bar');
    if (bar) bar.style.display = 'none';
  }
  if (msg && msg.command === 'scanResult') {
    if (!scanResults[msg.path]) { scanResults[msg.path] = {}; }
    scanResults[msg.path][msg.runnerName] = { display: msg.display, status: msg.status, detail: msg.detail || [] };
    updateCardScanResults(msg.path);
  }
  if (msg && msg.command === 'scanDone') {
    const btn = document.getElementById('runner-btn');
    if (btn) { btn.textContent = 'scan ▾'; btn.disabled = false; }
  }
  if (msg && msg.command === 'favoritesUpdated') {
    msg.favorites.forEach(f => favSet.add(f));
    // remove unfavorited paths
    [...favSet].forEach(f => { if (!msg.favorites.includes(f)) favSet.delete(f); });
    render();
  }
});

// ── hangar tabs ──────────────────────────────────────────────
function renderHangarTabs() {
  const $tabs = document.getElementById('hangar-tabs');
  let html = '<div class="htab' + (!state.hangarFilter ? ' active' : '') + '" data-hangar="">all</div>';
  html += HANGARS.map((h, i) =>
    '<div class="htab' + (state.hangarFilter === h.name ? ' active' : '') + '" data-hangar="' + esc(h.name) + '" data-idx="' + i + '" data-path="' + esc(h.path) + '">' +
    esc(h.name) +
    '<span class="htab-ignore" data-path="' + esc(h.path) + '" title="Edit .hangarignore">⊘</span>' +
    (HANGARS.length > 1 ? '<span class="htab-remove" data-idx="' + i + '">×</span>' : '') +
    '</div>'
  ).join('');
  html += '<div class="htab htab-add" id="htab-add">+</div>';
  $tabs.innerHTML = html;

  $tabs.querySelectorAll('.htab-ignore').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ command: 'openHangarIgnore', hangarPath: el.getAttribute('data-path') });
    });
  });

  $tabs.querySelectorAll('.htab[data-hangar]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('htab-remove') || e.target.classList.contains('htab-ignore')) return;
      // save current group for the current hangar
      hangarStates[state.hangarFilter ?? ''] = state.activeGroup;
      state.hangarFilter = el.getAttribute('data-hangar') || null;
      // restore saved group for new hangar, validate it still exists
      const saved = hangarStates[state.hangarFilter ?? ''] ?? null;
      const scopedGroups = new Set((state.hangarFilter ? projects.filter(p => p.hangar === state.hangarFilter) : projects).map(p => p.group));
      state.activeGroup = saved && scopedGroups.has(saved) ? saved : null;
      saveState();
      renderHangarTabs();
      renderChips();
      render();
    });
  });
  $tabs.querySelectorAll('.htab-remove').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ command: 'removeHangar', index: parseInt(el.getAttribute('data-idx')) });
    });
  });
  document.getElementById('htab-add').addEventListener('click', () => {
    vscode.postMessage({ command: 'addHangar' });
  });
}

// ── actions ──────────────────────────────────────────────────
function openCard(ev, p)    {
  const isModified = ev.metaKey || ev.ctrlKey;
  const action = isModified ? CONFIG.clickAction : CONFIG.chipAction;
  vscode.postMessage({ command: 'openProject', path: p, newWindow: action === 'new-window' });
}
function openIntelliJ(p)   { vscode.postMessage({ command: 'openIntelliJ', path: p }); }
function openInTerminal(p) { vscode.postMessage({ command: 'openInTerminal', path: p }); }
function setBaseBranch(p)  { vscode.postMessage({ command: 'setBaseBranch', path: p }); }
function syncProject(p)    { vscode.postMessage({ command: 'syncProject', path: p }); }
function reveal(p)          { vscode.postMessage({ command: 'revealInFinder', path: p }); }
function openRemote(url)    { if (url) vscode.postMessage({ command: 'openRemote', url }); }
function refresh()        { vscode.postMessage({ command: 'refresh' }); }
function clearRecents()   { vscode.postMessage({ command: 'clearRecents' }); }
function toggleFavorite(p){ vscode.postMessage({ command: 'toggleFavorite', path: p }); }

function toggleSelectMode() {
  selectMode = !selectMode;
  selected.clear();
  document.body.classList.toggle('select-mode', selectMode);
  document.getElementById('select-toggle').classList.toggle('active', selectMode);
  document.getElementById('select-status').textContent = '';
  render();
}

function updateSelectStatus() {
  document.getElementById('select-status').textContent = selected.size ? selected.size + ' selected' : '';
}

function toggleRunnerMenu() {
  const menu = document.getElementById('runner-menu');
  if (!menu) { return; }
  const isOpen = menu.style.display !== 'none';
  if (isOpen) { menu.style.display = 'none'; return; }
  if (!RUNNERS.length) {
    menu.innerHTML = '<div class="runner-item muted">no runners in settings</div>';
  } else {
    menu.innerHTML = RUNNERS.map((r, i) =>
      '<div class="runner-item" data-idx="' + i + '">' + esc(r.name) +
      (r.stacks ? ' <span class="runner-stacks">' + esc(r.stacks.join(', ')) + '</span>' : '') +
      '</div>'
    ).join('');
    menu.querySelectorAll('.runner-item[data-idx]').forEach(el => {
      el.addEventListener('click', () => {
        const r = RUNNERS[parseInt(el.getAttribute('data-idx'))];
        if (r) { runScanner(r); }
        menu.style.display = 'none';
      });
    });
  }
  menu.style.display = 'block';
}

function runScanner(runner) {
  const btn = document.getElementById('runner-btn');
  if (btn) { btn.textContent = runner.name + '…'; btn.disabled = true; }
  const paths = selectMode
    ? [...selected]
    : projects.filter(p => p.hasGit).map(p => p.path);
  projects.forEach(p => { if (scanResults[p.path]) { delete scanResults[p.path][runner.name]; } });
  vscode.postMessage({ command: 'runScanner', runner, paths });
}

function showScanTooltip(el, title, lines) {
  clearTimeout(tooltipHideTimer);
  if (!lines || !lines.length) { return; }
  $tooltip.innerHTML = '<div class="tip-head">' + esc(title) + '</div>' +
    lines.map(l => '<div class="tip-scan-line">' + esc(l) + '</div>').join('');
  $tooltip.classList.add('visible');
  const rect = el.getBoundingClientRect();
  const tw = Math.min(420, window.innerWidth - 20);
  let left = rect.left;
  if (left + tw > window.innerWidth - 10) { left = window.innerWidth - tw - 10; }
  $tooltip.style.left = left + 'px';
  $tooltip.style.top = (rect.bottom + 6) + 'px';
  $tooltip.style.minWidth = '220px';
}

function updateCardScanResults(projPath) {
  $main.querySelectorAll('.scan-results').forEach(el => {
    if (el.getAttribute('data-path') !== projPath) { return; }
    const results = scanResults[projPath] || {};
    el.innerHTML = Object.entries(results).map(([name, r]) =>
      '<span class="scan-tag ' + r.status + '" data-runner="' + esc(name) + '">' + esc(name) + ': ' + esc(r.display) + '</span>'
    ).join('');
    el.querySelectorAll('.scan-tag[data-runner]').forEach(tag => {
      const rName = tag.getAttribute('data-runner');
      tag.addEventListener('mouseenter', () => {
        const r = (scanResults[projPath] || {})[rName];
        if (r && r.detail && r.detail.length) { showScanTooltip(tag, rName, r.detail); }
      });
      tag.addEventListener('mouseleave', hideTooltip);
    });
  });
}

function toggleCloneBar() {
  const bar = document.getElementById('clone-bar');
  const open = bar.style.display !== 'none';
  bar.style.display = open ? 'none' : 'flex';
  if (!open) document.getElementById('clone-url').focus();
}

function submitClone() {
  const url = document.getElementById('clone-url').value.trim();
  if (!url) return;
  const btn = document.getElementById('clone-submit-btn');
  btn.disabled = true;
  btn.textContent = 'clonando…';
  vscode.postMessage({ command: 'cloneRepo', url });
}

document.getElementById('clone-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitClone();
  if (e.key === 'Escape') toggleCloneBar();
});

// ── card ⌘+click → open in new window ────────────────────────
$main.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  const cardPath = card.getAttribute('data-path');
  if (selectMode && !e.target.closest('button, .commits-badge')) {
    if (selected.has(cardPath)) { selected.delete(cardPath); } else { selected.add(cardPath); }
    card.classList.toggle('selected', selected.has(cardPath));
    updateSelectStatus();
    return;
  }
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.target.closest('button, .remote-btn, .commits-badge')) return;
  const p = byPath[cardPath];
  if (!p) return;
  e.stopPropagation();
  if (p.stack === 'java' || p.stack === 'gradle') {
    openIntelliJ(cardPath);
  } else {
    vscode.postMessage({ command: 'openProject', path: cardPath, newWindow: true });
  }
});

// ── controls ─────────────────────────────────────────────────
$q.addEventListener('input', e => { state.query = e.target.value; saveState(); render(); });

// sort cycle
$sortCycle.addEventListener('click', () => {
  const i = (SORTS.indexOf(state.sort) + 1) % SORTS.length;
  state.sort = SORTS[i];
  $sortCycle.textContent = 'sort: ' + state.sort + ' ▸';
  saveState();
  render();
});

// theme cycle
let currentTheme = document.body.getAttribute('data-theme') || 'terminal';
$themeCycle.addEventListener('click', () => {
  const i = (THEMES.indexOf(currentTheme) + 1) % THEMES.length;
  currentTheme = THEMES[i];
  document.body.setAttribute('data-theme', currentTheme);
  $themeCycle.textContent = 'theme: ' + currentTheme + ' ▸';
  vscode.postMessage({ command: 'setTheme', theme: currentTheme });
});

$gitToggle.addEventListener('click', () => {
  state.gitOnly = !state.gitOnly;
  $gitToggle.classList.toggle('active', state.gitOnly);
  saveState();
  render();
});

const $attentionToggle = document.getElementById('attention-toggle');
$attentionToggle.addEventListener('click', () => {
  state.attentionOnly = !state.attentionOnly;
  $attentionToggle.classList.toggle('active', state.attentionOnly);
  saveState();
  render();
});


document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== $q) {
    e.preventDefault(); $q.focus();
  } else if (e.key === 'Escape') {
    $q.value = ''; state.query = ''; saveState(); render(); $q.blur();
  } else if (e.key === 'r' && document.activeElement !== $q && !e.metaKey && !e.ctrlKey) {
    refresh();
  }
});

// restore button labels from saved state
$sortCycle.textContent = 'sort: ' + state.sort + ' ▸';
$gitToggle.classList.toggle('active', state.gitOnly);
$attentionToggle.classList.toggle('active', state.attentionOnly);

renderHangarTabs();
renderChips();
render();
// restore persisted query and focus
$q.value = state.query;
setTimeout(() => $q.focus(), 120);
</script>
</body>
</html>`;
}

export function deactivate() { _activated = false; }
