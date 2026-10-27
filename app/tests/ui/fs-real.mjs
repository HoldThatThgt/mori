// 文件系统规格的真实模型一层（docs/specs/file-system.md §19.1“真实”一行；§19.2 FS-21、FS-40、FS-54、FS-55、FS-67、
// FS-82、FS-93、FS-113、FS-114）：真正的 Mori 对真实的 DeepSeek 与 GLM，全部经界面操作；只断言程序保证的事，模型说了
// 什么、做了什么写进 note。数据目录的两种来源、key 的规矩（只在内存里、从不打印或写进文件、最后核对没有泄露）、记录代理、
// 录制器与结果文件都在 fs-real-setup.mjs；场景在三个模块里：
// - fs-real-perm.mjs：身份段（三种模式）、Full access（FS-40）、.work 里的草稿（FS-54，录 work-scratch.json）、
//   Full access 写到外面的卡（录 full-outside.json）、关闭模式的 ask_user_question、你不在时的自动拒绝与提醒
//   （FS-82，录 away-reminder.json）；
// - fs-real-team.mjs：协作模式的收窄（FS-67，同一次运行量 FS-21 的协作模式部分）、关闭模式与协作模式分开时的提问（FS-93）；
// - fs-real-wt.mjs：快照的实测（FS-21）、worktree 里改文件、提交与合并（FS-113）、命令语料统计（FS-55，放在最后，这次运行
//   的会话也算进去）。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/fs-real.mjs --source <Mori 数据目录> [--repo <第二个 git 仓库>] [--only <步骤名或 FS 编号>] [--exe <Mori.exe>]
//   或 key 方式：不给 --source，FS_REAL_DEEPSEEK_KEY 与 FS_REAL_GLM_KEY 都有值（由运行它的进程从负责人的 env 文件读出、不回显），
//   只经界面建一个新的数据目录。结果写 test-results/fs-real.json（--only 时 fs-partial-real.json，--exe 时带 -packaged）。

import { createRealContext, runReal } from './fs-real-setup.mjs';
import { PERM_STEPS } from './fs-real-perm.mjs';
import { TEAM_STEPS } from './fs-real-team.mjs';
import { WT_STEPS } from './fs-real-wt.mjs';

// 身份段与权限在前（PERM_STEPS 里你不在的那一步在它自己的最后），然后协作模式、worktree，命令语料统计最后（WT_STEPS 的末项）
const steps = [...PERM_STEPS, ...TEAM_STEPS, ...WT_STEPS];

process.exitCode = await runReal(createRealContext({ steps }));
