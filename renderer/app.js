'use strict';

/* ======================= 基础工具 ======================= */

const el = (id) => document.getElementById(id);
// 注意：contextBridge 注入的 window.api 是只读全局属性，不能再声明同名变量，直接引用全局 api 即可
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LANE_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#a371f7', '#f778ba', '#39c5cf', '#ff9e64', '#7ee787', '#db6d28'];

const S = {
  repos: [],
  active: null,
  status: null,
  tab: 'changes',
  selected: new Set(),
  filter: '',
  diff: null,
  commitMsg: '',
  amend: false,
  busy: false,
  netBusy: false,
  gen: 0,
  history: { commits: [], limit: 200, scope: 'all', search: '', sel: null, detail: null, detailFile: null, error: '', loading: false },
  branches: { local: [], remote: [], error: '' },
  rescue: { reflog: [], stash: [], error: '' },
};

function bumpGen() {
  S.gen += 1;
  return S.gen;
}

function stale(gen, repo) {
  return gen !== S.gen || repo !== S.active;
}

/* ======================= 提示 / 对话框 ======================= */

function toast(msg, kind = 'info', ms) {
  const root = el('toasts');
  const div = document.createElement('div');
  div.className = 'toast ' + kind;
  div.textContent = msg;
  div.title = '点击关闭';
  div.addEventListener('click', () => div.remove());
  root.appendChild(div);
  const ttl = ms || (kind === 'err' ? 12000 : kind === 'ok' ? 3200 : 5200);
  setTimeout(() => { if (div.parentElement) div.remove(); }, ttl);
  return div;
}

function modal({ title, bodyHtml = '', okText = '确定', cancelText = '取消', danger = false, requireType = '', input = null, extraCheck = null }) {
  return new Promise((resolve) => {
    const root = el('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2>${esc(title)}</h2>
        <div class="m-body">${bodyHtml}</div>
        ${input ? `<div class="field" style="margin-top:12px">
            <label>${esc(input.label || '')}</label>
            <input type="text" id="modalInput" placeholder="${esc(input.placeholder || '')}" value="${esc(input.value || '')}" />
          </div>` : ''}
        ${requireType ? `<div class="field" style="margin-top:12px">
            <label>请输入 <span class="type-hint">${esc(requireType)}</span> 以确认</label>
            <input type="text" id="modalType" placeholder="${esc(requireType)}" />
          </div>` : ''}
        <div class="m-foot">
          <button class="ghost" data-m="cancel">${esc(cancelText)}</button>
          <button class="${danger ? 'danger' : 'primary'}" data-m="ok">${esc(okText)}</button>
        </div>
      </div>`;
    root.appendChild(overlay);
    const okBtn = overlay.querySelector('[data-m="ok"]');
    const cancelBtn = overlay.querySelector('[data-m="cancel"]');
    const typeInput = overlay.querySelector('#modalType');
    const textInput = overlay.querySelector('#modalInput');

    const updateOk = () => {
      let ok = true;
      if (requireType) ok = (typeInput.value || '').trim() === requireType;
      if (extraCheck) ok = ok && !!extraCheck();
      okBtn.disabled = !ok;
    };
    if (requireType) { typeInput.addEventListener('input', updateOk); updateOk(); }

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && (e.target === textInput || e.target === typeInput || e.target === okBtn)) {
        e.stopPropagation();
        if (!okBtn.disabled) close({ input: textInput ? textInput.value : '', value: true });
      }
    };
    document.addEventListener('keydown', onKey, true);
    okBtn.addEventListener('click', () => {
      if (okBtn.disabled) return;
      close({ input: textInput ? textInput.value : '', value: true });
    });
    cancelBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    setTimeout(() => (typeInput || textInput || okBtn).focus(), 60);
  });
}

async function confirmDanger({ title, bodyHtml, okText = '执行', requireType = '' }) {
  return !!(await modal({ title, bodyHtml, okText, danger: true, requireType }));
}

async function errorDialog(title, message) {
  await modal({
    title,
    bodyHtml: `<p>Git 返回：</p><pre>${esc(message)}</pre>`,
    okText: '知道了',
    cancelText: '关闭',
  });
}

function menuModal({ title, subtitleHtml = '', items }) {
  return new Promise((resolve) => {
    const root = el('modal-root');
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="modal" role="dialog">
      <h2>${esc(title)}</h2>
      ${subtitleHtml ? `<div class="m-body">${subtitleHtml}</div>` : ''}
      <div class="menu-list">
        ${items.map((it, i) => `<button data-i="${i}" class="${it.cls || ''}">${esc(it.label)}</button>`).join('')}
      </div>
      <div class="m-foot"><button class="ghost" data-m="cancel">取消</button></div>
    </div>`;
    root.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { const idx = +b.dataset.i; overlay.remove(); resolve(items[idx].value ?? idx); return; }
      if (e.target.closest('[data-m="cancel"]') || e.target === overlay) { overlay.remove(); resolve(null); }
    });
  });
}

/* ======================= 数据操作 ======================= */

async function gitCall(action, payload) {
  if (!S.active) return { ok: false, message: '没有选中仓库' };
  try {
    return await api.git(S.active, action, payload);
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
}

function resetRepoState() {
  bumpGen();
  S.status = null;
  S.selected = new Set();
  S.filter = '';
  S.diff = null;
  S.commitMsg = '';
  S.amend = false;
  S.history = { commits: [], limit: 200, scope: 'all', search: '', sel: null, detail: null, detailFile: null, error: '', loading: false };
  S.branches = { local: [], remote: [], error: '' };
  S.rescue = { reflog: [], stash: [], error: '' };
}

/** 状态刷新后：丢掉已不存在的选中项与过期的 diff */
function pruneAfterStatus() {
  const st = S.status;
  if (!st) return;
  const has = new Set();
  st.staged.forEach((f) => has.add('staged:' + f.path));
  st.unstaged.forEach((f) => has.add('unstaged:' + f.path));
  st.untracked.forEach((f) => has.add('untracked:' + f.path));
  st.conflicted.forEach((f) => has.add('conflicted:' + f.path));
  for (const key of [...S.selected]) {
    if (!has.has(key)) S.selected.delete(key);
  }
  if (S.diff && !has.has(S.diff.kind + ':' + S.diff.path)) S.diff = null;
}

async function loadRepos() {
  let res;
  try {
    res = await api.repos.list();
  } catch (e) {
    toast('读取仓库列表失败：' + (e.message || e), 'err');
    renderAll();
    return;
  }
  if (!res || !res.ok) {
    toast('读取仓库列表失败：' + ((res && res.message) || '未知错误'), 'err');
    renderAll();
    return;
  }
  S.repos = res.data.repos;
  const last = res.data.lastActive;
  const pick = S.repos.find((r) => r.path === last && r.ok) || S.repos.find((r) => r.ok) || S.repos[0];
  if (pick) {
    if (!S.active || !S.repos.some((r) => r.path === S.active)) {
      S.active = pick.path;
      resetRepoState();
      await api.repos.setActive(pick.path).catch(() => {});
    }
  } else {
    S.active = null;
  }
  await refreshActive({ quiet: true });
  renderAll();
}

async function refreshActive({ quiet } = {}) {
  if (!S.active) return;
  const repo = S.active;
  const gen = S.gen;
  const res = await gitCall('status');
  if (stale(gen, repo)) return;
  if (res.ok) {
    S.status = res.data;
    pruneAfterStatus();
  } else {
    S.status = null;
    S.selected.clear();
    S.diff = null;
    if (!quiet) toast(res.message, 'err');
  }
  // 同步侧栏该仓库的概要
  const card = S.repos.find((r) => r.path === repo);
  if (card && S.status) {
    card.info = {
      branch: S.status.branch || '(无提交)',
      detached: S.status.detached,
      upstream: S.status.upstream,
      ahead: S.status.ahead,
      behind: S.status.behind,
      dirty: S.status.staged.length + S.status.unstaged.length + S.status.untracked.length + S.status.conflicted.length,
      staged: S.status.staged.length,
      unstaged: S.status.unstaged.length + S.status.untracked.length,
      conflicted: S.status.conflicted.length,
    };
  }
}

async function refreshCurrentView() {
  const repo = S.active;
  const gen = S.gen;
  await refreshActive();
  if (!repo || stale(gen, repo)) return;
  const tab = S.tab;
  if (tab === 'history') {
    await loadBranches({ silent: true });
    if (stale(gen, repo) || S.tab !== tab) return;
    if (!S.branches.error && S.history.scope.startsWith('ref:') &&
        !S.branches.local.some((b) => 'ref:' + b.name === S.history.scope)) {
      S.history.scope = 'all';
    }
    await loadHistory();
  } else if (tab === 'branches') {
    await loadBranches();
  } else if (tab === 'rescue') {
    await loadRescue();
  }
  if (stale(gen, repo) || S.tab !== tab) return;
  refreshUI();
  if (tab === 'history') renderHistory();
  if (tab === 'changes' && S.diff) await openFileDiff(S.diff.path, S.diff.kind);
}

async function refreshSidebarOnly() {
  const res = await api.repos.list();
  if (res && res.ok) { S.repos = res.data.repos; renderSidebar(); }
}

async function selectRepo(path) {
  if (S.active === path) return;
  S.active = path;
  resetRepoState();
  await api.repos.setActive(path).catch(() => {});
  await refreshActive({ quiet: true });
  renderAll();
  if (S.tab === 'history') {
    await loadBranches({ silent: true });
    await loadHistory();
    if (S.tab === 'history') renderHistory();
  }
  if (S.tab === 'branches') { await loadBranches(); if (S.tab === 'branches') renderBranches(); }
  if (S.tab === 'rescue') { await loadRescue(); if (S.tab === 'rescue') renderRescue(); }
}

async function afterMutation({ refresh = true, reloadHistory = false, reloadBranches = false, reloadRescue = false } = {}) {
  if (refresh) await refreshActive({ quiet: true });
  if (reloadHistory) await loadHistory({ silent: true });
  if (reloadBranches) await loadBranches({ silent: true });
  if (reloadRescue) await loadRescue({ silent: true });
  refreshUI();
}

/** 只更新必要区域，避免整页重建导致输入框失焦 */
function refreshUI() {
  renderSidebar();
  renderTopbar();
  renderTabs();
  if (!S.active) { renderView(); return; }
  if (S.tab === 'changes') {
    renderFileList();
    renderDiffPane();
    updateCommitButton();
  } else if (S.tab === 'history') {
    renderHistoryList();
  } else if (S.tab === 'branches') {
    renderBranches();
  } else if (S.tab === 'rescue') {
    renderRescue();
  }
}

function updateCommitButton() {
  const btn = document.querySelector('[data-act="do-commit"]');
  if (!btn) return;
  const st = S.status;
  const staged = st ? st.staged.length : 0;
  const can = staged > 0 || (S.amend && st && !st.unborn);
  btn.disabled = !can;
  btn.textContent = S.amend ? '修改并提交' : '提交';
  const hint = document.querySelector('.commit-hint');
  if (hint) {
    const total = st ? st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length : 0;
    hint.innerHTML = commitHintHtml(st, staged, total);
  }
  updateSelectionBar();
}

/* ======================= 渲染：侧栏 / 顶栏 / 标签 ======================= */

function dirtyBadge(info) {
  if (!info) return '';
  const parts = [];
  if (info.conflicted) parts.push(`<span class="chip red tiny">冲突 ${info.conflicted}</span>`);
  if (info.dirty) parts.push(`<span class="chip yellow tiny">${info.dirty} 处改动</span>`);
  else parts.push(`<span class="chip tiny">干净</span>`);
  return parts.join('');
}

function trackBadge(info) {
  if (!info) return '';
  let out = '';
  if (info.ahead) out += `<span class="chip tiny">↑${info.ahead}</span>`;
  if (info.behind) out += `<span class="chip tiny">↓${info.behind}</span>`;
  return out;
}

function renderSidebar() {
  const box = el('repoList');
  if (!S.repos.length) {
    box.innerHTML = `<div class="empty" style="padding:24px 12px">
      <h3>还没有仓库</h3>
      <p>点上面的「添加仓库」，选择一个本地 Git 仓库文件夹（也可以选多个）。</p>
    </div>`;
    return;
  }
  box.innerHTML = S.repos.map((r) => {
    const active = r.path === S.active;
    if (!r.ok) {
      return `<div class="repo-card broken ${active ? 'active' : ''}" data-act="repo-select" data-path="${esc(r.path)}" title="${esc(r.path)}">
        <div class="rc-top"><span class="rc-name">${esc(r.name)}</span></div>
        <div class="rc-path">${esc(r.path)}</div>
        <div class="rc-meta"><span class="chip red tiny">无法读取</span><span class="chip tiny">${esc(r.error || '')}</span></div>
      </div>`;
    }
    const info = r.info || {};
    return `<div class="repo-card ${active ? 'active' : ''}" data-act="repo-select" data-path="${esc(r.path)}" title="${esc(r.path)}">
      <div class="rc-top">
        <span class="rc-name">${esc(r.name)}</span>
        <button class="ghost sm rc-menu" data-act="repo-menu" data-path="${esc(r.path)}" title="更多">⋯</button>
      </div>
      <div class="rc-path">${esc(r.path)}</div>
      <div class="rc-meta">
        <span class="chip branch" title="${esc(info.upstream || info.branch || '')}">${esc(info.branch || '?')}</span>
        ${trackBadge(info)}
        ${dirtyBadge(info)}
      </div>
    </div>`;
  }).join('');
}

function renderTopbar() {
  const box = el('topbar');
  const repo = S.repos.find((r) => r.path === S.active);
  if (!repo) {
    box.innerHTML = `<div class="repo-head"><div class="rh-name">GitDesk</div><div class="rh-path">从左侧添加一个本地 Git 仓库开始</div></div>`;
    return;
  }
  const st = S.status;
  const info = repo.info || {};
  box.innerHTML = `
    <div class="repo-head">
      <div class="rh-name">
        <span class="truncate">${esc(repo.name)}</span>
        ${st && st.detached ? '<span class="chip yellow tiny">游离 HEAD</span>' : ''}
        ${st && st.unborn ? '<span class="chip yellow tiny">还没有提交</span>' : ''}
      </div>
      <div class="rh-path">${esc(repo.path)}</div>
    </div>
    <div class="repo-meta">
      <span class="chip branch" title="当前分支">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 3.5-4 3.5-8.5 4"/></svg>
        ${esc(st ? st.branch || '(无提交)' : info.branch || '?')}
      </span>
      ${st && st.upstream ? `<span class="chip tiny" title="上游">${esc(st.upstream)}</span>` : ''}
      ${trackBadge(st)}
      ${st && (st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length) ? `<span class="chip yellow tiny">未提交改动</span>` : ''}
    </div>
    <div class="top-actions">
      <button class="icon" data-act="reveal" title="在资源管理器中打开">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        打开文件夹
      </button>
      <button class="icon" data-act="refresh" title="刷新（F5）">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
        刷新
      </button>
    </div>`;
}

function renderTabs() {
  const box = el('tabs');
  const st = S.status;
  const changed = st ? st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length : 0;
  const tabs = [
    ['changes', '变更', changed ? String(changed) : ''],
    ['history', '历史', ''],
    ['branches', '分支', ''],
    ['rescue', '救急', ''],
  ];
  box.innerHTML = tabs.map(([k, label, count]) =>
    `<button data-tab="${k}" data-act="tab" class="${S.tab === k ? 'active' : ''}">${label}${count ? `<span class="count">${count}</span>` : ''}</button>`
  ).join('');
}

/* ======================= 渲染：变更 ======================= */

function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

function fileRow(kind, item, current) {
  const key = kind + ':' + item.path;
  const [dir, name] = splitPath(item.path);
  const rawCode = item.code || (kind === 'untracked' ? '?' : 'M');
  const code = /^[MADRCUT?]$/.test(rawCode) ? rawCode : (kind === 'conflicted' ? 'U' : 'M');
  const sel = S.selected.has(key);
  const isCur = current && S.diff && S.diff.kind === kind && S.diff.path === item.path;
  return `<div class="file-row ${sel ? 'sel' : ''} ${isCur ? 'cur' : ''}" data-act="file-open" data-path="${esc(item.path)}" data-kind="${kind}" title="${esc(item.path)}">
    <input class="cb" type="checkbox" data-act="file-toggle" data-path="${esc(item.path)}" data-kind="${kind}" ${sel ? 'checked' : ''} />
    <span class="fcode ${code === '?' ? 'q' : code}">${esc(code)}</span>
    <span class="fname">${dir ? `<span class="fdir">${esc(dir)}</span>` : ''}${esc(name)}</span>
  </div>`;
}

function commitHintHtml(st, stagedCount, total) {
  if (st && st.unborn && stagedCount) return '这是仓库的第一次提交，提交后会创建当前分支。';
  if (st && st.conflicted.length) return '还有未解决的冲突，解决后才能提交。';
  const more = total && !stagedCount ? '，先在左侧暂存要提交的文件' : '';
  return `已暂存 ${stagedCount} 个文件${more} · <span class="kbd">Ctrl</span>+<span class="kbd">Enter</span> 提交`;
}

function groupHead(title, count, kind, actionsHtml) {
  const keys = kind ? filesOfKind(kind).filter(matchesFilter).map((f) => kind + ':' + f.path) : [];
  const allSel = keys.length > 0 && keys.every((k) => S.selected.has(k));
  return `<div class="group-head">
    ${kind ? `<input class="cb" type="checkbox" data-act="group-toggle" data-kind="${kind}" ${allSel ? 'checked' : ''} />` : ''}
    <span>${title}</span><span class="gh-count">${count}</span>
    <div class="gh-actions">${actionsHtml || ''}</div>
  </div>`;
}

function filesOfKind(kind) {
  if (!S.status) return [];
  if (kind === 'staged') return S.status.staged;
  if (kind === 'unstaged') return S.status.unstaged;
  if (kind === 'untracked') return S.status.untracked;
  if (kind === 'conflicted') return S.status.conflicted;
  return [];
}

function matchesFilter(item) {
  if (!S.filter) return true;
  return item.path.toLowerCase().includes(S.filter.toLowerCase());
}

function renderFileList() {
  const box = el('fileList');
  if (!box) return;
  const st = S.status;
  if (!st) { box.innerHTML = `<div class="empty"><p>读取状态失败</p></div>`; return; }
  const staged = st.staged.filter(matchesFilter);
  const unstaged = st.unstaged.filter(matchesFilter);
  const untracked = st.untracked.filter(matchesFilter);
  const conflicted = st.conflicted.filter(matchesFilter);
  const total = staged.length + unstaged.length + untracked.length + conflicted.length;
  if (!total) {
    box.innerHTML = `<div class="empty" style="padding:40px 20px">
      <div class="big-icon">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <h3>工作区干净</h3>
      <p>${S.filter ? '没有匹配的文件' : '没有待提交的改动。'}</p>
    </div>`;
    updateSelectionBar();
    return;
  }
  let html = '';
  if (conflicted.length) {
    html += groupHead('冲突', conflicted.length, 'conflicted', `<button data-act="use-ours">全部用当前分支</button><button data-act="use-theirs">全部用对方版本</button>`);
    html += conflicted.map((f) => fileRow('conflicted', f, true)).join('');
  }
  if (staged.length) {
    html += groupHead('已暂存', staged.length, 'staged', `<button data-act="unstage-all">全部取消暂存</button>`);
    html += staged.map((f) => fileRow('staged', f, true)).join('');
  }
  if (unstaged.length) {
    html += groupHead('更改', unstaged.length, 'unstaged', `<button data-act="stage-group" data-kind="unstaged">全部暂存</button>`);
    html += unstaged.map((f) => fileRow('unstaged', f, true)).join('');
  }
  if (untracked.length) {
    html += groupHead('未跟踪', untracked.length, 'untracked', `<button data-act="stage-group" data-kind="untracked">全部暂存</button>`);
    html += untracked.map((f) => fileRow('untracked', f, true)).join('');
  }
  box.innerHTML = html;
  updateSelectionBar();
}

function updateSelectionBar() {
  const bar = el('selBar');
  if (!bar) return;
  const n = S.selected.size;
  bar.style.display = n ? 'flex' : 'none';
  const text = el('selCount');
  if (text) text.textContent = `已选 ${n} 项`;
}

function renderDiffPane() {
  const box = el('diffPane');
  if (!box) return;
  const d = S.diff;
  if (!d) {
    box.innerHTML = `<div class="empty">
      <div class="big-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M19 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h9l5 5v12a1 1 0 0 1-1 1z"/><path d="M9 13h6M9 17h4"/></svg>
      </div>
      <h3>选择一个文件查看差异</h3>
      <p>左侧点文件名即可查看改动内容；勾选框用于批量暂存 / 取消暂存 / 丢弃。</p>
    </div>`;
    return;
  }
  const kindLabel = { staged: '已暂存', unstaged: '未暂存', untracked: '新文件', conflicted: '冲突' }[d.kind] || '';
  const header = `<div class="diff-head">
    <span class="chip ${d.kind === 'staged' ? 'green' : d.kind === 'conflicted' ? 'red' : 'tiny'}">${esc(kindLabel)}</span>
    <span class="dh-path grow">${esc(d.path)}</span>
    ${d.truncated ? '<span class="chip yellow tiny">内容过大，已截断</span>' : ''}
    <button class="ghost sm" data-act="copy-path" data-path="${esc(d.path)}">复制路径</button>
  </div>`;

  if (d.loading) {
    box.innerHTML = header + `<div class="empty"><span class="spinner"></span><p>正在读取差异…</p></div>`;
    return;
  }
  if (d.error) {
    box.innerHTML = header + `<div class="empty"><h3>读取失败</h3><p>${esc(d.error)}</p></div>`;
    return;
  }

  let body = '';
  if (d.fileList) {
    body = `<div style="padding:14px 16px"><p class="muted" style="margin:0 0 8px">${esc(d.note || '')}</p>
      <div class="mono" style="font-size:12px;line-height:1.9;color:#8cbcf8">${d.fileList.map(esc).join('<br>')}</div></div>`;
  } else if (d.binary) {
    body = `<div class="empty"><h3>无法预览</h3><p>${esc(d.note || '二进制文件')}</p></div>`;
  } else if (!d.text || !d.text.trim()) {
    body = `<div class="empty"><h3>没有可显示的差异</h3><p>${esc(d.note || '该文件没有文本改动，可能是二进制文件，或改动已全部暂存。')}</p></div>`;
  } else {
    const mode = d.kind === 'untracked' || d.kind === 'conflicted' ? 'file' : 'diff';
    body = diffToHtml(d.text, mode, d.truncated);
  }
  box.innerHTML = header + `<div class="diff-body">${body}</div>`;
}

function diffToHtml(text, mode, truncated) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (mode === 'file' && lines.length && lines[lines.length - 1] === '') lines.pop();
  const MAXL = 6000;
  const out = [];
  let oldNo = 0;
  let newNo = mode === 'file' ? 1 : 0;
  let shown = 0;
  const row = (cls, oldN, newN, sig, content) =>
    `<div class="dline ${cls}"><span class="ln">${oldN}</span><span class="ln">${newN}</span><span class="sig">${sig}</span><span class="txt">${esc(content)}</span></div>`;

  for (const line of lines) {
    if (shown++ > MAXL) break;
    if (mode === 'diff' && line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      out.push(`<div class="dline hunk"><span class="ln"></span><span class="ln"></span><span class="sig"></span><span class="txt">${esc(line)}</span></div>`);
      continue;
    }
    if (mode === 'diff' && /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|old mode|new mode|Binary files|copy from|copy to)/.test(line)) {
      out.push(`<div class="dline meta"><span class="ln"></span><span class="ln"></span><span class="sig"></span><span class="txt">${esc(line)}</span></div>`);
      continue;
    }
    if (mode === 'file') {
      out.push(row('add', '', newNo++, '+', line));
      continue;
    }
    if (line.startsWith('+')) {
      out.push(row('add', '', newNo++, '+', line.slice(1)));
    } else if (line.startsWith('-')) {
      out.push(row('del', oldNo++, '', '-', line.slice(1)));
    } else if (line.startsWith(' ')) {
      out.push(row('ctx', oldNo++, newNo++, ' ', line.slice(1)));
    } else if (line.startsWith('\\')) {
      out.push(`<div class="dline meta"><span class="ln"></span><span class="ln"></span><span class="sig"></span><span class="txt">${esc(line)}</span></div>`);
    } else if (line === '') {
      continue;
    } else {
      out.push(`<div class="dline meta"><span class="ln"></span><span class="ln"></span><span class="sig"></span><span class="txt">${esc(line)}</span></div>`);
    }
  }
  let tail = '';
  if (truncated) tail = `<div class="dline meta"><span class="ln"></span><span class="ln"></span><span class="sig"></span><span class="txt">… 内容已截断（超过 400KB）</span></div>`;
  return `<pre class="diff">${out.join('')}${tail}</pre>`;
}

function renderChanges() {
  const st = S.status;
  const view = el('view');
  const stagedCount = st ? st.staged.length : 0;
  const dirty = st ? st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length : 0;
  const canCommit = stagedCount > 0 || (S.amend && !!st && !st.unborn);

  view.innerHTML = `
    <div class="split">
      <div class="col-left">
        <div class="list-toolbar">
          <input type="search" id="changesFilter" placeholder="筛选文件…" value="${esc(S.filter)}" />
          <button class="ghost icon" data-act="refresh" title="刷新（F5）">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
          </button>
        </div>
        <div class="file-list" id="fileList"></div>
        <div class="sel-bar" id="selBar" style="display:none">
          <span id="selCount" class="dim" style="font-size:11.5px"></span>
          <span class="grow"></span>
          <button class="sm" data-act="stage-sel">暂存</button>
          <button class="sm" data-act="unstage-sel">取消暂存</button>
          <button class="sm danger" data-act="discard-sel">丢弃</button>
          <button class="ghost sm" data-act="clear-sel">清空选择</button>
        </div>
        <div class="commit-box">
          <textarea id="commitMsg" placeholder="提交信息（Ctrl+Enter 提交）">${esc(S.commitMsg)}</textarea>
          <div class="commit-row">
            <label class="cbx"><input type="checkbox" id="amendChk" ${S.amend ? 'checked' : ''} /> 修改上次提交</label>
            <span class="grow"></span>
            <button class="primary" data-act="do-commit" ${canCommit ? '' : 'disabled'}>${S.amend ? '修改并提交' : '提交'}</button>
          </div>
          <div class="commit-hint">${commitHintHtml(st, stagedCount, dirty)}</div>
        </div>
      </div>
      <div class="col-right" id="diffPane"></div>
    </div>`;
  renderFileList();
  renderDiffPane();
}

/* ======================= 渲染：历史 ======================= */

function computeGraph(commits) {
  const lanes = [];
  const rows = [];
  let maxLanes = 1;
  for (const c of commits) {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) { lanes.push(null); lane = lanes.length - 1; }
    }
    const before = lanes.slice();
    lanes[lane] = null;
    const parentLanes = [];
    c.parents.forEach((p, k) => {
      let t = lanes.indexOf(p);
      if (t === -1) {
        if (k === 0) t = lane;
        else {
          t = lanes.indexOf(null);
          if (t === -1) { lanes.push(null); t = lanes.length - 1; }
        }
        lanes[t] = p;
      }
      parentLanes.push(t);
    });
    rows.push({ commit: c, lane, before, parentLanes });
    maxLanes = Math.max(maxLanes, lanes.length, before.length);
  }
  return { rows, maxLanes };
}

function graphSvg(row, maxLanes) {
  const laneW = 15;
  const pad = 7;
  const W = maxLanes * laneW + pad * 2;
  const H = 40;
  const x = (l) => pad + l * laneW;
  const y = H / 2;
  const parts = [];
  const line = (l, y1, y2) =>
    `<line x1="${x(l)}" y1="${y1}" x2="${x(l)}" y2="${y2}" stroke="${LANE_COLORS[l % LANE_COLORS.length]}" stroke-width="1.6" opacity="0.85"/>`;

  // 穿过本行的 lane：本行 lane 也要画，否则每行的连线会在圆点上方断开
  row.before.forEach((h, l) => {
    if (!h) return;
    if (l === row.lane) {
      if (row.parentLanes.length) parts.push(line(l, 0, H));
      else parts.push(line(l, 0, y)); // 根提交：只画到圆点
    } else {
      parts.push(line(l, 0, H));
    }
  });
  // 本提交到各父提交的连线
  row.parentLanes.forEach((t) => {
    const col = LANE_COLORS[t % LANE_COLORS.length];
    if (t === row.lane) {
      parts.push(`<line x1="${x(t)}" y1="${y}" x2="${x(t)}" y2="${H}" stroke="${col}" stroke-width="1.8"/>`);
    } else {
      parts.push(`<path d="M ${x(row.lane)} ${y} C ${x(row.lane)} ${y + 12}, ${x(t)} ${H - 14}, ${x(t)} ${H}" fill="none" stroke="${col}" stroke-width="1.6"/>`);
    }
  });
  const color = LANE_COLORS[row.lane % LANE_COLORS.length];
  const isHead = row.commit.refs && row.commit.refs.head;
  parts.push(`<circle cx="${x(row.lane)}" cy="${y}" r="4.6" fill="${isHead ? color : '#0d1117'}" stroke="${color}" stroke-width="2"/>`);
  return `<svg class="graph" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

function refChips(refs) {
  if (!refs) return '';
  const out = [];
  refs.branches.forEach((b) => out.push(`<span class="chip green tiny" title="分支 ${esc(b)}">${esc(b)}</span>`));
  refs.tags.forEach((t) => out.push(`<span class="chip yellow tiny" title="标签 ${esc(t)}">${esc(t)}</span>`));
  refs.remote.forEach((r) => out.push(`<span class="chip tiny" title="远程分支 ${esc(r)}">${esc(r)}</span>`));
  return out.join('');
}

function filteredCommits() {
  const q = S.history.search.trim().toLowerCase();
  if (!q) return S.history.commits;
  return S.history.commits.filter((c) =>
    c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.short.includes(q));
}

function renderHistoryList() {
  const box = el('historyList');
  if (!box) return;
  const list = filteredCommits();
  if (!list.length) {
    box.innerHTML = `<div class="empty"><h3>${S.history.search ? '没有匹配的提交' : '没有提交记录'}</h3>
      <p>${S.history.search ? '换个关键词试试。' : '这个仓库还没有提交，或者当前范围里没有提交。'}</p></div>`;
    return;
  }
  const searching = !!S.history.search.trim();
  const { rows, maxLanes } = computeGraph(list);
  box.innerHTML = rows.map((row) => {
    const c = row.commit;
    const sel = S.history.sel === c.hash;
    return `<div class="commit-row ${sel ? 'sel' : ''}" data-act="commit-open" data-hash="${esc(c.hash)}" title="${esc(c.subject)}">
      ${searching ? '' : graphSvg(row, maxLanes)}
      <div class="c-main">
        <div class="c-line1">
          <span class="subject">${esc(c.subject)}</span>
          <span class="refs">${refChips(c.refs)}</span>
        </div>
        <div class="c-line2">
          <span class="c-hash">${esc(c.short)}</span>
          <span class="truncate">${esc(c.author)}</span>
          <span class="cdate">${esc(c.rel)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderCommitDetail() {
  const box = el('commitDetail');
  if (!box) return;
  const d = S.history.detail;
  if (!d) {
    box.innerHTML = `<div class="empty"><h3>选择一次提交</h3><p>右侧会显示提交信息、改动文件与具体差异。</p></div>`;
    return;
  }
  if (!S.history.detailFile && d.files.length) S.history.detailFile = d.files[0].path;
  const files = d.files.map((f) => {
    const sel = S.history.detailFile === f.path;
    const code = /^[MADRCUTX]$/.test(f.code) ? f.code : 'M';
    return `<div class="commit-file ${sel ? 'sel' : ''}" data-act="commit-file" data-path="${esc(f.path)}">
      <span class="fcode ${code}">${esc(code)}</span>
      <span class="fname">${esc(f.path)}</span>
      ${f.from ? `<span class="dim" style="font-size:11px">← ${esc(f.from)}</span>` : ''}
    </div>`;
  }).join('');
  const isMerge = d.parents && d.parents.length > 1;
  box.innerHTML = `
    <div class="detail-meta">
      <h2>${esc(d.subject)}</h2>
      ${d.body ? `<div class="detail-body">${esc(d.body)}</div>` : ''}
      <div class="dm-row" style="margin-top:10px">
        <span class="chip tiny">${esc(d.author)}</span>
        <span class="mono dim">${esc(d.hash.slice(0, 10))}</span>
        <span class="dim">${esc(d.date)}</span>
        ${isMerge ? '<span class="chip purple tiny" title="合并提交：文件改动相对第一父提交">合并提交</span>' : ''}
        <span class="dim" style="margin-left:auto">${d.files.length} 个文件改动</span>
        <button class="ghost sm" data-act="copy-hash" data-hash="${esc(d.hash)}">复制 hash</button>
      </div>
    </div>
    <div class="commit-files">${files || '<div class="empty" style="padding:16px"><p>没有文件改动</p></div>'}</div>
    <div class="diff-body" id="commitDiff"></div>`;
  loadCommitDiff();
}

async function loadCommitDiff() {
  const box = el('commitDiff');
  if (!box) return;
  const d = S.history.detail;
  if (!d) { box.innerHTML = ''; return; }
  if (!S.history.detailFile) S.history.detailFile = d.files.length ? d.files[0].path : null;
  if (!S.history.detailFile) {
    box.innerHTML = '<div class="empty"><p>这次提交没有文件改动</p></div>';
    return;
  }
  const gen = S.gen;
  const repo = S.active;
  const file = S.history.detailFile;
  box.innerHTML = '<div style="padding:16px" class="dim">正在读取差异…</div>';
  const res = await gitCall('commitDiff', { hash: d.hash, file });
  if (!box.isConnected || stale(gen, repo) || S.history.detailFile !== file) return;
  if (!res.ok) { box.innerHTML = `<div style="padding:16px" class="muted">${esc(res.message)}</div>`; return; }
  box.innerHTML = diffToHtml(res.data.text, 'diff', res.data.truncated);
}

function renderHistory() {
  const view = el('view');
  const scopeOpts = [['all', '全部分支'], ['current', '当前分支']]
    .concat(S.branches.local.map((b) => ['ref:' + b.name, b.name]));
  view.innerHTML = `
    <div class="toolbar">
      <select id="histScope">
        ${scopeOpts.map(([v, l]) => `<option value="${esc(v)}" ${S.history.scope === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <input type="search" id="histSearch" placeholder="搜索信息 / 作者 / hash" value="${esc(S.history.search)}" />
      <button class="ghost icon" data-act="hist-reload" title="刷新">刷新</button>
      <span class="spacer"></span>
      <span class="dim" style="font-size:11.5px" id="histCount">${filteredCommits().length} / ${S.history.commits.length} 次提交</span>
      <button class="sm" data-act="hist-more" ${S.history.commits.length < S.history.limit ? 'disabled' : ''}>加载更多</button>
    </div>
    <div class="split">
      <div class="col-left hist-left"><div class="commit-list" id="historyList"></div></div>
      <div class="col-right" id="commitDetail"></div>
    </div>`;
  renderHistoryList();
  renderCommitDetail();
}

async function loadHistory({ silent } = {}) {
  if (!S.active) return;
  const repo = S.active;
  const gen = S.gen;
  const h = S.history;
  const request = Symbol();
  h.loading = request;
  const payload = { limit: h.limit };
  if (h.scope === 'all') payload.all = true;
  else if (h.scope === 'current') payload.ref = 'HEAD';
  else if (h.scope.startsWith('ref:')) payload.ref = h.scope.slice(4);
  const res = await gitCall('log', payload);
  if (stale(gen, repo) || h.loading !== request) return;
  h.loading = false;
  if (!res.ok) {
    h.error = res.message;
    if (!silent) toast('读取历史失败：' + res.message, 'err');
    if (S.tab === 'history') renderCommitDetail();
    return;
  }
  h.commits = res.data;
  if (h.sel && !h.commits.some((c) => c.hash === h.sel)) {
    h.sel = null;
    h.detail = null;
    h.detailFile = null;
  }
  const c = el('histCount');
  if (c) c.textContent = `${filteredCommits().length} / ${h.commits.length} 次提交`;
  renderHistoryList();
  if (S.tab === 'history') {
    if (!h.sel) renderCommitDetail();
    else if (!document.querySelector('#commitDetail .detail-meta')) renderCommitDetail();
  }
}

/* ======================= 渲染：分支 ======================= */

function trackText(track) {
  if (!track) return '';
  return track.replace(/^\[|\]$/g, '');
}

function renderBranches() {
  const view = el('view');
  const b = S.branches;
  const locals = b.local.map((br) => `<div class="branch-row ${br.current ? 'current' : ''}">
    <span class="b-dot"></span>
    <div class="b-main">
      <div class="b-name">${esc(br.name)} ${br.current ? '<span class="chip green tiny">当前</span>' : ''}</div>
      <div class="b-sub">${esc(br.subject || '')} · ${esc(br.rel || '')}${br.upstream ? ` · ${esc(br.upstream)} ${esc(trackText(br.track) || '')}` : ' · 无上游'}</div>
    </div>
    <div class="b-actions">
      ${br.current ? '' : `<button class="sm" data-act="switch-branch" data-name="${esc(br.name)}">切换</button>`}
      ${br.current ? '' : `<button class="sm" data-act="merge-branch" data-name="${esc(br.name)}" title="把该分支合并到当前分支">合并</button>`}
      ${br.current ? '' : `<button class="sm ghost danger" data-act="delete-branch" data-name="${esc(br.name)}" title="删除分支">删除</button>`}
      <button class="sm ghost" data-act="branch-menu" data-name="${esc(br.name)}" title="更多">⋯</button>
    </div>
  </div>`).join('');

  const remotes = b.remote.map((r) => `<div class="branch-row">
    <span class="b-dot" style="background:#31405a"></span>
    <div class="b-main">
      <div class="b-name">${esc(r.name)}</div>
      <div class="b-sub">${esc(r.subject || '')} · ${esc(r.rel || '')}</div>
    </div>
    <div class="b-actions">
      <button class="sm" data-act="checkout-remote" data-name="${esc(r.name)}">检出</button>
    </div>
  </div>`).join('');

  view.innerHTML = `
    <div class="toolbar">
      <button class="primary icon" data-act="new-branch">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        新建分支
      </button>
      <button data-act="fetch">获取远程</button>
      <button data-act="pull">拉取</button>
      <button data-act="push">推送</button>
      <span class="spacer"></span>
      ${S.status && S.status.upstream ? '' : '<button class="sm" data-act="publish">发布到远程</button>'}
      <button class="ghost icon" data-act="branches-reload" title="刷新">刷新</button>
    </div>
    <div class="branch-layout">
      <div class="branch-panel">
        <div class="bp-head">本地分支 <span class="count">${b.local.length}</span></div>
        ${locals || '<div class="empty" style="padding:20px"><p>还没有本地分支</p></div>'}
      </div>
      <div class="branch-panel">
        <div class="bp-head">远程分支 <span class="count">${b.remote.length}</span></div>
        ${remotes || '<div class="empty" style="padding:20px"><p>没有远程分支（未配置远程或还没获取）</p></div>'}
      </div>
    </div>`;
}

async function loadBranches({ silent } = {}) {
  if (!S.active) return;
  const repo = S.active;
  const gen = S.gen;
  const res = await gitCall('branches');
  if (stale(gen, repo)) return;
  if (res.ok) {
    S.branches = { local: res.data.local, remote: res.data.remote, error: '' };
  } else {
    S.branches.error = res.message;
    if (!silent) toast('读取分支失败：' + res.message, 'err');
  }
}

/* ======================= 渲染：救急 ======================= */

function renderRescue() {
  const view = el('view');
  const r = S.rescue;
  const st = S.status;
  const conflicts = st ? st.conflicted : [];
  const reflogRows = r.reflog.map((x) => `<tr>
      <td class="mono">${esc(x.hash)}</td>
      <td>${esc(x.action)}</td>
      <td class="dim">${esc(x.rel)}</td>
      <td class="ops">
        <button class="sm ghost" data-act="reflog-branch" data-hash="${esc(x.hash)}" title="根据这次记录新建一个分支">建分支</button>
        <button class="sm ghost" data-act="reflog-reset" data-hash="${esc(x.hash)}" title="把当前分支重置到这次记录">重置</button>
      </td>
    </tr>`).join('');

  const stashRows = r.stash.map((x) => `<div class="row" style="padding:5px 2px;border-bottom:1px solid #1a2028">
      <span class="mono dim" style="font-size:11px">${esc(x.sel)}</span>
      <span class="grow truncate">${esc(x.subject)}</span>
      <button class="sm" data-act="stash-apply" data-sel="${esc(x.sel)}">应用</button>
      <button class="sm ghost" data-act="stash-pop" data-sel="${esc(x.sel)}">应用并删除</button>
      <button class="sm ghost danger" data-act="stash-drop" data-sel="${esc(x.sel)}">删除</button>
    </div>`).join('');

  view.innerHTML = `<div class="rescue">
    <div class="rescue-grid">
      <div class="card">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>
          撤销上次提交（保留改动）
        </h3>
        <p>把 HEAD 退回到上一次提交，所有改动都留在工作区，可以修改后重新提交。</p>
        <div class="card-actions">
          <button data-act="undo-commit" ${st && st.unborn ? 'disabled' : ''}>执行 git reset --soft HEAD~1</button>
        </div>
      </div>

      <div class="card">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
          暂存当前改动（stash）
        </h3>
        <p>把未提交的改动收起来，工作区变干净；需要时再应用回来。</p>
        <div class="card-actions">
          <button data-act="stash-save">保存当前改动</button>
          <button class="ghost sm" data-act="rescue-reload">刷新</button>
        </div>
        <div style="margin-top:9px">${stashRows || '<div class="dim" style="font-size:11.5px">没有 stash 记录</div>'}</div>
      </div>

      <div class="card danger-zone">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
          丢弃所有未暂存改动
        </h3>
        <p>未暂存的修改会被永久丢弃，<span class="danger-note">无法恢复</span>。已暂存的内容不受影响。</p>
        <div class="card-actions">
          <button class="danger" data-act="discard-all">丢弃并还原</button>
        </div>
      </div>

      <div class="card danger-zone">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v6h6"/><path d="M20 20v-6h-6"/><path d="M20 8a8 8 0 0 0-14.9-3M4 16a8 8 0 0 0 14.9 3"/></svg>
          清理未跟踪文件
        </h3>
        <p>删除所有新加的、还没有被 Git 跟踪的文件和文件夹，<span class="danger-note">无法恢复</span>。</p>
        <div class="card-actions">
          <button class="danger" data-act="clean-untracked">清理</button>
        </div>
      </div>

      ${conflicts.length ? `<div class="card wide">
        <h3>冲突处理（${conflicts.length} 个文件）</h3>
        <p>选择一个版本会把它标记为已解决（git checkout --ours/--theirs 然后 git add）。注意：rebase 过程中 ours 与 theirs 含义会相反。</p>
        ${conflicts.map((f) => `<div class="row" style="padding:4px 0;border-bottom:1px solid #1a2028">
          <span class="mono" style="font-size:11.5px">${esc(f.path)}</span>
          <span class="grow"></span>
          <button class="sm" data-act="conflict-ours" data-path="${esc(f.path)}">用当前分支版本</button>
          <button class="sm" data-act="conflict-theirs" data-path="${esc(f.path)}">用对方版本</button>
        </div>`).join('')}
      </div>` : ''}

      <div class="card wide">
        <h3>重新定位 HEAD（reflog）</h3>
        <p>reflog 记录了 HEAD 的每次移动。可以在这里把当前分支重置到某次记录，或根据它新建分支找回误删的提交。</p>
        <div class="reflog-wrap">
          <table class="reflog-table">
            <tbody>${reflogRows || '<tr><td class="dim" style="padding:12px">没有记录</td></tr>'}</tbody>
          </table>
        </div>
        <div class="card-actions" style="margin-top:10px">
          <button data-act="reset-to-commit">按 hash 重置…</button>
          <button class="ghost sm" data-act="rescue-reload">刷新</button>
        </div>
      </div>

      <div class="card wide">
        <h3>从某次提交恢复单个文件</h3>
        <p>把某个提交里的文件内容取回到工作区（不会改动提交历史，恢复后需要自己提交）。</p>
        <div class="inline-fields">
          <div class="field"><label>提交 hash</label><input type="text" id="restoreHash" placeholder="例如 3f2a9c1" /></div>
          <div class="field"><label>文件路径（仓库内相对路径）</label><input type="text" id="restorePath" placeholder="例如 src/app.js" /></div>
        </div>
        <div class="card-actions">
          <button data-act="restore-file">恢复文件</button>
        </div>
      </div>
    </div>
  </div>`;
}

async function loadRescue({ silent } = {}) {
  if (!S.active) return;
  const repo = S.active;
  const gen = S.gen;
  const [rl, sl] = await Promise.all([gitCall('reflog', { limit: 60 }), gitCall('stashList')]);
  if (stale(gen, repo)) return;
  S.rescue.reflog = rl.ok ? rl.data : [];
  S.rescue.stash = sl.ok ? sl.data : [];
  if (!rl.ok && !silent) toast('读取 reflog 失败：' + rl.message, 'err');
}

/* ======================= 渲染总入口 ======================= */

function renderView() {
  if (!S.active || !S.repos.some((r) => r.path === S.active)) {
    el('view').innerHTML = `<div class="empty">
      <div class="big-icon">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="8" r="3"></circle>
          <path d="M6 9v6"></path><path d="M18 11c0 4-4 4-9 4"></path>
        </svg>
      </div>
      <h3>欢迎使用 GitDesk</h3>
      <p>添加一个本地 Git 仓库后，就能在这里查看改动、提交、浏览历史、管理分支，以及在出错时救急。<br>仓库列表保存在本机，随时可以增删。</p>
      <button class="primary" data-act="add-repo" style="margin-top:6px">添加仓库</button>
    </div>`;
    return;
  }
  if (S.tab === 'changes') return renderChanges();
  if (S.tab === 'history') return renderHistory();
  if (S.tab === 'branches') return renderBranches();
  if (S.tab === 'rescue') return renderRescue();
}

function renderAll() {
  renderSidebar();
  renderTopbar();
  renderTabs();
  renderView();
}

/* ======================= 动作 ======================= */

async function doAddRepo() {
  const res = await api.repos.pick();
  if (!res || !res.ok) { toast('添加失败', 'err'); return; }
  const { added, failed } = res.data;
  if (added.length) {
    toast(`已添加 ${added.length} 个仓库`, 'ok');
    await loadRepos();
    if (added.length === 1) await selectRepo(added[0].path);
  }
  if (failed.length) {
    const lines = failed.map((f) => `${f.path}\n  ${f.message}`).join('\n');
    await errorDialog('有 ' + failed.length + ' 个文件夹未能添加', lines);
  }
}

async function repoMenu(path) {
  const repo = S.repos.find((r) => r.path === path);
  const choice = await menuModal({
    title: repo ? repo.name : path,
    subtitleHtml: `<p class="mono" style="font-size:11.5px;color:#8b949e;word-break:break-all">${esc(path)}</p>`,
    items: [
      { label: '在资源管理器中打开', value: 'reveal' },
      { label: '从列表移除（不会删除文件）', value: 'remove', cls: 'danger' },
    ],
  });
  if (choice === 'reveal') { api.repos.reveal(path); return; }
  if (choice === 'remove') {
    const ok = await confirmDanger({
      title: '从列表移除？',
      bodyHtml: `<p>只会把它从 GitDesk 的仓库列表里移除，<b>不会删除任何文件</b>，也不会影响仓库本身。</p><p class="mono dim" style="font-size:11.5px">${esc(path)}</p>`,
      okText: '移除',
    });
    if (!ok) return;
    const r = await api.repos.remove(path);
    if (!r.ok) { toast('移除失败：' + r.message, 'err'); return; }
    if (S.active === path) { S.active = null; resetRepoState(); }
    toast('已从列表移除', 'ok');
    await loadRepos();
  }
}

async function handleCommit() {
  if (S.busy) return;
  const msgEl = el('commitMsg');
  const msg = (msgEl ? msgEl.value : S.commitMsg).trim();
  const amend = el('amendChk') ? el('amendChk').checked : S.amend;
  S.commitMsg = msgEl ? msgEl.value : S.commitMsg;
  S.amend = amend;
  if (!msg) { toast('请填写提交信息', 'warn'); (msgEl || {}).focus?.(); return; }
  if (amend) {
    const ok = await confirmDanger({
      title: '修改上次提交？',
      bodyHtml: `<p>这会用当前暂存的改动重写最近一次提交（历史会变）。如果该提交已经推送到远程，其他人会受影响。</p>`,
      okText: '修改提交',
    });
    if (!ok) return;
  }
  S.busy = true;
  const res = await gitCall('commit', { message: msg, amend });
  S.busy = false;
  if (!res.ok) {
    toast('提交失败：' + (res.hint || res.message), 'err');
    return;
  }
  S.commitMsg = '';
  S.amend = false;
  const m = (res.output || '').match(/\[([^\]]+)\s+([0-9a-f]{6,})\]/);
  toast(m ? `已提交 ${m[2]}（${m[1].trim()}）` : '提交成功', 'ok');
  await afterMutation({ reloadHistory: true });
}

async function selectedPaths(kinds) {
  const out = [];
  for (const key of S.selected) {
    const [kind, ...rest] = key.split(':');
    const p = rest.join(':');
    if (!kinds || kinds.includes(kind)) out.push({ kind, path: p });
  }
  return out;
}

async function stageSelected() {
  const items = (await selectedPaths(['unstaged', 'untracked']));
  const staged = (await selectedPaths(['staged'])).length;
  if (!items.length) {
    toast(staged ? '选中的文件已在暂存区' : '请先勾选要暂存的文件', 'warn');
    return;
  }
  const res = await gitCall('stage', { paths: items.map((i) => i.path) });
  if (!res.ok) { toast('暂存失败：' + res.message, 'err'); return; }
  S.selected.clear();
  await afterMutation();
}

async function unstageSelected() {
  const items = await selectedPaths(['staged']);
  if (!items.length) { toast('请先勾选已暂存的文件', 'warn'); return; }
  const res = await gitCall('unstage', { paths: items.map((i) => i.path), unborn: !!(S.status && S.status.unborn) });
  if (!res.ok) { toast('取消暂存失败：' + res.message, 'err'); return; }
  S.selected.clear();
  await afterMutation();
}

async function discardSelected() {
  const items = await selectedPaths(['unstaged', 'untracked']);
  const staged = await selectedPaths(['staged']);
  if (!items.length) {
    toast(staged.length ? '已暂存的文件请先取消暂存，再丢弃' : '请先勾选要丢弃的文件', 'warn');
    return;
  }
  const list = items.map((i) => i.path);
  const ok = await confirmDanger({
    title: '丢弃这些改动？',
    bodyHtml: `<p>以下文件的未暂存修改将永久丢失，且无法恢复：</p><pre>${esc(list.join('\n'))}</pre>`,
    okText: '丢弃',
    requireType: '丢弃',
  });
  if (!ok) return;
  const unstagedPaths = items.filter((i) => i.kind === 'unstaged').map((i) => i.path);
  const untrackedPaths = items.filter((i) => i.kind === 'untracked').map((i) => i.path);
  let err = '';
  if (unstagedPaths.length) {
    const r = await gitCall('discardPaths', { paths: unstagedPaths });
    if (!r.ok) err = r.message;
  }
  if (!err && untrackedPaths.length) {
    const r = await gitCall('discardUntracked', { paths: untrackedPaths });
    if (!r.ok) err = r.message;
  }
  if (err) { toast('丢弃失败：' + err, 'err'); return; }
  S.selected.clear();
  S.diff = null;
  toast('已丢弃所选改动', 'ok');
  await afterMutation();
}

async function openFileDiff(path, kind) {
  const repo = S.active;
  const gen = S.gen;
  const request = { path, kind, text: '', loading: true };
  S.diff = request;
  renderDiffPane();
  const res = await gitCall('diffFile', {
    file: path,
    staged: kind === 'staged',
    untracked: kind === 'untracked',
    conflict: kind === 'conflicted',
  });
  if (stale(gen, repo) || S.diff !== request) return;
  if (!res.ok) {
    S.diff = { path, kind, error: res.message };
    renderDiffPane();
    return;
  }
  S.diff = {
    path,
    kind,
    text: res.data.text || '',
    note: res.data.note,
    fileList: res.data.fileList,
    binary: res.data.binary,
    truncated: res.data.truncated,
  };
  renderDiffPane();
}

async function openCommit(hash) {
  S.history.sel = hash;
  S.history.detail = null;
  S.history.detailFile = null;
  renderHistoryList();
  const box = el('commitDetail');
  if (box) box.innerHTML = '<div style="padding:18px" class="dim">读取提交信息…</div>';
  const repo = S.active;
  const gen = S.gen;
  const res = await gitCall('showCommit', { hash });
  if (stale(gen, repo) || S.history.sel !== hash) return;
  if (!res.ok) {
    if (box && box.isConnected) {
      box.innerHTML = `<div class="empty"><h3>读取提交失败</h3><p>${esc(res.message)}</p></div>`;
    }
    return;
  }
  S.history.detail = res.data;
  renderCommitDetail();
}

async function ensureBranches() {
  if (!S.branches.local.length) await loadBranches({ silent: true });
}

/* ======================= 事件 ======================= */

function onClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;

  if (act === 'file-toggle') {
    e.stopPropagation();
    const key = t.dataset.kind + ':' + t.dataset.path;
    if (S.selected.has(key)) S.selected.delete(key); else S.selected.add(key);
    renderFileList();
    return;
  }
  if (act === 'group-toggle') {
    e.stopPropagation();
    const kind = t.dataset.kind;
    const keys = filesOfKind(kind).filter(matchesFilter).map((f) => kind + ':' + f.path);
    const allSel = keys.length && keys.every((k) => S.selected.has(k));
    if (allSel) keys.forEach((k) => S.selected.delete(k));
    else keys.forEach((k) => S.selected.add(k));
    renderFileList();
    return;
  }

  if (act === 'repo-select') { selectRepo(t.dataset.path); return; }
  if (act === 'repo-menu') {
    e.stopPropagation();
    repoMenu(t.dataset.path);
    return;
  }
  if (act === 'add-repo') { doAddRepo(); return; }
  if (act === 'refresh') { refreshCurrentView(); return; }
  if (act === 'refresh-all') { refreshAll(); return; }
  if (act === 'reveal') { api.repos.reveal(S.active); return; }
  if (act === 'tab') {
    const tab = t.dataset.tab;
    if (S.tab === tab) return;
    S.tab = tab;
    renderTabs();
    renderView();
    if (tab === 'history') {
      (async () => {
        await loadBranches({ silent: true });
        await loadHistory();
        if (S.tab === 'history') renderHistory();
      })();
    }
    if (tab === 'branches') loadBranches().then(() => { if (S.tab === 'branches') renderBranches(); });
    if (tab === 'rescue') loadRescue().then(() => { if (S.tab === 'rescue') renderRescue(); });
    return;
  }

  if (act === 'file-open') {
    openFileDiff(t.dataset.path, t.dataset.kind);
    return;
  }
  if (act === 'stage-sel') { stageSelected(); return; }
  if (act === 'unstage-sel') { unstageSelected(); return; }
  if (act === 'discard-sel') { discardSelected(); return; }
  if (act === 'clear-sel') { S.selected.clear(); renderFileList(); return; }
  if (act === 'stage-group') {
    const kind = t.dataset.kind;
    const paths = filesOfKind(kind).filter(matchesFilter).map((f) => f.path);
    if (!paths.length) return;
    gitCall('stage', { paths }).then(async (r) => {
      if (!r.ok) { toast('暂存失败：' + r.message, 'err'); return; }
      await afterMutation();
    });
    return;
  }
  if (act === 'stage-all') {
    gitCall('stageAll').then(async (r) => {
      if (!r.ok) { toast('暂存失败：' + r.message, 'err'); return; }
      S.selected.clear();
      await afterMutation();
      toast('已暂存全部改动', 'ok');
    });
    return;
  }
  if (act === 'unstage-all') { unstageAll(); return; }
  if (act === 'do-commit') { handleCommit(); return; }
  if (act === 'copy-path') { copyText(t.dataset.path); return; }
  if (act === 'copy-hash') { copyText(t.dataset.hash); return; }
  if (act === 'use-ours' || act === 'use-theirs') {
    const side = act === 'use-ours' ? 'ours' : 'theirs';
    const paths = (S.status && S.status.conflicted || []).map((f) => f.path);
    if (!paths.length) return;
    confirmDanger({
      title: '全部采用' + (side === 'ours' ? '当前分支' : '对方') + '版本？',
      bodyHtml: `<p>冲突文件将整体替换为${side === 'ours' ? '当前分支' : '对方分支'}的版本，然后标记为已解决。</p>`,
      okText: '采用',
    }).then(async (ok) => {
      if (!ok) return;
      const r = await gitCall('resolveConflict', { paths, side });
      if (!r.ok) { toast('失败：' + r.message, 'err'); return; }
      toast('已解决冲突', 'ok');
      await afterMutation();
    });
    return;
  }

  if (act === 'hist-reload') { loadHistory().then(() => renderHistoryList()); return; }
  if (act === 'hist-more') {
    if (S.history.loading || S.history.commits.length < S.history.limit) return;
    S.history.limit += 200;
    loadHistory().then(() => { if (S.tab === 'history') renderHistory(); });
    return;
  }
  if (act === 'commit-open') { openCommit(t.dataset.hash); return; }
  if (act === 'commit-file') {
    S.history.detailFile = t.dataset.path;
    renderCommitDetail();
    return;
  }

  if (act === 'new-branch') { newBranchFlow(); return; }
  if (act === 'switch-branch') { switchBranch(t.dataset.name); return; }
  if (act === 'merge-branch') { mergeBranch(t.dataset.name); return; }
  if (act === 'delete-branch') { deleteBranchFlow(t.dataset.name); return; }
  if (act === 'branch-menu') { branchMenu(t.dataset.name); return; }
  if (act === 'checkout-remote') { checkoutRemote(t.dataset.name); return; }
  if (act === 'fetch') { runNet('fetchAll', '获取远程更新'); return; }
  if (act === 'pull') { runNet('pull', '拉取'); return; }
  if (act === 'push') { runNet('push', '推送'); return; }
  if (act === 'publish') { runNet('pushSetUpstream', '发布分支到远程'); return; }
  if (act === 'branches-reload') { loadBranches().then(() => renderBranches()); return; }

  if (act === 'undo-commit') { undoCommit(); return; }
  if (act === 'discard-all') { discardAll(); return; }
  if (act === 'clean-untracked') { cleanUntracked(); return; }
  if (act === 'stash-save') { stashSave(); return; }
  if (act === 'stash-apply' || act === 'stash-pop') { stashApply(t.dataset.sel, act === 'stash-pop'); return; }
  if (act === 'stash-drop') { stashDrop(t.dataset.sel); return; }
  if (act === 'reflog-branch') { reflogBranch(t.dataset.hash); return; }
  if (act === 'reflog-reset') { resetFlow(t.dataset.hash); return; }
  if (act === 'reset-to-commit') { resetFlow(''); return; }
  if (act === 'restore-file') { restoreFile(); return; }
  if (act === 'conflict-ours' || act === 'conflict-theirs') {
    const side = act === 'conflict-ours' ? 'ours' : 'theirs';
    const path = t.dataset.path;
    gitCall('resolveConflict', { paths: [path], side }).then(async (r) => {
      if (!r.ok) { toast('失败：' + r.message, 'err'); return; }
      toast('已解决：' + path, 'ok');
      await afterMutation();
    });
    return;
  }
  if (act === 'rescue-reload') { loadRescue().then(() => renderRescue()); return; }
}

function onInput(e) {
  const id = e.target.id;
  if (id === 'commitMsg') { S.commitMsg = e.target.value; return; }
  if (id === 'amendChk') {
    S.amend = e.target.checked;
    const btn = document.querySelector('[data-act="do-commit"]');
    if (btn) {
      const staged = S.status ? S.status.staged.length : 0;
      btn.disabled = !(staged > 0 || (S.amend && S.status && !S.status.unborn));
      btn.textContent = S.amend ? '修改并提交' : '提交';
    }
    return;
  }
  if (id === 'changesFilter') {
    S.filter = e.target.value;
    renderFileList();
    return;
  }
  if (id === 'histSearch') {
    S.history.search = e.target.value;
    renderHistoryList();
    const c = el('histCount');
    if (c) c.textContent = `${filteredCommits().length} / ${S.history.commits.length} 次提交`;
    return;
  }
  if (id === 'histScope') {
    S.history.scope = e.target.value;
    loadHistory().then(renderHistoryList);
    return;
  }
}

function onKey(e) {
  // 模态框打开时，屏蔽全局快捷键（否则 Ctrl+Enter 会在确认框上触发提交）
  if (el('modal-root').childElementCount > 0) return;
  if (e.key === 'F5') { e.preventDefault(); refreshCurrentView(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (S.tab === 'changes') { e.preventDefault(); handleCommit(); }
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制：' + text, 'ok', 2200);
  } catch {
    toast('复制失败', 'err');
  }
}

async function refreshAll() {
  toast('正在刷新全部仓库…', 'info', 1600);
  await refreshSidebarOnly();
  if (S.active) await refreshCurrentView();
  const bad = S.repos.filter((r) => !r.ok).length;
  toast(bad ? `刷新完成，${bad} 个仓库无法读取` : '刷新完成', bad ? 'warn' : 'ok');
}

/* ---------- 变更批量操作 ---------- */

async function unstageAll() {
  if (!S.status || !S.status.staged.length) { toast('没有已暂存的文件', 'warn'); return; }
  const r = await gitCall('unstage', { paths: S.status.staged.map((f) => f.path), unborn: !!S.status.unborn });
  if (!r.ok) { toast('取消暂存失败：' + r.message, 'err'); return; }
  S.selected.clear();
  await afterMutation();
}

/* ---------- 分支操作 ---------- */

async function newBranchFlow() {
  await ensureBranches();
  const current = S.status ? S.status.branch : '';
  const res = await modal({
    title: '新建分支',
    bodyHtml: `<p class="muted" style="font-size:12px">基于 <b>${esc(current || '当前 HEAD')}</b> 创建新分支。</p>`,
    input: { label: '分支名', placeholder: '例如 feature/login' },
    okText: '创建并切换',
  });
  if (!res || !res.value) return;
  const name = (res.input || '').trim();
  if (!name) return;
  const r = await gitCall('createBranch', { name, checkout: true });
  if (!r.ok) { toast('创建失败：' + r.message, 'err'); return; }
  toast('已切换到新分支 ' + name, 'ok');
  await afterMutation({ reloadBranches: true, reloadHistory: true });
}

async function switchBranch(name) {
  const dirty = S.status && (S.status.staged.length + S.status.unstaged.length + S.status.untracked.length);
  const r = await gitCall('checkout', { ref: name });
  if (!r.ok) {
    if (dirty) {
      const ok = await confirmDanger({
        title: '切换失败，可能被未提交的改动挡住',
        bodyHtml: `<p>git 返回：</p><pre>${esc(r.message)}</pre><p>可以先把当前改动 stash 起来再切换（救急页里有该操作）。</p>`,
        okText: '去救急页',
      });
      if (ok) { S.tab = 'rescue'; renderTabs(); renderView(); loadRescue().then(renderRescue); }
      return;
    }
    toast('切换失败：' + r.message, 'err');
    return;
  }
  toast('已切换到 ' + name, 'ok');
  resetRepoState();
  await afterMutation({ reloadBranches: true, reloadHistory: true, reloadRescue: true });
}

async function mergeBranch(name) {
  const cur = S.status ? S.status.branch : '';
  const ok = await confirmDanger({
    title: '合并分支？',
    bodyHtml: `<p>把 <b>${esc(name)}</b> 合并到当前分支 <b>${esc(cur)}</b>。</p><p class="muted">如果出现冲突，需要在变更页或救急页处理。</p>`,
    okText: '合并',
  });
  if (!ok) return;
  const r = await gitCall('merge', { ref: name });
  if (!r.ok) {
    if (r.conflicts) {
      toast('合并有冲突，请处理冲突文件', 'warn');
      S.tab = 'changes';
      renderTabs();
      await afterMutation();
      return;
    }
    toast('合并失败：' + r.message, 'err');
    return;
  }
  toast('已合并 ' + name, 'ok');
  await afterMutation({ reloadBranches: true, reloadHistory: true });
}

async function deleteBranchFlow(name) {
  const ok = await confirmDanger({
    title: '删除分支 ' + name + '？',
    bodyHtml: `<p>只会删除分支指针。已合并的提交仍然保留在仓库里，未合并的提交若之后强制删除则只能靠 reflog 找回。</p>`,
    okText: '删除分支',
  });
  if (!ok) return;
  const r = await gitCall('deleteBranch', { name, force: false });
  if (r.ok) {
    toast('已删除分支 ' + name, 'ok');
    await afterMutation({ reloadBranches: true });
    return;
  }
  if (r.unmerged) {
    const ok = await confirmDanger({
      title: '分支还没有完全合并',
      bodyHtml: `<p>删除 <b>${esc(name)}</b> 会丢失它上面独有的提交（可能需要 reflog 才能找回）。</p><p>确定要强制删除吗？</p>`,
      okText: '强制删除',
      requireType: '删除',
    });
    if (!ok) return;
    const r2 = await gitCall('deleteBranch', { name, force: true });
    if (!r2.ok) { toast('删除失败：' + r2.message, 'err'); return; }
    toast('已强制删除 ' + name, 'ok');
    await afterMutation({ reloadBranches: true });
    return;
  }
  toast('删除失败：' + r.message, 'err');
}

async function branchMenu(name) {
  const choice = await menuModal({
    title: '分支 ' + name,
    subtitleHtml: '<p class="muted" style="font-size:12px">重命名会保留该分支的历史。</p>',
    items: [
      { label: '重命名…', value: 'rename' },
      { label: '复制分支名', value: 'copy' },
    ],
  });
  if (choice === 'copy') { copyText(name); return; }
  if (choice !== 'rename') return;
  const res = await modal({
    title: '重命名分支',
    input: { label: '新分支名', value: name },
    okText: '重命名',
  });
  if (!res || !res.value) return;
  const to = (res.input || '').trim();
  if (!to || to === name) return;
  const r = await gitCall('renameBranch', { from: name, to });
  if (!r.ok) { toast('重命名失败：' + r.message, 'err'); return; }
  toast(`已把 ${name} 重命名为 ${to}`, 'ok');
  await afterMutation({ reloadBranches: true, reloadHistory: true });
}

async function checkoutRemote(fullName) {
  const short = fullName.split('/').slice(1).join('/');
  const ok = await confirmDanger({
    title: '检出远程分支',
    bodyHtml: `<p>把远程分支 <b>${esc(fullName)}</b> 检到本地，新本地分支名默认为 <b>${esc(short)}</b>。</p>`,
    okText: '检出',
  });
  if (!ok) return;
  const r = await gitCall('createBranch', { name: short, from: fullName, checkout: true });
  if (!r.ok) { toast('检出失败：' + r.message, 'err'); return; }
  toast('已检出 ' + short, 'ok');
  await afterMutation({ reloadBranches: true, reloadHistory: true });
}

async function runNet(action, label) {
  if (S.netBusy) { toast('上一个远程操作还没结束，稍等一下', 'warn'); return; }
  const ok = await modal({
    title: label,
    bodyHtml: `<p>执行 <b>${action === 'fetchAll' ? 'git fetch --all --prune' : action === 'pull' ? 'git pull' : action === 'push' ? 'git push' : 'git push -u'}</b>。</p>${action === 'pull' ? '<p class="muted">如果本地有未提交改动，pull 可能被拒绝。</p>' : ''}`,
    okText: '开始',
  });
  if (!ok) return;
  S.netBusy = true;
  const t = toast(label + '中…', 'info', 60000);
  const res = await gitCall(action);
  S.netBusy = false;
  if (t && t.parentElement) t.remove();
  if (!res.ok) {
    toast(label + '失败：' + (res.hint || res.message), 'err');
    return;
  }
  const detail = res.output ? '：' + res.output.split('\n').slice(0, 3).join('\n') : '';
  toast(label + '完成' + detail, 'ok');
  await afterMutation({ reloadBranches: S.tab === 'branches', reloadHistory: S.tab === 'history' });
}

/* ---------- 救急操作 ---------- */

async function undoCommit() {
  const ok = await confirmDanger({
    title: '撤销上次提交？',
    bodyHtml: `<p>执行 <b>git reset --soft HEAD~1</b>：撤销最近一次提交，改动全部保留在工作区。</p><p class="muted">如果这次提交已经推送到远程，其他人可能已经拉到，撤销会造成分叉，需要谨慎。</p>`,
    okText: '撤销提交',
  });
  if (!ok) return;
  const r = await gitCall('reset', { mode: 'soft', target: 'HEAD~1' });
  if (!r.ok) { toast('撤销失败：' + r.message, 'err'); return; }
  toast('已撤销上次提交，改动仍在工作区', 'ok');
  await afterMutation({ reloadHistory: S.tab === 'history', reloadRescue: true });
}

async function discardAll() {
  const st = S.status;
  if (!st) return;
  const paths = st.unstaged.map((f) => f.path);
  if (!paths.length) { toast('没有未暂存的改动', 'warn'); return; }
  const ok = await confirmDanger({
    title: '丢弃所有未暂存改动？',
    bodyHtml: `<p>以下 ${paths.length} 个文件的修改将<span class="danger-note">永久丢失</span>：</p><pre>${esc(paths.slice(0, 40).join('\n'))}${paths.length > 40 ? '\n…' : ''}</pre>`,
    okText: '全部丢弃',
    requireType: '丢弃',
  });
  if (!ok) return;
  const r = await gitCall('discardPaths', { paths });
  if (!r.ok) { toast('失败：' + r.message, 'err'); return; }
  S.diff = null;
  toast('已丢弃未暂存的改动', 'ok');
  await afterMutation({ reloadRescue: true });
}

async function cleanUntracked() {
  const st = S.status;
  if (!st) return;
  if (!st.untracked.length) { toast('没有未跟踪文件', 'warn'); return; }
  const ok = await confirmDanger({
    title: '清理未跟踪文件？',
    bodyHtml: `<p>将删除 ${st.untracked.length} 个未跟踪文件/目录，<span class="danger-note">无法恢复</span>：</p><pre>${esc(st.untracked.slice(0, 40).map((f) => f.path).join('\n'))}${st.untracked.length > 40 ? '\n…' : ''}</pre>`,
    okText: '清理',
    requireType: '清理',
  });
  if (!ok) return;
  const r = await gitCall('discardUntracked', { paths: st.untracked.map((f) => f.path) });
  if (!r.ok) { toast('清理失败：' + r.message, 'err'); return; }
  toast('已清理未跟踪文件', 'ok');
  await afterMutation({ reloadRescue: true });
}

async function stashSave() {
  const res = await modal({
    title: '保存当前改动到 stash',
    bodyHtml: `<p>把未提交的改动收进 stash，工作区变干净。默认包含新文件。</p>`,
    input: { label: '说明（可留空）', placeholder: '例如：做实验前先存一下' },
    okText: '保存',
  });
  if (!res || !res.value) return;
  const r = await gitCall('stashPush', { message: (res.input || '').trim(), includeUntracked: true });
  if (!r.ok) { toast('保存失败：' + r.message, 'err'); return; }
  if (r.noChanges) { toast('没有可保存的改动，工作区是干净的', 'warn'); return; }
  toast(r.output || '已保存到 stash', 'ok');
  await afterMutation({ reloadRescue: true });
}

async function stashApply(sel, pop) {
  if (pop) {
    const ok = await confirmDanger({
      title: '应用并删除这条 stash？',
      bodyHtml: `<p>先把 <span class="mono">${esc(sel)}</span> 的改动应用到工作区，成功后再删除这条记录。如果应用有冲突，记录会保留。</p>`,
      okText: '应用并删除',
    });
    if (!ok) return;
  }
  const r = await gitCall('stashApply', { sel, pop });
  if (!r.ok) {
    toast((pop ? '应用并删除' : '应用') + '失败：' + r.message, 'err');
    return;
  }
  toast('已应用 ' + sel, 'ok');
  await afterMutation({ reloadRescue: true });
}

async function stashDrop(sel) {
  const ok = await confirmDanger({
    title: '删除这条 stash？',
    bodyHtml: `<p>删除后其中的改动只能靠 dangling commit 找回，通常很麻烦。</p><p class="mono">${esc(sel)}</p>`,
    okText: '删除',
    requireType: '删除',
  });
  if (!ok) return;
  const r = await gitCall('stashDrop', { sel });
  if (!r.ok) { toast('删除失败：' + r.message, 'err'); return; }
  toast('已删除 ' + sel, 'ok');
  await afterMutation({ reloadRescue: true });
}

async function reflogBranch(hash) {
  const res = await modal({
    title: '根据记录新建分支',
    bodyHtml: `<p>在提交 <span class="mono">${esc(hash)}</span> 上新建分支（这是找回误删提交最安全的方式）。</p>`,
    input: { label: '新分支名', placeholder: '例如 rescue/lost-work', value: 'rescue/' + hash },
    okText: '创建',
  });
  if (!res || !res.value) return;
  const name = (res.input || '').trim();
  const r = await gitCall('branchFrom', { name, hash });
  if (!r.ok) { toast('创建失败：' + r.message, 'err'); return; }
  toast('已创建分支 ' + name, 'ok');
  await afterMutation({ reloadBranches: true, reloadRescue: true });
}

async function resetFlow(presetHash) {
  const res = await modal({
    title: '重置当前分支',
    bodyHtml: `<p>把当前分支的 HEAD 移动到指定提交。三种模式：</p>
      <p><b>--soft</b> 只移动 HEAD，改动保留在暂存区；<br><b>--mixed</b> 移动 HEAD 并取消暂存，改动留在工作区；<br><b>--hard</b> 移动 HEAD 并<b class="danger-note">丢弃所有未提交改动</b>。</p>`,
    input: { label: '目标提交 hash（或 HEAD~2 这样的写法）', placeholder: '例如 3f2a9c1', value: presetHash || '' },
    okText: '下一步',
  });
  if (!res || !res.value) return;
  const target = (res.input || '').trim();
  if (!target) return;
  const modeRes = await modal({
    title: '选择重置模式',
    bodyHtml: `<p>目标：<span class="mono">${esc(target)}</span></p><p>当前未提交改动：${S.status ? S.status.staged.length + S.status.unstaged.length + S.status.untracked.length : 0} 处。</p>`,
    input: { label: '模式（soft / mixed / hard）', value: 'mixed' },
    okText: '执行重置',
    danger: true,
  });
  if (!modeRes || !modeRes.value) return;
  const mode = (modeRes.input || 'mixed').trim().toLowerCase();
  if (!['soft', 'mixed', 'hard'].includes(mode)) { toast('模式只能是 soft / mixed / hard', 'err'); return; }
  const ok = await confirmDanger({
    title: '重置到 ' + target + '（' + mode + '）？',
    bodyHtml: `<p>这会移动当前分支的 HEAD。${mode === 'hard' ? '<b class="danger-note">--hard 会丢弃所有未提交改动，且无法恢复。</b>' : '未提交改动会保留。'}</p><p class="muted">如果后悔，可以在救急页的 reflog 里找回原来的位置。</p>`,
    okText: '执行',
    requireType: mode === 'hard' ? '重置' : '',
  });
  if (!ok) return;
  const r = await gitCall('reset', { mode, target });
  if (!r.ok) { toast('重置失败：' + r.message, 'err'); return; }
  toast('已重置到 ' + target + '（' + mode + '）', 'ok');
  S.diff = null;
  await afterMutation({ reloadHistory: true, reloadBranches: true, reloadRescue: true });
}

async function restoreFile() {
  const hash = (el('restoreHash') || {}).value || '';
  const file = (el('restorePath') || {}).value || '';
  const ref = hash.trim();
  if (!ref || !file) { toast('请填写提交 hash 和文件路径', 'warn'); return; }
  const ok = await confirmDanger({
    title: '恢复文件？',
    bodyHtml: `<p>把 <span class="mono">${esc(ref)}</span> 里 <span class="mono">${esc(file)}</span> 的内容写回工作区（覆盖当前文件内容）。</p>`,
    okText: '恢复',
  });
  if (!ok) return;
  const r = await gitCall('restoreFileFrom', { hash: ref, file });
  if (!r.ok) { toast('恢复失败：' + r.message, 'err'); return; }
  toast('已恢复文件，记得提交', 'ok');
  await afterMutation({ reloadRescue: true });
}

/* ======================= 启动 ======================= */

function bindEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  document.addEventListener('keydown', onKey);
  el('btnAddRepo').addEventListener('click', doAddRepo);
  el('btnRefreshAll').addEventListener('click', refreshAll);
  if (api && api.on) {
    api.on('add', doAddRepo);
    api.on('refresh', refreshCurrentView);
    api.on('about', () => {
      modal({
        title: 'GitDesk',
        bodyHtml: `<p>本地 Git 图形面板，基于 Electron 构建，所有操作都在本机执行。</p>
          <p class="muted" style="font-size:12px">多仓库管理 · 变更与提交 · 提交历史与分支 · 救急（reflog / 重置 / 丢弃 / stash）</p>`,
        okText: '好',
      });
    });
  }
}

async function boot() {
  if (typeof api === 'undefined' || !api) {
    el('view').innerHTML = '<div class="empty"><h3>预加载脚本没有生效</h3><p>请重新启动应用。</p></div>';
    return;
  }
  bindEvents();
  try {
    const info = await api.app.info();
    if (info && info.ok) {
      el('gitVer').textContent = info.data.git.replace('git version ', 'git ');
      el('appVer').textContent = 'v' + info.data.appVersion;
    }
  } catch { /* 版本信息失败不影响使用 */ }
  try {
    await loadRepos();
  } catch (e) {
    toast('启动时出错：' + (e.message || e), 'err');
    renderAll();
  }
  if (S.active && S.tab === 'history') loadHistory();
}

boot();
