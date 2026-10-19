# Mori

Mori（莫里）是面向个人机器和公司内网的桌面 Agent harness，以编码任务为主。
它让多个模型分别承担对话、目标整理、记忆查询、执行、监督和验收，
由程序维护任务状态、控制工具执行和分配模型并发。

用户通过 `agent.md` 定义 Agent，并指定随用户会话默认并行启动，或由 main agent 按需决定启动。
随会话启动的 main agent 相互平级，其中默认 agent 承担用户入口；每个 main agent 都能启动自己的 subagent，
subagent 不能再启动 subagent。main agent 之间可以通信，subagent 只能与自己的 main agent 和同族 subagent 通信。

Agent 向权限范围内的共享区追加简短结果、来源和更正；其他 Agent 在后续请求中按职责判断，
需要时读取原文或向作者追问。共享记录不逐条绑定操作依赖或版本检查，只保留必要的任务依赖。

仓库名称：`mori`。

当前方案（v0）：Electron 桌面 App，后端原样使用 pi-coding-agent SDK（1.3.0），Mori 只做界面、离线安装包和进程桥。
方案见 [Mori App v0 方案](docs/app-v0.md)，代码在 [app/](app/README.md)。

当前阶段：M2（批准与 F8）开发中：界面、后台进程与合成端点测试已完成，真实会话录制与真实模型走查等你提供走查数据目录。
检查记录见 [M0](docs/v0/m0-checks.md)、[M1](docs/v0/m1-checks.md) 和 [M2](docs/v0/m2-checks.md)。

原设计入口：[Mori 产品与技术 Proposal](docs/proposal.md)。其中以 DSH 为基座的选择和多 agent 机制本轮暂停，见 v0 方案第 9 节。

底座能力分别设计、评审和验收：

- [Agent 通信与上下文共享 Proposal](docs/proposals/agent-communication.md)
- [Agent 协作引导与上下文准备 Proposal](docs/proposals/agent-collaboration.md)
- [Agent 角色定义与生命周期 Proposal](docs/proposals/agent-lifecycle.md)
- [Chrome DevTools 内嵌工具 Proposal](docs/proposals/chrome-devtools.md)
- [内网模型资源可靠性 Proposal](docs/proposals/model-reliability.md)
- [界面与运行记录 Proposal](docs/proposals/interface.md)

重设计草案（2026-10-19，待评审；确认后替代上面文档中的相应部分）：

- [平行 Agent 与 TaskBoard Proposal](docs/proposals/parallel-agents-taskboard.md)（细节见[构建规格](docs/specs/parallel-agents-taskboard.md)）
- [统一模型提供商 Proposal](docs/proposals/model-providers.md)（细节见[构建规格](docs/specs/model-providers.md)）

## 界面 Demo（已冻结）

`demo/` 是早期的界面故事板，现在只作为视觉与交互参考，不再继续开发：[demo](demo/README.md)。

在 PowerShell 中运行 `./demo/start.ps1`，浏览器打开 <http://127.0.0.1:4173>。
模型请求、工具调用、测试输出与维护流程均为演示数据，尚未接入 DSH 运行时。
可查看任务阶段、两层 Agent 与独立子会话、工具调用树和请求轨迹，并体验登录等待、结果核对及休眠恢复。
