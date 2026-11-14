'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const git = require('./lib/git');

const isDev = !app.isPackaged;

function readArg(name) {
  const prefix = name + '=';
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

// 调试用参数只在开发模式生效
const SHOT = isDev ? readArg('--shot') : '';
const SHOT_TAB = isDev ? readArg('--shot-tab') : '';
const SHOT_ALL = isDev ? readArg('--shot-all') : '';
const LOG_FILE = isDev ? readArg('--log') : '';
const DEV_REPOS = isDev ? process.argv.filter((a) => a.startsWith('--dev-repo=')).map((a) => a.slice('--dev-repo='.length)) : [];

let win = null;
let storePath = null;
let store = { repos: [], lastActive: '' };

function logLine(msg) {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* 忽略日志写入失败 */ }
}

function dataDir() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadStore() {
  storePath = path.join(dataDir(), 'repos.json');
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.repos)) {
      store = {
        repos: parsed.repos.filter((r) => r && typeof r.path === 'string'),
        lastActive: typeof parsed.lastActive === 'string' ? parsed.lastActive : '',
      };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('读取仓库列表失败：', e.message);
  }
}

function saveStore() {
  if (!storePath) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('保存仓库列表失败：', e.message);
  }
}

function normPath(p) {
  try {
    return path.resolve(p).replace(/[\\/]+$/, '');
  } catch {
    return p;
  }
}

async function realPath(p) {
  try {
    return await fsp.realpath(normPath(p));
  } catch {
    return normPath(p);
  }
}

function samePath(a, b) {
  return normPath(a).toLowerCase() === normPath(b).toLowerCase();
}

async function knownRepo(repo) {
  if (!repo || typeof repo !== 'string') throw new Error('缺少仓库路径');
  const hit = store.repos.find((r) => samePath(r.path, repo));
  if (!hit) throw new Error('该仓库不在列表中，请先添加');
  const real = await realPath(hit.path);
  const check = await git.isRepo(real);
  if (!check.ok) throw new Error('无法访问仓库：' + check.message);
  return check.root || real;
}

async function addRepos(paths, opts = {}) {
  const added = [];
  const failed = [];
  for (const raw of paths) {
    if (!raw || typeof raw !== 'string') continue;
    const p = normPath(raw);
    const check = await git.isRepo(p);
    if (!check.ok) {
      failed.push({ path: p, message: check.message });
      continue;
    }
    const root = normPath(check.root);
    if (store.repos.some((r) => samePath(r.path, root))) {
      failed.push({ path: p, message: '已在列表中' });
      continue;
    }
    const name = path.basename(root) || root;
    const entry = { path: root, name, addedAt: Date.now() };
    if (opts.persist === false) entry.ephemeral = true;
    store.repos.push(entry);
    added.push({ path: root, name });
  }
  if (added.length) {
    if (opts.persist !== false) {
      if (!store.lastActive) store.lastActive = added[0].path;
      saveStore();
    }
  }
  return { ok: true, data: { added, failed } };
}

async function repoSummary(r) {
  const item = { path: r.path, name: r.name || path.basename(r.path) || r.path, addedAt: r.addedAt || 0 };
  try {
    const real = await realPath(r.path);
    const check = await git.isRepo(real);
    if (!check.ok) throw new Error(check.message);
    const info = await git.quickInfo(check.root || real);
    return { ...item, ok: true, root: check.root || real, info: info.ok ? info.data : null };
  } catch (e) {
    return { ...item, ok: false, error: e.message || String(e) };
  }
}

const actions = {
  status: (repo) => git.status(repo),
  quickInfo: (repo) => git.quickInfo(repo),
  log: (repo, p) => git.log(repo, p),
  branches: (repo) => git.branches(repo),
  remotes: (repo) => git.remotes(repo),
  diffFile: (repo, p) => git.diffFile(repo, p.file, p),
  showCommit: (repo, p) => git.showCommit(repo, p.hash),
  commitDiff: (repo, p) => git.commitDiff(repo, p.hash, p.file),
  stage: (repo, p) => git.stage(repo, p.paths),
  stageAll: (repo) => git.stageAll(repo),
  unstage: (repo, p) => git.unstage(repo, p.paths, p.unborn),
  discardPaths: (repo, p) => git.discardPaths(repo, p.paths),
  discardUntracked: (repo, p) => git.discardUntracked(repo, p.paths),
  commit: (repo, p) => git.commit(repo, p.message, p),
  checkout: (repo, p) => git.checkout(repo, p.ref, p),
  createBranch: (repo, p) => git.createBranch(repo, p.name, p.from, p.checkout),
  renameBranch: (repo, p) => git.renameBranch(repo, p.from, p.to),
  deleteBranch: (repo, p) => git.deleteBranch(repo, p.name, p.force),
  merge: (repo, p) => git.merge(repo, p.ref),
  resolveConflict: (repo, p) => git.resolveConflict(repo, p.paths, p.side),
  reflog: (repo, p) => git.reflog(repo, p && p.limit),
  reset: (repo, p) => git.reset(repo, p.mode, p.target),
  branchFrom: (repo, p) => git.branchFrom(repo, p.name, p.hash),
  restoreFileFrom: (repo, p) => git.restoreFileFrom(repo, p.hash, p.file),
  stashPush: (repo, p) => git.stashPush(repo, p.message, p.includeUntracked),
  stashList: (repo) => git.stashList(repo),
  stashApply: (repo, p) => git.stashApply(repo, p.sel, p.pop),
  stashDrop: (repo, p) => git.stashDrop(repo, p.sel),
  fetchAll: (repo) => git.fetchAll(repo),
  pull: (repo) => git.pull(repo),
  push: (repo) => git.push(repo),
  pushSetUpstream: (repo) => git.pushSetUpstream(repo),
  configInfo: (repo) => git.configInfo(repo),
  setConfig: (repo, p) => git.setConfig(repo, p.key, p.value),
};

function registerIpc() {
  ipcMain.handle('repos:list', async () => {
    try {
      const repos = await Promise.all(store.repos.map(repoSummary));
      return { ok: true, data: { repos, lastActive: store.lastActive } };
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
  });

  ipcMain.handle('repos:refreshOne', async (_e, repo) => {
    try {
      const p = await knownRepo(repo);
      const info = await git.quickInfo(p);
      return { ok: true, data: info.ok ? info.data : null };
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
  });

  ipcMain.handle('repos:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择 Git 仓库文件夹',
      buttonLabel: '添加此仓库',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: true, data: { added: [], failed: [] } };
    return addRepos(res.filePaths);
  });

  ipcMain.handle('repos:remove', async (_e, repo) => {
    const idx = store.repos.findIndex((r) => samePath(r.path, repo));
    if (idx >= 0) {
      store.repos.splice(idx, 1);
      if (store.lastActive && samePath(store.lastActive, repo)) {
        store.lastActive = store.repos[0] ? store.repos[0].path : '';
      }
      saveStore();
      return { ok: true };
    }
    return { ok: false, message: '不在列表中' };
  });

  ipcMain.handle('repos:setActive', async (_e, repo) => {
    store.lastActive = typeof repo === 'string' ? repo : '';
    saveStore();
    return { ok: true };
  });

  ipcMain.handle('repos:reveal', async (_e, repo) => {
    try {
      const p = await knownRepo(repo);
      const err = await shell.openPath(p);
      return err ? { ok: false, message: err } : { ok: true };
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
  });

  ipcMain.handle('git:call', async (_e, { repo, action, payload }) => {
    const fn = actions[action];
    if (!fn) return { ok: false, message: '未知操作：' + action };
    let p;
    try {
      p = await knownRepo(repo);
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
    try {
      return await fn(p, payload || {});
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('app:info', async () => {
    const v = await git.run(os.tmpdir(), ['--version']);
    return {
      ok: true,
      data: {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        git: v.ok ? v.stdout.trim() : '未找到 git',
        userData: dataDir(),
        dev: isDev,
      },
    };
  });
}

function buildMenu() {
  const send = (channel) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel);
  };
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '添加仓库…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:add') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', accelerator: 'F5', click: () => send('menu:refresh') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 GitDesk', click: () => send('menu:about') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function captureAndQuit(outPath) {
  try {
    await new Promise((r) => setTimeout(r, 1800));
    if (SHOT_ALL) {
      fs.mkdirSync(SHOT_ALL, { recursive: true });
      for (const tab of ['changes', 'history', 'branches', 'rescue']) {
        await win.webContents.executeJavaScript(
          `(() => { const b = document.querySelector('[data-tab="${tab}"]'); if (b) b.click(); return true; })()`,
          true
        );
        await new Promise((r) => setTimeout(r, 1400));
        if (tab === 'changes') {
          await win.webContents.executeJavaScript(
            `(() => { const r = document.querySelector('[data-act="file-open"]'); if (r) r.click(); return true; })()`,
            true
          );
          await new Promise((r) => setTimeout(r, 900));
        }
        if (tab === 'history') {
          await win.webContents.executeJavaScript(
            `(() => { const rows = document.querySelectorAll('[data-act="commit-open"]'); if (rows.length > 3) rows[3].click(); return true; })()`,
            true
          );
          await new Promise((r) => setTimeout(r, 1200));
        }
        const img = await win.webContents.capturePage();
        const file = path.join(SHOT_ALL, `shot-${tab}.png`);
        fs.writeFileSync(file, img.toPNG());
        console.log('SHOT_SAVED ' + file);
      }
      app.quit();
      return;
    }
    if (SHOT_TAB) {
      await win.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('[data-tab="${SHOT_TAB}"]'); if (b) b.click(); return true; })()`,
        true
      );
      await new Promise((r) => setTimeout(r, 1500));
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(outPath, img.toPNG());
    console.log('SHOT_SAVED ' + outPath);
  } catch (e) {
    console.error('截图失败', e);
  }
  app.quit();
}

function createWindow() {
  const iconPath = path.join(__dirname, 'renderer', 'icon.png');
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 620,
    backgroundColor: '#0d1117',
    show: false,
    title: 'GitDesk',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (LOG_FILE) {
    win.webContents.on('console-message', (event) => {
      if (event && typeof event === 'object' && event.message !== undefined) {
        logLine(`[renderer:${event.level}] ${event.message} (${event.sourceId || ''}:${event.lineNumber || ''})`);
      }
    });
    win.webContents.on('preload-error', (_e, p, err) => logLine(`[preload-error] ${p}: ${err && err.stack}`));
    win.webContents.on('render-process-gone', (_e, d) => logLine(`[render-gone] ${JSON.stringify(d)}`));
    win.webContents.on('did-fail-load', (_e, code, desc) => logLine(`[fail-load] ${code} ${desc}`));
  }

  if (SHOT || SHOT_ALL) {
    win.webContents.on('did-finish-load', () => captureAndQuit(SHOT));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    loadStore();
    registerIpc();
    buildMenu();
    if (DEV_REPOS.length) {
      await addRepos(DEV_REPOS, { persist: false }).catch((e) => logLine('dev-repo 失败：' + e.message));
    }
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
