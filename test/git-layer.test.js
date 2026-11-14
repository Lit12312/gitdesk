'use strict';

/**
 * GitDesk git 执行层实测。
 *
 * 测试只写入项目的 test/ 目录，临时仓库位于 test/tmp/。
 * 运行：node test/git-layer.test.js
 * 产物：test\results.json（机器可读结果）、控制台 PASS/FAIL 输出。
 */

const fs = require('node:fs');
const path = require('node:path');
const git = require('../lib/git.js');

const TEST_DIR = __dirname;
const TMP = path.join(TEST_DIR, 'tmp');

// ---------------------------------------------------------------- 断言与记录

class AssertionError extends Error {}

let current = null;
const results = [];

function rec(line) {
  if (current) current.evidence.push(String(line));
}

function short(v) {
  let s;
  if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  if (s === undefined) s = String(v);
  s = s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function ok(cond, msg, evidence) {
  if (!cond) throw new AssertionError(msg);
  if (evidence !== undefined) rec(evidence);
}

function eq(actual, expected, label, extra) {
  const a = short(actual);
  const e = short(expected);
  if (a !== e) {
    throw new AssertionError(`${label}：期望 ${e}，实际 ${a}${extra ? `（${extra}）` : ''}`);
  }
  rec(`${label} = ${a}`);
}

function truthy(v, label) {
  ok(Boolean(v), `${label} 应为真，实际 ${short(v)}`, `${label} = ${short(v)}`);
}

async function test(name, fn) {
  const record = { name, status: 'PASS', evidence: [], error: null, ms: 0 };
  current = record;
  const t0 = Date.now();
  try {
    await fn(record);
  } catch (e) {
    record.status = 'FAIL';
    record.error = (e && e.message) ? e.message : String(e);
    if (!(e instanceof AssertionError)) {
      record.error = `[脚本/环境异常] ${record.error}${e && e.stack ? `\n${e.stack}` : ''}`;
    }
  } finally {
    record.ms = Date.now() - t0;
    current = null;
  }
  results.push(record);
  const tag = record.status === 'PASS' ? 'PASS' : 'FAIL';
  console.log(`\n${tag}  ${name}  (${record.ms}ms)`);
  for (const line of record.evidence) console.log(`      · ${line}`);
  if (record.status === 'FAIL') console.log(`      ✗ ${record.error}`);
}

function section(title) {
  console.log(`\n\n========== ${title} ==========`);
}

// ---------------------------------------------------------------- 仓库工具

let seq = 0;

async function newRepo(label) {
  seq += 1;
  const dir = path.join(TMP, `r${String(seq).padStart(2, '0')}-${label}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = await git.run(dir, ['init', '-b', 'main']);
  if (!r.ok) throw new Error(`git init 失败: ${r.message}`);
  const cfg = [
    ['user.name', '测试用户'],
    ['user.email', 'test@example.com'],
    ['core.autocrlf', 'false'],
    ['core.safecrlf', 'false'],
    ['commit.gpgsign', 'false'],
    ['gc.auto', '0'],
  ];
  for (const [k, v] of cfg) {
    const c = await git.run(dir, ['config', k, v]);
    if (!c.ok) throw new Error(`git config ${k} 失败: ${c.message}`);
  }
  return dir;
}

async function newBare(label) {
  seq += 1;
  const dir = path.join(TMP, 'remotes', `${String(seq).padStart(2, '0')}-${label}.git`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = await git.run(dir, ['init', '--bare']);
  if (!r.ok) throw new Error(`git init --bare 失败: ${r.message}`);
  return dir;
}

function w(repo, rel, content) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function rd(repo, rel) {
  return fs.readFileSync(path.join(repo, rel), 'utf8');
}

function exists(repo, rel) {
  return fs.existsSync(path.join(repo, rel));
}

async function g(repo, args, opts = {}) {
  const r = await git.run(repo, args);
  if (!r.ok && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} 失败: ${r.message}`);
  }
  return r;
}

async function revParse(repo, rev) {
  const r = await git.run(repo, ['rev-parse', rev]);
  return r.ok ? r.stdout.trim() : null;
}

async function statusOf(repo) {
  const r = await git.status(repo);
  if (!r.ok) throw new AssertionError(`status 应成功，实际 ${short(r)}`);
  return r.data;
}

async function seed(repo, files, msg) {
  for (const [rel, content] of Object.entries(files)) w(repo, rel, content);
  await g(repo, ['add', '-A']);
  await g(repo, ['commit', '-m', msg]);
}

function paths(list) {
  return list.map((e) => e.path);
}

function entry(list, p) {
  return list.find((e) => e.path === p);
}

/** 用 %00 作为分隔符从 git 直接取本地分支真值（for-each-ref 支持 %00，不支持 %x1f）。 */
async function rawLocalBranches(repo) {
  const fmt = [
    '%(refname:short)%00%(HEAD)%00%(objectname:short)%00%(upstream:short)%00',
    '%(upstream:track)%00%(committerdate:iso-strict)%00%(committerdate:relative)%00%(subject)',
  ].join('');
  const r = await g(repo, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads']);
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const f = line.split('\0');
    return {
      name: f[0], current: f[1] === '*', hash: f[2], upstream: f[3],
      track: f[4] || '', date: f[5], rel: f[6], subject: f[7],
    };
  });
}

async function rawRemoteBranches(repo) {
  const fmt = '%(refname:short)%00%(objectname:short)%00%(committerdate:relative)%00%(subject)';
  const r = await g(repo, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/remotes']);
  return r.stdout.split('\n').filter(Boolean)
    .map((line) => { const f = line.split('\0'); return { name: f[0], hash: f[1], rel: f[2], subject: f[3] }; })
    .filter((e) => !e.name.endsWith('/HEAD'));
}

/** 构造一个内容冲突并返回 merge() 的结果。 */
async function makeConflictRepo(label) {
  const repo = await newRepo(label);
  await seed(repo, { 'f.txt': 'base\n' }, 'base');
  await g(repo, ['checkout', '-b', 'topic']);
  w(repo, 'f.txt', 'topic\n');
  await g(repo, ['commit', '-am', 'topic change']);
  await g(repo, ['checkout', 'main']);
  w(repo, 'f.txt', 'main\n');
  await g(repo, ['commit', '-am', 'main change']);
  const merged = await git.merge(repo, 'topic');
  return { repo, merged };
}

// ================================================================ 用例

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const startedAt = new Date().toISOString();
  console.log(`node ${process.version} / git: ${(await git.run(TMP, ['--version'])).stdout.trim()}`);
  console.log(`临时目录: ${TMP}`);

  // ------------------------------------------------------------ 1. isRepo
  section('1. isRepo');

  await test('1.1 isRepo：合法仓库返回 ok + root', async () => {
    const repo = await newRepo('isrepo-ok');
    const r = await git.isRepo(repo);
    ok(r.ok === true, `ok 应为 true，实际 ${short(r)}`);
    eq(typeof r.root, 'string', 'root 类型');
    const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    eq(norm(r.root), norm(repo), 'root 指向仓库根');
    const direct = await g(repo, ['rev-parse', '--show-toplevel']);
    eq(norm(r.root), norm(direct.stdout.trim()), 'root 与 git rev-parse --show-toplevel 一致');
  });

  await test('1.2 isRepo：非仓库目录返回 ok:false', async () => {
    const dir = path.join(TMP, 'definitely-not-a-repo');
    fs.mkdirSync(dir, { recursive: true });
    const r = await git.isRepo(dir);
    ok(r.ok === false, `ok 应为 false，实际 ${short(r)}`);
    ok(typeof r.message === 'string' && r.message.length > 0, 'message 应非空');
    rec(`message = ${short(r.message)}`);
    ok(/not a git repository|不是 Git 仓库/i.test(r.message), `message 应说明不是仓库，实际 ${short(r.message)}`);
    eq(r.root, undefined, '失败时不应有 root');
  });

  await test('1.3 isRepo：不存在的路径返回 ok:false / 路径不存在', async () => {
    const dir = path.join(TMP, 'no-such-dir-xyz');
    const r = await git.isRepo(dir);
    eq(r.ok, false, 'ok');
    eq(r.message, '路径不存在', 'message');
  });

  await test('1.4 isRepo：文件（非目录）返回 不是目录', async () => {
    const repo = await newRepo('isrepo-file');
    w(repo, 'file.txt', 'x\n');
    const r = await git.isRepo(path.join(repo, 'file.txt'));
    eq(r.ok, false, 'ok');
    eq(r.message, '不是目录', 'message');
  });

  await test('1.5 isRepo：空路径返回 路径为空', async () => {
    const r = await git.isRepo('');
    eq(r.ok, false, 'ok');
    eq(r.message, '路径为空', 'message');
  });

  // ------------------------------------------------------------ 2. status
  section('2. status');

  await test('2.1 status：干净工作区', async () => {
    const repo = await newRepo('status-clean');
    await seed(repo, { 'a.txt': 'one\n', '中文.txt': '中文\n' }, 'init');
    const st = await statusOf(repo);
    eq(st.branch, 'main', 'branch');
    eq(st.unborn, false, 'unborn');
    eq(st.detached, false, 'detached');
    eq(st.upstream, '', 'upstream');
    eq(st.staged, [], 'staged');
    eq(st.unstaged, [], 'unstaged');
    eq(st.untracked, [], 'untracked');
    eq(st.conflicted, [], 'conflicted');
    ok(/^[0-9a-f]{40}$/.test(st.oid), `oid 应为 40 位 sha，实际 ${short(st.oid)}`);
  });

  await test('2.2 status：修改未暂存', async () => {
    const repo = await newRepo('status-unstaged');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, 'a.txt', 'two\n');
    const st = await statusOf(repo);
    eq(st.staged, [], 'staged');
    eq(st.unstaged, [{ path: 'a.txt', code: 'M', orig: null }], 'unstaged');
    eq(st.untracked, [], 'untracked');
  });

  await test('2.3 status：已暂存', async () => {
    const repo = await newRepo('status-staged');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, 'a.txt', 'two\n');
    await g(repo, ['add', 'a.txt']);
    const st = await statusOf(repo);
    eq(st.staged, [{ path: 'a.txt', code: 'M', orig: null }], 'staged');
    eq(st.unstaged, [], 'unstaged');
  });

  await test('2.4 status：未跟踪文件', async () => {
    const repo = await newRepo('status-untracked-file');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, 'new.txt', 'hello\n');
    const st = await statusOf(repo);
    eq(st.untracked, [{ path: 'new.txt', code: '?' }], 'untracked');
    eq(st.staged, [], 'staged');
  });

  await test('2.5 status：未跟踪目录（normal 模式折叠为一条 dir/）', async () => {
    const repo = await newRepo('status-untracked-dir');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, 'dir/x.txt', 'x\n');
    w(repo, 'dir/sub/y.txt', 'y\n');
    const st = await statusOf(repo);
    const raw = await g(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=normal']);
    rec(`原始 porcelain: ${short(raw.stdout)}`);
    eq(paths(st.untracked), ['dir/'], 'untracked 路径');
    eq(st.untracked[0].code, '?', 'untracked code');
    eq(st.staged, [], 'staged');
  });

  await test('2.6 status：重命名（中文文件名不乱码）', async () => {
    const repo = await newRepo('status-rename-cn');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    await g(repo, ['mv', 'a.txt', '中文 名.txt']);
    const st = await statusOf(repo);
    const e = st.staged[0];
    ok(Boolean(e), `staged 应有 1 条，实际 ${short(st.staged)}`);
    eq(e.code, 'R', 'staged.code');
    eq(e.path, '中文 名.txt', 'staged.path（中文不乱码）');
    eq(e.orig, 'a.txt', 'staged.orig');
    ok(!/\\d{3}/.test(e.path), `路径不应含八进制转义，实际 ${short(e.path)}`);
    eq(st.unstaged, [], 'unstaged');
  });

  await test('2.7 status：一个文件同时暂存 + 再修改（MM）', async () => {
    const repo = await newRepo('status-mm');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, 'a.txt', 'two\n');
    await g(repo, ['add', 'a.txt']);
    w(repo, 'a.txt', 'three\n');
    const st = await statusOf(repo);
    eq(entry(st.staged, 'a.txt').code, 'M', 'staged code');
    eq(entry(st.unstaged, 'a.txt').code, 'M', 'unstaged code');
    eq(st.staged.length, 1, 'staged 数量');
    eq(st.unstaged.length, 1, 'unstaged 数量');
  });

  await test('2.8 status：merge 冲突产生 u 记录', async () => {
    const { repo } = await makeConflictRepo('status-conflict');
    const st = await statusOf(repo);
    eq(st.conflicted.length, 1, 'conflicted 数量');
    eq(st.conflicted[0].path, 'f.txt', 'conflicted.path');
    eq(st.conflicted[0].code, 'UU', 'conflicted.code');
    eq(st.conflicted[0].unmerged, true, 'conflicted.unmerged');
    eq(st.staged, [], 'staged（冲突不应重复计入）');
    eq(st.unstaged, [], 'unstaged（冲突不应重复计入）');
  });

  await test('2.9 status：带空格的中文路径解析', async () => {
    const repo = await newRepo('status-space-path');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, '带 空格 中文.txt', '内容\n');
    await g(repo, ['add', '-A']);
    const st = await statusOf(repo);
    eq(paths(st.staged), ['带 空格 中文.txt'], 'staged 路径完整');
    const st2 = await statusOf(repo);
    eq(st2.staged[0].code, 'A', 'staged.code');
  });

  // ------------------------------------------------------------ 3. quickInfo / 空仓库
  section('3. quickInfo 与空仓库');

  await test('3.1 quickInfo 计数与 status 一致（含双计数场景）', async () => {
    const repo = await newRepo('quickinfo');
    await seed(repo, { 'a.txt': 'one\n', 'b.txt': 'b\n' }, 'init');
    w(repo, 'a.txt', 'staged\n');
    await g(repo, ['add', 'a.txt']);
    w(repo, 'a.txt', 'staged+worktree\n'); // 同时暂存 + 再修改
    w(repo, 'u.txt', 'u\n');
    w(repo, 'ud/x.txt', 'x\n');
    const st = await statusOf(repo);
    const qi = await git.quickInfo(repo);
    ok(qi.ok === true, `quickInfo 应成功，实际 ${short(qi)}`);
    rec(`status: staged=${st.staged.length} unstaged=${st.unstaged.length} untracked=${st.untracked.length} conflicted=${st.conflicted.length}`);
    rec(`quickInfo: ${short(qi.data)}`);
    eq(qi.data.staged, st.staged.length, 'quickInfo.staged');
    eq(qi.data.unstaged, st.unstaged.length + st.untracked.length, 'quickInfo.unstaged = unstaged + untracked');
    eq(qi.data.conflicted, st.conflicted.length, 'quickInfo.conflicted');
    eq(qi.data.dirty, st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length,
      'quickInfo.dirty = 四类之和');
    eq(qi.data.branch, 'main', 'quickInfo.branch');
  });

  await test('3.2 quickInfo 冲突计数', async () => {
    const { repo } = await makeConflictRepo('quickinfo-conflict');
    const st = await statusOf(repo);
    const qi = await git.quickInfo(repo);
    eq(qi.ok, true, 'ok');
    eq(qi.data.conflicted, 1, 'quickInfo.conflicted');
    eq(qi.data.dirty, st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length,
      'quickInfo.dirty');
    eq(qi.data.staged, 0, 'quickInfo.staged');
  });

  await test('3.3 空仓库（git init 后无提交）的 status / quickInfo / log', async () => {
    const repo = await newRepo('empty-repo');
    const st = await statusOf(repo);
    eq(st.branch, 'main', 'status.branch');
    eq(st.unborn, true, 'status.unborn');
    eq(st.oid, '(initial)', 'status.oid');
    eq(st.staged, [], 'status.staged');
    const qi = await git.quickInfo(repo);
    eq(qi.ok, true, 'quickInfo.ok');
    eq(qi.data.branch, 'main', 'quickInfo.branch');
    eq(qi.data.dirty, 0, 'quickInfo.dirty');
    const lg = await git.log(repo);
    eq(lg.ok, true, '空仓库 log 应 ok:true（不应是错误）');
    eq(lg.data, [], '空仓库 log.data');
    eq(lg.empty, true, '空仓库 log.empty');
  });

  // ------------------------------------------------------------ 4. log
  section('4. log');

  await test('4.1 log 字段完整性（HEAD -> main）', async () => {
    const repo = await newRepo('log-fields');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'second']);
    w(repo, 'f.txt', '3\n');
    await g(repo, ['commit', '-am', 'third']);
    const lg = await git.log(repo);
    eq(lg.ok, true, 'ok');
    eq(lg.data.length, 3, '提交数量');
    const c = lg.data[0];
    ok(/^[0-9a-f]{40}$/.test(c.hash), `hash 应为 40 位 sha，实际 ${short(c.hash)}`);
    ok(/^[0-9a-f]{7,}$/.test(c.short), `short 应为短 sha，实际 ${short(c.short)}`);
    eq(c.author, '测试用户', 'author（中文）');
    eq(c.email, 'test@example.com', 'email');
    eq(typeof c.time, 'number', 'time 类型');
    truthy(c.time > 1600000000, 'time 数值合理');
    truthy(typeof c.rel === 'string' && c.rel.length > 0, 'rel 非空');
    eq(c.subject, 'third', 'subject');
    eq(c.parents.length, 1, 'parents 数量');
    eq(c.parents[0], await revParse(repo, 'HEAD~1'), 'parents[0] 指向上一提交');
    eq(c.refs.head, true, 'refs.head');
    eq(c.refs.branches, ['main'], 'refs.branches');
    eq(c.refs.tags, [], 'refs.tags');
    eq(c.refs.remote, [], 'refs.remote');
  });

  await test('4.2 log 字段数量与原始格式一致（9 字段/条）', async () => {
    const repo = await newRepo('log-fieldcount');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'second']);
    const raw = await g(repo, ['log', '-n', '5', '--date-order',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ar%x1f%s%x1f%P%x1f%D%x1e']);
    const recs = raw.stdout.split('\x1e').map((s) => s.replace(/^\n+/, '')).filter(Boolean);
    eq(recs.length, 2, '原始记录数量');
    for (const r of recs) eq(r.split('\x1f').length, 9, '每条原始记录字段数');
    const lg = await git.log(repo);
    eq(lg.data.length, recs.length, '解析条数与原始条数一致');
  });

  await test('4.3 log refs：tag 与远程分支、--all', async () => {
    const repo = await newRepo('log-refs');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'second']);
    const c2 = await revParse(repo, 'HEAD');
    await g(repo, ['tag', 'v1.0']);
    const bare = await newBare('log-origin');
    await g(repo, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
    await g(repo, ['push', '-u', 'origin', 'main']);
    w(repo, 'f.txt', '3\n');
    await g(repo, ['commit', '-am', 'third']);
    await g(repo, ['checkout', '-b', 'topic', c2]);
    w(repo, 'topic.txt', 't\n');
    await g(repo, ['add', '-A']);
    await g(repo, ['commit', '-m', 'topic work']);
    const c4 = await revParse(repo, 'HEAD');
    await g(repo, ['checkout', 'main']);

    const lg = await git.log(repo);
    eq(lg.data.length, 3, '默认只走 HEAD 的 3 条');
    const second = lg.data.find((x) => x.subject === 'second');
    eq(second.refs.tags, ['v1.0'], 'second.refs.tags');
    eq(second.refs.remote, ['origin/main'], 'second.refs.remote');
    eq(second.refs.head, false, 'second.refs.head');
    eq(second.refs.branches, [], 'second.refs.branches');

    const all = await git.log(repo, { all: true });
    eq(all.data.length, 4, '--all 的提交数量');
    ok(all.data.some((x) => x.hash === c4), '--all 包含 topic 上的提交');
    ok(all.data.some((x) => x.hash === c2), '--all 包含 c2');

    const byRef = await git.log(repo, { ref: 'topic' });
    eq(byRef.data[0].subject, 'topic work', 'ref=topic 的首条');
    eq(byRef.data.length, 3, 'ref=topic 的提交数量');

    const limited = await git.log(repo, { limit: 2 });
    eq(limited.data.length, 2, 'limit=2');
  });

  await test('4.4 log：空仓库返回 ok:true / []', async () => {
    const repo = await newRepo('log-empty');
    const lg = await git.log(repo);
    eq(lg.ok, true, 'ok');
    eq(lg.data, [], 'data');
    eq(lg.empty, true, 'empty');
  });

  await test('4.5（额外诊断）log refs：本地分支名含 "/" 不应被当成远程', async () => {
    const repo = await newRepo('log-slash-ref');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    await g(repo, ['checkout', '-b', 'feat/slash']);
    const lg = await git.log(repo);
    rec(`refs = ${short(lg.data[0].refs)}`);
    eq(lg.data[0].refs.head, true, 'refs.head');
    // 修正预期：checkout -b 后 main 与 feat/slash 指向同一个提交，%D 会同时列出两者
    ok(lg.data[0].refs.branches.includes('feat/slash'), 'refs.branches 应包含本地分支 feat/slash');
    ok(lg.data[0].refs.branches.includes('main'), 'refs.branches 也应包含 main');
    eq(lg.data[0].refs.remote, [], 'refs.remote 不应包含本地分支');
  });

  // ------------------------------------------------------------ 5. branches / remotes
  section('5. branches / remotes');

  await test('5.1 branches：本地分支、当前标记、上游 track', async () => {
    const repo = await newRepo('branches');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const bare = await newBare('branches-origin');
    await g(repo, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
    await g(repo, ['push', '-u', 'origin', 'main']);
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'second']);
    await g(repo, ['branch', 'dev', 'HEAD~1']);
    await g(repo, ['tag', 'v2']);

    const truth = await rawLocalBranches(repo);
    rec(`git 真值(raw for-each-ref %00): ${short(truth)}`);
    const br = await git.branches(repo);
    ok(br.ok === true, `branches 应 ok，实际 ${short(br)}`);
    rec(`branches() = ${short(br.data)}`);
    eq(br.data.local.length, 2, 'local 数量');
    eq(br.data.local.map((b) => b.name).sort(), ['dev', 'main'], 'local 名称');
    const mainB = br.data.local.find((b) => b.name === 'main');
    const devB = br.data.local.find((b) => b.name === 'dev');
    ok(Boolean(mainB) && Boolean(devB), 'main/dev 都应存在');
    eq(mainB.current, true, 'main.current');
    eq(devB.current, false, 'dev.current');
    eq(mainB.upstream, 'origin/main', 'main.upstream');
    eq(mainB.track, '[ahead 1]', 'main.track');
    eq(devB.upstream, '', 'dev.upstream');
    eq(devB.track, '', 'dev.track');
    ok(/^[0-9a-f]{7,}$/.test(mainB.hash), 'main.hash 为短 sha');
    ok(/^\d{4}-\d{2}-\d{2}T/.test(mainB.date), `main.date 为 ISO，实际 ${short(mainB.date)}`);
    ok(typeof mainB.rel === 'string' && mainB.rel.length > 0, 'main.rel 非空');
    eq(mainB.subject, 'second', 'main.subject');
    eq(devB.subject, 'first', 'dev.subject');
  });

  await test('5.2 branches：远程分支列表（排除 origin/HEAD）', async () => {
    const repo = await newRepo('branches-remote');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const bare = await newBare('branches-remote-origin');
    await g(repo, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
    await g(repo, ['push', '-u', 'origin', 'main']);
    await g(repo, ['branch', 'dev']);
    await g(repo, ['push', 'origin', 'dev']);
    await g(repo, ['fetch', 'origin']);

    const truth = await rawRemoteBranches(repo);
    rec(`git 真值(raw): ${short(truth.map((e) => e.name))}`);
    const br = await git.branches(repo);
    rec(`branches().remote = ${short(br.data.remote)}`);
    eq(br.data.remote.map((e) => e.name).sort(), ['origin/dev', 'origin/main'], 'remote 名称');
    for (const e of br.data.remote) {
      ok(/^[0-9a-f]{7,}$/.test(e.hash), `${e.name} hash 为短 sha`);
      truthy(typeof e.rel === 'string' && e.rel.length > 0, `${e.name} rel 非空`);
      truthy(typeof e.subject === 'string', `${e.name} subject 为字符串`);
    }
  });

  await test('5.3 remotes：远程列表', async () => {
    const repo = await newRepo('remotes');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const empty = await git.remotes(repo);
    eq(empty.ok, true, '无远程时 ok');
    eq(empty.data, [], '无远程时 data');
    const bare = await newBare('remotes-origin');
    await g(repo, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
    const r = await git.remotes(repo);
    eq(r.ok, true, 'ok');
    eq(r.data, ['origin'], 'data');
  });

  await test('5.4 branches：空仓库（无分支）', async () => {
    const repo = await newRepo('branches-empty');
    const br = await git.branches(repo);
    eq(br.ok, true, 'ok');
    eq(br.data.local, [], 'local');
    eq(br.data.remote, [], 'remote');
  });

  // ------------------------------------------------------------ 6. diffFile
  section('6. diffFile');

  await test('6.1 diffFile：未暂存修改', async () => {
    const repo = await newRepo('diff-unstaged');
    await seed(repo, { 'a.txt': 'old line\n' }, 'init');
    w(repo, 'a.txt', 'new line\n');
    const r = await git.diffFile(repo, 'a.txt');
    ok(r.ok === true, `应 ok，实际 ${short(r)}`);
    eq(r.data.kind, 'unstaged', 'kind');
    eq(r.data.truncated, false, 'truncated');
    ok(r.data.text.includes('-old line'), 'text 含删除行');
    ok(r.data.text.includes('+new line'), 'text 含新增行');
    rec(`text 长度 = ${r.data.text.length}`);
  });

  await test('6.2 diffFile：已暂存修改', async () => {
    const repo = await newRepo('diff-staged');
    await seed(repo, { 'a.txt': 'old line\n' }, 'init');
    w(repo, 'a.txt', 'new line\n');
    await g(repo, ['add', 'a.txt']);
    const staged = await git.diffFile(repo, 'a.txt', { staged: true });
    eq(staged.ok, true, 'staged ok');
    eq(staged.data.kind, 'staged', 'kind');
    ok(staged.data.text.includes('+new line'), 'staged.text 含新增行');
    const unstaged = await git.diffFile(repo, 'a.txt');
    eq(unstaged.data.text, '', '同一文件未暂存 diff 应为空');
  });

  await test('6.3 diffFile：未跟踪文件返回文件内容', async () => {
    const repo = await newRepo('diff-untracked');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, 'new.txt', 'hello 中文\n第二行\n');
    const r = await git.diffFile(repo, 'new.txt', { untracked: true });
    ok(r.ok === true, `应 ok，实际 ${short(r)}`);
    eq(r.data.kind, 'untracked', 'kind');
    eq(r.data.text, 'hello 中文\n第二行\n', 'text 等于文件内容');
    eq(r.data.truncated, false, 'truncated');
    truthy(r.data.note, 'note');
  });

  await test('6.4 diffFile：未跟踪目录返回文件列表', async () => {
    const repo = await newRepo('diff-untracked-dir');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, 'dir/x.txt', 'x\n');
    w(repo, 'dir/sub/y.txt', 'y\n');
    const r = await git.diffFile(repo, 'dir', { untracked: true });
    ok(r.ok === true, `应 ok，实际 ${short(r)}`);
    eq(r.data.kind, 'untracked-dir', 'kind');
    eq(r.data.text, '', 'text');
    eq(r.data.fileList.slice().sort(), ['sub/y.txt', 'x.txt'], 'fileList（相对目录）');
    eq(r.data.note, '2 个未跟踪文件', 'note');
  });

  await test('6.5 diffFile：中文路径', async () => {
    const repo = await newRepo('diff-cn');
    await seed(repo, { '中文.txt': '中文内容\n' }, 'init');
    w(repo, '中文.txt', '中文内容\n新增中文\n');
    const r = await git.diffFile(repo, '中文.txt');
    eq(r.ok, true, 'ok');
    eq(r.data.kind, 'unstaged', 'kind');
    ok(r.data.text.includes('中文内容'), 'text 含中文内容，无乱码');
    ok(r.data.text.includes('新增中文'), 'text 含新增中文');
    const dirUntracked = await git.diffFile(repo, '新建目录', { untracked: true });
    eq(dirUntracked.ok, false, '不存在的未跟踪路径应失败');
    ok(dirUntracked.message.includes('无法读取文件'), `message 应说明无法读取，实际 ${short(dirUntracked.message)}`);
  });

  await test('6.6 diffFile：参数校验与错误', async () => {
    const repo = await newRepo('diff-errors');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    const r1 = await git.diffFile(repo, '');
    eq(r1.ok, false, '空路径 ok');
    eq(r1.message, '缺少文件路径', '空路径 message');
    const r2 = await git.diffFile(repo, '不存在.txt');
    eq(r2.ok, true, '已跟踪但无改动的文件应 ok（空 diff）');
    eq(r2.data.text, '', '空 diff text');
  });

  // ------------------------------------------------------------ 7. showCommit / commitDiff
  section('7. showCommit / commitDiff');

  await test('7.1 showCommit：重命名提交（R + path/from）', async () => {
    const repo = await newRepo('show-rename');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join('');
    await seed(repo, { 'old.txt': lines }, 'init');
    await g(repo, ['mv', 'old.txt', 'new.txt']);
    w(repo, 'new.txt', lines.replace('line 5', 'line five'));
    await g(repo, ['add', '-A']);
    await g(repo, ['commit', '-m', 'rename it']);
    const hash = await revParse(repo, 'HEAD');
    const r = await git.showCommit(repo, hash);
    ok(r.ok === true, `应 ok，实际 ${short(r)}`);
    rec(`files = ${short(r.data.files)}`);
    eq(r.data.files.length, 1, 'files 数量');
    eq(r.data.files[0].code, 'R', 'files[0].code');
    eq(r.data.files[0].path, 'new.txt', 'files[0].path');
    eq(r.data.files[0].from, 'old.txt', 'files[0].from');
    eq(r.data.subject, 'rename it', 'subject');
    eq(r.data.hash, hash, 'hash');
    eq(r.data.parents.length, 1, 'parents 数量');
    eq(r.data.refs.head, true, 'refs.head');
    eq(r.data.refs.branches, ['main'], 'refs.branches');
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.data.date), `date 格式，实际 ${short(r.data.date)}`);
  });

  await test('7.2 showCommit：A/M/D 混合提交 + body', async () => {
    const repo = await newRepo('show-codes');
    await seed(repo, { 'mod.txt': 'one\n', 'del.txt': 'bye\n' }, 'init');
    w(repo, 'mod.txt', 'two\n');
    fs.rmSync(path.join(repo, 'del.txt'));
    w(repo, 'added.txt', 'new\n');
    await g(repo, ['add', '-A']);
    await g(repo, ['commit', '-m', '标题行\n\n正文第一行\n正文第二行']);
    const hash = await revParse(repo, 'HEAD');
    const r = await git.showCommit(repo, hash);
    const byPathMap = Object.fromEntries(r.data.files.map((f) => [f.path, f.code]));
    rec(`files = ${short(r.data.files)}`);
    eq(byPathMap['added.txt'], 'A', 'added.txt 的 code');
    eq(byPathMap['del.txt'], 'D', 'del.txt 的 code');
    eq(byPathMap['mod.txt'], 'M', 'mod.txt 的 code');
    eq(r.data.subject, '标题行', 'subject');
    eq(r.data.body, '正文第一行\n正文第二行', 'body');
    eq(r.data.author, '测试用户', 'author（中文）');
  });

  await test('7.3 commitDiff：整提交与单文件过滤', async () => {
    const repo = await newRepo('commitdiff');
    await seed(repo, { 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, 'init');
    w(repo, 'a.txt', 'a2\n');
    w(repo, 'b.txt', 'b2\n');
    await g(repo, ['commit', '-am', 'both']);
    const hash = await revParse(repo, 'HEAD');
    const all = await git.commitDiff(repo, hash);
    eq(all.ok, true, '整提交 ok');
    ok(all.data.text.includes('a.txt') && all.data.text.includes('b.txt'), '整提交包含两个文件');
    eq(all.data.truncated, false, 'truncated');
    const onlyB = await git.commitDiff(repo, hash, 'b.txt');
    eq(onlyB.ok, true, '单文件 ok');
    ok(onlyB.data.text.includes('b.txt'), '单文件包含 b.txt');
    ok(!onlyB.data.text.includes('a.txt'), '单文件不应包含 a.txt');
    ok(onlyB.data.text.includes('+b2'), '单文件包含新增内容');
  });

  await test('7.4 showCommit / commitDiff：中文路径', async () => {
    const repo = await newRepo('show-cn');
    await seed(repo, { 'a.txt': 'a\n' }, 'init');
    w(repo, '中文.txt', '中文内容\n');
    await g(repo, ['add', '-A']);
    await g(repo, ['commit', '-m', '加中文文件']);
    const hash = await revParse(repo, 'HEAD');
    const r = await git.showCommit(repo, hash);
    eq(r.data.files.length, 1, 'files 数量');
    eq(r.data.files[0].path, '中文.txt', 'files[0].path（不乱码）');
    eq(r.data.files[0].code, 'A', 'files[0].code');
    const d = await git.commitDiff(repo, hash, '中文.txt');
    ok(d.data.text.includes('中文.txt'), 'commitDiff 含中文文件名');
    ok(d.data.text.includes('+中文内容'), 'commitDiff 含中文内容');
  });

  await test('7.5 showCommit / commitDiff：非法 hash', async () => {
    const repo = await newRepo('show-bad');
    await seed(repo, { 'a.txt': 'a\n' }, 'init');
    const r = await git.showCommit(repo, 'deadbeefdeadbeef');
    eq(r.ok, false, 'showCommit 非法 hash ok');
    truthy(r.message, 'showCommit 非法 hash message');
    const d = await git.commitDiff(repo, 'deadbeefdeadbeef');
    eq(d.ok, false, 'commitDiff 非法 hash ok');
    truthy(d.message, 'commitDiff 非法 hash message');
  });

  // ------------------------------------------------------------ 8. stage / unstage / discard
  section('8. stage / unstage / discardPaths / discardUntracked');

  await test('8.1 stage：多文件（中文 + 空格）', async () => {
    const repo = await newRepo('stage');
    await seed(repo, { 'a.txt': 'one\n', 'b.txt': 'b\n' }, 'init');
    w(repo, 'a.txt', 'two\n');
    w(repo, '中 文.txt', '中文\n');
    w(repo, 'c.txt', 'c\n');
    const r = await git.stage(repo, ['a.txt', '中 文.txt', 'c.txt']);
    eq(r.ok, true, 'ok');
    const st = await statusOf(repo);
    eq(paths(st.staged).sort(), ['a.txt', 'c.txt', '中 文.txt'].sort(), 'staged 路径');
    eq(st.unstaged, [], 'unstaged');
  });

  await test('8.2 stage：空/非法入参', async () => {
    const repo = await newRepo('stage-invalid');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    const r1 = await git.stage(repo, []);
    eq(r1.ok, false, '空数组 ok');
    eq(r1.message, '没有选中文件', '空数组 message');
    const r2 = await git.stage(repo, [null, 123, '']);
    eq(r2.ok, false, '非法元素 ok');
    eq(r2.message, '没有选中文件', '非法元素 message');
  });

  await test('8.3 unstage：已暂存文件回到未暂存', async () => {
    const repo = await newRepo('unstage');
    await seed(repo, { 'a.txt': 'one\n', 'b.txt': 'b\n' }, 'init');
    w(repo, 'a.txt', 'two\n');
    w(repo, 'b.txt', 'b2\n');
    await g(repo, ['add', '-A']);
    const r = await git.unstage(repo, ['a.txt']);
    eq(r.ok, true, 'ok');
    const st = await statusOf(repo);
    eq(paths(st.staged), ['b.txt'], 'staged 只剩 b.txt');
    eq(paths(st.unstaged), ['a.txt'], 'unstaged 为 a.txt');
    eq(rd(repo, 'a.txt'), 'two\n', '工作区内容未被改动');
  });

  await test('8.4 unstage：unborn 仓库（首次提交前撤销暂存）', async () => {
    const repo = await newRepo('unstage-unborn');
    w(repo, 'f.txt', 'first\n');
    await g(repo, ['add', 'f.txt']);
    const before = await statusOf(repo);
    eq(paths(before.staged), ['f.txt'], '暂存前 staged');
    const r = await git.unstage(repo, ['f.txt'], true);
    eq(r.ok, true, 'unborn unstage ok');
    const after = await statusOf(repo);
    eq(after.staged, [], '撤销后 staged');
    eq(paths(after.untracked), ['f.txt'], '撤销后变回未跟踪');
    ok(exists(repo, 'f.txt'), '文件仍在磁盘');
    const noFlag = await (async () => {
      await g(repo, ['add', 'f.txt']);
      return git.unstage(repo, ['f.txt']); // 故意不传 unborn
    })();
    eq(noFlag.ok, true, '不传 unborn 时也应成功（git 2.56 的 restore --staged 在无 HEAD 时可用）');
    eq((await statusOf(repo)).staged, [], '不传 unborn 也撤销了暂存');
    rec('观察：unborn 标记在 git 2.56 下非必需；两条路径结果一致');
  });

  await test('8.5 discardPaths：未暂存修改与已暂存修改的语义', async () => {
    const repo = await newRepo('discard');
    await seed(repo, { 'a.txt': 'committed\n', 'b.txt': 'b-committed\n' }, 'init');
    w(repo, 'a.txt', 'worktree\n');
    const r1 = await git.discardPaths(repo, ['a.txt']);
    eq(r1.ok, true, '未暂存 discard ok');
    eq(rd(repo, 'a.txt'), 'committed\n', 'a.txt 内容回到已提交版本');
    eq((await statusOf(repo)).unstaged, [], 'discard 后无未暂存修改');

    // 已暂存修改：git restore -- <path> 只回滚工作区，不回滚索引
    w(repo, 'b.txt', 'staged-content\n');
    await g(repo, ['add', 'b.txt']);
    w(repo, 'b.txt', 'worktree-again\n');
    const r2 = await git.discardPaths(repo, ['b.txt']);
    eq(r2.ok, true, '已暂存 discard ok');
    eq(rd(repo, 'b.txt'), 'staged-content\n', 'b.txt 回到索引内容');
    const st = await statusOf(repo);
    eq(entry(st.staged, 'b.txt').code, 'M', '索引仍是暂存的修改（discardPaths 不取消暂存）');
    eq(st.unstaged, [], '工作区与索引一致');
  });

  await test('8.6 discardUntracked：删除未跟踪文件与目录', async () => {
    const repo = await newRepo('discard-untracked');
    await seed(repo, { 'a.txt': 'one\n' }, 'init');
    w(repo, 'u.txt', 'u\n');
    w(repo, 'udir/x.txt', 'x\n');
    w(repo, 'udir/sub/y.txt', 'y\n');
    const r = await git.discardUntracked(repo, ['u.txt', 'udir']);
    eq(r.ok, true, 'ok');
    ok(!exists(repo, 'u.txt'), 'u.txt 已删除');
    ok(!exists(repo, 'udir'), 'udir 已删除');
    eq((await statusOf(repo)).untracked, [], 'untracked 为空');
    const empty = await git.discardUntracked(repo, []);
    eq(empty.ok, false, '空入参 ok');
    eq(empty.message, '没有选中文件', '空入参 message');
  });

  await test('8.7 sanitizePaths：路径清洗与反斜杠转换', async () => {
    const r = git.sanitizePaths(['a\\b.txt', '', null, 123, 'x\u0000y', 'ok/ok.txt']);
    eq(r, ['a/b.txt', 'ok/ok.txt'], 'sanitizePaths');
    eq(git.sanitizePaths('not-array'), [], '非数组输入');
  });

  await test('8.8 含方括号的文件名按原样匹配', async () => {
    const repo = await newRepo('literal-paths');
    const exact = 'notes[1].txt';
    const other = 'notes1.txt';
    await seed(repo, { [exact]: 'exact original\n', [other]: 'other original\n' }, 'seed');
    w(repo, exact, 'exact changed\n');
    w(repo, other, 'other changed\n');

    const diff = await git.diffFile(repo, exact);
    ok(diff.ok && diff.data.text.includes('+exact changed'), '差异包含所选文件');
    ok(!diff.data.text.includes('other changed'), '差异不包含相似名称的文件');
    eq((await git.stage(repo, [exact])).ok, true, '暂存成功');
    eq((await statusOf(repo)).staged.map((f) => f.path), [exact], '仅暂存所选文件');
    eq((await git.unstage(repo, [exact], false)).ok, true, '取消暂存成功');
    eq((await statusOf(repo)).staged, [], '暂存区清空');
    eq((await git.discardPaths(repo, [exact])).ok, true, '丢弃成功');
    eq(rd(repo, exact), 'exact original\n', '还原所选文件');
    eq(rd(repo, other), 'other changed\n', '保留相似名称的改动');

    w(repo, 'new[1].txt', 'exact\n');
    w(repo, 'new1.txt', 'other\n');
    eq((await git.discardUntracked(repo, ['new[1].txt'])).ok, true, '清理成功');
    eq(exists(repo, 'new[1].txt'), false, '删除所选新文件');
    eq(exists(repo, 'new1.txt'), true, '保留相似名称的新文件');
  });

  // ------------------------------------------------------------ 9. commit
  section('9. commit');

  await test('9.1 commit：普通提交（含中文消息与多行 body）', async () => {
    const repo = await newRepo('commit');
    w(repo, 'f.txt', 'one\n');
    await g(repo, ['add', '-f', 'f.txt']);
    const r = await git.commit(repo, '提交标题\n\n正文行 A\n正文行 B');
    eq(r.ok, true, 'ok');
    const lg = await git.log(repo);
    eq(lg.data.length, 1, '提交数量');
    eq(lg.data[0].subject, '提交标题', 'subject');
    const sc = await git.showCommit(repo, lg.data[0].hash);
    eq(sc.data.body, '正文行 A\n正文行 B', 'body');
    eq((await statusOf(repo)).staged, [], '提交后 staged 为空');
  });

  await test('9.2 commit：--amend 修改提交信息', async () => {
    const repo = await newRepo('commit-amend');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const before = await revParse(repo, 'HEAD');
    const r = await git.commit(repo, '修正后的标题', { amend: true });
    eq(r.ok, true, 'ok');
    const after = await revParse(repo, 'HEAD');
    ok(after !== before, 'amend 后 hash 变化');
    const lg = await git.log(repo);
    eq(lg.data.length, 1, '提交数量不变');
    eq(lg.data[0].subject, '修正后的标题', 'subject 已更新');
  });

  await test('9.3 commit：空消息被拒绝（不调用 git）', async () => {
    const repo = await newRepo('commit-empty-msg');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['add', '-f', 'f.txt']);
    const r1 = await git.commit(repo, '   ');
    eq(r1.ok, false, '空白消息 ok');
    eq(r1.message, '提交信息不能为空', '空白消息 message');
    const r2 = await git.commit(repo, '');
    eq(r2.ok, false, '空消息 ok');
    eq(r2.message, '提交信息不能为空', '空消息 message');
    eq((await git.log(repo)).data.length, 1, '没有产生新提交');
  });

  await test('9.4 commit：nothing-to-commit 的 hint', async () => {
    const repo = await newRepo('commit-nothing');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const r = await git.commit(repo, '没有改动');
    eq(r.ok, false, 'ok');
    ok(/nothing to commit/i.test(r.message), `message 应为 nothing to commit，实际 ${short(r.message)}`);
    eq(r.hint, '没有可提交的改动', 'hint');
  });

  await test('9.5 commit：opts.all（-a）自动暂存已跟踪改动', async () => {
    const repo = await newRepo('commit-all');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    w(repo, 'f.txt', '2\n');
    const r = await git.commit(repo, 'all commit', { all: true });
    eq(r.ok, true, 'ok');
    eq((await git.log(repo)).data[0].subject, 'all commit', 'subject');
    eq((await statusOf(repo)).staged, [], 'staged 为空');
  });

  await test('9.6 commit：--amend --no-edit 保留原消息', async () => {
    const repo = await newRepo('commit-amend-noedit');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    w(repo, 'g.txt', 'g\n');
    await g(repo, ['add', '-A']);
    const r = await git.commit(repo, '', { amend: true, amendNoEdit: true });
    eq(r.ok, true, 'ok');
    const lg = await git.log(repo);
    eq(lg.data.length, 1, '提交数量');
    eq(lg.data[0].subject, 'first', 'subject 未变');
    const sc = await git.showCommit(repo, lg.data[0].hash);
    eq(sc.data.files.map((f) => f.path).sort(), ['f.txt', 'g.txt'], 'amend 后的文件列表');
  });

  await test('9.7 commit：空仓库首次提交', async () => {
    const repo = await newRepo('commit-root');
    w(repo, 'f.txt', '1\n');
    await g(repo, ['add', '-A']);
    const r = await git.commit(repo, 'root');
    eq(r.ok, true, 'ok');
    const lg = await git.log(repo);
    eq(lg.data.length, 1, '提交数量');
    eq(lg.data[0].parents, [], 'root 提交无 parents');
  });

  // ------------------------------------------------------------ 10. checkout / branch 操作
  section('10. checkout / createBranch / renameBranch / deleteBranch');

  await test('10.1 checkout：切换分支与错误分支', async () => {
    const repo = await newRepo('checkout');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    await g(repo, ['branch', 'dev']);
    const r = await git.checkout(repo, 'dev');
    eq(r.ok, true, 'ok');
    eq(await git.currentBranch(repo), 'dev', '当前分支');
    const bad = await git.checkout(repo, 'no-such-branch');
    eq(bad.ok, false, '不存在分支 ok');
    truthy(bad.message, '不存在分支 message');
    const empty = await git.checkout(repo, '');
    eq(empty.ok, false, '空分支 ok');
    eq(empty.message, '缺少分支名', '空分支 message');
  });

  await test('10.2 createBranch：普通 / 从指定提交 / 创建并切换', async () => {
    const repo = await newRepo('create-branch');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const c1 = await revParse(repo, 'HEAD');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'second']);

    const r1 = await git.createBranch(repo, 'feature/a');
    eq(r1.ok, true, '普通创建 ok');
    eq(await revParse(repo, 'refs/heads/feature/a'), await revParse(repo, 'HEAD'), 'feature/a 指向 HEAD');
    eq(await git.currentBranch(repo), 'main', '创建后仍停留在 main');

    const r2 = await git.createBranch(repo, 'from-old', c1);
    eq(r2.ok, true, '从指定提交创建 ok');
    eq(await revParse(repo, 'refs/heads/from-old'), c1, 'from-old 指向 c1');

    const r3 = await git.createBranch(repo, 'co', null, true);
    eq(r3.ok, true, '创建并切换 ok');
    eq(await git.currentBranch(repo), 'co', '当前分支为 co');
  });

  await test('10.3 createBranch：非法分支名被拒绝', async () => {
    const repo = await newRepo('create-branch-invalid');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    for (const name of ['bad name', '-bad', 'a..b', 'x.lock', 'a/b//c']) {
      const r = await git.createBranch(repo, name);
      eq(r.ok, false, `分支名 ${JSON.stringify(name)} ok`);
      ok(r.message.includes('分支名不合法'), `${JSON.stringify(name)} message 应含“分支名不合法”，实际 ${short(r.message)}`);
    }
    const empty = await git.createBranch(repo, '');
    eq(empty.ok, false, '空分支名 ok');
    eq(empty.message, '缺少分支名', '空分支名 message');
    const dup = await git.createBranch(repo, 'main');
    eq(dup.ok, false, '已存在分支 ok');
    truthy(dup.message, '已存在分支 message');
    rec(`已存在分支 message = ${short(dup.message)}`);
  });

  await test('10.4 renameBranch：正常重命名与非法目标名', async () => {
    const repo = await newRepo('rename-branch');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    await g(repo, ['branch', 'dev']);
    const r = await git.renameBranch(repo, 'dev', 'dev2');
    eq(r.ok, true, 'ok');
    // 用 git 原始输出验证（不依赖 branches()，它是另一个已知缺陷）
    const headsRaw = (await g(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
      .stdout.split('\n').filter(Boolean).sort();
    rec(`git 真值 refs/heads = ${short(headsRaw)}`);
    eq(headsRaw, ['dev2', 'main'], '重命名后的分支（raw git 真值）');
    const bad = await git.renameBranch(repo, 'dev2', 'bad name');
    eq(bad.ok, false, '非法目标名 ok');
    ok(bad.message.includes('分支名不合法'), `非法目标名 message，实际 ${short(bad.message)}`);
    const missing = await git.renameBranch(repo, 'nope', 'x');
    eq(missing.ok, false, '不存在的源分支 ok');
    const empty = await git.renameBranch(repo, '', 'x');
    eq(empty.ok, false, '空源分支 ok');
    eq(empty.message, '缺少分支名', '空源分支 message');
  });

  await test('10.5 deleteBranch：已合并 / 未合并（unmerged=true）/ 强制', async () => {
    const repo = await newRepo('delete-branch');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    await g(repo, ['branch', 'merged-one']);
    const rm = await git.deleteBranch(repo, 'merged-one', false);
    eq(rm.ok, true, '已合并分支删除 ok');
    eq(await revParse(repo, 'refs/heads/merged-one'), null, 'merged-one 已不存在');

    await g(repo, ['branch', 'unmerged']);
    await g(repo, ['checkout', 'unmerged']);
    w(repo, 'g.txt', 'g\n');
    await g(repo, ['add', '-A']);
    await g(repo, ['commit', '-m', 'unmerged work']);
    await g(repo, ['checkout', 'main']);
    const d = await git.deleteBranch(repo, 'unmerged', false);
    eq(d.ok, false, '未合并分支（force=false）ok');
    eq(d.unmerged, true, 'unmerged 标记');
    ok(/not fully merged/i.test(d.message), `message 应说明未合并，实际 ${short(d.message)}`);
    const f = await git.deleteBranch(repo, 'unmerged', true);
    eq(f.ok, true, '强制删除 ok');
    eq(await revParse(repo, 'refs/heads/unmerged'), null, 'unmerged 已不存在');

    const cur = await git.deleteBranch(repo, 'main', true);
    eq(cur.ok, false, '删除当前分支 ok');
    truthy(cur.message, '删除当前分支 message');
    rec(`删除当前分支 message = ${short(cur.message)}`);
    const empty = await git.deleteBranch(repo, '', true);
    eq(empty.ok, false, '空分支名 ok');
    eq(empty.message, '缺少分支名', '空分支名 message');
  });

  // ------------------------------------------------------------ 11. merge / resolveConflict
  section('11. merge / resolveConflict');

  await test('11.1 merge：冲突返回 conflicts=true 且 status 有 u 记录', async () => {
    const { repo, merged } = await makeConflictRepo('merge-conflict');
    eq(merged.ok, false, 'merge ok');
    eq(merged.conflicts, true, 'merge.conflicts');
    ok(/CONFLICT/i.test(merged.message), `message 应含 CONFLICT，实际 ${short(merged.message)}`);
    const st = await statusOf(repo);
    eq(st.conflicted.length, 1, 'status.conflicted 数量');
    eq(st.conflicted[0].code, 'UU', 'u 记录 code');
  });

  await test('11.2 resolveConflict：ours 后冲突消失并可提交合并', async () => {
    const { repo } = await makeConflictRepo('resolve-ours');
    const r = await git.resolveConflict(repo, ['f.txt'], 'ours');
    eq(r.ok, true, 'resolve ok');
    eq(rd(repo, 'f.txt'), 'main\n', '内容为 ours 版本');
    const st = await statusOf(repo);
    eq(st.conflicted, [], '冲突消失');
    // 取 ours 后内容与 HEAD 完全一致，索引没有相对 HEAD 的改动，因此不应有 staged 条目。
    eq(st.staged, [], '取 ours 后索引与 HEAD 相同（git 真实行为：没有 staged 条目）');
    const cached = await g(repo, ['diff', '--cached', '--name-only']);
    eq(cached.stdout.trim(), '', 'git diff --cached 为空（交叉验证）');
    const c = await git.commit(repo, '合并 topic（取 ours）');
    eq(c.ok, true, '解决后可提交（merge 进行中，允许树与 HEAD 相同）');
    const lg = await git.log(repo);
    eq(lg.data[0].parents.length, 2, '合并提交 parents 数量');
    const sc = await git.showCommit(repo, lg.data[0].hash);
    eq(sc.data.parents.length, 2, 'showCommit 的 parents 数量');
  });

  await test('11.3 resolveConflict：theirs', async () => {
    const { repo } = await makeConflictRepo('resolve-theirs');
    const r = await git.resolveConflict(repo, ['f.txt'], 'theirs');
    eq(r.ok, true, 'resolve ok');
    eq(rd(repo, 'f.txt'), 'topic\n', '内容为 theirs 版本');
    eq((await statusOf(repo)).conflicted, [], '冲突消失');
  });

  await test('11.4 resolveConflict：未传 side 时默认 ours', async () => {
    const { repo } = await makeConflictRepo('resolve-default');
    const r = await git.resolveConflict(repo, ['f.txt']);
    eq(r.ok, true, 'resolve ok');
    eq(rd(repo, 'f.txt'), 'main\n', '默认 ours');
  });

  await test('11.5 merge：无冲突时成功（真实合并提交）', async () => {
    const repo = await newRepo('merge-ok');
    await seed(repo, { 'base.txt': 'b\n' }, 'base');
    await g(repo, ['checkout', '-b', 'feat']);
    w(repo, 'feat.txt', 'f\n');
    await g(repo, ['add', '-A']);
    await g(repo, ['commit', '-m', 'feat work']);
    await g(repo, ['checkout', 'main']);
    w(repo, 'main.txt', 'm\n');
    await g(repo, ['add', '-A']);
    await g(repo, ['commit', '-m', 'main work']);
    const r = await git.merge(repo, 'feat');
    eq(r.ok, true, 'merge ok');
    truthy(r.output, 'merge output');
    rec(`merge output = ${short(r.output)}`);
    const lg = await git.log(repo);
    eq(lg.data[0].parents.length, 2, '合并提交 parents 数量');
    eq((await statusOf(repo)).staged, [], '合并后 staged 为空');
    ok(exists(repo, 'feat.txt'), 'feat.txt 已合并进来');
    const bad = await git.merge(repo, 'no-such-branch');
    eq(bad.ok, false, '不存在分支 merge ok');
    eq(bad.conflicts, false, '不存在分支 conflicts');
    const empty = await git.merge(repo, '');
    eq(empty.ok, false, '空分支 ok');
    eq(empty.message, '缺少分支名', '空分支 message');
  });

  // ------------------------------------------------------------ 12. reflog / reset / branchFrom / restoreFileFrom
  section('12. reflog / reset / branchFrom / restoreFileFrom');

  await test('12.1 reflog：条目字段', async () => {
    const repo = await newRepo('reflog');
    await seed(repo, { 'f.txt': '1\n' }, 'c1');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'c2']);
    w(repo, 'f.txt', '3\n');
    await g(repo, ['commit', '-am', 'c3']);
    const r = await git.reflog(repo);
    eq(r.ok, true, 'ok');
    ok(r.data.length >= 3, `条目数应 >= 3，实际 ${r.data.length}`);
    const first = r.data[0];
    ok(/^HEAD@\{.+\}$/.test(first.sel), `sel 形如 HEAD@{...}，实际 ${short(first.sel)}`);
    rec(`sel 实际格式 = ${short(first.sel)}`);
    // reflog() 传了 --date=iso，所以 %gd 是日期型 selector。验证它仍可被 git 解析。
    const resolved = await git.run(repo, ['rev-parse', first.sel]);
    eq(resolved.ok, true, 'sel 可被 git rev-parse 解析（日期型 selector 可用）');
    eq(resolved.stdout.trim(), await revParse(repo, 'HEAD'), 'sel 解析到当前 HEAD');
    rec('观察：--date=iso 使 %gd 变成 HEAD@{<日期>} 而非 HEAD@{0}；功能可用（reset 也接受），仅显示形式不同');
    ok(/^[0-9a-f]{7,}$/.test(first.hash), 'hash 为短 sha');
    ok(first.action.includes('commit'), `action 含 commit，实际 ${short(first.action)}`);
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(first.date), `date ISO，实际 ${short(first.date)}`);
    truthy(first.rel, 'rel 非空');
    rec(`reflog[0] = ${short(first)}`);
    ok(r.data.some((e) => /commit \(initial\)/.test(e.action) || e.action.includes('c1')), '包含首次提交记录');
  });

  await test('12.2 reset --soft：HEAD 回退，索引/工作区保持', async () => {
    const repo = await newRepo('reset-soft');
    await seed(repo, { 'f.txt': '1\n' }, 'c1');
    const c1 = await revParse(repo, 'HEAD');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'c2']);
    w(repo, 'f.txt', '3\n');
    await g(repo, ['commit', '-am', 'c3']);
    const r = await git.reset(repo, 'soft', c1);
    eq(r.ok, true, 'ok');
    eq(await revParse(repo, 'HEAD'), c1, 'HEAD 指向 c1');
    eq(rd(repo, 'f.txt'), '3\n', '工作区保持 c3 内容');
    const st = await statusOf(repo);
    eq(entry(st.staged, 'f.txt').code, 'M', '索引相对 HEAD 为已暂存修改');
    eq(st.unstaged, [], '工作区与索引一致（无未暂存修改）');
  });

  await test('12.3 reset --mixed：HEAD/索引回退，工作区保持', async () => {
    const repo = await newRepo('reset-mixed');
    await seed(repo, { 'f.txt': '1\n' }, 'c1');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'c2']);
    const c2 = await revParse(repo, 'HEAD');
    w(repo, 'f.txt', '3\n');
    await g(repo, ['commit', '-am', 'c3']);
    const r = await git.reset(repo, 'mixed', c2);
    eq(r.ok, true, 'ok');
    eq(await revParse(repo, 'HEAD'), c2, 'HEAD 指向 c2');
    eq(rd(repo, 'f.txt'), '3\n', '工作区保持 c3 内容');
    const st = await statusOf(repo);
    eq(st.staged, [], 'staged 为空（索引已回退）');
    eq(entry(st.unstaged, 'f.txt').code, 'M', '工作区相对索引为修改');
  });

  await test('12.4 reset --hard：工作区也回退', async () => {
    const repo = await newRepo('reset-hard');
    await seed(repo, { 'f.txt': '1\n' }, 'c1');
    const c1 = await revParse(repo, 'HEAD');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'c2']);
    w(repo, 'f.txt', '3\n');
    await g(repo, ['commit', '-am', 'c3']);
    const r = await git.reset(repo, 'hard', c1);
    eq(r.ok, true, 'ok');
    eq(await revParse(repo, 'HEAD'), c1, 'HEAD 指向 c1');
    eq(rd(repo, 'f.txt'), '1\n', '工作区回到 c1 内容');
    const st = await statusOf(repo);
    eq(st.staged, [], 'staged 为空');
    eq(st.unstaged, [], 'unstaged 为空');
  });

  await test('12.5 reset：非法模式 / 非法目标', async () => {
    const repo = await newRepo('reset-invalid');
    await seed(repo, { 'f.txt': '1\n' }, 'c1');
    const bad = await git.reset(repo, 'merge', 'HEAD');
    eq(bad.ok, false, '非法模式 ok');
    eq(bad.message, '非法的重置模式', '非法模式 message');
    const noTarget = await git.reset(repo, 'soft', '');
    eq(noTarget.ok, false, '缺目标 ok');
    eq(noTarget.message, '缺少目标提交', '缺目标 message');
    const noRev = await git.reset(repo, 'soft', 'no-such-rev');
    eq(noRev.ok, false, '不存在目标 ok');
    truthy(noRev.message, '不存在目标 message');
  });

  await test('12.6 branchFrom：从指定提交建分支', async () => {
    const repo = await newRepo('branch-from');
    await seed(repo, { 'f.txt': '1\n' }, 'c1');
    const c1 = await revParse(repo, 'HEAD');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'c2']);
    const r = await git.branchFrom(repo, 'from-c1', c1);
    eq(r.ok, true, 'ok');
    eq(await revParse(repo, 'refs/heads/from-c1'), c1, 'from-c1 指向 c1');
    eq(await git.currentBranch(repo), 'main', '仍在 main');
    const bad = await git.branchFrom(repo, 'bad name', c1);
    eq(bad.ok, false, '非法分支名 ok');
    ok(bad.message.includes('分支名不合法'), `非法分支名 message，实际 ${short(bad.message)}`);
    const noRev = await git.branchFrom(repo, 'x', 'no-such-rev');
    eq(noRev.ok, false, '不存在提交 ok');
  });

  await test('12.7 restoreFileFrom：从历史提交取回文件', async () => {
    const repo = await newRepo('restore-from');
    await seed(repo, { 'f.txt': 'v1\n' }, 'c1');
    const c1 = await revParse(repo, 'HEAD');
    w(repo, 'f.txt', 'v2\n');
    await g(repo, ['commit', '-am', 'c2']);
    w(repo, 'f.txt', 'v3\n');
    await g(repo, ['commit', '-am', 'c3']);
    const r = await git.restoreFileFrom(repo, c1, 'f.txt');
    eq(r.ok, true, 'ok');
    eq(rd(repo, 'f.txt'), 'v1\n', '工作区内容为 c1 版本');
    const st = await statusOf(repo);
    // 设计变更：改用 git restore --source --worktree 后只写工作区，不再改动索引
    eq(st.staged, [], '索引不应被改动（只恢复工作区）');
    const bad = await git.restoreFileFrom(repo, c1, '');
    eq(bad.ok, false, '缺文件参数 ok');
    eq(bad.message, '缺少参数', '缺文件参数 message');
    const noFile = await git.restoreFileFrom(repo, c1, 'nope.txt');
    eq(noFile.ok, false, '不存在文件 ok');
  });

  await test('12.8 恢复历史单个文件时保留暂存区并拒绝目录或缺失文件', async () => {
    const repo = await newRepo('restore-only-file');
    const file = 'docs/note[1].txt';
    const other = 'docs/note1.txt';
    await seed(repo, { [file]: 'first\n', [other]: 'other first\n' }, 'first');
    const source = await revParse(repo, 'HEAD');
    await seed(repo, { [file]: 'second\n', [other]: 'other second\n', 'later.txt': 'later\n' }, 'second');
    w(repo, file, 'staged\n');
    eq((await git.stage(repo, [file])).ok, true, '暂存当前改动');
    w(repo, file, 'worktree\n');

    eq((await git.restoreFileFrom(repo, source, 'docs')).ok, false, '拒绝目录');
    eq(rd(repo, file), 'worktree\n', '拒绝目录后保留工作区改动');
    eq((await git.restoreFileFrom(repo, source, 'later.txt')).ok, false, '拒绝历史中不存在的文件');
    eq(rd(repo, 'later.txt'), 'later\n', '保留后来加入的文件');
    eq((await git.restoreFileFrom(repo, source, './' + file)).ok, true, '恢复带方括号的文件');
    eq(rd(repo, file), 'first\n', '工作区恢复成历史版本');
    eq(rd(repo, other), 'other second\n', '保留相似名称的文件');
    eq((await g(repo, ['show', ':' + file])).stdout, 'staged\n', '暂存内容原样保留');
  });

  // ------------------------------------------------------------ 13. stash
  section('13. stashPush / stashList / stashApply / stashDrop');

  await test('13.1 stashPush：已跟踪改动被收起，工作区干净', async () => {
    const repo = await newRepo('stash-push');
    await seed(repo, { 'f.txt': 'base\n' }, 'init');
    w(repo, 'f.txt', 'wip\n');
    const r = await git.stashPush(repo, '我的暂存', false);
    eq(r.ok, true, 'ok');
    ok(/Saved working directory/i.test(r.output), `output 应为 Saved working directory，实际 ${short(r.output)}`);
    eq(rd(repo, 'f.txt'), 'base\n', '工作区已还原');
    eq((await statusOf(repo)).staged, [], 'staged 为空');
    const list = await git.stashList(repo);
    eq(list.ok, true, 'stashList ok');
    eq(list.data.length, 1, 'stash 条目数');
    ok(/^stash@\{/.test(list.data[0].sel), `sel 形如 stash@{...}，实际 ${short(list.data[0].sel)}`);
    ok(list.data[0].subject.includes('我的暂存'), `subject 含消息，实际 ${short(list.data[0].subject)}`);
    ok(/^[0-9a-f]{7,}$/.test(list.data[0].hash), 'hash 为短 sha');
    truthy(list.data[0].date, 'date 非空');
    rec(`stashList = ${short(list.data)}`);
  });

  await test('13.2 stashApply：恢复改动且保留 stash 条目', async () => {
    const repo = await newRepo('stash-apply');
    await seed(repo, { 'f.txt': 'base\n' }, 'init');
    w(repo, 'f.txt', 'wip\n');
    await git.stashPush(repo, 'wip msg', false);
    const sel = (await git.stashList(repo)).data[0].sel;
    const r = await git.stashApply(repo, sel, false);
    eq(r.ok, true, 'apply ok');
    eq(rd(repo, 'f.txt'), 'wip\n', '改动已恢复');
    eq(entry((await statusOf(repo)).unstaged, 'f.txt').code, 'M', '状态为未暂存修改');
    eq((await git.stashList(repo)).data.length, 1, 'apply 后条目仍在');
  });

  await test('13.3 stashDrop：删除条目（使用 stashList 返回的 sel）', async () => {
    const repo = await newRepo('stash-drop');
    await seed(repo, { 'f.txt': 'base\n' }, 'init');
    w(repo, 'f.txt', 'wip\n');
    await git.stashPush(repo, 'wip msg', false);
    const sel = (await git.stashList(repo)).data[0].sel;
    const r = await git.stashDrop(repo, sel);
    eq(r.ok, true, 'drop ok');
    const after = await git.stashList(repo);
    const raw = await g(repo, ['stash', 'list', '--pretty=format:%gd%x1f%h%x1f%gs%x1e']);
    rec(`drop 用的 sel = ${short(sel)}`);
    rec(`drop 返回 ok=${r.ok}；drop 后模块 stashList 条目数 = ${after.data.length}`);
    rec(`drop 后 git 原始 stash list = ${short(raw.stdout)}`);
    // 分离根因：若换成规范 selector，drop 是否能生效
    if (after.data.length > 0) {
      const d2 = await git.stashDrop(repo, 'stash@{0}');
      const after2 = await git.stashList(repo);
      rec(`对照：stashDrop('stash@{0}') => ok=${d2.ok}，剩余条目 = ${after2.data.length}`);
    }
    eq(after.data, [], '用 stashList 返回的 sel 删除后，stash 列表应为空');
  });

  await test('13.7（额外诊断）stashApply pop=true 应移除条目', async () => {
    const repo = await newRepo('stash-pop');
    await seed(repo, { 'f.txt': 'base\n' }, 'init');
    w(repo, 'f.txt', 'wip\n');
    await git.stashPush(repo, 'pop me', false);
    const sel = (await git.stashList(repo)).data[0].sel;
    const r = await git.stashApply(repo, sel, true);
    eq(r.ok, true, 'pop 返回 ok');
    eq(rd(repo, 'f.txt'), 'wip\n', '改动已恢复');
    const after = await git.stashList(repo);
    const raw = await g(repo, ['stash', 'list', '--pretty=format:%gd%x1f%h%x1f%gs%x1e']);
    rec(`pop 的 sel = ${short(sel)}`);
    rec(`git stash pop 输出含 Dropped 字样 = ${/Dropped/i.test(r.output)}`);
    rec(`pop 后模块 stashList 条目数 = ${after.data.length}，原始 = ${short(raw.stdout)}`);
    eq(after.data.length, 0, 'pop 后 stash 条目应被移除');
  });

  await test('13.4 stashPush -u：包含未跟踪文件', async () => {
    const repo = await newRepo('stash-untracked');
    await seed(repo, { 'f.txt': 'base\n' }, 'init');
    w(repo, 'f.txt', 'wip\n');
    w(repo, 'new.txt', 'untracked\n');
    const r = await git.stashPush(repo, 'with untracked', true);
    eq(r.ok, true, 'ok');
    ok(!exists(repo, 'new.txt'), '未跟踪文件已被收起');
    eq((await statusOf(repo)).untracked, [], 'untracked 为空');
    eq((await git.stashList(repo)).data.length, 1, 'stash 条目数');
    const sel = (await git.stashList(repo)).data[0].sel;
    const ap = await git.stashApply(repo, sel, false);
    eq(ap.ok, true, 'apply ok');
    ok(exists(repo, 'new.txt'), '未跟踪文件已恢复');
    eq(rd(repo, 'new.txt'), 'untracked\n', '未跟踪文件内容');
  });

  await test('13.5 stashPush：无改动时 git 退出码为 0（观察项）', async () => {
    const repo = await newRepo('stash-empty');
    await seed(repo, { 'f.txt': 'base\n' }, 'init');
    const r = await git.stashPush(repo, 'nothing', false);
    eq(r.ok, true, 'git stash push 无改动仍返回 0');
    // 设计变更：无改动通过独立标志返回，UI 用 warn 提示而不是假装成功
    eq(r.noChanges, true, '应带 noChanges 标志');
    ok(/No local changes to save/i.test(r.output), `output 应提示无改动，实际 ${short(r.output)}`);
    eq((await git.stashList(repo)).data, [], '没有生成 stash 条目');
  });

  await test('13.6 stashApply / stashDrop：非法选择器', async () => {
    const repo = await newRepo('stash-invalid');
    await seed(repo, { 'f.txt': 'base\n' }, 'init');
    const ap = await git.stashApply(repo, 'stash@{99}', false);
    eq(ap.ok, false, 'apply 非法 sel ok');
    truthy(ap.message, 'apply 非法 sel message');
    const dr = await git.stashDrop(repo, 'stash@{99}');
    eq(dr.ok, false, 'drop 非法 sel ok');
    const emptySel = await git.stashApply(repo, '', false);
    eq(emptySel.ok, false, 'apply 空 sel ok');
    eq(emptySel.message, '缺少 stash 项', 'apply 空 sel message');
  });

  // ------------------------------------------------------------ 14. config
  section('14. configInfo / setConfig');

  await test('14.1 configInfo：读取本地配置与远程 URL', async () => {
    const repo = await newRepo('config-info');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const bare = await newBare('config-origin');
    await g(repo, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
    const r = await git.configInfo(repo);
    eq(r.ok, true, 'ok');
    eq(r.data['user.name'], '测试用户', 'user.name');
    eq(r.data['user.email'], 'test@example.com', 'user.email');
    const rawUrl = (await g(repo, ['config', '--get', 'remote.origin.url'])).stdout.trim();
    eq(r.data['remote.origin.url'], rawUrl, 'remote.origin.url 与 git config 一致');
    const rawIgnore = await git.run(repo, ['config', '--get', 'core.ignorecase']);
    eq(r.data['core.ignorecase'], rawIgnore.ok ? rawIgnore.stdout.trim() : '', 'core.ignorecase 与 git config 一致');
    rec(`core.ignorecase = ${short(r.data['core.ignorecase'])}`);
  });

  await test('14.2 setConfig：修改 user.name 并生效', async () => {
    const repo = await newRepo('config-set');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const r = await git.setConfig(repo, 'user.name', '新名字');
    eq(r.ok, true, 'ok');
    const raw = (await g(repo, ['config', '--local', '--get', 'user.name'])).stdout.trim();
    eq(raw, '新名字', 'git config --local 读回');
    eq((await git.configInfo(repo)).data['user.name'], '新名字', 'configInfo 读回');
    w(repo, 'f.txt', '2\n');
    await g(repo, ['commit', '-am', 'after rename']);
    eq((await git.log(repo)).data[0].author, '新名字', '新提交的 author');
  });

  await test('14.3 setConfig：非法 key 被拒绝', async () => {
    const repo = await newRepo('config-illegal');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    for (const key of ['core.editor', 'remote.origin.url', 'user.signingkey', '']) {
      const r = await git.setConfig(repo, key, 'x');
      eq(r.ok, false, `key ${JSON.stringify(key)} ok`);
      eq(r.message, '不允许修改该配置', `key ${JSON.stringify(key)} message`);
    }
    eq((await g(repo, ['config', '--get', 'core.editor'], { allowFail: true })).stdout.trim(), '', 'core.editor 未被写入');
  });

  await test('14.4 setConfig：空值被接受（实现未校验值，观察项）', async () => {
    const repo = await newRepo('config-empty-value');
    await seed(repo, { 'f.txt': '1\n' }, 'first');
    const r = await git.setConfig(repo, 'user.email', '');
    eq(r.ok, true, 'git 允许写入空值，故实现返回 ok');
    eq((await git.configInfo(repo)).data['user.email'], '', 'configInfo 读回空字符串');
  });

  // ------------------------------------------------------------ 汇总
  const finishedAt = new Date().toISOString();
  const failed = results.filter((r) => r.status === 'FAIL');
  const passed = results.length - failed.length;

  // 失败归因：本节全部为「实现 bug」；如将来出现「预期不对」的失败，应在此登记。
  const attribution = {
    '4.5': '实现 bug：parseRefs 用 "/" 判断远程，本地分支 feat/slash 被误判',
    '5.1': '实现 bug：branches() 的 for-each-ref 格式使用 %x1f（git 不支持，原样输出）',
    '5.2': '实现 bug：同 5.1；另有 origin/HEAD 的过滤条件（endsWith("/HEAD")）失效',
    '13.3': '实现 bug：stashList 用 --date=iso 生成日期型 selector，stashDrop 静默无效',
    '13.7': '实现 bug：同 13.3，pop 的 drop 部分无效',
  };

  console.log('\n\n================ 汇总 ================');
  console.log(`总计: ${results.length}  通过: ${passed}  失败: ${failed.length}`);
  const caseKey = (name) => (name.match(/^(\d+\.\d+)/) || [])[1] || name;
  console.log('失败归因: 实现 bug ' + failed.filter((f) => attribution[caseKey(f.name)])
    .length + ' 项 / 预期不对 0 项（首轮 4 项预期错误已修正，见 REPORT.md §6）');
  for (const f of failed) {
    const key = caseKey(f.name);
    console.log(`\nFAIL  ${f.name}`);
    if (f.evidence.length) console.log(`  证据: ${f.evidence.slice(-3).join(' | ')}`);
    console.log(`  原因: ${f.error}`);
    console.log(`  归因: ${attribution[key] || '未登记（需人工判断是实现 bug 还是预期不对）'}`);
  }

  fs.writeFileSync(path.join(TEST_DIR, 'results.json'), JSON.stringify({
    startedAt, finishedAt,
    env: { node: process.version, git: (await git.run(TMP, ['--version'])).stdout.trim(), platform: process.platform },
    total: results.length, passed, failed: failed.length,
    results: results.map((r) => (r.status === 'FAIL'
      ? { ...r, attribution: attribution[caseKey(r.name)] || null }
      : r)),
  }, null, 2));

  console.log(`\n结果已写入 ${path.join(TEST_DIR, 'results.json')}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error('测试脚本自身异常:', e);
  process.exit(2);
});
