# Mori 实现约定

给在本仓库里实现 Mori 的人和模型看。方案以 [docs/app-v0.md](docs/app-v0.md) 为准，本文件只摘录必须遵守的约定。

## 仓库结构

- `app/`：Windows 桌面 App（Electron + React/TS），后端原样使用 pi-coding-agent SDK。
  - `src/main/` 窗口、对话框、启动与有序关闭后台进程。
  - `src/preload/` 通往后台进程的 MessagePort，暴露 `window.mori`。
  - `src/kernel/` 后台进程（utilityProcess）：调用 pi、转发事件、读写 pi 的配置文件。
  - `src/shared/` 进程桥协议：Mori 自己的命令用 zod；pi 事件只引用类型。
  - `src/renderer/` 界面。
  - `tests/` 合成端点、冒烟测试、预检脚本、静态检查。
- `docs/app-v0.md` 方案；`docs/v0/` 每个里程碑的检查记录与临时默认值。
- `docs/specs/` 构建规格：proposal 的实现说明；`docs/v1/` 模型层（[docs/specs/model-providers.md](docs/specs/model-providers.md)）的检查记录、状态表与临时默认值。
- `demo/` 早期故事板，已冻结，只作视觉参考。
- `docs/proposal.md` 与 `docs/proposals/` 是原设计，部分规则本轮暂停，见 v0 方案第 9 节。

## 工作约定（v0 方案第 8 节）

1. 规格只写"必须看到"：每屏一张状态表（状态 ｜ 来源 ｜ 必须可见 ｜ 可做的操作），实现该屏前写好。
2. 完成顺序：写状态表 → 从真实会话录 fixture → 界面测试 → 实现 → 用真实模型走一遍 → 负责人走查。缺一步不算完成。
3. 每一步都可以走查：一步只做一屏的状态或一族事件，每步都有在 App 里看得到的变化。
4. 不造后端：pi 有的能力直接用；pi 没有的，先确认是否在 v0 范围内（方案第 4 节），不在就不写。
   每加一段非界面代码，都要能指向方案第 6 节"后台进程只做六件事"（第 6 件是模型层，按 `docs/specs/model-providers.md`）或第 4 节表中标 Mori 的行。
5. `src/` 中不出现"示例""演示""mock"；界面测试回放的事件来自真实录制，手写的要标明 synthetic。
6. 诚实交付：交付说明列出未验证的项；遇到阻塞就停下来报告并给出选项，不写假实现，不静默换路线。
   临时默认值登记在 [docs/v0/defaults.md](docs/v0/defaults.md)；模型层的登记在 [docs/v1/defaults.md](docs/v1/defaults.md)。
7. 边界：pi 的运行时代码只在 `app/src/kernel/` 中 import；`app/src/shared/` 可以 `import type`。
   pi 和其他新依赖都锁精确版本，并确认可以离线使用。

## 工程约束（proposal 工程约束）

- 采用能满足当前需求的最简单实现，复用已有依赖；不增加兼容层、migration、fallback、推测性抽象或重复配置层。
  模型层从 `models.json` 的一次性迁移、按候选换 key 和换模型是统一模型提供商 proposal 要求的功能，不在此列。
- 每行不超过 120 字符，每文件不超过 2000 行，每函数不超过 50 行且不超过 5 个入参。
- 接口声明使用 Doxygen 风格注释，类型成员说明语义。
- 注释用中文；代码、日志和错误输出用英文；异常分支记录错误日志。
- 界面文字：模型层起新写和改写的界面用英文（app-v0 §11，2026-10-21）；没有改到的旧界面仍是中文，等英文任务统一改。

## 常用命令（在 `app/` 下）

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 类型检查 + 静态检查（禁用词、行宽） |
| `npm run smoke` | 构建后用合成端点跑冒烟测试 |
| `npm run dist` | 检查、构建并生成 NSIS 安装包 |
| `npm run test:unit` | 内核纯函数的单元测试（`node --test`） |
| `npm run test:v1-models` | 模型层的单元、App、回放测试，最后检查规格 §14 的每一条都有通过的结果 |

本机访问不了 `registry.npmjs.org`，`app/.npmrc` 使用 npmmirror；安装 Electron 前设 `ELECTRON_MIRROR`，见 `app/README.md`。
