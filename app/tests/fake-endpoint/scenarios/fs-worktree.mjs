// 合成端点（synthetic）的帮助：文件系统第 3 步 worktree 的 App 套件 tests/ui/fs-app-worktree.mjs（docs/specs/file-system.md
// §11、§19.2 的 FS-98–FS-112）写消息用的步骤。worktree 会话里的对话 Agent 在关闭模式下按关键词回答（server.mjs 开头），
// 所以这里不另写脚本（SCENARIOS 为空），只给出关键词的写法；一轮里几步用 fs-git.mjs 的 keywordSteps 连起来
// （"steps: a ;; b ;; say: …"），单独一步可以直接作一条消息。
//   - 改文件、删文件、写 .work 里的草稿：gitStep.write / edit / remove（fs-git.mjs）、wtStep.draft（FS-104：归档时
//     干净的 worktree 连同 .work/ 里的草稿一起删掉；FS-110：原 worktree 里没提交的改动）。
//   - 在 worktree 里提交：wtStep.commit(说明)：一条 bash 命令 git add -A 再 git commit，提交者写在命令的 -c 里
//     （WT_GIT_USER，不依赖全局配置；另关掉 commit.gpgsign）。在 worktree 会话的工作路径里跑，Mori 的命令分析认作只在
//     工作路径里（git 自己写共用的 .git 不算写入，file-system-permissions.md §7.7），Full access 下不出卡。
//   - 合并进主文件夹：wtStep.merge(主文件夹, 分支)：git -C '<主文件夹>' merge --no-edit '<分支>'；命令分析为 git -C 记一条
//     leave，scope outside，Full access 下也出卡（§7.7 最后一段，FS-113 的合成版本）；允许后主文件夹的 git log 有 worktree
//     里的提交（主文件夹没动过时是快进）。
//   - 写到主文件夹：wtStep.writeMain(主文件夹, 相对路径, 文字)：write 工具写主文件夹里的文件（绝对路径，工作路径外），
//     出卡、scope outside（proposal §5.4：写主文件夹等于写到外面）。注意：从 worktree 的根写相对的 "../x" 落在
//     <R>/.mori/worktrees/ 下，工作路径外的目标按整条路径比受保护名单（file-system-permissions.md §6.4），有 .mori 一段，
//     所以是 scope protected，不是 outside；要 outside 就写主文件夹里的绝对路径（selfcheck-team.mjs 量过）。
//   - 让会话忙（运行一直在跑）：gitStep.hold(毫秒, gitStep.say(文字)) 单独作一条消息、"wait <秒>s"、gitStep.sleep(秒)
//     （fs-git.mjs 开头第一节）；wtStep.busy(毫秒) 是第一种的简写。
// 路径、分支与提交说明里不能有单引号（命令用单引号括起来），有时抛错。

import { join } from 'node:path';
import { gitStep } from './fs-git.mjs';

/** 提交者（wtStep.commit、wtStep.merge 写在命令的 -c 里；synthetic） */
export const WT_GIT_USER = Object.freeze({ name: 'Mori Worktree Test', email: 'mori-worktree@example.invalid' });

/** 套件要比较的文字 */
export const WT_TEXT = {
  /** wtStep.busy 推迟之后的回复 */
  late: 'Done after the wait.',
};

/** @brief 放进 bash 单引号里的文字；有单引号时抛错。 */
function quoted(text) {
  if (String(text).includes("'")) throw new Error(`fs-worktree: a single quote cannot be quoted here: ${text}`);
  return `'${text}'`;
}

/** git 的提交者与签名设置（-c，在子命令之前） */
const GIT_IDENTITY = `-c user.name=${quoted(WT_GIT_USER.name)} -c user.email=${WT_GIT_USER.email} `
  + '-c commit.gpgsign=false';

/** worktree 会话的一步（关键词的单步写法，规则见文件开头） */
export const wtStep = Object.freeze({
  /** @brief 把工作路径里的改动全部提交（git add -A 与 git commit -q -m）。 */
  commit: (message) => `run: git add -A && git ${GIT_IDENTITY} commit -q -m ${quoted(message)}`,
  /** @brief 在主文件夹里合并 worktree 的分支（git -C '<主文件夹>' merge --no-edit '<分支>'）。 */
  merge: (mainFolder, branch) => `run: git -C ${quoted(mainFolder)} ${GIT_IDENTITY} merge --no-edit ${quoted(branch)}`,
  /** @brief write 工具写主文件夹里的文件（绝对路径，内容同 gitStep.write：writtenText(text)）。 */
  writeMain: (mainFolder, relPath, text) => gitStep.write(join(mainFolder, relPath), text),
  /** @brief write 工具写 .work/<name>（工作路径里的草稿）。 */
  draft: (name, text) => gitStep.write(`.work/${name}`, text),
  /** @brief 这一轮推迟 ms 毫秒再回 WT_TEXT.late（单独作一条消息，或作关键词链的一步）。 */
  busy: (ms) => gitStep.hold(ms, gitStep.say(WT_TEXT.late)),
});

/** worktree 的 App 套件不用脚本模式（见文件开头） */
export const SCENARIOS = {};
