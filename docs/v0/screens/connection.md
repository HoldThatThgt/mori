# 连接表单与首次启动（M1）

依据：方案 5.2。同一个表单出现在三处：首次启动、"设置 → 连接"、错误卡上的"去设置"。

> v1：见 docs/specs/model-providers.md §9.1：首次启动表单改为英文、加网络区域，写 Mori 的 `model-config.json`（§4.1）；"设置 → 连接"由设置 → Models 取代，"去设置"删除（§9.3）。状态表见 [../../v1/screens/first-run.md](../../v1/screens/first-run.md)。

## 字段

> v1：见 docs/specs/model-providers.md §9.1（首次启动表单的字段）、§4.1（写到 `model-config.json`）。

| 字段 | 写到哪里 | 说明 |
| --- | --- | --- |
| 名称 | `models.json` 中 `mori-endpoint` 的 `name` | 必填 |
| 服务地址 | `baseUrl` | 必填，必须是 URL |
| 接口类型 | `api` | 默认"OpenAI 兼容（Chat Completions）"= `openai-completions`；另有 `openai-responses`、`anthropic-messages` |
| API key | Mori 加密保存（`credentials.json`），不写 `models.json` | 密码框；已保存时占位文字"已加密保存（不显示）；改了服务地址就要重新填写" |
| 模型 ID | `models[0].id` | 必填 |
| 上下文长度 | `models[0].contextWindow` | 正整数，默认 128000（临时默认值） |
| 兼容选项 | `compat` 中对应字段 | 只在接口类型为 OpenAI 兼容时显示；勾选写入，取消勾选删除该字段；手写的其他 `compat` 字段保留。列表见 `docs/v0/defaults.md` |

## 状态表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | 启动后 `config.get` 尚未返回 | 表单不可编辑，"正在读取连接…" | 无 |
| 读取失败 | `config.get` 报错 | 错误原文 | 重新打开 App |
| 首次启动（v1：见 docs/specs/model-providers.md §9.1、§9.4 `firstRun`） | `config.get` 返回没有已保存的连接 | 整窗只有连接表单，标题"连接模型"，一句说明"填好后先测试连接" | 填写、保存、测试连接 |
| 已保存的连接（v1：见 docs/specs/model-providers.md §9.1：已有配置时不显示这张表单） | `config.get` 返回已保存连接 | 表单回填（key 不回填，只提示已加密保存） | 修改、保存、测试连接 |
| 有未保存的修改 | 你改了任一字段 | "保存"可用 | 保存；测试连接（会先保存） |
| 保存中 | 你点了"保存"或"测试连接" | 按钮不可用，"保存中…" | 无 |
| 已保存（v1：见 docs/specs/model-providers.md §9.4：`connection.save` 删除，改为 `models.firstRun`） | `connection.save` 返回无错误 | "已保存" | 测试连接 |
| 保存后 pi 报告配置错误（v1：见 docs/specs/model-providers.md §4.4 第 5 步、§9.4） | `connection.save` 返回 `error` | "已保存，但配置有错误："+ 原文 | 修改后再保存 |
| 保存失败（v1：见 docs/specs/model-providers.md §9.4、§4.1 改地址删除 key） | `connection.save` 报错（例如改了服务地址却没填 key） | "保存失败："+ 原文 | 修改后再保存 |
| 测试中（v1：见 docs/specs/model-providers.md §9.1：不用 30 秒总时限） | 你点了"测试连接" | 按钮变为"测试中…"，旁边出现"取消" | 取消 |
| 测试已取消 | 你点了"取消"，`connection.test` 返回取消 | "已取消测试" | 再次测试 |
| 测试成功（v1：见 docs/specs/model-providers.md §9.1：之后在表单下方显示探针状态） | `connection.test` 返回 `ok` | "连接成功 · 首字 N ms · 共 N ms"（有思考内容时加"· 有思考内容"）和回复开头 | 首次启动时进入"打开文件夹" |
| 测试失败 | `connection.test` 返回 `error` | "连接失败："+ 错误原文 | 修改、再次测试 |

## 首次启动之后：打开文件夹

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 等你选文件夹 | 首次启动时测试成功；或已有连接但还没打开任何会话（M3 起侧栏有会话时说明改为"从左侧选一个会话继续，或打开一个文件夹开始新的会话。"，见 [sessions.md](sessions.md)） | "打开文件夹…"按钮和一句说明"选择一个项目文件夹开始对话" | 打开文件夹… |
| 选择中 | 系统对话框打开 | 系统对话框 | 选择或取消 |
| 正在打开 | 选好了文件夹，`session.create` 尚未返回 | "正在打开 <文件夹名>…" | 无 |
| 打开失败 | `session.create` 报错 | "打开失败："+ 原文 | 再次打开 |
| 已打开 | `session.create` 返回 | 进入三栏布局，中栏是新会话的空状态 | 发第一条消息 |

（v1：见 docs/specs/model-providers.md §9.1：添加提供商改用设置 → Models 的提供商表单。）
M6 起可以有多个连接、每个连接下多个模型，"添加连接"用的就是这张表单（多了"支持思考"和"新会话默认的思考强度"），
见 [settings.md](settings.md)。

## 作为"设置 → 连接"与"去设置"的落点

> v1：见 docs/specs/model-providers.md §9.1、§9.3：由设置 → Models 取代，"去设置"删除；保存后打开着的会话不再换模型对象，下一个请求起按新配置选择（§4.4 第 6 步）。

- 中栏换成设置页，顶部"返回会话"；返回时会话的滚动位置、草稿都在（会话面板没有卸载，只是隐藏）。
- 从错误卡"去设置"进入时，同一页面，焦点放在 API key 输入框。
- 保存后已打开的会话用新配置（M0：整个后台进程共用一个 ModelRuntime，保存后 `refresh()`；M6 查明打开着的会话仍拿着旧的模型对象，
  改为保存后把它们换成新的模型对象，见 [../m6-checks.md](../m6-checks.md)）。
