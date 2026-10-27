// 按主文件夹算项目（docs/specs/file-system.md §11.3、§11.7、§11.8；验收 §19.2 FS-102 的单元层）：Mori worktree 里的会话
// （工作路径 <R>\.mori\worktrees\<名字>[\<sub>]）读写主文件夹的项目记忆：projectDir 与 claimProject 按项目文件夹，
// project.json 记主文件夹，worktree 路径不报 This project’s memory folder belongs to …，mori.memory_changed 的 cwd 是主文件夹；
// 增强读主文件夹和它的 worktree 里的会话与反馈，增强会话自己在主文件夹里运行，增强提示（takeNotice）也按主文件夹；
// 模型层的 projectContext、registerProject、projectAccess 按主文件夹（.mori/models.json 从主文件夹读，Project access 只列主文件夹）；
// 角色从 <projectFolder>/.mori/agents 读；界面的本次信任回答与记忆页跟随的项目按主文件夹。不在 Mori worktree 里的会话
// （子文件夹、.claude\worktrees\x、名字不是 Mori 取的）结果与现在相同。
// 按路径认主文件夹不调 git、不读 worktree 里的文件（§11.3），所以这里不建真实的 worktree：worktree 的工作路径是临时目录里
// synthetic 的文件夹（有的根本不建）。会话文件、反馈、enhance.json、角色文件与模型配置都是测试手写的（synthetic）；
// 会话表、模型层的 pi 运行时、看不见的增强会话与界面的后台进程都是替身（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from '../load.mjs';
import { PAGE, freshUserData, loadMemoryKernel, ok } from '../memory/core-helpers.mjs';
import {
  at, enhanceJson, enhancer, ended, listedFeedback, listedSessions, messageOf, readEnhance, runSetup, turn, until,
  writeEnhance, writeFeedback, writeSession,
} from '../memory/enhance-harness.mjs';
import { bridge, loadRendererModules } from './renderer-load.mjs';

const WS = await loadKernelModule('src/shared/workspace.ts');
const K = await loadMemoryKernel();
const F = await loadKernelModule('src/kernel/feedbackRead.ts');
const ROLES = await loadKernelModule('src/kernel/roles.ts');
const ML = await loadKernelModule('src/kernel/modelLayer.ts');
const MC = await loadKernelModule('src/kernel/modelConfig.ts');

/** §11.2 那样取出的两个名字 */
const NAME = 'fix-login-3fa9c1';
const NAME2 = 'add-search-0b12ef';
/** 只看 TASTE：STRATEGY、REVIEW 的 doneThrough 在很后面，它们没有该跑的日子 */
const ONLY_TASTE = { strategy: { doneThrough: '2026-12-31' }, review: { doneThrough: '2026-12-31' } };
/** 记忆与 pi 读的环境变量（场景里会设，测试结束时还原） */
const PI_ENV = ['PI_OFFLINE', 'PI_TELEMETRY', 'PI_CODING_AGENT_DIR'];

/** @brief 主文件夹 main 里名为 name 的 Mori worktree 的工作路径；sub 为子文件夹（主文件夹在仓库子文件夹里时）。 */
function treeOf(main, name = NAME, sub = null) {
  const root = join(main, '.mori', 'worktrees', name);
  return sub ? join(root, sub) : root;
}

/** @brief 记忆的项目目录名（memoryFiles.ts projectDirName 那种编码，这里独立算出）。 */
const dirName = (cwd) => `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

/** @brief 记下 PI_ENV 现在的值，测试结束时还原（场景与 Project access 的测试会改它们）。 */
function keepPiEnv(t) {
  const saved = PI_ENV.map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** @brief 这个测试里内核记的错误日志收进数组、不打印；测试结束后换回。 */
function quiet(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  t.after(() => {
    console.error = original;
  });
  return lines;
}

/** @brief 一个项目目录的 project.json。 */
function ownerOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
}

// ---- §11.3：按路径认主文件夹 ----

test('FS-102 projectFolder: a Mori worktree gives its main folder (with the subfolder); other paths are themselves',
  () => {
    const main = 'D:\\work\\tool';
    assert.equal(WS.projectFolder(main), main);
    assert.equal(WS.projectFolder(treeOf(main)), main);
    assert.equal(WS.projectFolder(treeOf(main, NAME, 'app')), 'D:\\work\\tool\\app');
    for (const own of ['D:\\work\\tool\\web', 'D:\\work\\tool\\.claude\\worktrees\\x',
      'D:\\work\\tool\\.mori\\worktrees\\Fix_Login', 'D:\\work\\tool\\.mori\\worktrees']) {
      assert.equal(WS.projectFolder(own), own, `${own} is not in a Mori worktree`);
    }
  });

// ---- 记忆（memory.ts、memoryFiles.ts、memory 工具） ----

/** @brief agent 调用方的 memory 工具（真实的 memoryTool），在工作路径 cwd 的会话里；位置是 synthetic 的。 */
function agentTool(cwd) {
  return K.memoryTool({ cwd, caller: { kind: 'agent' }, run: null, scope: null,
    position: () => ({ session: null, entry: null, title: 'Chat (synthetic)' }) });
}

/** @brief 在 cwd 的会话里用 memory 工具记一条本项目的事实；返回结果的文字、是否出错与 details。 */
async function saveFact(cwd, abstract) {
  const call = await agentTool(cwd).execute('call-1', { action: 'save', kind: 'fact', abstract,
    quote: `note this: ${abstract}` });
  return { text: call.content[0].text, isError: call.isError === true, details: call.details };
}

test('FS-102 the memory tool in a worktree session writes the main folder’s project memory; project.json records '
  + 'the main folder and mori.memory_changed carries it', async (t) => {
  const { cwd: main, events, memoryRoot } = freshUserData(t, K);
  const tree = treeOf(main);
  const saved = await saveFact(tree, 'Uses pnpm');
  assert.deepEqual([saved.text, saved.isError], ['Saved to Facts (this project): Uses pnpm', false]);
  const own = K.projectDir(main);
  assert.deepEqual(K.projectDir(tree), own, 'the same project folder, not occupied');
  assert.deepEqual([basename(own.dir), own.error], [dirName(main), null]);
  assert.deepEqual(ownerOf(own.dir), { cwd: resolve(main) }, 'project.json records the main folder');
  assert.equal(existsSync(join(memoryRoot, 'projects', dirName(tree))), false, 'no project folder of the worktree');
  assert.deepEqual(events, [{ type: 'mori.memory_changed', cwd: main, layers: ['project'], kinds: ['fact'],
    revision: saved.details.revision }]);
  assert.equal((await K.revision(main, 'project', saved.details.revision)).revision.cwd, main);
  assert.deepEqual((await K.list(main, 'project', 'fact')).entries.map((row) => row.abstract), ['Uses pnpm']);
  // 主文件夹自己照常写（project.json 记的就是它）；另一个 worktree 的会话读到两条，新会话的快照也是
  ok(await K.save(PAGE, { cwd: main, layer: 'project', kind: 'fact', abstract: 'Node 22', detail: '',
    evidence: [] }));
  const second = treeOf(main, NAME2);
  assert.deepEqual((await K.list(second, 'project', 'fact')).entries.map((row) => row.abstract),
    ['Uses pnpm', 'Node 22']);
  assert.deepEqual((await K.abstracts(second)).project.fact, ['Uses pnpm', 'Node 22']);
  const page = ok(await K.save(PAGE, { cwd: second, layer: 'project', kind: 'taste', abstract: 'Short answers',
    detail: '', evidence: [] }));
  assert.deepEqual(events.at(-1), { type: 'mori.memory_changed', cwd: main, layers: ['project'], kinds: ['taste'],
    revision: page.revision });
  assert.deepEqual(ownerOf(own.dir), { cwd: resolve(main) }, 'project.json is not rewritten by a worktree');
});

test('FS-102 a main folder that already has project memory is not occupied for its worktrees; a worktree of a '
  + 'subfolder writes that subfolder’s project', async (t) => {
  const { cwd: main, events } = freshUserData(t, K);
  ok(await K.save(PAGE, { cwd: main, layer: 'project', kind: 'fact', abstract: 'Main first', detail: '',
    evidence: [] }));
  const saved = await saveFact(treeOf(main), 'From the worktree');
  assert.deepEqual([saved.text, saved.isError], ['Saved to Facts (this project): From the worktree', false]);
  assert.deepEqual((await K.list(main, 'project', 'fact')).entries.map((row) => row.abstract),
    ['Main first', 'From the worktree']);
  const sub = join(main, 'app');
  const subTree = treeOf(main, NAME, 'app');
  assert.equal(K.projectDir(subTree).dir, K.projectDir(sub).dir);
  assert.notEqual(K.projectDir(subTree).dir, K.projectDir(main).dir, 'the subfolder is a project of its own');
  const subSaved = await saveFact(subTree, 'App uses Vite');
  assert.equal(subSaved.isError, false);
  assert.deepEqual(ownerOf(K.projectDir(sub).dir), { cwd: resolve(sub) });
  assert.equal(events.at(-1).cwd, sub, 'mori.memory_changed carries the subfolder (the worktree’s main folder)');
  assert.deepEqual((await K.list(main, 'project', 'fact')).entries.map((row) => row.abstract),
    ['Main first', 'From the worktree'], 'the main folder of the repository root is not touched');
});

test('FS-102 the encoding check compares main folders: a worktree of a folder whose project folder is claimed by '
  + 'another folder is refused like that folder', async (t) => {
  const { userData } = freshUserData(t, K);
  const first = join(userData, 'work', 'a-b');
  const second = join(userData, 'work', 'a', 'b');
  ok(await K.save(PAGE, { cwd: first, layer: 'project', kind: 'fact', abstract: 'Mine', detail: '', evidence: [] }));
  const owner = `This project’s memory folder belongs to ${first}.`;
  assert.equal(K.projectDir(treeOf(second)).error, owner);
  const refused = await saveFact(treeOf(second), 'Theirs');
  assert.deepEqual([refused.text, refused.isError], [owner, true]);
  assert.equal(K.projectDir(treeOf(first)).error, null, 'the owner’s own worktree is not refused');
  assert.equal((await saveFact(treeOf(first), 'Also mine')).isError, false);
});

test('FS-102 sessions outside Mori worktrees keep their own project: subfolders, .claude\\worktrees\\x and names '
  + 'Mori doesn’t give', async (t) => {
  const { cwd: main, events } = freshUserData(t, K);
  ok(await K.save(PAGE, { cwd: main, layer: 'project', kind: 'fact', abstract: 'Main', detail: '', evidence: [] }));
  const others = [join(main, 'web'), join(main, '.claude', 'worktrees', 'x'), treeOf(main, 'Fix_Login'),
    join(main, '.mori', 'worktrees')];
  for (const cwd of others) {
    assert.deepEqual([basename(K.projectDir(cwd).dir), K.projectDir(cwd).error], [dirName(cwd), null], cwd);
    assert.deepEqual((await K.abstracts(cwd)).project.fact, [], `${cwd} does not see the main folder’s memory`);
  }
  const web = others[0];
  const saved = await saveFact(web, 'Web uses Next');
  assert.equal(saved.isError, false);
  assert.deepEqual(ownerOf(K.projectDir(web).dir), { cwd: resolve(web) });
  assert.equal(events.at(-1).cwd, web);
  assert.deepEqual((await K.list(main, 'project', 'fact')).entries.map((row) => row.abstract), ['Main']);
});

test('FS-102 enhance.set from a worktree session on a fresh project claims the main folder (writeProjectJson)',
  async (t) => {
    const { userData, cwd: main, memoryRoot } = freshUserData(t, K);
    await K.startEnhance({ userData, emitGlobal: () => undefined,
      clock: { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined } });
    const tree = treeOf(main);
    const set = await K.setEnhance(tree, { time: '05:00' });
    assert.deepEqual([set.error, set.info.time], [null, '05:00']);
    const own = K.projectDir(main);
    assert.deepEqual(ownerOf(own.dir), { cwd: resolve(main) }, 'project.json records the main folder');
    assert.equal(own.error, null, 'the main folder is not occupied by its worktree');
    assert.equal(existsSync(join(memoryRoot, 'projects', dirName(tree))), false, 'no project folder of the worktree');
    const info = await K.enhanceInfo(main);
    assert.deepEqual([info.error, info.time], [null, '05:00'], 'the main folder reads the setting');
    ok(await K.save(PAGE, { cwd: main, layer: 'project', kind: 'fact', abstract: 'Main writes too', detail: '',
      evidence: [] }));
  });

// ---- 增强与反馈（enhanceRun.ts、feedbackRead.ts、enhance.ts 的 takeNotice） ----

/**
 * @brief 增强的场景：主文件夹 shop 和它的 worktree 里的会话，另有 worktree 的子文件夹、.claude\worktrees\x 与别的项目的
 *        worktree 里的会话（都不该读）；反馈同样。返回会话文件。
 */
function seedDay(env, main) {
  const tree = treeOf(main);
  const files = {
    main: writeSession(env.agentDir, { id: 'main', cwd: main, at: at('2026-10-22', '08:59'),
      items: turn('a1', '2026-10-22', '09:00', 'Plan the release') }),
    tree: writeSession(env.agentDir, { id: 'tree', cwd: tree, at: at('2026-10-22', '09:59'),
      items: turn('b1', '2026-10-22', '10:00', 'Fix the login page') }),
  };
  const outside = [join(tree, 'web'), join(main, '.claude', 'worktrees', 'x'), treeOf(env.project('blog'))];
  outside.forEach((cwd, i) => writeSession(env.agentDir, { id: `out${i}`, cwd, at: at('2026-10-22', '10:30'),
    items: turn(`c${i}`, '2026-10-22', '11:00') }));
  writeFeedback(env.userData, { name: 'fb-tree.json', cwd: tree, at: at('2026-10-22', '11:00'), sessionFile: files.tree,
    entryId: 'b1a', expected: 'Lead with the answer', quote: 'Answer b1' });
  outside.forEach((cwd, i) => writeFeedback(env.userData, { name: `fb-out${i}.json`, cwd,
    at: at('2026-10-22', '12:00') }));
  return files;
}

/** @brief 这次运行里看不见的会话写一条 TASTE（synthetic，同 memory 工具带着运行的句柄写），依据是 worktree 里的会话。 */
function tasteWrite(env, treeFile) {
  return (spec) => ({ act: async () => {
    const saved = await env.k.memory.save(enhancer('taste', spec.run), { cwd: spec.cwd, layer: 'project',
      kind: 'taste', abstract: 'Lead with the answer', detail: '', evidence: [{ at: '2026-10-22', session: treeFile,
        entry: 'b1u', title: 'Fix the login page', quote: 'Fix the login page' }] });
    if (saved.error !== null) throw new Error(saved.error);
  } });
}

test('FS-102 enhancement reads the sessions and feedback of the main folder and its worktrees, runs in the main '
  + 'folder, and a worktree session takes the notice', async (t) => {
  keepPiEnv(t);
  const env = await runSetup(t, at('2026-10-23', '05:00'));
  const main = env.project('shop');
  const files = seedDay(env, main);
  writeEnhance(env.k.memory, main, enhanceJson({ since: '2026-10-20', doneThrough: '2026-10-21', tasks: ONLY_TASTE }));
  env.script = tasteWrite(env, files.tree);
  await env.startEnhance();
  assert.equal((await ended(env, main, 'taste', '2026-10-22')).phase, 'done');
  const message = messageOf(env, 'taste', '2026-10-22');
  assert.deepEqual(listedSessions(message).map((item) => [item.title, item.file]),
    [['Plan the release', files.main], ['Fix the login page', files.tree]],
    'a worktree of a subfolder, .claude\\worktrees\\x and another project’s worktree are not listed');
  assert.deepEqual(listedFeedback(message), ['- fb-tree.json · hoped for: “Lead with the answer” · about: '
    + `“Answer b1” in ${files.tree} (entry b1a)`]);
  assert.deepEqual(env.built.map((record) => [record.spec.cwd, record.actError]), [[main, null]],
    'the enhancement session itself runs in the main folder');
  assert.deepEqual(readEnhance(env.k.memory, main).tasks.taste.watermarks,
    { [files.main]: 'a1a', [files.tree]: 'b1a' });
  const [row] = (await env.k.memory.revisions(main, 'project')).revisions;
  const { revision } = await env.k.memory.revision(main, 'project', row.id);
  assert.deepEqual([revision.cwd, revision.run.sessions, revision.run.feedback], [main, 2, 1]);
  const changed = env.events.filter((event) => event.type === 'mori.memory_changed');
  assert.ok(changed.length > 0 && changed.every((event) => event.cwd === main), JSON.stringify(changed));
  // 新建的 worktree 会话取走主文件夹的增强提示（§11.7：takeNotice 经 projectDir），快照里有这条
  assert.deepEqual(await env.k.enhance.takeNotice(treeOf(main, NAME2)), { revisions: [row.id],
    counts: { taste: 1, strategy: 0, review: 0 }, from: '2026-10-22', to: '2026-10-22' });
  assert.equal(await env.k.enhance.takeNotice(main), null, 'taken once for the whole project');
  assert.deepEqual((await env.k.memory.abstracts(treeOf(main))).project.taste, ['Lead with the answer']);
});

test('FS-102 feedback from a worktree session goes to its main folder; outside Mori worktrees nothing changes',
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mori-fs-fb-'));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
    const main = join(root, 'work', 'shop');
    const day = (name, cwd, time) => writeFeedback(root, { name, cwd, at: at('2026-10-22', time) });
    day('a-main.json', main, '09:00');
    day('b-tree.json', treeOf(main), '10:00');
    day('c-tree2.json', treeOf(main, NAME2), '11:00');
    day('d-sub.json', treeOf(main, NAME, 'web'), '12:00');
    day('e-web.json', join(main, 'web'), '13:00');
    day('f-claude.json', join(main, '.claude', 'worktrees', 'x'), '14:00');
    const from = at('2026-10-22', '04:00');
    const to = at('2026-10-23', '04:00');
    const names = async (cwd) => (await F.dayFeedback(root, cwd, from, to, null)).map((item) => item.name);
    assert.deepEqual(await names(main), ['a-main.json', 'b-tree.json', 'c-tree2.json']);
    assert.deepEqual(await names(join(main, 'web')), ['d-sub.json', 'e-web.json'],
      'the worktree of a subfolder belongs to that subfolder');
    assert.deepEqual(await names(join(main, '.claude', 'worktrees', 'x')), ['f-claude.json']);
    assert.deepEqual(await names(treeOf(main)), [], 'a worktree path is never a project of its own');
  });

// ---- 角色（roles.ts loadRoles） ----

/** @brief 写一个合格的角色文件 <dir>/.mori/agents/<name>.md（synthetic）。 */
function writeRole(dir, name, seats) {
  mkdirSync(join(dir, '.mori', 'agents'), { recursive: true });
  const seatLine = seats ? [`seats: ${seats}`] : [];
  const lines = ['---', `name: ${name}`, `description: The ${name} role (synthetic)`, ...seatLine, '---',
    `Work as the ${name}.`];
  writeFileSync(join(dir, '.mori', 'agents', `${name}.md`), `${lines.join('\n')}\n`);
}

test('FS-102 roles of a worktree session come from the main folder’s .mori/agents; other folders read their own',
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mori-fs-roles-'));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
    const main = join(root, 'tool');
    writeRole(main, 'reviewer', '[close]');
    writeRole(join(main, 'app'), 'planner', '[create]');
    const tree = treeOf(main);
    mkdirSync(tree, { recursive: true });
    const deps = { pickExists: () => false, parseFrontmatter };
    const names = async (cwd) => (await ROLES.loadRoles(cwd, deps)).roles.map((role) => [role.name, role.file]);
    const reviewer = [['reviewer', '.mori/agents/reviewer.md'], ['mori', null]];
    assert.deepEqual(await names(tree), reviewer, 'the worktree has no .mori/agents of its own');
    const load = await ROLES.loadRoles(tree, deps);
    assert.deepEqual([load.problems, load.holders], [[], { dialog: 'mori', create: 'mori', close: 'reviewer' }]);
    writeRole(tree, 'stale', null);
    assert.deepEqual(await names(tree), reviewer, 'a copy inside the worktree is not read');
    assert.deepEqual(await names(treeOf(main, NAME, 'app')), [['planner', '.mori/agents/planner.md'], ['mori', null]]);
    assert.deepEqual(await names(join(main, 'web')), [['mori', null]], 'a subfolder does not read its parent’s roles');
    assert.deepEqual(await names(main), reviewer);
  });

// ---- 模型层（modelLayer.ts 的 projectContext、registerProject、projectAccess） ----

/**
 * @brief 模型层的配置（synthetic）：一个本机提供商、一个分组 team。2026-10-26 起没有网络区域与 Project access
 *        （合进来的那条线，WP-05），FS-102 在模型层只查项目配置 .mori/models.json 按主文件夹读。
 */
function layerConfig() {
  const p = { id: 'p', name: 'P', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9000/p',
    compat: {}, concurrency: 4, keys: [{ ref: 'p#1', label: 'Key 1' }], nextKeyNumber: 2,
    models: [{ id: 'm1', family: '', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] }] };
  return { version: 1, providers: [p], groups: [{ id: 'team', members: ['p'] }], normalDefault: 'p/m1' };
}

/** @brief pi 运行时的替身（synthetic）：只记下注册的提供商。 */
function fakeRuntime() {
  return {
    registered: new Map(),
    registerProvider(id, input) { this.registered.set(id, input); },
    unregisterProvider(id) { this.registered.delete(id); },
    async refresh() {},
    getModel() { return undefined; },
    getProviders() { return []; },
  };
}

/** @brief 临时目录里的模型层，载入 config；key 是测试用的假值。 */
async function scratchLayer(t, root, config) {
  const dir = join(root, 'userData');
  mkdirSync(dir, { recursive: true });
  const paths = { config: join(dir, 'model-config.json'), profiles: join(dir, 'model-profiles.json'),
    notice: join(dir, 'model-migration.json'), v0Models: join(dir, 'agent', 'models.json') };
  writeFileSync(paths.config, JSON.stringify(config));
  const layer = new ML.ModelLayer(fakeRuntime(), MC.reservedIds(['openai']), paths, () => {});
  await layer.load({ 'p#1': 'sk-synthetic' }, ['p#1'], null);
  return layer;
}

/** @brief 主文件夹 tool（有 .mori/models.json）与它的 worktree（自己那份是坏的）的模型层。 */
async function modelProject(t) {
  quiet(t);
  const root = mkdtempSync(join(tmpdir(), 'mori-fs-ml-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const main = join(root, 'tool');
  mkdirSync(join(main, '.mori'), { recursive: true });
  writeFileSync(join(main, '.mori', 'models.json'), JSON.stringify({ groups: { team: ['p/m1'] } }));
  const tree = treeOf(main);
  mkdirSync(join(tree, '.mori'), { recursive: true });
  writeFileSync(join(tree, '.mori', 'models.json'), '{ "groups": ');
  const layer = await scratchLayer(t, root, layerConfig());
  return { root, main, tree, layer };
}

test('FS-102 projectContext of a worktree session reads the main folder’s .mori/models.json', async (t) => {
  const { main, tree, layer } = await modelProject(t);
  const own = { project: { groups: { team: ['p/m1'] } }, projectError: null };
  assert.deepEqual(await layer.projectContext(main), own);
  assert.deepEqual(await layer.projectContext(tree), own, 'the worktree’s own broken copy is not read');
  assert.deepEqual(await layer.projectContext(treeOf(main, NAME2)), own, 'a worktree folder that does not exist');
  assert.deepEqual(await layer.projectContext(treeOf(main, NAME, 'app')), { project: null, projectError: null },
    'a worktree of a subfolder is that subfolder');
  assert.deepEqual(await layer.projectContext(join(main, 'web')), { project: null, projectError: null },
    'a subfolder outside a worktree is a project of its own, as before');
});

// ---- 界面的本次信任回答（state/trust.ts）与记忆页跟随的项目（state/memory.ts） ----

/**
 * 界面模块（trust.ts、memory.ts 与仓库共用一份状态）；第一个用到它的测试才打包、装上浏览器替身，前面的内核测试不受影响
 */
let rendererModules = null;

/** @brief 打包并导入界面的 trust.ts、memory.ts 与 store.ts（只一次）。 */
function renderer() {
  rendererModules ??= loadRendererModules({ trust: 'src/renderer/src/state/trust.ts',
    memory: 'src/renderer/src/state/memory.ts', store: 'src/renderer/src/state/store.ts' });
  return rendererModules;
}

/**
 * @brief 后台进程的替身（synthetic）：只有 folders 里的工作路径的 trust.check 要问；别的命令、别的文件夹的 trust.check
 *        都立即拒绝（不该问的文件夹被问时测试马上失败，不会等一个没人回答的询问框）。
 */
function trustOnly(folders) {
  const askable = new Set(folders);
  return async (command) => {
    if (command.type === 'trust.check' && askable.has(command.cwd)) return { ask: true, readError: null };
    throw new Error(`unexpected ${command.type} ${command.cwd}`);
  };
}

/** @brief 等界面出现第 count 个信任询问框，返回最后一个。 */
async function promptShown(store, count) {
  await until(() => store.useApp.getState().trustPrompts.length === count, `trust prompt #${count}`, 5_000);
  return store.useApp.getState().trustPrompts.at(-1);
}

test('FS-102 a trust answer given in the main folder holds for its worktrees in this run; a subfolder is asked',
  { timeout: 10_000 }, async () => {
    const R = await renderer();
    const main = 'C:\\w\\tool';
    const web = join(main, 'web');
    bridge.reset(trustOnly([main, web]));
    const asked = R.trust.trustFor(main);
    const first = await promptShown(R.store, 1);
    assert.equal(first.cwd, main);
    R.trust.answerTrust(first.id, { trusted: true, remember: false });
    assert.deepEqual(await asked, { trusted: true, remember: false });
    for (const cwd of [treeOf(main), treeOf(main, NAME2)]) {
      assert.deepEqual(await R.trust.trustFor(cwd), { trusted: true, remember: false }, cwd);
    }
    const second = R.trust.trustFor(web);
    const webPrompt = await promptShown(R.store, 1);
    assert.equal(webPrompt.cwd, web, 'the subfolder is asked with its own prompt');
    R.trust.answerTrust(webPrompt.id, { trusted: false, remember: false });
    assert.deepEqual(await second, { trusted: false, remember: false });
    assert.deepEqual(await R.trust.trustFor(treeOf(main, NAME, 'web')), { trusted: false, remember: false });
    assert.deepEqual(bridge.commands.map((command) => [command.type, command.cwd]),
      [['trust.check', main], ['trust.check', web]], 'worktrees of an answered folder are not checked again');
  });

// §11.7：Remember my choice 记在会话的工作路径（kernel/trust.ts remember 不改），在 worktree 会话里勾它只记那个
// worktree；同时在问、没有显示自己的询问框的主文件夹拿到的是沿用的回答，同 trustFor 的“沿用的不再记住一次”
test('FS-102 a worktree and its main folder asking at the same time share one trust prompt; only the folder the '
  + 'prompt named remembers', { timeout: 10_000 }, async () => {
  const R = await renderer();
  const main = 'C:\\w\\shared';
  bridge.reset(trustOnly([treeOf(main), main]));
  const fromTree = R.trust.trustFor(treeOf(main));
  const fromMain = R.trust.trustFor(main);
  const prompt = await promptShown(R.store, 1);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(R.store.useApp.getState().trustPrompts.length, 1, 'one prompt for the project');
  assert.equal(prompt.cwd, treeOf(main), 'the prompt names the working folder that asked first');
  R.trust.answerTrust(prompt.id, { trusted: true, remember: true });
  assert.deepEqual(await fromTree, { trusted: true, remember: true });
  assert.deepEqual(await fromMain, { trusted: true, remember: false },
    'the main folder never showed its own prompt: it is trusted without remembering the main folder');
  assert.deepEqual(bridge.commands.map((command) => command.cwd), [treeOf(main), main],
    'trust.check still goes with each working folder');
});

/** @brief 记忆页读取的替身（synthetic）：列表、修订与增强状态都是空的；别的命令拒绝。 */
async function memoryAnswers(command) {
  if (command.type === 'memory.list') return { entries: [], error: null };
  if (command.type === 'memory.revisions') {
    return command.id ? { revision: { id: command.id }, error: null } : { revisions: [], error: null };
  }
  if (command.type === 'enhance.get') return { cwd: command.cwd, error: null };
  throw new Error(`unexpected ${command.type} ${command.cwd}`);
}

/** @brief 等记忆页发出 count 条命令，返回 [类型, cwd] 列表。 */
async function memoryCommands(count) {
  await until(() => bridge.commands.length >= count, `${count} memory commands`, 5_000);
  return bridge.commands.map((command) => [command.type, command.cwd]);
}

test('FS-102 the Memory page follows a worktree session’s main folder, and View in Memory focuses its pane',
  { timeout: 10_000 }, async (t) => {
    const R = await renderer();
    const S = R.store;
    t.after(() => S.useApp.setState({ view: 'chat', tabs: [], split: null, activeKey: null }));
    const main = 'C:\\w\\memo';
    const tree = S.newTab(treeOf(main), { sessionId: 'pi-tree', phase: 'ready' });
    bridge.reset(memoryAnswers);
    S.useApp.setState({ kernel: 'ready', tabs: [tree], split: null, activeKey: tree.key, view: 'chat' });
    R.memory.openMemory();
    assert.deepEqual(await memoryCommands(2), [['memory.list', main], ['enhance.get', main]]);
    assert.equal(R.memory.useMemory.getState().cwd, main, 'the Project layer is the main folder');
    // 分屏：焦点在别的项目那一栏，View in Memory 落到主文件夹，焦点换到 worktree 会话那一栏
    const other = S.newTab('C:\\w\\other', { sessionId: 'pi-other', phase: 'ready' });
    S.useApp.setState({ view: 'chat', tabs: [other, tree], split: [other.key, tree.key], activeKey: other.key });
    bridge.reset(memoryAnswers);
    R.memory.openMemoryAt({ cwd: main, layer: 'project', revision: 'r1' });
    assert.equal(S.useApp.getState().activeKey, tree.key, 'the worktree session is the main folder’s project');
    assert.deepEqual(await memoryCommands(3), [['memory.revisions', main], ['memory.revisions', main],
      ['enhance.get', main]]);
    assert.deepEqual([R.memory.useMemory.getState().cwd, bridge.commands[1].id], [main, 'r1']);
  });
