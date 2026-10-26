# Mori 实现约定

给在本仓库里实现 Mori 的人和模型看。方案以 [docs/app-v0.md](docs/app-v0.md) 为准，本文件只摘录必须遵守的约定。

## 仓库结构

- `app/`：Windows 桌面 App（Electron + React/TS），后端原样使用 pi-coding-agent SDK。
  - `src/main/` 窗口、对话框、启动与有序关闭后台进程。
  - `src/preload/` 通往后台进程的 MessagePort，暴露 `window.mori`。
  - `src/kernel/` 后台进程（utilityProcess）：调用 pi、转发事件、读写 pi 的配置文件、模型层、平行 Agent 与 TaskBoard、
    记忆（记忆模块、system prompt 拼装、增强任务）。
  - `src/shared/` 进程桥协议：Mori 自己的命令用 zod；pi 事件只引用类型。
  - `src/renderer/` 界面。
  - `tests/` 合成端点、冒烟测试、预检脚本、静态检查。
- `docs/app-v0.md` 方案；`docs/v0/` 每个里程碑的检查记录与临时默认值。
- `docs/specs/` 构建规格：proposal 的实现说明；`docs/v1/` 模型层（[docs/specs/model-providers.md](docs/specs/model-providers.md)）、一键拉取模型（[docs/specs/model-discovery.md](docs/specs/model-discovery.md)，检查记录 `docs/v1/discovery-checks.md`，临时默认值在 `docs/v1/defaults.md`）、平行 Agent（[docs/specs/parallel-agents-taskboard.md](docs/specs/parallel-agents-taskboard.md)；普通模式的 subagent 工具是它的增补，[docs/specs/subagent.md](docs/specs/subagent.md)）与记忆（[docs/specs/memory.md](docs/specs/memory.md)）的检查记录、状态表与临时默认值。
- `demo/` 早期故事板，已冻结，只作视觉参考。
- `docs/proposal.md` 与 `docs/proposals/` 是原设计，部分规则本轮暂停，见 v0 方案第 9 节；agent-lifecycle、agent-communication、agent-collaboration 已被平行 Agent 与 TaskBoard Proposal 第四版取代。

## 工作约定（v0 方案第 8 节）

1. 规格只写"必须看到"：每屏一张状态表（状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作），实现该屏前写好。
2. 完成顺序：写状态表 → 从真实会话录 fixture → 界面测试 → 实现 → 用真实模型走一遍 → 负责人走查。缺一步不算完成。
   录 fixture 和真实模型走查只在模型看到的或做的有变化时做（发给模型的文字、工具、批准、会话的命令和事件）；只改界面布局、
   文字或样式时可以跳过，在检查记录里写明（2026-10-23 负责人定，见下面"测试分层"）。
3. 每一步都可以走查：一步只做一屏的状态或一族事件，每步都有在 App 里看得到的变化。
4. 不造后端：pi 有的能力直接用；pi 没有的，先确认是否在范围内（方案第 4 节、各构建规格的范围一节），不在就不写。
   每加一段非界面代码，都要能指向方案第 6 节"后台进程只做八件事"（第 6 件是模型层，按 `docs/specs/model-providers.md`，一键拉取模型按 `docs/specs/model-discovery.md`；第 7 件是平行 Agent 与 TaskBoard，按 `docs/specs/parallel-agents-taskboard.md`；第 8 件是记忆、拼装与增强，按 `docs/specs/memory.md`）或第 4 节表中标 Mori 的行。
5. `src/` 中不出现"示例""演示""mock"；界面测试回放的事件来自真实录制，手写的要标明 synthetic。
6. 诚实交付：交付说明列出未验证的项；遇到阻塞就停下来报告并给出选项，不写假实现，不静默换路线。
   临时默认值登记在 [docs/v0/defaults.md](docs/v0/defaults.md)；模型层、一键拉取模型、平行 Agent 与记忆的登记在 [docs/v1/defaults.md](docs/v1/defaults.md)。
7. 边界：pi 的运行时代码只在 `app/src/kernel/` 中 import；`app/src/shared/` 可以 `import type`。
   pi 和其他新依赖都锁精确版本，并确认可以离线使用。

## 测试分层（2026-10-23 负责人定，2026-10-26 改）

界面套件每启动一次 Mori 就弹出一个窗口。平时只跑不超过 2 分钟的快速集；完整的界面回归只在负责人要求推送到远端时跑。
跳过的层在检查记录里写明。

1. 每次改动：`npm run check`、构建、单元测试（`npm run test:unit` 和改动涉及的其他单元测试脚本），再跑界面快速集
   `npm run test:quick`（`tests/ui/quick.mjs`：冒烟测试加三段回放，两条线同时跑，整套不超过 2 分钟；超过时把集合减小，
   不往里加）。
2. 改动新增或改写的界面用例，只用 `--only` 跑这几个用例；不跑它们所在的整个套件，也不跑覆盖同一界面的其他套件。
3. 完整回归只在负责人要求推送到远端之前跑一次，在开发构建上：`node tests/ui/v1-models-existing.mjs --id TB-46` 等汇总、
   全部 `mN-app` 与回放、各 `tb-*`、`v1-models-*`、`mem-*`、`md-*` 套件和各个 `spec-coverage` 检查。合并别的分支或
   rebase 之后同样只跑第 1、2 条，完整回归留到推送前。
4. 打包程序：推送前 `npm run dist:dir` 后跑 `m0-smoke --exe`；改了打包配置、主进程或 preload 时，再用 `--exe` 跑这次改动
   自己的用例（`--only`）。
5. 真实模型走查与录 fixture 只在模型看到的或做的有变化时做（见上面第 2 条），只跑覆盖这次变化的用例。

## 不留未完成项，不做规格外的东西（2026-10-26 负责人定）

负责人原话："Do not defer any pending implementation work — enforce this with test cases — and do not build anything the spec
doesn't describe." 对所有会话、子 Agent 和工作流里的 Agent 都适用。

1. 规格写了的实现（含包的说明、走查条目、负责人的回答），在同一个包、同一个会话里做完：不写"留到后续""交给下一个包"
   "以后再做"，不留占位实现。要等别的包合并的部分，那个包一合并就做；不依赖它的部分现在就做，不等。
   要负责人选的，先按推荐做完并登记临时默认值；只有真正的阻塞（缺权限、缺数据、方案互相冲突）才按工作约定第 6 条停下来报告，
   这一项不算完成。
2. 用测试守住，测试不过不算完成：
   - 规格验收表的每一条先写测试（测试名以编号开头），再写实现。`tests/unit/spec-ids.test.mjs`（`npm run test:unit`）查
     每份规格表的每个编号在它列出的每一层都有测试写好，测试里用到的编号都在表里。新规格加进 `tests/spec-coverage.mjs` 的
     `SPECS`，这两项检查和推送前的覆盖检查就都管到它。
   - 单元报告器全部是严格模式：跳过的、标为待办的测试算失败。`tests/md-markers.mjs`（`npm run test:unit` 里的 MP-38）：
     新加的行里不能有推迟实现的标记。
   - 推送前的 `spec-coverage`：每个编号在它列出的每一层都要有通过的结果；名字以这份规格的前缀开头、编号却不在表里的检查算缺口。
   - 界面检查的 `known` 只用于上游的问题（pi 的缺陷、模型行为），不用来放过自己没做完的。
   - 测试查得到的就写成用例、在同一个包里跑；"没有验证的"只留测试到不了的（真实的桌面外观、这台机器造不出的环境），写明为什么。
3. 不做规格没写的东西：行为、选项、界面、文字，先写进规格（状态表；验收表加编号）再写测试和实现。规格外的"顺手"改进、预留的
   扩展点、没有验收条目的功能都不做。负责人已经要求的（走查条目、回答、诊断计划）规格里还没写，就先补进规格再做；不属于这些的
   停下来问负责人。

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
| `npm run smoke` | 构建后用合成端点跑冒烟测试 |
| `npm run test:quick` | 构建后跑界面快速集（冒烟测试加三段回放，不超过 2 分钟）；每次改动跑这个，不跑下面的整套 |
| `npm run dist` | 检查、构建并生成 NSIS 安装包 |
| `npm run test:unit` | 内核纯函数的单元测试（`node --test`） |
| `npm run test:v1-models` | 模型层的单元、App、回放测试，最后检查规格 §14 的每一条都有通过的结果 |
| `npm run test:taskboard` | 平行 Agent 与 TaskBoard 的单元、App、回放测试和现有套件，最后检查规格 §17 的每一条都有通过的结果 |
| `npm run test:mem-unit` | 记忆的单元测试（`node --test`） |
| `npm run test:memory` | 提示词分层与记忆的单元、App、回放测试和现有套件，最后检查规格 §14 的每一条都有通过的结果 |
| `npm run test:md-unit` | 一键拉取模型的单元测试（`node --test`，跳过的与 todo 的测试算失败） |
| `npm run test:sa-unit` | 普通模式 subagent 工具的单元测试（`node --test`） |
| `npm run test:subagent` | subagent 工具的单元、App、回放测试，最后检查规格 §14.3 的每一条都有通过的结果（真实层 `sa-real.mjs` 要 `--source`） |
| `npm run test:discovery` | 一键拉取模型的单元、App、回放测试和现有套件，最后检查规格 §13 的每一条都有通过的结果（真实层 MD-14 由你跑 `md-real.mjs`） |

`test:v1-models`、`test:taskboard`、`test:memory`、`test:discovery`、`test:subagent` 和 `test:m6-app` 跑的是整套界面测试，只在推送到远端之前跑
（见"测试分层"第 3 条）；平时只跑其中的单元测试脚本。

本机访问不了 `registry.npmjs.org`，`app/.npmrc` 使用 npmmirror；安装 Electron 前设 `ELECTRON_MIRROR`，见 `app/README.md`。
