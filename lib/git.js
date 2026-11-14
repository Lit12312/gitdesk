'use strict';

/**
 * GitDesk git 执行层。
 * 所有 git 调用都走 execFile（不经过 shell），参数以数组传递，避免转义/注入问题。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_BUFFER = 64 * 1024 * 1024;

function gitEnv() {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
    LANG: 'C',
  };
  // 防止父进程设置的 GIT_* 变量把命令重定向到别的仓库
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_NAMESPACE;
  return env;
}

/** 修订号/分支引用：不允许空白、不允许以 - 开头（否则会被 git 当成选项） */
function isSafeRev(rev) {
  return typeof rev === 'string' && rev.length > 0 && rev.length <= 255
    && !/^\s|[\s]$/.test(rev) && !rev.startsWith('-') && !rev.includes('\0');
}

function isSafeRefName(name) {
  return isSafeRev(name) && !name.includes('..') && !name.includes('@{');
}

function run(cwd, args, opts = {}) {
  const finalArgs = [
    '-c', 'core.quotepath=false',
    '-c', 'color.ui=never',
    '-c', 'core.pager=cat',
    ...args,
  ];
  return new Promise((resolve) => {
    execFile('git', finalArgs, {
      cwd,
      env: gitEnv(),
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      timeout: opts.timeout || 120000,
    }, (err, stdout, stderr) => {
      const out = stdout || '';
      const errOut = stderr || '';
      if (!err) {
        resolve({ ok: true, code: 0, stdout: out, stderr: errOut, message: '' });
        return;
      }
      const code = typeof err.code === 'number' ? err.code : -1;
      let message = errOut.trim();
      if (!message) message = out.trim();
      if (!message) message = err.message || 'git 命令失败';
      resolve({ ok: false, code, stdout: out, stderr: errOut, message });
    });
  });
}

function runForPaths(repo, args) {
  return run(repo, ['--literal-pathspecs', ...args]);
}

async function isRepo(dir) {
  if (!dir) return { ok: false, message: '路径为空' };
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return { ok: false, message: '不是目录' };
  } catch (e) {
    return { ok: false, message: '路径不存在' };
  }
  const r = await run(dir, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return { ok: false, message: r.message };
  const root = r.stdout.trim();
  if (!root) return { ok: false, message: '不是 Git 仓库' };
  return { ok: true, root };
}

function parseStatus(raw) {
  const tokens = raw.split('\0');
  const res = {
    branch: '', oid: '', upstream: '', ahead: 0, behind: 0,
    detached: false, unborn: false,
    staged: [], unstaged: [], untracked: [], conflicted: [],
  };
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (!t) continue;
    if (t.startsWith('#')) {
      for (const line of t.split('\n')) {
        const m = line.match(/^# (branch\.(?:oid|head|upstream|ab)) (.*)$/);
        if (!m) continue;
        const [, key, val] = m;
        if (key === 'branch.oid') {
          res.oid = val;
          if (val === '(initial)') res.unborn = true;
        } else if (key === 'branch.head') {
          if (val === '(detached)') { res.detached = true; res.branch = 'HEAD (detached)'; }
          else res.branch = val;
        } else if (key === 'branch.upstream') {
          res.upstream = val;
        } else if (key === 'branch.ab') {
          const ab = val.match(/\+(\d+)\s+-(\d+)/);
          if (ab) { res.ahead = +ab[1]; res.behind = +ab[2]; }
        }
      }
      continue;
    }
    const kind = t[0];
    if (kind === '1') {
      const parts = t.split(' ');
      const xy = parts[1] || '..';
      const p = parts.slice(8).join(' ');
      pushEntry(res, xy, p, null);
    } else if (kind === '2') {
      const parts = t.split(' ');
      const xy = parts[1] || '..';
      const p = parts.slice(9).join(' ');
      const orig = tokens[i + 1];
      if (orig !== undefined) i += 1;
      pushEntry(res, xy, p, orig);
    } else if (kind === 'u') {
      const parts = t.split(' ');
      const xy = parts[1] || '..';
      const p = parts.slice(10).join(' ');
      res.conflicted.push({ path: p, code: xy, unmerged: true });
    } else if (kind === '?') {
      res.untracked.push({ path: t.slice(2), code: '?' });
    }
  }
  return res;
}

function pushEntry(res, xy, p, orig) {
  const x = xy[0] || '.';
  const y = xy[1] || '.';
  if (x !== '.') res.staged.push({ path: p, code: x, orig: orig || null });
  if (y !== '.') res.unstaged.push({ path: p, code: y, orig: orig || null });
}

async function status(repo) {
  const r = await run(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
  if (!r.ok) return { ok: false, message: r.message };
  const st = parseStatus(r.stdout);
  return { ok: true, data: st };
}

async function currentBranch(repo) {
  const r = await run(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.stdout.trim() : null;
}

async function quickInfo(repo) {
  const st = await status(repo);
  if (!st.ok) return { ok: false, message: st.message };
  const d = st.data;
  const dirty = d.staged.length + d.unstaged.length + d.untracked.length + d.conflicted.length;
  return {
    ok: true,
    data: {
      branch: d.branch || '(无提交)',
      detached: d.detached,
      upstream: d.upstream,
      ahead: d.ahead,
      behind: d.behind,
      dirty,
      staged: d.staged.length,
      unstaged: d.unstaged.length + d.untracked.length,
      conflicted: d.conflicted.length,
    },
  };
}

function parseRefs(decoration) {
  const out = { branches: [], tags: [], remote: [], head: false };
  if (!decoration) return out;
  for (let part of decoration.split(',')) {
    part = part.trim();
    if (!part) continue;
    if (part.startsWith('HEAD -> ')) { out.head = true; part = part.slice(8).trim(); }
    else if (part === 'HEAD') { out.head = true; continue; }
    if (part.startsWith('tag: ')) part = part.slice(5).trim();
    if (part.startsWith('refs/heads/')) out.branches.push(part.slice('refs/heads/'.length));
    else if (part.startsWith('refs/remotes/')) out.remote.push(part.slice('refs/remotes/'.length));
    else if (part.startsWith('refs/tags/')) out.tags.push(part.slice('refs/tags/'.length));
    else if (part.startsWith('refs/')) { /* refs/stash 等，忽略 */ }
    else out.branches.push(part);
  }
  return out;
}

async function log(repo, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 2000);
  const args = [
    'log', `-n`, String(limit),
    '--date-order',
    '--decorate=full',
    '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ar%x1f%s%x1f%P%x1f%D%x1e',
  ];
  if (opts.all) args.push('--branches', '--tags', '--remotes', 'HEAD');
  else if (opts.ref) {
    if (!isSafeRev(opts.ref)) return { ok: false, message: '非法的提交/分支参数' };
    args.push(opts.ref);
  }
  const r = await run(repo, args);
  if (!r.ok) {
    // 空仓库：git log 会失败
    if (/does not have any commits|unknown revision|bad revision/i.test(r.message)) {
      return { ok: true, data: [], empty: true };
    }
    return { ok: false, message: r.message };
  }
  const commits = [];
  for (const rec of r.stdout.split('\x1e')) {
    const line = rec.replace(/^\n+/, '');
    if (!line) continue;
    const f = line.split('\x1f');
    if (f.length < 9) continue;
    commits.push({
      hash: f[0],
      short: f[1],
      author: f[2],
      email: f[3],
      time: +f[4],
      rel: f[5],
      subject: f[6],
      parents: f[7] ? f[7].split(' ').filter(Boolean) : [],
      refs: parseRefs(f[8]),
    });
  }
  return { ok: true, data: commits };
}

async function branches(repo) {
  // 注意：for-each-ref 的 --format 只支持 %xx 形式的十六进制转义（%1f），不支持 %x1f
  const localFmt = '%(refname:short)%1f%(HEAD)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:iso-strict)%1f%(committerdate:relative)%1f%(subject)%1f%(symref)%1e';
  const r = await run(repo, ['for-each-ref', '--sort=-committerdate', `--format=${localFmt}`, 'refs/heads']);
  if (!r.ok) return { ok: false, message: r.message };
  const local = [];
  for (const rec of r.stdout.split('\x1e')) {
    const line = rec.replace(/^\n+/, '');
    if (!line) continue;
    const f = line.split('\x1f');
    if (f.length < 9) continue;
    if (f[8]) continue; // 符号引用
    local.push({
      name: f[0],
      current: f[1] === '*',
      hash: f[2],
      upstream: f[3],
      track: f[4] || '',
      date: f[5],
      rel: f[6],
      subject: f[7],
    });
  }
  const remoteFmt = '%(refname:short)%1f%(objectname:short)%1f%(committerdate:relative)%1f%(subject)%1f%(symref)%1e';
  const rr = await run(repo, ['for-each-ref', '--sort=-committerdate', `--format=${remoteFmt}`, 'refs/remotes']);
  const remote = [];
  if (rr.ok) {
    for (const rec of rr.stdout.split('\x1e')) {
      const line = rec.replace(/^\n+/, '');
      if (!line) continue;
      const f = line.split('\x1f');
      if (f.length < 5) continue;
      if (f[4]) continue; // origin/HEAD 之类的符号引用
      remote.push({ name: f[0], hash: f[1], rel: f[2], subject: f[3] });
    }
  }
  return { ok: true, data: { local, remote } };
}

async function remotes(repo) {
  const r = await run(repo, ['remote']);
  if (!r.ok) return { ok: true, data: [] };
  return { ok: true, data: r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

function limitText(text, max = 400000) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** 把仓库内相对路径解析为绝对路径，越界（../ 或绝对盘符）返回 null */
function safeJoin(repo, rel) {
  const root = path.resolve(repo);
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return abs;
}

async function diffFile(repo, file, opts = {}) {
  if (!file || typeof file !== 'string') return { ok: false, message: '缺少文件路径' };
  const rel = file.replace(/\\/g, '/');
  let args;
  if (opts.staged) args = ['diff', '--cached', '--no-color', '--no-ext-diff', '--', rel];
  else if (opts.untracked || opts.conflict) {
    const abs = safeJoin(repo, rel);
    if (!abs) return { ok: false, message: '非法路径' };
    const kind = opts.conflict ? 'conflicted' : 'untracked';
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        if (opts.conflict) return { ok: false, message: '该路径不是文件' };
        const list = [];
        const CAP = 400;
        async function walk(dir, prefix, depth) {
          if (list.length >= CAP || depth > 6) return;
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (list.length >= CAP) return;
            if (e.isSymbolicLink()) { list.push(prefix + e.name + '（符号链接）'); continue; }
            const p = path.join(dir, e.name);
            const rp = prefix + e.name;
            if (e.isDirectory()) await walk(p, rp + '/', depth + 1);
            else list.push(rp);
          }
        }
        await walk(abs, '', 0);
        return {
          ok: true,
          data: {
            kind: 'untracked-dir',
            text: '',
            fileList: list,
            note: `${list.length}${list.length >= CAP ? '+' : ''} 个未跟踪文件`,
          },
        };
      }
      if (st.size > 8 * 1024 * 1024) {
        return { ok: true, data: { kind, text: '', binary: true, note: '文件超过 8MB，未读取内容' } };
      }
      const fh = await fs.open(abs, 'r');
      try {
        const len = Math.min(st.size, 400 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
        if (buf.includes(0)) {
          return { ok: true, data: { kind, text: '', binary: true, note: '二进制文件，无法预览' } };
        }
        return {
          ok: true,
          data: {
            kind,
            text: buf.toString('utf8'),
            truncated: st.size > len,
            note: opts.conflict ? '冲突文件的工作区内容（含冲突标记）' : '未跟踪的新文件',
          },
        };
      } finally {
        await fh.close();
      }
    } catch (e) {
      return { ok: false, message: '无法读取文件：' + (e.message || e) };
    }
  } else {
    args = ['diff', '--no-color', '--no-ext-diff', '--', rel];
  }
  const r = await runForPaths(repo, args);
  if (!r.ok) return { ok: false, message: r.message };
  const { text, truncated } = limitText(r.stdout);
  return { ok: true, data: { kind: opts.staged ? 'staged' : 'unstaged', text, truncated } };
}

async function showCommit(repo, hash) {
  if (!isSafeRev(hash)) return { ok: false, message: '非法的提交参数' };
  const meta = await run(repo, [
    'show', '-s', '--no-color', '--decorate=full',
    '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%ar%x1f%s%x1f%b%x1f%P%x1f%D',
    '--date=format:%Y-%m-%d %H:%M',
    '--end-of-options', hash,
  ]);
  if (!meta.ok) return { ok: false, message: meta.message };
  const f = meta.stdout.split('\x1f');
  const parents = f[8] ? f[8].split(' ').filter(Boolean) : [];
  const filesArgs = ['show', '--name-status', '--format=', '-z', '--no-color'];
  if (parents.length > 1) filesArgs.push('-m', '--first-parent');
  filesArgs.push('--end-of-options', hash);
  const filesRes = await run(repo, filesArgs);
  const files = [];
  if (filesRes.ok) {
    const toks = filesRes.stdout.split('\0').filter((t) => t && t !== '\n');
    for (let i = 0; i < toks.length; i++) {
      const code = (toks[i] || '').trim();
      if (!/^[AMDRCTUXB]/.test(code)) continue;
      let p = toks[i + 1];
      if (p === undefined) break;
      if (code[0] === 'R' || code[0] === 'C') {
        const from = toks[i + 1];
        const to = toks[i + 2];
        i += 2;
        files.push({ code: code[0], path: to, from });
      } else {
        i += 1;
        files.push({ code: code[0], path: p.replace(/\n+$/, '') });
      }
    }
  }
  return {
    ok: true,
    data: {
      hash: f[0], short: f[1], author: f[2], email: f[3],
      date: f[4], rel: f[5], subject: f[6],
      body: (f[7] || '').trim(), parents,
      refs: parseRefs(f[9] || ''),
      files,
    },
  };
}

async function commitDiff(repo, hash, file) {
  if (!isSafeRev(hash)) return { ok: false, message: '非法的提交参数' };
  const args = ['show', '--no-color', '--no-ext-diff', '--format=', '--end-of-options', hash];
  if (file) args.push('--', file.replace(/\\/g, '/'));
  const r = await runForPaths(repo, args);
  if (!r.ok) return { ok: false, message: r.message };
  const { text, truncated } = limitText(r.stdout);
  return { ok: true, data: { text, truncated } };
}

function sanitizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .filter((p) => typeof p === 'string' && p.length > 0 && !p.includes('\0'))
    .map((p) => p.replace(/\\/g, '/'));
}

async function stage(repo, paths) {
  const list = sanitizePaths(paths);
  if (!list.length) return { ok: false, message: '没有选中文件' };
  const r = await runForPaths(repo, ['add', '--', ...list]);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

async function stageAll(repo) {
  const r = await run(repo, ['add', '-A']);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

async function unstage(repo, paths, unborn) {
  const list = sanitizePaths(paths);
  if (!list.length) return { ok: false, message: '没有选中文件' };
  let r;
  if (unborn) {
    r = await runForPaths(repo, ['rm', '--cached', '-r', '--quiet', '--force', '--', ...list]);
  } else {
    r = await runForPaths(repo, ['restore', '--staged', '--', ...list]);
    if (!r.ok) r = await runForPaths(repo, ['reset', '--quiet', 'HEAD', '--', ...list]);
  }
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

async function discardPaths(repo, paths) {
  const list = sanitizePaths(paths);
  if (!list.length) return { ok: false, message: '没有选中文件' };
  let r = await runForPaths(repo, ['restore', '--', ...list]);
  if (!r.ok) r = await runForPaths(repo, ['checkout', '--', ...list]);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

async function discardUntracked(repo, paths) {
  const list = sanitizePaths(paths);
  if (!list.length) return { ok: false, message: '没有选中文件' };
  const r = await runForPaths(repo, ['clean', '-f', '-d', '--', ...list]);
  return r.ok ? { ok: true, output: r.stdout } : { ok: false, message: r.message };
}

async function commit(repo, message, opts = {}) {
  const msg = String(message || '').trim();
  if (!msg && !opts.amendNoEdit) return { ok: false, message: '提交信息不能为空' };
  const args = ['commit'];
  if (opts.amend) {
    args.push('--amend');
    if (opts.amendNoEdit) args.push('--no-edit');
  }
  if (msg) args.push('-m', msg);
  if (opts.all) args.push('-a');
  const r = await run(repo, args);
  if (!r.ok) {
    let hint = '';
    if (/nothing to commit/i.test(r.message)) hint = '没有可提交的改动';
    else if (/Please tell me who you are|empty ident/i.test(r.message)) hint = '请先配置 user.name 与 user.email（见设置）';
    return { ok: false, message: r.message, hint };
  }
  return { ok: true, output: r.stdout };
}

async function checkout(repo, ref, opts = {}) {
  if (!ref) return { ok: false, message: '缺少分支名' };
  if (!isSafeRev(ref)) return { ok: false, message: '非法的分支名' };
  const args = ['checkout'];
  if (opts.detach) args.push('--detach');
  args.push('--end-of-options', ref);
  const r = await run(repo, args);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, output: r.stdout + r.stderr };
}

async function checkRefName(repo, name) {
  const r = await run(repo, ['check-ref-format', '--branch', name]);
  return { ok: r.ok, message: r.ok ? '' : r.message };
}

async function createBranch(repo, name, from, doCheckout) {
  if (!name) return { ok: false, message: '缺少分支名' };
  if (!isSafeRefName(name)) return { ok: false, message: '分支名不合法' };
  const check = await checkRefName(repo, name);
  if (!check.ok) return { ok: false, message: '分支名不合法：' + check.message };
  if (from && !isSafeRev(from)) return { ok: false, message: '非法的起点提交' };
  const args = ['branch', name];
  if (from) args.push(from);
  const r = await run(repo, args);
  if (!r.ok) return { ok: false, message: r.message };
  if (doCheckout) return checkout(repo, name);
  return { ok: true };
}

async function renameBranch(repo, from, to) {
  if (!from || !to) return { ok: false, message: '缺少分支名' };
  if (!isSafeRefName(from) || !isSafeRefName(to)) return { ok: false, message: '分支名不合法' };
  const check = await checkRefName(repo, to);
  if (!check.ok) return { ok: false, message: '分支名不合法：' + check.message };
  const r = await run(repo, ['branch', '-m', from, to]);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

async function deleteBranch(repo, name, force) {
  if (!name) return { ok: false, message: '缺少分支名' };
  if (!isSafeRefName(name)) return { ok: false, message: '分支名不合法' };
  const r = await run(repo, ['branch', force ? '-D' : '-d', name]);
  if (!r.ok) {
    const unmerged = /not fully merged|未完全合并/i.test(r.message);
    return { ok: false, message: r.message, unmerged };
  }
  return { ok: true };
}

async function merge(repo, ref) {
  if (!ref) return { ok: false, message: '缺少分支名' };
  if (!isSafeRev(ref)) return { ok: false, message: '非法的分支名' };
  const r = await run(repo, ['merge', '--no-edit', '--', ref]);
  if (!r.ok) {
    const conflicts = (r.stdout + '\n' + r.stderr).includes('CONFLICT');
    return { ok: false, message: r.message, conflicts };
  }
  return { ok: true, output: r.stdout };
}

async function resolveConflict(repo, paths, side) {
  const list = sanitizePaths(paths);
  if (!list.length) return { ok: false, message: '没有选中文件' };
  const flag = side === 'theirs' ? '--theirs' : '--ours';
  const r = await runForPaths(repo, ['checkout', flag, '--', ...list]);
  if (!r.ok) return { ok: false, message: r.message };
  const add = await runForPaths(repo, ['add', '--', ...list]);
  return add.ok ? { ok: true } : { ok: false, message: add.message };
}

async function reflog(repo, limit = 100) {
  const r = await run(repo, [
    'reflog', '--date=iso', '-n', String(limit),
    '--pretty=format:%h%x1f%gd%x1f%gs%x1f%ad%x1f%ar%x1e',
  ]);
  if (!r.ok) return { ok: false, message: r.message };
  const list = [];
  for (const rec of r.stdout.split('\x1e')) {
    const line = rec.replace(/^\n+/, '');
    if (!line) continue;
    const f = line.split('\x1f');
    if (f.length < 5) continue;
    list.push({ hash: f[0], sel: f[1], action: f[2], date: f[3], rel: f[4] });
  }
  return { ok: true, data: list };
}

async function reset(repo, mode, target) {
  const allowed = ['soft', 'mixed', 'hard'];
  if (!allowed.includes(mode)) return { ok: false, message: '非法的重置模式' };
  if (!target) return { ok: false, message: '缺少目标提交' };
  if (!isSafeRev(target)) return { ok: false, message: '非法的目标提交' };
  const r = await run(repo, ['reset', `--${mode}`, target], { timeout: 180000 });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, output: r.stdout + r.stderr };
}

async function branchFrom(repo, name, hash) {
  if (!name) return { ok: false, message: '缺少分支名' };
  if (!isSafeRefName(name)) return { ok: false, message: '分支名不合法' };
  const check = await checkRefName(repo, name);
  if (!check.ok) return { ok: false, message: '分支名不合法：' + check.message };
  if (!isSafeRev(hash)) return { ok: false, message: '非法的提交参数' };
  const r = await run(repo, ['branch', name, hash]);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

async function restoreFileFrom(repo, hash, file) {
  if (!hash || !file) return { ok: false, message: '缺少参数' };
  if (!isSafeRev(hash)) return { ok: false, message: '非法的参数' };
  const [input] = sanitizePaths([file]);
  if (!input || path.isAbsolute(input) || input.split('/').includes('..')) {
    return { ok: false, message: '请输入仓库内的文件相对路径' };
  }
  const rel = path.posix.normalize(input);
  const commit = await run(repo, ['rev-parse', '--verify', '--end-of-options', hash + '^{commit}']);
  if (!commit.ok) return { ok: false, message: commit.message };
  const source = commit.stdout.trim();
  const entry = await runForPaths(repo, ['ls-tree', '-z', source, '--', rel]);
  if (!entry.ok) return { ok: false, message: entry.message };
  const tab = entry.stdout.indexOf('\t');
  const type = entry.stdout.slice(0, tab).split(' ')[1];
  if (type !== 'blob' || entry.stdout.slice(tab + 1) !== rel + '\0') {
    return { ok: false, message: '该提交里没有这个文件，请检查路径' };
  }
  const r = await runForPaths(repo, ['restore', `--source=${source}`, '--worktree', '--overlay', '--', rel]);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

async function stashPush(repo, message, includeUntracked) {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message) args.push('-m', message);
  const r = await run(repo, args);
  if (!r.ok) return { ok: false, message: r.message };
  const out = r.stdout.trim();
  if (/No local changes to save/i.test(out)) {
    return { ok: true, noChanges: true, output: out };
  }
  return { ok: true, output: out };
}

async function stashList(repo) {
  // 注意：任何 --date=… 都会让 %gd 变成日期型 selector（stash@{2026-…}），drop/pop 会静默失效。
  // 所以这里不传 --date，时间用相对时间 %cr。
  const r = await run(repo, ['stash', 'list', '--pretty=format:%gd%x1f%h%x1f%cr%x1f%gs%x1e']);
  if (!r.ok) return { ok: false, message: r.message };
  const list = [];
  for (const rec of r.stdout.split('\x1e')) {
    const line = rec.replace(/^\n+/, '');
    if (!line) continue;
    const f = line.split('\x1f');
    if (f.length < 4) continue;
    list.push({ sel: f[0], hash: f[1], date: f[2], subject: f[3] });
  }
  return { ok: true, data: list };
}

const STASH_SEL_RE = /^stash@\{\d+\}$/;

async function stashApply(repo, sel, pop) {
  if (!sel) return { ok: false, message: '缺少 stash 项' };
  if (!STASH_SEL_RE.test(sel)) return { ok: false, message: '非法的 stash 引用' };
  const r = await run(repo, ['stash', pop ? 'pop' : 'apply', sel]);
  if (!r.ok) return { ok: false, message: r.message, conflicts: /CONFLICT/.test(r.stdout + r.stderr) };
  return { ok: true, output: r.stdout };
}

async function stashDrop(repo, sel) {
  if (!sel) return { ok: false, message: '缺少 stash 项' };
  if (!STASH_SEL_RE.test(sel)) return { ok: false, message: '非法的 stash 引用' };
  const r = await run(repo, ['stash', 'drop', sel]);
  if (!r.ok) return { ok: false, message: r.message };
  const out = r.stdout || '';
  if (!/Dropped/i.test(out)) return { ok: false, message: 'git 没有确认删除，stash 可能仍然存在：' + out.trim() };
  return { ok: true, output: out.trim() };
}

async function fetchAll(repo) {
  const r = await run(repo, ['fetch', '--all', '--prune'], { timeout: 300000 });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, output: (r.stdout + r.stderr).trim() };
}

async function pull(repo) {
  const r = await run(repo, ['pull', '--no-edit'], { timeout: 300000 });
  if (!r.ok) return { ok: false, message: r.message, conflicts: /CONFLICT/.test(r.stdout + r.stderr) };
  return { ok: true, output: (r.stdout + r.stderr).trim() };
}

async function push(repo) {
  const r = await run(repo, ['push'], { timeout: 300000 });
  if (!r.ok) {
    let hint = '';
    if (/no upstream branch|set-upstream/i.test(r.message)) hint = '当前分支还没有上游分支，可先用“发布分支”。';
    return { ok: false, message: r.message, hint };
  }
  return { ok: true, output: (r.stderr + r.stdout).trim() };
}

async function pushSetUpstream(repo) {
  const branch = await currentBranch(repo);
  if (!branch) return { ok: false, message: '当前不在分支上' };
  const remRes = await run(repo, ['remote']);
  const remotes = remRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!remotes.length) return { ok: false, message: '没有配置远程仓库' };
  const r = await run(repo, ['push', '-u', remotes[0], branch], { timeout: 300000 });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, output: (r.stderr + r.stdout).trim() };
}

async function configInfo(repo) {
  const names = ['user.name', 'user.email', 'remote.origin.url', 'core.ignorecase'];
  const out = {};
  for (const key of names) {
    const r = await run(repo, ['config', '--get', key]);
    out[key] = r.ok ? r.stdout.trim() : '';
  }
  return { ok: true, data: out };
}

async function setConfig(repo, key, value) {
  const allowed = ['user.name', 'user.email'];
  if (!allowed.includes(key)) return { ok: false, message: '不允许修改该配置' };
  const r = await run(repo, ['config', '--local', key, value]);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

module.exports = {
  run,
  isRepo,
  status,
  quickInfo,
  currentBranch,
  log,
  branches,
  remotes,
  diffFile,
  showCommit,
  commitDiff,
  stage,
  stageAll,
  unstage,
  discardPaths,
  discardUntracked,
  commit,
  checkout,
  createBranch,
  renameBranch,
  deleteBranch,
  merge,
  resolveConflict,
  reflog,
  reset,
  branchFrom,
  restoreFileFrom,
  stashPush,
  stashList,
  stashApply,
  stashDrop,
  fetchAll,
  pull,
  push,
  pushSetUpstream,
  configInfo,
  setConfig,
  sanitizePaths,
};
