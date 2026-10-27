// 记忆目录写保护的单元测试（docs/specs/memory.md §7.7、§9.6、MEM-13）：mori-memory 的 tool_call 处理器把 write、edit 的
// path 按 pi 的 resolveToCwd 解析（去掉 @、/c/… 换成 C:\…、展开 ~、file:// 换成路径、相对 ctx.cwd），落在
// <userData>/memory 里时拒绝；只是大小写或分隔符不同的路径同样拒绝，前缀相同的兄弟目录与别处放行；增强会话里
// write、edit 一律拒绝。处理器经真实的 memoryExtension 注册在替身扩展 API 上；路径都在测试的临时目录下（synthetic）。
// resolveToCwd、insideDir 从 memoryExtension.ts 移到了 pathGate.ts（docs/specs/file-system-permissions.md §6.3）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadKernelModule } from '../load.mjs';
import { fakePi, freshUserData, loadTextKernel } from './text-helpers.mjs';

const K = await loadTextKernel();
const { insideDir, resolveToCwd } = await loadKernelModule('src/kernel/pathGate.ts');
const MEMORY_FILES_ONLY = 'Memory files can only be changed with the memory tool or on the Memory page.';
const ENHANCEMENT_WRITES = 'Enhancement runs can only change memory, with the memory tool.';

/**
 * @brief 一个会话的 mori-memory 的 tool_call 处理器（真实的 memorySetup 与 memoryExtension）。
 * @param cwd 会话的工作目录
 * @param enhance 增强会话的任务；普通会话为 null
 * @return (工具名, path) → 处理器的结果
 */
async function guardOf(cwd, enhance = null) {
  const spec = { enhance: enhance && { task: enhance, run: { id: 'r1', cwd, task: enhance, day: '2026-10-22' },
    scope: { sessions: [], instanceFiles: [], feedback: [] } } };
  const setup = await K.ext.memorySetup({ cwd, kind: 'user', spec, seats: () => K.assemble.userRunSeats(null, false),
    position: () => ({ session: null, entry: null, title: '' }), permission: () => 'ask' });
  const api = fakePi();
  K.ext.memoryExtension(setup)(api);
  const handler = api.handlers.get('tool_call');
  return (toolName, path) => handler({ type: 'tool_call', toolCallId: 'c1', toolName, input: { path, content: 'x' } },
    { cwd });
}

/** @brief Git Bash 的盘符写法：C:\a\b → /c/a/b。 */
function shellForm(path) {
  return `/${path[0].toLowerCase()}${path.slice(2).replaceAll('\\', '/')}`;
}

test('MEM-13 write and edit into <userData>/memory are refused with the §7.7 text in every path form', async (t) => {
  const { userData, memoryRoot, cwd } = freshUserData(t, K);
  assert.equal(K.memory.memoryDir(), memoryRoot);
  const guard = await guardOf(cwd);
  const target = join(memoryRoot, 'user', 'TASTE.md');
  const forms = [
    ['absolute', target],
    ['relative to the session cwd', relative(cwd, target)],
    ['@ prefix', `@${target}`],
    ['only the case differs', target.toUpperCase()],
    ['mixed case and slashes', target.replaceAll('\\', '/').replace('memory', 'MeMoRy')],
    ['file:// URL', pathToFileURL(target).href],
    ['the memory folder itself', memoryRoot],
    ['a new file inside', join(memoryRoot, 'projects', 'x', 'entries', 'new.md')],
  ];
  if (process.platform === 'win32') forms.push(['/c/… form', shellForm(target)]);
  const fromHome = relative(homedir(), target);
  const underHome = !fromHome.startsWith('..') && !isAbsolute(fromHome);
  if (underHome) forms.push(['~ form', `~/${fromHome.replaceAll('\\', '/')}`]);
  else t.diagnostic(`the temporary userData ${userData} is not under the home folder; the ~ form is not checked`);
  for (const [label, path] of forms) {
    for (const tool of ['write', 'edit']) {
      assert.deepEqual(guard(tool, path), { block: true, reason: MEMORY_FILES_ONLY }, `${tool}: ${label} (${path})`);
    }
  }
});

test('MEM-13 a sibling folder with the same prefix and other places are allowed; other tools are not checked',
  async (t) => {
    const { userData, memoryRoot, cwd } = freshUserData(t, K);
    const guard = await guardOf(cwd);
    const allowed = [join(userData, 'memory-x', 'a.md'), join(userData, 'memoryx.md'),
      join(userData, 'pi', 'AGENTS.md'), join(cwd, 'src', 'a.ts'), 'notes.md', join(`${memoryRoot}-backup`, 'a.md')];
    for (const path of allowed) {
      assert.equal(guard('write', path), undefined, `write ${path}`);
      assert.equal(guard('edit', path), undefined, `edit ${path}`);
    }
    for (const tool of ['read', 'bash', 'grep', 'memory']) {
      assert.equal(guard(tool, join(memoryRoot, 'user', 'TASTE.md')), undefined, `${tool} is not checked`);
    }
  });

test('MEM-13 insideDir and resolveToCwd follow the sessionFilePath rule and pi path resolution', (t) => {
  const { memoryRoot, cwd } = freshUserData(t, K);
  assert.equal(insideDir(memoryRoot, memoryRoot), true);
  assert.equal(insideDir(memoryRoot, join(memoryRoot, 'a', 'b.md')), true);
  assert.equal(insideDir(memoryRoot, `${memoryRoot}-x`), false, 'same prefix, sibling folder');
  assert.equal(insideDir(memoryRoot, join(memoryRoot, '..', 'other')), false);
  assert.equal(insideDir(memoryRoot, join(memoryRoot, '..notes')), true, 'a name starting with .. is inside (pi)');
  assert.equal(resolveToCwd('a.md', cwd), join(cwd, 'a.md'));
  assert.equal(resolveToCwd('@a.md', cwd), join(cwd, 'a.md'));
  assert.equal(resolveToCwd('~', cwd), homedir());
  assert.equal(resolveToCwd('~/x/y.md', cwd), join(homedir(), 'x', 'y.md'));
  assert.equal(resolveToCwd(pathToFileURL(join(cwd, 'b.md')).href, 'D:\\elsewhere'), join(cwd, 'b.md'));
  if (process.platform === 'win32') {
    assert.equal(resolveToCwd(shellForm(join(cwd, 'c.md')), 'D:\\x'), join(cwd, 'c.md'));
  }
});

test('MEM-13 in an enhancement session every write and edit is refused, wherever it points', async (t) => {
  const { memoryRoot, cwd } = freshUserData(t, K);
  const guard = await guardOf(cwd, 'taste');
  for (const path of [join(cwd, 'a.md'), join(memoryRoot, 'user', 'TASTE.md'), 'b.md']) {
    for (const tool of ['write', 'edit']) {
      assert.deepEqual(guard(tool, path), { block: true, reason: ENHANCEMENT_WRITES }, `${tool} ${path}`);
    }
  }
  assert.equal(guard('read', join(cwd, 'a.md')), undefined, 'reading is allowed');
  assert.equal(guard('bash', join(cwd, 'a.md')), undefined, 'commands are not checked (§7.7)');
});
