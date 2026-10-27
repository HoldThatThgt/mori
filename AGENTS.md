# Mori 实现约定

给在本仓库里实现 Mori 的人和模型看。方案以 [docs/app-v0.md](docs/app-v0.md) 为准，本文件只摘录必须遵守的约定。

## 仓库结构

- `app/`：Windows 桌面 App（Electron + React/TS），后端原样使用 pi-coding-agent SDK。
  - `src/main/` 窗口、对话框、启动与有序关闭后台进程。
  - `src/preload/` 通往后台进程的 MessagePort，暴露 `window.mori`。
  - `src/kernel/` 后台进程（utilityProcess）：调用 pi、转发事件、读写 pi 的配置文件、模型层、平行 Agent 与 TaskBoard、
    记忆（记忆模块、system prompt 拼装、增强任务）、工作区（git 状态、快照与 Rewind、路径闸与命令分析、收窄、你不在、
    提问工具、worktree 与 Initialize git）。
  - `src/shared/` 进程桥协议：Mori 自己的命令用 zod；pi 事件只引用类型。
  - `src/renderer/` 界面。
  - `tests/` 合成端点、冒烟测试、预检脚本、静态检查。
- `docs/app-v0.md` 方案；`docs/v0/` 每个里程碑的检查记录与临时默认值。
- `docs/specs/` 构建规格：proposal 的实现说明；`docs/v1/` 模型层（[docs/specs/model-providers.md](docs/specs/model-providers.md)）、一键拉取模型（[docs/specs/model-discovery.md](docs/specs/model-discovery.md)，检查记录 `docs/v1/discovery-checks.md`，临时默认值在 `docs/v1/defaults.md`）、平行 Agent（[docs/specs/parallel-agents-taskboard.md](docs/specs/parallel-agents-taskboard.md)）、记忆（[docs/specs/memory.md](docs/specs/memory.md)）与文件系统（[docs/specs/file-system.md](docs/specs/file-system.md) 和续篇 [docs/specs/file-system-permissions.md](docs/specs/file-system-permissions.md)，检查记录 `docs/v1/fs-checks.md`）的检查记录、状态表与临时默认值。
- `demo/` 早期故事板，已冻结，只作视觉参考。
- `docs/proposal.md` 与 `docs/proposals/` 是原设计，部分规则本轮暂停，见 v0 方案第 9 节；agent-lifecycle、agent-communication、agent-collaboration 已被平行 Agent 与 TaskBoard Proposal 第四版取代。

## 工作约定（v0 方案第 8 节）

1. 规格只写"必须看到"：每屏一张状态表（状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作），实现该屏前写好。
2. 完成顺序：写状态表 → 从真实会话录 fixture → 界面测试 → 实现 → 用真实模型走一遍 → 负责人走查。缺一步不算完成。
   录 fixture 和真实模型走查只在模型看到的或做的有变化时做（发给模型的文字、工具、批准、会话的命令和事件）；只改界面布局、
   文字或样式时可以跳过，在检查记录里写明（2026-10-23 负责人定，见下面"测试分层"）。
3. 每一步都可以走查：一步只做一屏的状态或一族事件，每步都有在 App 里看得到的变化。
4. 不造后端：pi 有的能力直接用；pi 没有的，先确认是否在范围内（方案第 4 节、各构建规格的范围一节），不在就不写。
   每加一段非界面代码，都要能指向方案第 6 节"后台进程只做九件事"（第 6 件是模型层，按 `docs/specs/model-providers.md`，一键拉取模型按 `docs/specs/model-discovery.md`；第 7 件是平行 Agent 与 TaskBoard，按 `docs/specs/parallel-agents-taskboard.md`；第 8 件是记忆、拼装与增强，按 `docs/specs/memory.md`；第 9 件是工作区，按 `docs/specs/file-system.md`）或第 4 节表中标 Mori 的行。
5. `src/` 中不出现"示例""演示""mock"；界面测试回放的事件来自真实录制，手写的要标明 synthetic。
6. 诚实交付：交付说明列出未验证的项；遇到阻塞就停下来报告并给出选项，不写假实现，不静默换路线。
   临时默认值登记在 [docs/v0/defaults.md](docs/v0/defaults.md)；模型层、一键拉取模型、平行 Agent、记忆与文件系统的登记在 [docs/v1/defaults.md](docs/v1/defaults.md)。
7. 边界：pi 的运行时代码只在 `app/src/kernel/` 中 import；`app/src/shared/` 可以 `import type`。
   pi 和其他新依赖都锁精确版本，并确认可以离线使用。

## 测试分层（2026-10-23 负责人定，2026-10-26 改）

界面测试（App、回放、冒烟套件）每个都会一个接一个地弹出 Mori 窗口，完整跑一遍要一个多小时。平时每个任务只跑不开窗口的
最小集；完整测试只在负责人要求推送到远端时跑。跳过的层在检查记录和交付说明里写明。

1. 每个任务只跑最小集：`npm run test:min`（类型检查与静态检查、构建、`test:unit`、`test:tb-unit`、`test:mem-unit`、
   `test:md-unit`、`test:fs-unit`；不开窗口，2026-10-26 在本机约 100 秒，整套不超过 2 分钟）。合并别的分支或 rebase 之后也只跑最小集。
2. 任务里不跑 `m0-smoke`、`mN-app`、回放、`v1-models-*`、`tb-*`、`mem-*`、`md-*`、`fs-*` 套件和 `spec-coverage` 检查，
   新写或改过的界面套件也不单独跑：交付说明把它们列为未验证，留给推送前的完整测试。负责人点名要跑某个套件时照办。
3. 负责人要求推送到远端时，推送之前在开发构建上跑一次完整测试：`node tests/ui/v1-models-existing.mjs --id FS-115` 等汇总
   （它同时写 MP-37、TB-46、MEM-35、MD-15 的结果）、各 `tb-*`、`v1-models-*`、`mem-*`、`md-*`、`fs-*` 套件和各个 `spec-coverage` 检查
   （含 `node tests/spec-coverage.mjs --spec filesystem`）；再在打包程序上做冒烟：`npm run dist:dir`
   后跑 `m0-smoke --exe` 和一个 App 套件，改了打包配置、主进程或 preload 时加跑相关的套件。有失败先报告，由负责人决定
   是否推送。
4. 录 fixture 和真实模型走查只在模型看到的或做的有变化时跑（见上面"工作约定"第 2 条）。

## 工程约束（proposal 工程约束）

- 采用能满足当前需求的最简单实现，复用已有依赖；不增加兼容层、migration、fallback、推测性抽象或重复配置层。
  模型层从 `models.json` 的一次性迁移、按候选换 key 和换模型是统一模型提供商 proposal 要求的功能，不在此列；交给结案 Agent 的兜底、按写入等级的强制填写是平行 Agent proposal 要求的功能，同样不在此列；增强任务的补跑与失败后重试是提示词分层与记忆 proposal 要求的功能，也不在此列；按顺序试列表地址（补 `/v1`、去掉 `anthropic` 那一段）是一键拉取模型 proposal 要求的功能，同样不在此列。
- 每行不超过 120 字符，每文件不超过 2000 行，每函数不超过 50 行且不超过 5 个入参。
- 接口声明使用 Doxygen 风格注释，类型成员说明语义。
- 注释用中文；代码、日志和错误输出用英文；异常分支记录错误日志。
- 界面文字用英文（2026-10-21 起）：界面、读屏名、悬停提示、对话框，以及 Mori 写出的 F8 报告、导出、操作记录、
  发给模型的引用块和会话引用。有 Claude 桌面版对应的地方照 Claude 的用词；术语、写法和固定格式见
  [docs/v0/ui-strings.md](docs/v0/ui-strings.md)。注释仍用中文，注释里提到界面文字时照抄英文原文。
  模型层（v1）的界面文字同样按这份术语表。

## 常用命令（在 `app/` 下）

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 类型检查 + 静态检查（禁用词、行宽；字符串、正则、JSX 文本和 .html / .css 里不能有中文，注释不查） |
| `npm run test:min` | 每个任务跑的最小集：检查、构建和五组单元测试，不开窗口（见"测试分层"第 1 条） |
| `npm run smoke` | 构建后用合成端点跑冒烟测试 |
| `npm run dist` | 检查、构建并生成 NSIS 安装包 |
| `npm run test:unit` | 内核纯函数的单元测试（`node --test`） |
| `npm run test:v1-models` | 模型层的单元、App、回放测试，最后检查规格 §14 的每一条都有通过的结果 |
| `npm run test:taskboard` | 平行 Agent 与 TaskBoard 的单元、App、回放测试和现有套件，最后检查规格 §17 的每一条都有通过的结果 |
| `npm run test:mem-unit` | 记忆的单元测试（`node --test`） |
| `npm run test:memory` | 提示词分层与记忆的单元、App、回放测试和现有套件，最后检查规格 §14 的每一条都有通过的结果 |
| `npm run test:md-unit` | 一键拉取模型的单元测试（`node --test`，跳过的与 todo 的测试算失败） |
| `npm run test:discovery` | 一键拉取模型的单元、App、回放测试和现有套件，最后检查规格 §13 的每一条都有通过的结果（真实层 MD-14 由你跑 `md-real.mjs`） |
| `npm run test:fs-unit` | 文件系统的单元测试（`node --test`，跳过的、标为待办的测试算失败） |
| `npm run test:filesystem` | 文件系统的单元、App、回放测试和现有套件（`--id FS-115`），最后检查规格 §19.2 的每一条都有通过的结果（真实层由你跑 `fs-real.mjs`） |

本机访问不了 `registry.npmjs.org`，`app/.npmrc` 使用 npmmirror；安装 Electron 前设 `ELECTRON_MIRROR`，见 `app/README.md`。
