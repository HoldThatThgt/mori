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

基座选择：DeepSeek Harness 官方桌面工程，保留桌面界面和原生运行时，在现有扩展点增加业务能力。

当前阶段：方案设计。基座选型和产品名称已确定，具体实现尚未开始。

设计入口：[Mori 产品与技术 Proposal](docs/proposal.md)。

底座能力分别设计、评审和验收：

- [Agent 通信与上下文共享 Proposal](docs/proposals/agent-communication.md)
- [Agent 协作引导与上下文准备 Proposal](docs/proposals/agent-collaboration.md)
- [Agent 角色定义与生命周期 Proposal](docs/proposals/agent-lifecycle.md)
- [Chrome DevTools 内嵌工具 Proposal](docs/proposals/chrome-devtools.md)
- [内网模型资源可靠性 Proposal](docs/proposals/model-reliability.md)

重设计草案（2026-10-19，待评审；确认后替代上面文档中的相应部分）：

- [平行 Agent 与 TaskBoard Proposal](docs/proposals/parallel-agents-taskboard.md)（细节见[构建规格](docs/specs/parallel-agents-taskboard.md)）
- [统一模型提供商 Proposal](docs/proposals/model-providers.md)（细节见[构建规格](docs/specs/model-providers.md)）

## 界面 Demo

已提供基于 proposal 和 DSH 当前界面结构的本地交互演示：[demo](demo/README.md)。

在 PowerShell 中运行 `./demo/start.ps1`，浏览器打开 <http://127.0.0.1:4173>。
模型请求、工具调用、测试输出与维护流程均为演示数据，尚未接入 DSH 运行时。
