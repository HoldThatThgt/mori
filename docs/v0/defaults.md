# 临时默认值

实现时需要一个值、但还没有经过你确认的地方都登记在这里。每一项都是"临时默认值"，拿到依据后再定。

| 默认值 | 取值 | 位置 | 理由 | 何时复查 |
| --- | --- | --- | --- | --- |
| 连接表单的上下文长度 | 128000 | `app/src/renderer/src/App.tsx` `emptyForm` | 与 pi 的默认值相同 | 拿到真实端点时 |
| 测试连接的最大输出 | 512 token | `app/src/kernel/config.ts` `TEST_MAX_TOKENS` | 推理模型先输出思考，太小时只收到思考、没有正文 | 拿到真实端点时 |
| 测试连接的超时 | 30 秒 | `app/src/kernel/config.ts` `TEST_TIMEOUT_MS` | 端点接受连接却不回复时，按钮不至于一直处于"测试中" | 拿到真实端点时 |
| 测试连接的提示词 | `Reply with one short sentence.` | `app/src/kernel/config.ts` `testConnection` | 短、任何模型都能回答 | M1 |
| Mori 在 `models.json` 中的 provider id | `mori-endpoint` | `app/src/kernel/config.ts` `PROVIDER_ID` | 与 pi 内置 provider 不冲突 | M6（多模型） |
| 会话一律按"不信任项目"创建 | `projectTrusted: false` | `app/src/kernel/sessions.ts` `createSession` | 信任弹窗在 M3；在此之前不加载项目自带的扩展与配置 | M3 |
| 退出时等后台进程释放会话 | 3 秒 | `app/src/main/kernel-process.ts` `SHUTDOWN_TIMEOUT_MS` | 超时后直接结束整个进程树 | M1 |
| 工具卡输出最多显示 | 4000 字符 | `app/src/renderer/src/Chat.tsx` `ToolCard` | 临时界面，避免超长输出卡住渲染 | M1（正式工具卡） |
| 有新内容就滚到底部 | 总是跟随 | `app/src/renderer/src/Chat.tsx` `Chat` | 临时界面；方案 5.4 要求不在底部时不跟随 | M1 |
