# 临时默认值

实现时需要一个值、但还没有经过你确认的地方都登记在这里。每一项都是"临时默认值"，拿到依据后再定。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 连接表单的上下文长度 | 128000 | `app/src/renderer/src/components/ConnectionForm.tsx` `emptyForm` | 与 pi 的默认值相同 | 拿到内网端点时 |
| 测试连接的最大输出 | 512 token | `app/src/kernel/config.ts` `TEST_MAX_TOKENS` | 推理模型先输出思考，太小时只收到思考、没有正文 | 拿到内网端点时 |
| 测试连接的超时 | 30 秒 | `app/src/kernel/config.ts` `TEST_TIMEOUT_MS` | 端点接受连接却不回复时，按钮不至于一直处于"测试中" | 拿到内网端点时 |
| 测试连接的提示词 | `Reply with one short sentence.` | `app/src/kernel/config.ts` `testConnection` | 短、任何模型都能回答；M1 用 DeepSeek 两个模型都正常 | 拿到内网端点时 |
| Mori 在 `models.json` 中的 provider id | `mori-endpoint` | `app/src/kernel/config.ts` `PROVIDER_ID` | 与 pi 内置 provider 不冲突 | M6（多模型） |
| 会话一律按"不信任项目"创建 | `projectTrusted: false` | `app/src/kernel/sessions.ts` `startSession` | 信任弹窗在 M3；在此之前不加载项目自带的扩展与配置 | M3 |
| 退出时等后台进程释放会话 | 3 秒 | `app/src/main/kernel-process.ts` `SHUTDOWN_TIMEOUT_MS` | 超时后直接结束整个进程树；M1 没有发现需要调整的情况 | M6 |
| 兼容选项列表 | 端点不支持 developer 角色（`supportsDeveloperRole: false`）、不接受 store（`supportsStore: false`）、最大输出用 `max_tokens`（`maxTokensField`）、不支持流式用量（`supportsUsageInStreaming: false`）、不支持 strict 模式（`supportsStrictMode: false`）、工具结果需要带工具名（`requiresToolResultName: true`） | `app/src/shared/protocol.ts` `COMPAT_OPTIONS` | 方案 5.2 要求每项配中文说明；挑的是 OpenAI 兼容端点最常见的几处差异，与思考有关的（需要 `reasoning: true` 才生效）留到 M6 | 拿到内网端点时 |
| 错误卡附"去设置"的文字匹配 | 原文含 `401`、`unauthorized` 或 `api key`（不区分大小写） | `app/src/renderer/src/components/Transcript.tsx` `SETTINGS_HINT` | 方案 5.8；其他错误附"把上一条消息放回输入框" | 拿到内网端点的错误原文时 |
| 工具卡展开后输出最多显示 | 最后 20,000 字 | `app/src/renderer/src/components/ToolCard.tsx` `OUTPUT_MAX` | 避免超长输出卡住渲染；pi 的命令输出本身已截到 50KB 左右 | M4（文件阅读器） |
| "在底部"的判定 | 离底部不超过 24px | `app/src/renderer/src/components/Transcript.tsx` `BOTTOM_SLACK` | 小于一行字，滚轮停在差几像素处也算在底部 | 你走查时觉得跟随不对再调 |
| 输入框最高 | 220px，之后在框内滚动 | `app/src/renderer/src/components/Composer.tsx` `MAX_INPUT_HEIGHT` | 约 9 行；再高会挤掉对话流 | 同上 |
| 右栏在出现改动时自动打开 | 本会话第一次有编辑或写入结果时打开；你手动开关之后以你为准 | `app/src/renderer/src/App.tsx` `Workspace` | 方案 5.9 只说"没有改动时默认收起"，有改动时按"默认打开"理解 | M4 |
