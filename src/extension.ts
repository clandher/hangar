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
};

type Recents = Record<string, number>;
type Hangar = { name: string; path: string };

const RECENTS_KEY = 'recents';
const THEME_KEY = 'theme';
const HANGARS_KEY = 'hangars';
const FAVORITES_KEY = 'favorites';
const UI_STATE_KEY = 'uiState';
const DEFAULT_THEME = 'terminal';
const CONCURRENCY = 8;
const ENRICH_TIMEOUT = 4000;

export async function activate(context: vscode.ExtensionContext) {

  // migrate legacy single-dir setting
  const legacyDir = context.globalState.get<string>('projectsDir');
  if (legacyDir && !context.globalState.get<Hangar[]>(HANGARS_KEY)) {
    const name = path.basename(legacyDir);
    await context.globalState.update(HANGARS_KEY, [{ name, path: legacyDir }]);
    await context.globalState.update('projectsDir', undefined);
  }

  // no hangars: open dashboard anyway; it will show a warning

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
      vscode.window.showInformationMessage('Hangar storage cleared. Reload window to restart.');
    })
  );

  const showOnStartup = vscode.workspace.getConfiguration('hangar').get<boolean>('showOnStartup', true);
  if (showOnStartup) {
    openDashboard(context);
  }
}

async function openDashboard(context: vscode.ExtensionContext) {

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

  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'styles.css')
  );

  const render = () => {
    const hangars = context.globalState.get<Hangar[]>(HANGARS_KEY) ?? [];
    if (!hangars.length) {
      panel.webview.html = getNoHangarHtml(styleUri.toString());
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
    };
    const projects = hangars.flatMap(h => getProjects(h.path, recents, h.name));
    panel.webview.html = getHtml(projects, hangars, favorites, uiState, theme, styleUri.toString(), config, vscode.workspace.name);
    enrichProjects(projects, panel);
  };

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

  });
}

function trimRecents(recents: Recents): Recents {
  return Object.fromEntries(
    Object.entries(recents).sort((a, b) => b[1] - a[1]).slice(0, 20)
  );
}

function getProjects(projectsDir: string, recents: Recents, hangarName: string = ''): Project[] {

  let dirs: string[];
  try { dirs = fs.readdirSync(projectsDir); } catch { return []; }

  return dirs
    .map(name => {
      const fullPath = path.join(projectsDir, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { return null; }
      if (!stat.isDirectory() || name.startsWith('.')) return null;

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
        sizeKb: null,
        commits: null
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

function run(cmd: string, cwd: string): Promise<string> {
  return new Promise(resolve => {
    cp.exec(cmd, { cwd, timeout: ENRICH_TIMEOUT, maxBuffer: 1024 * 1024 },
      (err: Error | null, stdout: string) => resolve(err ? '' : stdout)
    );
  });
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

async function enrichProjects(projects: Project[], panel: vscode.WebviewPanel) {
  const queue = projects.slice();

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      if (!p) break;
      const [sizeKb, commits] = await Promise.all([
        getSizeKb(p.path),
        p.hasGit ? getCommits(p.path) : Promise.resolve(null)
      ]);
      panel.webview.postMessage({ command: 'enrich', path: p.path, sizeKb, commits });
    }
  }

  await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

type HangarConfig = { chipAction: string; clickAction: string; maxRecents: number; cardSize: string; showGitInfo: boolean };

function getNoHangarHtml(styleUri: string): string {
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
    Select the folder where you keep your projects.<br>Hangar will list everything inside it as a project.
  </div>
  <button onclick="addHangar()" style="margin-top:0.5rem;">+ select projects folder</button>
</div>
<script>
const vscode = acquireVsCodeApi();
function addHangar() { vscode.postMessage({ command: 'addHangar' }); }
</script>
</body>
</html>`;
}

function getHtml(projects: Project[], hangars: Hangar[], favorites: string[], uiState: object, theme: string, styleUri: string, config: HangarConfig, workspaceName?: string): string {

  const displayName = workspaceName ?? 'hangar';
  const groups = Array.from(new Set(projects.map(p => p.group))).sort();
  const recentProjects = projects
    .filter(p => p.lastOpened > 0)
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .slice(0, config.maxRecents);

  const HANGARS_JSON = JSON.stringify(hangars);
  const FAVORITES_JSON = JSON.stringify(favorites);
  const UI_STATE_JSON = JSON.stringify(uiState);

  // passed to webview JS as data
  const THEMES_JSON = JSON.stringify(['terminal', 'amber', 'synthwave', 'paper']);
  const SORTS_JSON  = JSON.stringify(['recent', 'modified', 'name', 'size', 'group']);

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
      <button onclick="refresh()">↺</button>
      <button id="theme-cycle" class="cycle-btn">theme: ${esc(theme)} ▸</button>
    </div>
  </div>
  <div class="hangar-tabs" id="hangar-tabs"></div>
  <div class="controls">
    <div class="search">
      <span class="sigil">$</span>
      <input id="q" type="text" placeholder="filter projects..." />
      <span class="count" id="count"></span>
    </div>
    <button id="sort-cycle" class="cycle-btn">sort: recent ▸</button>
    <button id="git-toggle">git only</button>
  </div>
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
  <div class="muted-time">v1.1.0</div>
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

// working copies with async enrichment fields
const projects = allProjects.map(p => Object.assign({}, p, { sizeKb: null, commits: null }));
const recents  = recentProjects.map(p => Object.assign({}, p, { sizeKb: null, commits: null }));

const byPath = {};
projects.forEach(p => { byPath[p.path] = p; });
recents.forEach(p => { byPath[p.path] = byPath[p.path] || p; });

const state = {
  query: '',
  sort: _saved.sort || 'recent',
  activeGroup: _saved.activeGroup || null,
  gitOnly: _saved.gitOnly || false,
  hangarFilter: _saved.hangarFilter || null
};
const hangarStates = _saved.hangarStates || {};

function saveState() {
  vscode.postMessage({ command: 'saveState', state: {
    sort: state.sort,
    activeGroup: state.activeGroup,
    gitOnly: state.gitOnly,
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

// ── card html ────────────────────────────────────────────────
function cardHtml(p, q) {
  const pa = esc(p.path);
  const branch  = p.branch ? '<span class="branch">' + esc(p.branch) + '</span>' : '';
  const stack   = p.stack  ? '<span class="stack">'  + esc(p.stack)  + '</span>' : '';
  // show only lastOpened (most meaningful); fall back to mtime labeled "mod"
  const timeVal = p.lastOpened
    ? '<span class="recent" title="last opened">↺ ' + fmtTime(p.lastOpened) + '</span>'
    : '<span class="muted-time" title="folder modified">' + fmtTime(p.mtime) + '</span>';
  const size    = p.sizeKb != null
    ? '<span class="size" title="disk size">' + fmtSize(p.sizeKb) + '</span>'
    : '<span class="size pending" title="disk size">…</span>';

  const remote = p.remoteUrl
    ? '<span class="remote-btn" onclick="event.stopPropagation(); openRemote(\\'' + esc(p.remoteUrl) + '\\')" title="' + esc(p.remoteUrl) + '">↗</span>'
    : '';

  const commitsBadge = p.hasGit && CONFIG.showGitInfo
    ? '<span class="commits-badge" data-path="' + pa + '">◈</span>'
    : '';

  const isFav = favSet.has(p.path);
  const starBtn = '<button class="star-btn' + (isFav ? ' starred' : '') + '" onclick="event.stopPropagation(); toggleFavorite(\\'' + pa + '\\')" title="' + (isFav ? 'Remove from favorites' : 'Add to favorites') + '">' + (isFav ? '★' : '☆') + '</button>';

  const isJava = p.stack === 'java' || p.stack === 'gradle';
  const vscBtn     = '<button onclick="event.stopPropagation(); openCard(event, \\'' + pa + '\\')">vsc</button>';
  const intellijBtn= '<button onclick="event.stopPropagation(); openIntelliJ(\\'' + pa + '\\')">intellij</button>';
  const openBtn    = isJava ? intellijBtn + vscBtn : '<button onclick="event.stopPropagation(); openCard(event, \\'' + pa + '\\')">open</button>';

  // last commit row
  let commitRow = '';
  if (p.hasGit && CONFIG.showGitInfo) {
    if (p.commits && p.commits.length) {
      const c = p.commits[0];
      commitRow = '<div class="commit-row">' +
        '<span class="commit-sha">' + esc(c.sha) + '</span>' +
        '<span class="commit-msg">' + esc(c.message) + '</span>' +
        '<span class="commit-author">' + esc(c.author) + '</span>' +
        '<span class="commit-when">' + fmtTime(c.ts) + '</span>' +
        '</div>';
    } else {
      commitRow = '<div class="commit-row pending">loading commit…</div>';
    }
  }

  return \`
    <div class="card" data-path="\${pa}">
      <div class="card-header">
        <div class="card-tags">
          <span class="tag">\${esc(p.group)}</span>
          \${stack}
        </div>
        <div class="actions">\${starBtn}\${openBtn}</div>
      </div>
      <div class="name">\${highlight(p.name, q)}</div>
      <div class="row">
        \${branch}
        \${commitsBadge}
        \${remote}
        \${timeVal}
        \${size}
      </div>
      \${commitRow}
    </div>
  \`;
}

// ── filtering + sorting ──────────────────────────────────────
function filtered() {
  const tokens = state.query.toLowerCase().trim().split(/\\s+/).filter(Boolean);
  return projects.filter(p => {
    if (state.gitOnly && !p.hasGit) return false;
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
    if (p) { p.sizeKb = msg.sizeKb; p.commits = msg.commits; }
    const r = recents.find(x => x.path === msg.path);
    if (r) { r.sizeKb = msg.sizeKb; r.commits = msg.commits; }
    render();
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
    '<div class="htab' + (state.hangarFilter === h.name ? ' active' : '') + '" data-hangar="' + esc(h.name) + '" data-idx="' + i + '">' +
    esc(h.name) +
    (HANGARS.length > 1 ? '<span class="htab-remove" data-idx="' + i + '">×</span>' : '') +
    '</div>'
  ).join('');
  html += '<div class="htab htab-add" id="htab-add">+</div>';
  $tabs.innerHTML = html;

  $tabs.querySelectorAll('.htab[data-hangar]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('htab-remove')) return;
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
function reveal(p)          { vscode.postMessage({ command: 'revealInFinder', path: p }); }
function openRemote(url)    { if (url) vscode.postMessage({ command: 'openRemote', url }); }
function refresh()        { vscode.postMessage({ command: 'refresh' }); }
function clearRecents()   { vscode.postMessage({ command: 'clearRecents' }); }
function toggleFavorite(p){ vscode.postMessage({ command: 'toggleFavorite', path: p }); }

// ── card ⌘+click → open in new window ────────────────────────
$main.addEventListener('click', e => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const card = e.target.closest('.card');
  if (!card) return;
  if (e.target.closest('button, .remote-btn, .commits-badge')) return;
  const path = card.getAttribute('data-path');
  const p = byPath[path];
  if (!p) return;
  e.stopPropagation();
  if (p.stack === 'java' || p.stack === 'gradle') {
    openIntelliJ(path);
  } else {
    vscode.postMessage({ command: 'openProject', path, newWindow: true });
  }
});

// ── controls ─────────────────────────────────────────────────
$q.addEventListener('input', e => { state.query = e.target.value; render(); });

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


document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== $q) {
    e.preventDefault(); $q.focus();
  } else if (e.key === 'Escape') {
    $q.value = ''; state.query = ''; render(); $q.blur();
  } else if (e.key === 'r' && document.activeElement !== $q && !e.metaKey && !e.ctrlKey) {
    refresh();
  }
});

// restore button labels from saved state
$sortCycle.textContent = 'sort: ' + state.sort + ' ▸';
$gitToggle.classList.toggle('active', state.gitOnly);

renderHangarTabs();
renderChips();
render();
// focus search after paint
setTimeout(() => $q.focus(), 120);
</script>
</body>
</html>`;
}

export function deactivate() {}
