// 合成测试端点（synthetic）自检的文件系统第 2 步部分（docs/specs/file-system.md §19.1“合成端点”）：单步关键词
// write file: <路径> :: <文字>、binary file:、many files:（生成的 bash 命令在 Git Bash 里真跑一次，比较写下的字节、
// 文件名与内容），写得不对时回 Unknown step，它们作关键词链的一步，单独一条以修饰开头的消息；脚本模式的 chain 步骤、
// {submitted} 与 {lastLine:<key>} 模板；场景 fs-git（scenarios/fs-git.mjs）的立项、task 实例、结案、分开时的对话、
// 关闭模式的对话与 FS-18 的只登记不建 task；fs-git.mjs 导出的写法与 writeManyFiles。
// 由 selfcheck.mjs 调用（gitChecks），帮助函数从那里传进来；名字以 "fs-git" 开头。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEGMENT_SENTENCES, SHARED_SENTENCE } from './scripts.mjs';
import { UNKNOWN_STEP, WRITE_CONTENT } from './replies.mjs';
import { GIT_SCENARIO, GIT_TEXT, binaryBytes, gitMessage, gitOpenRequest, gitStep, keywordSteps, manyFileName,
  writeManyFiles, writtenText } from './scenarios/fs-git.mjs';

/**
 * @brief Git Bash 的 bash.exe（git --exec-path 往上三级的 bin\bash.exe，同 Mori 的 bash 工具用的那一个）；没有时为 null。
 *        selfcheck-team.mjs 也用它（worktree 的提交与合并命令在 Git Bash 里真跑一次）。
 */
export function gitBash() {
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const bash = join(exec, '..', '..', '..', 'bin', 'bash.exe');
    return existsSync(bash) ? bash : null;
  } catch (error) {
    console.error('[selfcheck] cannot find Git Bash', error);
    return null;
  }
}

/**
 * @brief 在一个临时目录里做 work(dir)，再删掉这个目录（出错时同样删掉）。
 * @return { value（work 的返回值，出错时为 null）, error（出错的原因，没出错为 null） }
 */
function inTempDir(work) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-fs-git-'));
  try {
    return { value: work(dir), error: null };
  } catch (error) {
    return { value: null, error: String(error.stderr ?? error.message) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @brief 在临时目录里用 Git Bash 跑一条命令，再用 read(dir) 读结果；命令失败或读不到时 value 为 null、记下 error。 */
function inBash(bash, command, read) {
  return inTempDir((dir) => {
    execFileSync(bash, ['-c', command], { cwd: dir, stdio: 'pipe' });
    return read(dir);
  });
}

/** @brief dir 里的文件名（排好序）与各自的内容。 */
function listing(dir) {
  const names = readdirSync(dir).sort();
  return { names, contents: names.map((name) => readFileSync(join(dir, name), 'utf8')) };
}

/** @brief 单步关键词 write file: <路径> :: <文字>：内容按 writtenText；不带 " :: " 的照旧。 */
async function checkWriteText(kit, a) {
  const { chat, record, user, argsOf, same, fsKey } = kit;
  const lines = await chat(a.port, { messages: [user('write file: notes/a.txt :: one\\ntwo')] }, fsKey);
  const empty = await chat(a.port, { messages: [user('write file: e.txt ::')] }, fsKey);
  const spaced = await chat(a.port, { messages: [user('write file: img dir/c.txt :: v1 => v2')] }, fsKey);
  const plain = await chat(a.port, { messages: [user('write file: b.txt')] }, fsKey);
  record('fs-git keyword: write file: <path> :: <text> writes the text ("\\n" is a newline, a newline at the end, '
    + 'empty text writes an empty file); without " :: " the old content', lines.calls[0]?.name === 'write'
    && same(argsOf(lines), { path: 'notes/a.txt', content: 'one\ntwo\n' })
    && same(argsOf(empty), { path: 'e.txt', content: '' })
    && same(argsOf(spaced), { path: 'img dir/c.txt', content: 'v1 => v2\n' })
    && same(argsOf(plain), { path: 'b.txt', content: WRITE_CONTENT }) && writtenText('x\\ny') === 'x\ny\n',
  [lines, empty, spaced, plain].map((out) => out.calls[0]?.args).join(' | '));
}

/** 写得不对的关键词（文件系统第 2 步的三个与 edit file:）：每条都回 "Unknown step: <原文>"、没有调用 */
const BAD_INPUTS = ['binary file: x.bin :: a b', 'binary file: a.bin::v2', 'binary file: x.bin ::',
  'binary file: x.bin :: a%b', "binary file: it's.bin", 'write file: a.txt ::x', 'write file: a::b.txt :: x',
  'edit file: a.txt :: x', 'many files: big', 'many files: big 0', 'many files: big 100001'];

/** @brief BAD_INPUTS 都回 "Unknown step: <原文>"、没有调用（不拿整段当路径，不用空标记或默认标记）。 */
async function checkBadInputs(kit, a) {
  const { chat, record, user, fsKey } = kit;
  const outs = [];
  for (const text of BAD_INPUTS) outs.push(await chat(a.port, { messages: [user(text)] }, fsKey));
  const wrong = outs.map((out, i) => (out.calls.length === 0 && out.text === `${UNKNOWN_STEP} ${BAD_INPUTS[i]}`
    ? null : `${BAD_INPUTS[i]} -> ${out.text} ${out.calls.map((c) => c.args).join()}`)).filter(Boolean);
  record('fs-git keyword: badly written binary file: (tag with a space, "::" without spaces, empty or bad tag, quote '
    + 'in the path), write file: ("::x", "::" in the path), edit file: (no "=>"), many files: (no count, 0, over the '
    + 'cap) answer "Unknown step: <text>" with no call', wrong.length === 0, wrong.join(' | '));
}

/** @brief binary file:：命令原文与默认标记；命令在 Git Bash 里写下 binaryBytes 的字节。 */
async function checkBinary(kit, a, bash) {
  const { chat, record, user, argsOf, fsKey } = kit;
  const plain = await chat(a.port, { messages: [user('binary file: img.bin')] }, fsKey);
  const tagged = await chat(a.port, { messages: [user('binary file: img dir/b.bin :: v2')] }, fsKey);
  const command = argsOf(tagged)?.command ?? '';
  record('fs-git keyword: binary file: calls bash with printf of the tag (default MORI) and four bytes',
    plain.calls[0]?.name === 'bash' && argsOf(plain)?.command === "printf 'MORI\\000\\001\\002\\377' > 'img.bin'"
    && command === "printf 'v2\\000\\001\\002\\377' > 'img dir/b.bin'", `${argsOf(plain)?.command} | ${command}`);
  if (!bash) return record('fs-git keyword: binary file: writes binaryBytes(tag) in Git Bash', false, 'no Git Bash');
  const ran = inBash(bash, `mkdir -p 'img dir' && ${command}`, (dir) => readFileSync(join(dir, 'img dir', 'b.bin')));
  const bytes = ran.value;
  record('fs-git keyword: binary file: writes binaryBytes(tag) in Git Bash (it has a NUL byte)',
    bytes !== null && bytes.equals(binaryBytes('v2')) && bytes.includes(0), ran.error ?? bytes?.toString('hex'));
}

/** @brief many files:：命令原文；命令在 Git Bash 里建出 manyFileName(0..n-1)，内容是序号。 */
async function checkMany(kit, a, bash) {
  const { chat, record, user, argsOf, fsKey } = kit;
  const many = await chat(a.port, { messages: [user('many files: big 501')] }, fsKey);
  record('fs-git keyword: many files: <dir> <n> is one bash command (mkdir -p, seq | split)',
    many.calls.length === 1 && many.calls[0].name === 'bash'
    && argsOf(many)?.command === "mkdir -p 'big' && seq 1 501 | split -l 1 -d -a 5 --additional-suffix=.txt - 'big/f'",
    argsOf(many)?.command);
  if (!bash) return record('fs-git keyword: many files: creates the files in Git Bash', false, 'no Git Bash');
  const small = await chat(a.port, { messages: [user('many files: sub dir/m 12')] }, fsKey);
  const ran = inBash(bash, argsOf(small)?.command ?? 'false', (dir) => listing(join(dir, 'sub dir', 'm')));
  const { names, contents } = ran.value ?? { names: [], contents: [] };
  const want = Array.from({ length: 12 }, (_, i) => manyFileName(i));
  record('fs-git keyword: many files: creates manyFileName(0..n-1) in Git Bash, file i holds "<i+1>\\n"',
    names.join() === want.join() && contents.every((text, i) => text === `${i + 1}\n`),
    ran.error ?? `${names.slice(0, 3).join()} … ${contents.slice(0, 2).join('|')}`);
}

/** @brief writeManyFiles（FS-10：App 测试自己写很多个文件）：文件名与内容同 many files:，目录不在时建出来。 */
function checkWriteMany(kit) {
  const ran = inTempDir((dir) => {
    writeManyFiles(join(dir, 'a', 'big'), 12);
    return listing(join(dir, 'a', 'big'));
  });
  const { names, contents } = ran.value ?? { names: [], contents: [] };
  const want = Array.from({ length: 12 }, (_, i) => manyFileName(i));
  kit.record('fs-git exports: writeManyFiles(dir, n) creates dir and writes manyFileName(0..n-1) holding "<i+1>\\n"',
    names.join() === want.join() && contents.every((text, i) => text === `${i + 1}\n`),
    ran.error ?? `${names.slice(0, 3).join()} … ${contents.slice(0, 2).join('|')}`);
}

/** @brief 单独一条以修饰开头的消息当作只有一步的链：[wait] 推迟这一步、工具结果之后照常回；[fail-once] 先失败一次。 */
async function checkHeld(kit, a) {
  const { chat, record, user, toolTurn, argsOf, same, fsKey } = kit;
  const text = gitStep.hold(300, gitStep.write('held.txt', 'H1'));
  const first = await chat(a.port, { messages: [user(text)] }, fsKey);
  const after = await chat(a.port, { messages: [user(text), ...toolTurn('w1', 'write', {}, 'Wrote held.txt')] },
    fsKey);
  const late = await chat(a.port, { messages: [user(gitStep.hold(200, gitStep.say('Late held')))] }, fsKey);
  const once = [user('[fail-once 503] binary file: held-once.bin')];
  const failed = await chat(a.port, { messages: once }, fsKey);
  const retried = await chat(a.port, { messages: once }, fsKey);
  record('fs-git keyword: a message that starts with [wait <ms>] or [fail-once <status>] is a one-step chain (the '
    + 'write is delayed, the tool result gets the usual summary, a held say: answers its text, fail-once fails once)',
  text === '[wait 300] write file: held.txt :: H1' && same(argsOf(first), { path: 'held.txt', content: 'H1\n' })
    && first.firstAt - first.startedAt >= 300 && after.calls.length === 0 && after.text.includes('Wrote held.txt')
    && late.text === 'Late held' && late.calls.length === 0 && late.firstAt - late.startedAt >= 200
    && failed.status === 503 && retried.calls[0]?.name === 'bash'
    && argsOf(retried)?.command === "printf 'MORI\\000\\001\\002\\377' > 'held-once.bin'",
  `${first.calls[0]?.args} | ${after.text} | ${late.text} | ${failed.status} | ${retried.calls[0]?.args}`);
}

/** @brief 新关键词作关键词链的一步（修饰 [wait] 照样生效）；fs-git.mjs 的 gitStep、keywordSteps 写出的文字认得出。 */
async function checkKeywordChain(kit, a) {
  const { chat, record, user, toolTurn, argsOf, fsKey } = kit;
  const text = keywordSteps(gitStep.write('a.txt', 'A1'), gitStep.hold(300, gitStep.binary('b.bin')),
    gitStep.remove('c.txt'), gitStep.say('A done'));
  const start = [user(text)];
  const first = await chat(a.port, { messages: start }, fsKey);
  const wrote = [...start, ...toolTurn('w1', 'write', {}, 'ok')];
  const second = await chat(a.port, { messages: wrote }, fsKey);
  const third = await chat(a.port, { messages: [...wrote, ...toolTurn('b1', 'bash', {}, 'ok')] }, fsKey);
  const fourth = await chat(a.port, { messages: [...wrote, ...toolTurn('b1', 'bash', {}, 'ok'),
    ...toolTurn('r1', 'bash', {}, 'ok')] }, fsKey);
  const many = await chat(a.port, { messages: [user(gitStep.many('d', 3))] }, fsKey);
  const slept = await chat(a.port, { messages: [user(gitStep.sleep(20))] }, fsKey);
  const edited = await chat(a.port, { messages: [user(gitStep.edit('a.txt', 'A1', 'A2'))] }, fsKey);
  record('fs-git chain: the new keywords work as chain steps with [wait]; gitStep and keywordSteps write lines the '
    + 'endpoint reads', text === "steps: write file: a.txt :: A1 ;; [wait 300] binary file: b.bin :: MORI ;; "
    + "run: rm 'c.txt' ;; say: A done" && argsOf(first)?.content === 'A1\n'
    && second.calls[0]?.name === 'bash' && second.firstAt - second.startedAt >= 300
    && argsOf(third)?.command === "rm 'c.txt'" && fourth.text === 'A done' && fourth.calls.length === 0
    && argsOf(many)?.command.startsWith("mkdir -p 'd' && seq 1 3 |") && argsOf(slept)?.command === 'sleep 20'
    && argsOf(edited)?.edits?.[0]?.newText === 'A2',
  `${text} | ${first.calls[0]?.args} | ${second.calls[0]?.args} | ${fourth.text}`);
}

/** @brief 合并会话立项的 system 与 fs-git 的消息（synthetic）。 */
function gitSessions(kit) {
  const { sys, sample } = kit;
  return {
    merged: sys('Body. no role mark', sample(SEGMENT_SENTENCES['merged-create'])),
    planner: sys('MORI-ROLE-planner', sample(SHARED_SENTENCE), SEGMENT_SENTENCES.create),
    task: sys('You change files. MORI-ROLE-executor', sample(SHARED_SENTENCE), SEGMENT_SENTENCES.task),
    mergedTask: sys('Body. no role mark', sample(SHARED_SENTENCE), SEGMENT_SENTENCES.task),
    close: sys('MORI-ROLE-planner', sample(SHARED_SENTENCE), sample(SEGMENT_SENTENCES.close)),
    chat: sys('MORI-ROLE-chat', sample(SHARED_SENTENCE), SEGMENT_SENTENCES['team-dialog']),
    off: sys('Body text without a role mark.', SEGMENT_SENTENCES['off-dialog']),
    plain: sys('A system text without a segment sentence.'),
  };
}

/** @brief fs-git 立项：登记、按 {submitted} 建 task（description 取这次投递的行值，不取工作卡里旧的）、回 handled。 */
async function checkGitCreate(kit, d) {
  const { chatLogged, record, user, said, toolTurn, card, argsOf } = kit;
  const s = gitSessions(kit);
  const old = gitMessage([['git-task', 'run: echo old > old.txt']]);
  const msg = gitMessage([['git-task', [gitStep.edit('notes.md', 'hello', 'hi'), gitStep.run('echo x > b.txt')]]]);
  const history = [s.merged, user(old), ...toolTurn('s0', 'request_submit', {}, '[#1] Registered request 1: x.'),
    said(GIT_TEXT.handled), user('[Mori] T1 was handed off: done.'), said(GIT_TEXT.handled), user(msg)];
  const oldCard = card('Team mode: on', 'Open requests:', `- Request 1: "${old}"`);
  const submit = await chatLogged(d, { messages: [...history, oldCard] });
  const registered = [...history, ...toolTurn('s1', 'request_submit', {}, '[#4] Registered request 2: Git check '
    + 'tb-scenario:fs-git. Split it into tasks with task_create.')];
  const created = await chatLogged(d, { messages: [...registered, oldCard] });
  const done = await chatLogged(d, { messages: [...registered, ...toolTurn('t1', 'task_create', {}, 'ok'), oldCard] });
  const wake = await chatLogged(d, { messages: [...history, said(GIT_TEXT.handled), user('[Mori] T2 done.'),
    oldCard] });
  record('fs-git: merged create registers, task_create takes request {submitted} (2) and the git-task value of this '
    + 'delivery (not the one in the work card), then answers; a [Mori] delivery only answers',
  submit.out.calls[0]?.name === 'request_submit' && submit.log.k === 3 && argsOf(submit.out)?.title === GIT_TEXT.title
    && created.out.calls[0]?.name === 'task_create' && argsOf(created.out)?.request === 2
    && argsOf(created.out)?.assignee === 'mori' && !('read_only' in (argsOf(created.out) ?? {}))
    && !('limits' in (argsOf(created.out) ?? {}))
    && argsOf(created.out)?.description === "git-task: edit file: notes.md :: hello => hi ;; run: echo x > b.txt"
    && done.out.text === GIT_TEXT.handled && wake.out.calls.length === 0 && wake.out.text === GIT_TEXT.handled,
  `${created.out.calls[0]?.args} | ${done.out.text} | ${wake.out.text}`);
  const split = await chatLogged(d, { messages: [s.planner, user(`[Mori] New user message: ${msg}\nMake exactly one `
    + 'decision for it.'), ...toolTurn('s1', 'request_submit', {}, 'Registered request 1: Git check.')] });
  record('fs-git: split create (planner) assigns the task to executor with request 1',
    argsOf(split.out)?.assignee === 'executor' && argsOf(split.out)?.request === 1, split.out.calls[0]?.args);
}

/** @brief fs-git 立项的 git-create 行：一段一段做（带 [wait]），say 那一段结束运行。 */
async function checkGitCreateChain(kit, d) {
  const { chatLogged, record, user, toolTurn, argsOf } = kit;
  const s = gitSessions(kit);
  const msg = gitMessage([['git-create', ['run: echo a', '[wait 300] say: Deciding.']]]);
  const first = await chatLogged(d, { messages: [s.merged, user(msg)] });
  const second = await chatLogged(d, { messages: [s.merged, user(msg), ...toolTurn('b1', 'bash', {}, 'ok')] });
  record('fs-git: the git-create line runs part by part (no git-task: no request), [wait] delays its part',
    argsOf(first.out)?.command === 'echo a' && first.log.j === 0 && second.out.text === 'Deciding.'
    && second.out.firstAt - second.out.startedAt >= 300 && second.log.j === 1,
  `${first.out.calls[0]?.args} | ${second.out.text}`);
}

/** @brief fs-git 的 task 实例：工作卡（description 是 git-task 的行值，User's words 抄着原话）。 */
function gitTask(kit, system, value, rest) {
  const { user, card } = kit;
  const words = gitMessage([['git-task', value]]);
  return [system, user('[Mori] You are executor on T2 (request 2). Start work.'), ...rest,
    card('You are executor on T2 (request 2).', `Request 2: ${GIT_TEXT.title}`, "User's words:",
      `- [10:00] "${words}"`, 'Task T2: Change the files · changes files', `What to do: git-task: ${value}`)];
}

/** @brief fs-git task 实例：git-task 的几段依次（edit 再 bash），再交接；没有这一行时直接交接；强制填写按 handoff。 */
async function checkGitTask(kit, d) {
  const { chatLogged, record, toolTurn, argsOf, same } = kit;
  const s = gitSessions(kit);
  const value = 'edit file: notes.md :: hello => hello from the task ;; [wait 300] run: echo made > from-task.txt';
  const first = await chatLogged(d, { messages: gitTask(kit, s.task, value, []) });
  const edited = toolTurn('e1', 'edit', {}, 'ok');
  const second = await chatLogged(d, { messages: gitTask(kit, s.task, value, edited) });
  const third = await chatLogged(d, { messages: gitTask(kit, s.task, value, [...edited,
    ...toolTurn('b1', 'bash', {}, 'ok')]) });
  record('fs-git: the task instance does the git-task parts in order (edit, then bash after its [wait]), then '
    + 'task_handoff done', first.out.calls[0]?.name === 'edit' && first.log.task === 'T2'
    && same(argsOf(first.out)?.edits, [{ oldText: 'hello', newText: 'hello from the task' }])
    && argsOf(second.out)?.command === 'echo made > from-task.txt' && second.out.firstAt - second.out.startedAt >= 300
    && third.out.calls[0]?.name === 'task_handoff' && argsOf(third.out)?.task === 'T2'
    && argsOf(third.out)?.conclusion === GIT_TEXT.conclusion && argsOf(third.out)?.outcome === 'done',
  `${first.out.calls[0]?.args} | ${second.out.calls[0]?.args} | ${third.out.calls[0]?.args}`);
  const merged = await chatLogged(d, { messages: gitTask(kit, s.mergedTask, 'binary file: x.bin', []) });
  const none = await chatLogged(d, { messages: gitTask(kit, s.task, '', []) });
  record('fs-git: the merged task instance (mori) reads git-task too; without a value the task hands off at once',
    merged.log.agent === 'mori' && argsOf(merged.out)?.command === "printf 'MORI\\000\\001\\002\\377' > 'x.bin'"
    && none.out.calls[0]?.name === 'task_handoff' && none.log.j === 0,
  `${merged.out.calls[0]?.args} | ${none.out.calls[0]?.name}`);
}

/** @brief fs-git task 实例里一段带 [fail-once 503]：先失败一次，重试得到这一段；认不出的段回 Unknown step。 */
async function checkGitTaskFailures(kit, d) {
  const { chatLogged, record } = kit;
  const s = gitSessions(kit);
  const messages = gitTask(kit, s.task, '[fail-once 503] run: echo retried > r.txt', []);
  const failed = await chatLogged(d, { messages });
  const retried = await chatLogged(d, { messages });
  const unknown = await chatLogged(d, { messages: gitTask(kit, s.task, 'jump: nowhere', []) });
  record('fs-git: a git-task part with [fail-once 503] fails once (synthetic 503), the retry gets it; an unknown part '
    + 'answers "Unknown step:"', failed.out.status === 503
    && /git-task line of script fs-git/.test(failed.out.body?.error?.message ?? '')
    && retried.out.calls[0]?.name === 'bash' && unknown.out.text === `${UNKNOWN_STEP} jump: nowhere`,
  `${failed.out.status} ${failed.out.raw} | ${unknown.out.text}`);
}

/** @brief fs-git 结案：关闭交来的 task 与工作卡上的需求，再回 closed。 */
async function checkGitClose(kit, d) {
  const { chatLogged, record, user, toolTurn, card, argsOf } = kit;
  const s = gitSessions(kit);
  const closeCard = card('You are planner, closing request 2.', `Request 2: ${GIT_TEXT.title}`, 'With you:',
    '- T2 Change the files: done');
  const start = [s.close, user('[Mori] T2 was handed to you: done.')];
  const first = await chatLogged(d, { messages: [...start, closeCard] });
  const handed = [...start, ...toolTurn('h1', 'task_handoff', {}, 'ok')];
  const second = await chatLogged(d, { messages: [...handed, closeCard] });
  const third = await chatLogged(d, { messages: [...handed, ...toolTurn('r1', 'request_close', {}, 'ok'), closeCard] });
  record('fs-git: close hands off the task (close_done), closes request 2, then answers GIT_TEXT.closed',
    argsOf(first.out)?.task === 'T2' && argsOf(first.out)?.outcome === 'close_done'
    && second.out.calls[0]?.name === 'request_close' && argsOf(second.out)?.request === 2
    && argsOf(second.out)?.conclusion === GIT_TEXT.requestDone && third.out.text === GIT_TEXT.closed,
  `${first.out.calls[0]?.args} | ${second.out.calls[0]?.args} | ${third.out.text}`);
}

/** @brief fs-git 的对话：分开时 chat 做 git-dialog；关掉协作模式后（off-dialog、dialog）做 git-off，再回 off。 */
async function checkGitDialogs(kit, d) {
  const { chatLogged, record, user, said, toolTurn, argsOf } = kit;
  const s = gitSessions(kit);
  const teamTurn = [user(gitMessage([['git-task', 'run: echo t > t.txt']])), said(GIT_TEXT.handled)];
  const offMsg = gitMessage([['git-off', [gitStep.write('b.txt', 'B2'), gitStep.remove('c.txt')]]]);
  const offStart = [s.off, ...teamTurn, user(offMsg)];
  const wrote = await chatLogged(d, { messages: offStart });
  const removed = await chatLogged(d, { messages: [...offStart, ...toolTurn('w1', 'write', {}, 'ok')] });
  const replied = await chatLogged(d, { messages: [...offStart, ...toolTurn('w1', 'write', {}, 'ok'),
    ...toolTurn('r1', 'bash', {}, 'ok')] });
  const plain = await chatLogged(d, { messages: [s.plain, ...teamTurn, user('Thanks.')] });
  record('fs-git: after team mode is off the dialog (off-dialog) does the git-off parts, then GIT_TEXT.off; the next '
    + 'message without the line (dialog) only answers', wrote.log.kind === 'off-dialog' && wrote.log.k === 2
    && argsOf(wrote.out)?.content === 'B2\n' && argsOf(removed.out)?.command === "rm 'c.txt'"
    && replied.out.text === GIT_TEXT.off && plain.log.kind === 'dialog' && plain.log.scenario === 'fs-git'
    && plain.out.calls.length === 0 && plain.out.text === GIT_TEXT.off,
  `${JSON.stringify(wrote.log.kind)} ${wrote.out.calls[0]?.args} | ${replied.out.text} | ${plain.out.text}`);
  const asked = await chatLogged(d, { messages: [s.chat, user(gitMessage([['git-dialog', 'ask user: db']]))] });
  record('fs-git: split chat does the git-dialog line', asked.log.kind === 'team-dialog'
    && asked.out.calls[0]?.name === 'ask_user_question', JSON.stringify(asked.log));
}

/**
 * @brief FS-18 的 gitOpenRequest：合并会话的立项只登记 GIT_TEXT.openTitle（没有 git-task 行，不建 task），下一段推迟
 *        之后回 deciding；之后 Mori 补的 "has no tasks" 提醒只得到 handled（不停止时结案会把需求关掉，见 fs-git.mjs）。
 */
async function checkGitOpen(kit, d) {
  const { chatLogged, record, user, said, toolTurn, argsOf, same } = kit;
  const s = gitSessions(kit);
  const msg = gitOpenRequest(300);
  const first = await chatLogged(d, { messages: [s.merged, user(msg)] });
  const registered = [s.merged, user(msg), ...toolTurn('s1', 'request_submit', {}, '[#2] Registered request 1: '
    + `${GIT_TEXT.openTitle}. Split it into tasks with task_create.`)];
  const second = await chatLogged(d, { messages: registered });
  const nudge = await chatLogged(d, { messages: [...registered, said(GIT_TEXT.deciding),
    user('[Mori] Request 1 has no tasks. Split it with task_create now.')] });
  record('fs-git: gitOpenRequest makes the merged create register GIT_TEXT.openTitle without task_create, then '
    + 'answers GIT_TEXT.deciding after the hold; the "has no tasks" nudge only gets GIT_TEXT.handled',
  msg === 'git-create: call tool: request_submit {"title":"Open git check tb-scenario:fs-git","goal":"Stay open"} '
    + `;; [wait 300] say: Deciding.\n${GIT_SCENARIO}` && first.log.kind === 'merged-create'
    && first.out.calls.length === 1 && first.out.calls[0].name === 'request_submit'
    && same(argsOf(first.out), { title: GIT_TEXT.openTitle, goal: GIT_TEXT.openGoal })
    && second.out.calls.length === 0 && second.out.text === GIT_TEXT.deciding
    && second.out.firstAt - second.out.startedAt >= 300 && nudge.out.calls.length === 0
    && nudge.out.text === GIT_TEXT.handled,
  `${first.out.calls[0]?.args} | ${second.out.text} | ${nudge.out.text} ${nudge.out.calls.map((c) => c.name)}`);
}

/** @brief fs-git.mjs 导出的写法：gitMessage 的格式（最后一行是 GIT_SCENARIO）、binaryBytes、manyFileName。 */
function checkGitExports(kit) {
  const message = gitMessage([['git-task', ['a', 'b']], ['git-create', 'c']]);
  kit.record('fs-git exports: gitMessage joins chain parts with " ;; ", one key per line, tb-scenario last; '
    + 'binaryBytes and manyFileName', message === `git-task: a ;; b\ngit-create: c\n${GIT_SCENARIO}`
    && binaryBytes().toString('hex') === '4d4f5249000102ff' && manyFileName(0) === 'f00000.txt'
    && manyFileName(500) === 'f00500.txt', message);
}

/**
 * @brief 文件系统第 2 步的全部检查。
 * @param kit selfcheck.mjs 的帮助函数 { chat, chatLogged, record, user, sys, said, toolTurn, card, sample, argsOf,
 *            same, fsKey }
 * @param a 关键词端点（FAKE_KEYS 含 fsKey.key）
 * @param d 脚本端点（不查 key）
 */
export async function gitChecks(kit, a, d) {
  const bash = gitBash();
  await checkWriteText(kit, a);
  await checkBadInputs(kit, a);
  await checkBinary(kit, a, bash);
  await checkMany(kit, a, bash);
  await checkKeywordChain(kit, a);
  await checkHeld(kit, a);
  await checkGitCreate(kit, d);
  await checkGitCreateChain(kit, d);
  await checkGitTask(kit, d);
  await checkGitTaskFailures(kit, d);
  await checkGitClose(kit, d);
  await checkGitDialogs(kit, d);
  await checkGitOpen(kit, d);
  checkGitExports(kit);
  checkWriteMany(kit);
}
