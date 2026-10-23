# 一键拉取模型 检查记录

依据：[构建规格](../specs/model-discovery.md)（下称“规格”），它实现 [一键拉取模型 Proposal](../proposals/model-discovery.md) 第一版（2026-10-23）。
在 `claude/v1-discovery-91226e` 分支上做（从 `app-v0` 的 54f0758 切出，第一个提交是规格、proposal、状态表与文档）；
2026-10-24 合并进 `app-v0` 并推送（见下面“合并到 app-v0”）。

## 状态

实现与测试完成（2026-10-24），全部提交在 `claude/v1-discovery-91226e`，之后合并进 `app-v0`。规格 §3–§9 的行为全部实现；MD-01…MD-15 在各自列出的每一层都有通过的检查，
包括真实层 MD-14（你给了 key，见下面负责人的要求第 3 条）：`node tests/spec-coverage.mjs --spec discovery`（不带 `--allow-missing-real`）
输出 “every item is covered on every listed layer”。

最后一次在开发构建上依次跑完整的 `npm run test:discovery`（提交 6fdb6c7，2026-10-24 00:06–01:35），之后在同一个构建上用你的 key 跑 `md-real.mjs`：

| 层 | 结果 |
| --- | --- |
| 单元 | `test:md-unit` 197/197（跳过、todo 按失败算，没有）；`test:unit`（模型层）371/371；`test:tb-unit` 334/334；`test:mem-unit` 222/222；`npm run check` 通过 |
| App（合成端点） | `md-app-form` 82、`md-app-card` 68、`md-app-firstrun` 114，全部通过 |
| 回放 | `md-replay` 69/69：OpenRouter 的清单与 GLM 不带 key 的 401 是真实录制，`md-deepseek-card`、`md-glm-card` 是用你的 key 真实录制，`md-deepseek`、`md-shapes` 为 synthetic |
| 真实 | `md-real` 27/27：DeepSeek、OpenRouter、GLM 全部经界面操作（见下面“真实端点上看到的”）；回放检查在其中重放了这次录下的卡上拉取 |
| 现有功能（MD-15） | App 30/30（m0-smoke、m1–m6、v1-models、`tb-build-base`、9 个 `tb-app-*`、7 个 `mem-app-*`；m0-smoke 那条 `KNOWN` 是 pi #9129，这次之前就有）；回放与单元 16/16（test:unit、test:tb-unit、test:mem-unit、m1–m6、v1-models、tb、mem 的回放，模型层、TaskBoard、记忆的覆盖检查，以及 MD-15 的标记检查）；同时写了 MP-37、TB-46、MEM-35 的结果文件 |
| 标记检查 | `tests/md-markers.mjs`：这次新加的 19680 行（79 个文件）里没有 TODO、FIXME、not implemented、later、待实现 |
| key | 用你的 env 文件里的 4 个 key 在 `app/tests`、`app/test-results`、`docs`（4107 个文件）里查：没有 |

过程：契约（`shared/models.ts`、内核接口与文件归属、D1–D18）→ 实现 workflow（读取器、内核接线、清单与表单、模型行、首次启动五路，各接一路对抗审查）
→ 只读审查 workflow（8 个角度含“范围”一路 + 每条 3 个对抗核实 + 完整性复查，134 个 agent：确认 14 条、否掉 25 条，14 条全部修好）
→ 测试 workflow（三段：合成端点、覆盖与套件、样本；单元、现有测试迁移、三个 App 套件、回放与录制、真实层；补审计出的缺口与真实层运行，每路接一路审查）
→ 最后一次只读审查（98 个 agent：确认 20 条，都是文档、换行与无用代码，没有行为问题，全部修好）→ 依次跑全部套件两遍（第二遍在最终提交上）。
测试中只在多个套件同时跑时见过三处与本次无关的偶发失败（`tb-unit` 的 TB-39、`m6-app-mcp-shared` 第 9 步、`v1-models-app-switch` 的 Stop），依次跑的两遍里都通过。

交付：内核 `discoverRead.ts`（新）、`modelDiscover.ts`（新）、`modelCommands.ts`、`modelLayer.ts`（接线与 C11 的资源修正）、`probes.ts`、`modelProfiles.ts`、
`modelTimings.ts`；进程桥 `shared/models.ts`；界面 `settings/Checklist.tsx`（新）、`ProviderForm.tsx`、`Providers.tsx`、`ModelRows.tsx`、`ModelEditor.tsx`、
`fields.tsx`、`FirstRunForm.tsx`、`state/settings.ts`、`state/actionLog.ts`、`styles/models-settings.css`；测试见规格 §13 与 §13.4 的表；
文档：规格的五条更正与 §6.6 的负责人决定、两张状态表、defaults.md、ui-strings.md、AGENTS.md 与这份记录。

## 合并到 app-v0（2026-10-24）

你说“commit. merge, push”之后：

1. 先把 `origin/app-v0`（14b4c25：composer-pickers，输入框下面一行的权限、范围、Effort 按钮与用量圆环；AGENTS.md 的测试分层）
   合进分支（dfb7b46）。两边都改过的文件 30 个，有冲突的 7 个：`m1-app.mjs`、`m1-real.mjs`、`m6-record.mjs`、`m6-real.mjs`、
   `v1-models-app-session.mjs`（composer-pickers 把它的准备代码搬到了 `v1-models-session-setup.mjs`，探针日志的过滤跟着搬过去）、
   `docs/v0/ui-strings.md`、`docs/v1/screens/README.md`。两边的改动都留下（按行合并），composer-pickers 新写的步骤改走 Fetch models。
2. 合并后的修正（d1241c8）：
   - composer-pickers 的检查按首次启动表单原来的默认窗口 128,000 写；拉取之后清单行是合成端点报告的 131072。`m1-app` 的首次启动
     与“刚压缩完”、`m6-app-row` 的准备在清单行里把窗口改成 128000（规格 §6.2），`m6-helpers` 的 `firstRunAndOpen` 多一个 contextWindow。
   - 卡上原来的 Add model 表单（`m1-app` 的 addVerifiedModel、`m6-helpers` 的 addModelUi）和新套件 `m6-app-row` 里旧的
     Add provider 流程改走 Fetch models（§6.5、§13.4）。
   - 一次只读的合并审查（冲突的测试、两边都改的文档、源码、两组测试的语义冲突五个角度，每条一个对抗核实）确认 2 条，都已修好：
     `md-markers` 比较的起点是本地的 `app-v0`，它还停在 54f0758，合进来的 composer-pickers 的 “Queue for later” 被算成这次新加的
     标记（42 处），改成比较 `origin/app-v0`（分支合并的是它）；`first-run.md` 这次加的一行还写“顶栏范围按钮”，改成输入框下面一行的
     范围按钮“<提供商名称> · <当前模型 id>”。否掉 1 条（AGENTS.md 的测试分层没点名 md-* 套件：那里本来就是“等”，不是缺失）。
3. 测试按 AGENTS.md 的测试分层：合并之后只跑与冲突文件相关的套件和覆盖检查（第 3 条），打包程序只做冒烟（第 4 条）。
4. 在主目录把本地 `app-v0` 快进到 `origin/app-v0`，再 `--no-ff` 合并这个分支（“Merge v1-discovery: …”），推送 `app-v0`。
   主目录里没提交的规格与文档和这个分支的第一个提交逐字相同，合并前先放进一个带标签的 stash，确认它们都在历史里之后删掉。

| 层 | 结果 |
| --- | --- |
| 每次改动 | `npm run check`、build；`test:unit` 372、`test:tb-unit` 334、`test:mem-unit` 222、`test:md-unit` 197、合成端点自检 159，全部通过 |
| 开发构建的套件 | `md-app-form` 82、`md-app-card` 68、`md-app-firstrun` 114、`md-replay` 69、`m0-smoke` 18（+1 KNOWN，pi #9129）、`m2-app` 94、`m6-app-settings` 60、`m6-replay` 66、`v1-models-app-session` 146、`v1-models-app-settings` 141、`v1-models-app-switch` 78，全部通过；修正后 `m1-app` 46 / 47、`m6-app-row` 45 / 45、`m6-app-slash` 104–105 / 106（失败的见下面） |
| 检查 | `md-markers` 通过（对 14b4c25：81 个文件 19710 行）；四个 `spec-coverage`（模型层、taskboard、memory、discovery）通过 |
| 打包程序 | `npm run dist:dir` 之后 `m0-smoke --exe` 18（+1 KNOWN，同上）、`md-app-firstrun --exe` 114 / 114 |
| 没跑 | 完整回归（TB-46、MP-37、MEM-35、MD-15 汇总）：合并之后不要求（测试分层第 3 条）。真实模型走查（`m1-real`、`m6-real` 有冲突）：冲突只在测试的准备代码里（首次启动改走 Fetch models），合并没有改模型看到的或做的（第 5 条） |

没修的失败（都不在这次的代码里，没有改 composer-pickers 的测试）：

- `m1-app` 的“代码块：点"复制代码"后代码进系统剪贴板”：读回的剪贴板是空的。跑的时候这台机器锁屏（`LogonUI` 在运行），
  PowerShell 里 `Set-Clipboard` 之后 `Get-Clipboard` 也是空的；合并后第一遍（同样的源码）通过。`docs/v0/english-ui-checks.md`
  记过同样的情况。没验证：解锁后重跑。
- `m6-app-slash` 的“280px、生成中有字、Effort "High"”：量的时候左栏还在发送中（只有一个“Queue”，没有 ▾“More send options”；
  `waitRunningAt` 把发送中也算作开始生成）。在 composer-pickers 自己的提交 14b4c25 上（`git archive` 出来单独构建，同一台机器、
  同样锁屏）完整跑两遍，两遍都同样失败，量到的一样（`queue:28 stop:28`），所以不是这次合并带来的。
- `m6-app-slash` 的“拒绝启动：从文字框 Tab 依次是权限 → 范围 → 圆环”：合并后完整跑 5 遍失败 3 遍，14b4c25 完整跑 2 遍都通过
  （只跑那几个步骤时两边各失败 1 遍，但那时前面的步骤也失败了）。临时加日志看到：失败时按 Tab 之后焦点仍在文字框。会话树的
  “Open in split view”在打开之后才调 `focusComposer()`（等下一帧，浮层还开着就再等几帧），测试的 `splitOpen` 只等面板准备好、
  不等这次聚焦，聚焦晚到时把焦点从权限按钮拉回文字框；锁屏时动画帧被节流，晚到得更多。焦点的代码与测试都是 composer-pickers 的，
  这次没有改；两边失败次数的差别是不是只因为时序，没有查实。

## 负责人的要求（2026-10-23）

| # | 要求 | 怎么做到 |
| --- | --- | --- |
| 1 | 不留任何未完成项：规格 §3–§9 的每条行为、MD-01…MD-13 与 MD-15 在本次全部实现，并在它列出的每一层通过；不留 TODO、“later”、“not implemented”、桩代码，不留跳过、todo 或已知失败的测试 | `node tests/spec-coverage.mjs --spec discovery` 只对 MD-14 带 `--allow-missing-real`；拉取模型的结果文件里跳过或 todo 的测试按失败算；名字以 `MD-15` 开头的检查对本次新增和改动的文件查 TODO / FIXME / not implemented / later 标记 |
| 2 | 只做规格写了的：不加服务种类、设置、选项、兜底、目录查询、按名字猜、缓存或规格与状态表之外的界面；每条新代码路径都能指到规格的某一节 | 代码注释写明对应的规格小节；只读审查的“范围”一路专门找追溯不到规格的代码并删掉；规格有挡住实现的缺口时先问你，不自己定、不推后；状态表标“临时”的照标，不另加 |
| 3 | 只有 MD-14（真实层）可以留着：要用你数据目录里的 key | 后来你在会话里给了 key（2026-10-23：`HoldThatThgt` 目录下的 `mori.env`、`openrouter.env`、`glm.env`，“use them if u need”），所以 MD-14 在这台机器上跑了：`md-real.mjs` 加了按环境变量取 key 的方式（`MD_REAL_DEEPSEEK_KEY`、`MD_REAL_GLM_KEY`、`MD_REAL_OPENROUTER_KEY`），由运行它的进程从这几个文件读出、不打印；key 只在 Mori 自己的表单里输入，由 Mori 加密保存；录下的样本与 fixture 只有响应体和状态，没有请求头；用你数据目录的 `--source` 方式照旧可用 |
| 4 | 方法：用 Workflow 实现 | 先写契约（`shared/models.ts` 的类型与命令 schema、文件归属），再并行实现、每一路后接审查；然后只读审查（找问题 + 对抗核实，含范围一路）；再写测试；最后自己整合、构建、依次跑全部套件 |

## 实现中问你的（2026-10-23）

| # | 问题 | 你的回答 | 现在的做法 |
| --- | --- | --- | --- |
| 1 | 首次启动表单保存（key A）后把 Base URL 改到另一个 origin、框空着再拉取：§6.6 说拉取用内存里的 A，但接着保存时框空不发 key，模型层规格 §4.1 改了 origin 就删已存的 key，结果拉取有 key、保存后没有，占位却仍写“Saved. Leave empty to keep it.” | 选项 2，并修好占位文字（“option 2 + 修复占位数字”，按占位文字理解） | 规格 §6.6 与 first-run.md 已写明：内存里的 key 只在 Base URL 与保存的提供商同一个 origin 时用，占位写“Saved. Leave empty to keep it.”；origin 不同时拉取不带它、占位写“Optional”；带着不同的 origin 保存后内存里的 key 丢掉。MD-11 的“保存后改地址再拉取用内存里的 key”改成只改路径；另有一条检查改到别的 origin 时 key 与占位都回到 Optional |

## 规格更正

| # | 更正 | 依据 |
| --- | --- | --- |
| 1 | 规格更正（规划会话，2026-10-23）：§4.1 `chat` 先看 `capabilities.completion_chat`（布尔），再看 `type` | proposal §7：Mistral 的 `capabilities.completion_chat` 照通用规则读到；Mistral 的行同时有 `type: "base"`（或 `"fine-tuned"`），按原来的顺序 `type` 先下结论为假，每个 Mistral 聊天模型都会标 Not a chat model。规格与 proposal 冲突时以 proposal 为准，所以是规格的错，不是新的决定 |
| 2 | 规格更正（规划会话，2026-10-23）：§4.1 `contextWindow` 里 `meta.max_model_len`、`meta.n_ctx`、`meta.max_total_tokens` 三项（相对顺序不变）放在 `context_length` 之前 | 对照 llama.cpp 源码（`server-models.cpp`）：router 模式每行的 `context_length` 是 `n_ctx_train`（训练窗口），已加载模型的 `meta.n_ctx`（实际在用的窗口）只补进行里没有的键；按原来的顺序会读成训练窗口。`meta.*` 只出现在 llama.cpp 与 GPUStack `with_meta` 的行里，总是实际在用的窗口，proposal §7 |
| 3 | 规格更正（规划会话，2026-10-23）：§4.2 百炼一行，`inference_metadata.request_modality` 原样合并进行、按 §4.1 读，只有文字的模型因此明确报告没有图片；`capabilities`、`features`、`model_info` 不原样合并 | 原来只按对应取正面的值，只有文字的模型的图片为“没报告”；原样合并 `capabilities`（例如 `["TG"]`）会让 §4.1 把 `chat` 读成假、`VU` 也不算图片，所以只合并这一个字段 |
| 4 | 规格更正（规划会话，2026-10-23）：§3.2、§3.3 里对象有 `has_more` 或 `hasMore` 即为 Anthropic 形状，翻页的游标取 `last_id` 或 `lastId`（查询参数仍是 `after_id`） | MD-14 用你的 key 录下的 z.ai 列表（`glm-models-1.json`）是 `{ data, firstId, hasMore, lastId }`：按原来的写法认不出 Anthropic 形状，GLM 的 Add provider 写 “Detected: OpenAI-compatible server”，`hasMore` 为真时也不会翻页。API type 仍只看地址 |
| 5 | 规格更正（规划会话，2026-10-23，审查 C12）：§7.3 读版本时，第 6 步的请求连接失败或超时、种类因此判断为 unknown 的，按拿不到列表处理（档案不变）；404 等 HTTP 回答照样是判断种类的依据；只对读版本，探针第 0 步（§7.1）判断不了仍记 unknown | proposal §10 第 5 条“版本读不到时只比种类（同现在：读失败不算变化）”与模型层规格 MP-12“版本接口连不上时档案不变”。Ollama 的 `/api/version` 既是第 6 步的判断又是版本请求：它超时会让种类读成 unknown，原来按“种类不同即重新探测”会把这个提供商下每个模型都重新探测。单元测试：`profile-versions.test.mjs` 的 “list ok and /api/version timing out keeps the ollama profile” 与 “answering 404 is a changed kind” |

## 已知的限制与没验证的

- llama.cpp router 模式里没加载的模型只有 `context_length`（训练窗口），清单把它当报告的窗口、没有提示；§6.2 的 `trained_window` 提示只写给 Ollama，不另加（规划会话，2026-10-23）。
- 一次加入很多模型时的 `mori.profiles`（审查 C11；改在 `modelLayer.ts`、`modelProfiles.ts`，见规格 §2 的 2026-10-23 注）：原来每个探针开始、每一步、结束各发一份全部档案，
  一次加入 468 个模型时后台进程卡住数秒、序列化几百 MB。
  现在同一轮事件循环里的变化合成一份（第一份立即发、其余在这一轮结束时发最新的一份），拼档案视图由每个模型线性查找改为一次建索引；载荷与模型层规格 §9.5 相同。
  剩下的：探针第 2–7 步的开始（各等前一步请求的回复）和每个探针的结束各落在自己的一轮里，是那一轮的第一份、立即发，所以仍各发一份全部档案，总量随模型数平方增长。
  请求成功时每个模型约 7 份（模型都勾了 Supports thinking、要跑第 2 步；没勾的跳过第 2 步，少一份）：
  实测 100 个模型 684 份、合计约 54 MB；468 个模型 3208 份、合计约 1.2 GB，约 71 秒内陆续发出，后台进程最长停顿约 0.06 秒；
  key 被拒时模型池让排队的请求一起失败，各步合并，只剩每个探针的结束各发一份（真实写档案时每个探针在自己的一轮里结束；实测 1000 个模型约 1000 份、合计约 1 GB，
  30 秒内陆续发出、发完即释放，后台进程最长停顿 0.5 秒）。另外每个探针结束都重写一次整个 `model-profiles.json`。
  实测的做法（脚本在会话的临时目录，不进仓库）：esbuild 打包真实的 `kernel/modelLayer.ts`，替身 fetch 让列表 300 毫秒后回 N 个 OpenRouter 形状的模型；
  请求成功的那组对话请求 20–80 毫秒后回 HTTP 200（读完响应体、放回槽位），模型池每个 key 4 个，档案写入换成内存里的替身。
  再合并要按时间节流或成批写，规格没有这样的值，没有做；要做时需要你定一个新的临时默认值（定下后登记在 [defaults.md](defaults.md)“一键拉取模型”一节）。
- 审查 C8 的修法（保存成功晚到时不关掉已经换成的别的表单）同样用在了 Edit provider 和模型表单（Edit）：它们原来有同样的问题，修法只是落实“同一时刻只开一张”。
- SGLang 没有 `/version` 接口（版本在 `/server_info`，按 2026-10-23 的 `http_server.py`）：照 §3.3 与模型层规格 §7.1，SGLang 的版本仍为 null，档案键为 `sglang|unknown`，同这次之前（规划会话，2026-10-23：不改）。
- 原来被认成 vLLM 的 LocalAI、TensorRT-LLM（规格 §3.3）：升级后第一次读版本（§7.3）认出种类变成 `localai` / `tensorrt`，
  这个提供商下种类记成 `vllm` 的每个模型各重新自动探测一次（日志“server of <ref> changed to localai unknown; probing again”，
  TensorRT-LLM 为 `tensorrt unknown`；会再花一次自动探针的请求）；之后种类为 `localai` / `tensorrt`、版本为 null
  （档案里写 `unknown`），档案键最后一段由原来的 vLLM 版本变成 `unknown`，之后的读版本不再重新探测；
  这两种不再显示 Cancel test…（§7.2）。用 MD-12 的单元测试（`app/tests/unit/discovery/profile-versions.test.mjs`）
  和 App 测试（`app/tests/ui/md-app-card.mjs` 的 shapes 一步）在合成端点的 `localai`、`tensorrt` 形状上检查；
  没有真实的 LocalAI、TensorRT-LLM 部署，没在真实服务上验证。
- 模型层、TaskBoard 与记忆的真实层（MP-27；TB-04、TB-08、TB-34、TB-37、TB-45；MEM-05、MEM-10、MEM-22、MEM-34）本轮没有重跑，未验证
  （`app/tests/ui/v1-models-existing.mjs` 开头 MD-15 一段；[memory-checks.md](memory-checks.md)“未验证”对模型层与
  TaskBoard 的真实层也这样写）。
- 只有 OpenRouter、DeepSeek、z.ai 的 Anthropic 兼容列表（GLM）和 DeepInfra 是从真实服务录的（下面“录制的样本”；
  `open.bigmodel.cn` 只录到不带 key 的 401）。其余的种类与服务——vLLM、SGLang、llama.cpp、Ollama、LM Studio、TGI、LocalAI、
  Xinference、GPUStack、MindIE、LMDeploy、TensorRT-LLM、LiteLLM、New API、One API、Moonshot AI、百炼、千帆、Anthropic，
  以及种类为 `unknown` 的 Together、Mistral——只对手写（synthetic）的响应体检查过（其中几种另有合成端点的形状，
  `app/tests/fake-endpoint/discovery.mjs`），没在真实服务上验证（`app/tests/fixtures/discovery/bodies/README.md` 的“手写样本”；
  其中标“没核实”的有 LM Studio `/v1/models` 的行、百炼 compatible-mode 列表的形状、千帆的字段名、
  New API Anthropic 形状列表的 json 字段名）。
- GLM 的 OpenAI 形式地址（`open.bigmodel.cn/api/paas/v4/models`）带 key 时有没有列表、火山方舟有没有列表，都没有试
  （proposal §14）；MD-14 带 key 只试了 `https://api.z.ai/api/anthropic`。
- 百炼：`dashscope.aliyuncs.com` 上原生 `/api/v1/models` 的返回内容、`page_size=100` 是否被接受，以及 compatible-mode
  `/models` 的形状，都没有用真实 key 核对（proposal §14；[defaults.md](defaults.md)“百炼原生列表每页 / 最多页数”一行）。

## 实现时定下的（规格没写、实现必须有一个值的地方）

契约里的 D1–D18（`side-session-notes` 的 `discovery-contract.md`，这里照抄要点）：

| # | 情形 | 做法 |
| --- | --- | --- |
| D1 | 列表以外的请求（§3.3 第 6 步、§4.2 详情、读版本）的认证头 | 有 key 时带 `Authorization: Bearer <key>`；列表请求按 §3.2 |
| D2 | 有 Anthropic 提示时的第 ① 个列表地址 | 总带 `anthropic-version: 2023-06-01`；`x-api-key` 与 `Authorization` 只在有 key 时带 |
| D3 | `rejected`、`invalid` 没有原文时的“状态行” | `HTTP <状态码> <状态文字>` |
| D4 | `unreachable` 的 detail | 连接错误的 cause 原文（例如 `connect ECONNREFUSED 127.0.0.1:9`），没有时为错误原文；超时为 `Timed out after 15s` |
| D5 | 列表地址回 3xx、响应体超过 8 MB | 这一个地址按 `invalid` 失败（`Redirected to <location>`、`The model list is larger than 8 MB.`），接着试下一个；最后一个决定 `listError`（404/405 为 `no_list`，其余为 `invalid`）；401/403、连接失败、超时即停 |
| D6 | 15 秒从什么时候算 | 拿到这个 origin 的位置、发出之后，到读完响应体 |
| D7 | §3.3 的“第一行”“每一行” | 第 3 步与第 6 步 Ollama 的条件看第一行；第 4、5 步要求列表不空 |
| D8 | Anthropic 形状的翻页 | `after_id` 取响应的游标（字符串时），否则取最后一行的 id；游标是 `last_id`，没有这个字段时是 `lastId`（上面“规格更正”第 4 条） |
| D9 | 不是对象的行、id 不是字符串 | 当作没有字段的行，id 为空（Can’t add this model: the ID is empty）；先去重（留第一次出现的）再截到 1000 条 |
| D10 | 合并同时进行的读取 | 合并列表请求、翻页与 §3.3 的种类判断（含拿到列表后第 6 步的判断），键为 `baseUrl` + `api` + key 的 ref；新提供商不合并；等它的调用全部取消时才中止，所以取消命令不会取消探针第 0 步；单模型模式拿不到列表时第 6 步的判断同样合并一次；读完就丢 |
| D11 | §4.2 里 GPUStack、LocalAI 的 `<base>` | 拿到列表的那个地址的前缀；GPUStack 在拿到列表的地址上加 `with_meta=true` 重读 |
| D12 | 日志 | `discover <主机> kind=… models=… ms=…` 只对命令记；每个失败的详情请求记一行；日志里没有 key |
| D13 | 编辑提供商时带了 `models` | 不理会（同原来编辑时不理会 `model`） |
| D14 | 百炼的单模型模式 | `<origin>/api/v1/models?model=<编码后的 id>`，不翻页 |
| D15 | MindIE | 每个模型 `<origin>/v2/models/<编码后的 id>/config`，只受每个 origin 的并发上限限制 |
| D16 | `models.addModels` 同一次里重复的 id | 同样的错误文字“<id> is already in <provider name>.” |
| D17 | 操作记录里新提供商的主机 | `new URL(baseUrl).host`（非默认端口带端口）；不是 URL 时只记“Fetch models” |
| D18 | 没报告时的窗口与输出上限 | 放在 `shared/models.ts`（`UNREPORTED_CONTEXT_WINDOW`、`unreportedMaxTokens`），读取器与清单共用一份；defaults.md 的位置一栏已改 |

实现各路报上来、我接受的（A1–A21，`discovery-accepted-decisions.md`），以及审查的修法里定下的界面细节（A22、A23）：

| # | 情形 | 做法 |
| --- | --- | --- |
| A1 | 已有提供商拉取用哪个 key（§5.1“同 Test connection”） | 只看内存里有明文的 key（模型池里的那些），其中第一个没有 rate_limited、auth、quota 记录的，都有记录时第一个，都没有明文时不带认证头 |
| A2 | 新的一次发现自己就不合格（地址、key、提供商不存在） | 照样取消正在进行的那次（§5.3“新的到来时取消”） |
| A3 | 新建提供商没带模型 | 错误“A new provider needs at least one model”（界面不会这样发，zod 要求至少一个） |
| A4 | 读版本 | 按 `baseUrl` + `api` 分组，用组里第一个提供商的 key 和地址读一次；种类或版本变化的日志“server of <ref> changed to <kind> <version>; probing again” |
| A5 | 第 9 步与 §5.7 读指标 | 照旧用第一个 key 和探针步的时限（规格只改第 0 步） |
| A6 | key 换成 `***` 的范围 | 放进结果和日志的服务原文（listError.detail、Location、连接错误、日志里的地址）；解析出来的值（id、family、版本）不改，否则短 key 会改坏模型 id；在截到 2000 字之前换 |
| A7 | §4.1 思考、图片、工具 | 按表的列从左到右：任何一处报告支持即为真；“明确报告没有”一列只在没有任何一处报告支持时用；`no_tools` 只在没有一处报告支持工具、且有一处报告没有时加 |
| A8 | Anthropic 形状的后面某一页失败 | 留下已读到的页，记一行日志；读满 5 页仍不到 1000 条时 `truncated` 为假（§5.2 按超过 1000 条定义） |
| A9 | 命令的日志 | 没拿到列表时 `kind=none`；被取消时另记“discover <host> cancelled ms=…”；listError 单独一行 |
| A10 | LocalAI、MindIE 详情的形状（没有录制） | LocalAI 的 `/models/capabilities` 按数组或 `{ data: [...] }`、按 id 对上；MindIE config 读顶层 `max_seq_len`（proposal §14 未验证） |
| A11 | 百炼原生列表“取完” | 某一页少于 100 个，或读满 10 页 |
| A12 | 第 6 步的非 2xx | 不记日志（是判断种类的正常输入）；详情与版本请求失败照样记 |
| A13 | 每个请求的时限 | 用 setTimeout 与 AbortController（AbortSignal.timeout 的计时器不让进程等它）；fetch 与读响应体都和 signal 赛跑 |
| A14 | 连接错误是 AggregateError | 把里面的原文用“; ”连起来 |
| A15 | 关表单时取消拉取 | 只在它的拉取仍是最新一次时发 `models.discoverCancel`，不会取消别处刚开始的拉取 |
| A16 | 拉取命令出错、Fetch cancelled 显示到什么时候（临时） | Add provider 里改 Base URL 或 key 时清掉（连同上次保存失败的原文）；卡上的留到再点这张卡的 Fetch models |
| A17 | 过滤框、Add a model ID 里按 Enter（临时） | 什么也不做，不会按下“Add N models” |
| A18 | 清单的样子（临时） | 表头为 §6.2 的列名，放在最高 440px 的滚动框里；数字框是 inputMode numeric 的文字框；不能加入的行只有勾选框不可用，Added 的行全部不可用；Fetch models 不是主按钮 |
| A19 | “Updated to …”的位置、拉取中的 fetch-status | 在 Detected 一行之后（§6.1 的顺序）；拉取中 fetch-status 没有文字 |
| A20 | 首次启动（临时） | 内存里的 key 是上次保存成功时发出的 key；“有改动”指提供商字段与勾选的模型和上次保存的不同，或 key 框不空；保存中、测试中两个框只读、Fetch models 不可用；回到开始或新的一次拉取时清掉测试结果、探针状态与 Open folder…；有清单时加宽到 720px |
| A21 | 模型行的 Use | 与 Verify、上移下移共用这一行的“保存中”；“(not reported)”的括号部分在一个 span 里 |
| A22 | Add provider 加入中（Adding…，临时；审查 C7） | Base URL、API key 只读，Fetch models 不可用：免得加入还没返回时回到开始、收起清单（models-settings.md“加入中”一行的操作为“—”）；首次启动表单保存中、测试中同样（A20） |
| A23 | 卡上拉取中关掉这张卡的清单（临时；审查 C13） | 拉取中打开别的表单（Edit、Add provider、模型的 Edit、别的卡的 Fetch models）时，这次拉取被取消（A15、§5.3），卡上的按钮旁显示“Fetch cancelled”，留到再点这张卡的 Fetch models（同 A16；models-settings.md“卡上的 Fetch models”的“已取消”一行） |

## 录制的样本

`app/tests/fixtures/discovery/bodies/`，只存响应体和状态，不存请求头，文件里写明录制日期和地址：

| 文件 | 来源 |
| --- | --- |
| `openrouter-models.json` | 真实录制（2026-10-23，`https://openrouter.ai/api/v1/models`，公开列表，不带 key，468 个模型） |
| `deepseek-models-nokey.json` | 真实录制（2026-10-23，`https://api.deepseek.com/models`，不带 key：401） |
| `glm-models-nokey.json` | 真实录制（2026-10-23，`https://open.bigmodel.cn/api/paas/v4/models`，不带 key：401；不能说明 GLM 有没有列表接口，proposal §14） |
| `deepseek-models.json` | 真实录制（2026-10-23 首次、2026-10-24 在最终构建上重录，内容相同，`https://api.deepseek.com/models`，带你的 key，MD-14 的录制；2 个模型，带 `context_window`、`max_output_tokens`、`input_modalities`、`effort`，与官方文档一致），取代原来的 synthetic 样本 |
| `glm-models-1.json` | 真实录制（2026-10-23 首次、2026-10-24 在最终构建上重录，内容相同，`https://api.z.ai/api/anthropic/v1/models?limit=1000`，带你的 key，MD-14 的录制；11 个模型）：GLM 的 Anthropic 兼容地址**有**列表（proposal §14 原来以为没有） |
| `deepinfra-models.json` | 真实录制（2026-10-23，`https://api.deepinfra.com/v1/openai/models`，公开列表，不带 key；从 176 行里截了 5 行，行内容不改）：规格 §13.1 原列为手写，因有可用的公开接口改用真实录制。它的输出上限在 `metadata.max_tokens`，不在 §4.1 的路径里（`README.md` 已知问题 3），MD-03 的“不小于窗口的不算报告”另由 LiteLLM 样本、`openai-compatible-edge-rows.json` 和把 DeepInfra 每行的值放到 §4.1 输出上限路径上的 synthetic 用例（`rules-rows.test.mjs`）检查 |
| 其余（`README.md` 列出） | synthetic，各自写明依据（核对过的源码或文档地址） |

回放 fixture（`app/tests/fixtures/discovery/ui/`）：`md-openrouter.json`（真实，公开列表）、`md-glm.json`（真实，不带 key 的 401）、`md-deepseek-card.json` 与 `md-glm-card.json`（真实，MD-14 用你的 key 从卡上拉取录下）、`md-deepseek.json` 与 `md-shapes.json`（synthetic：合成端点的 rich、typed、ollama 等形状，覆盖真实服务给不出的清单情形与 §8 的五种提示）。

## 真实端点上看到的（MD-14，2026-10-23）

- DeepSeek：列表读出的窗口 1048576、输出上限 393216、思考、图片（只有 deepseek-flash）都与官方文档一致；勾选加入后探针完成。
- OpenRouter：468 个模型，过滤框按 id 子串过滤；加入一个免费、列出工具的模型。OpenRouter 的免费模型都要求思考，探针第 1–7 步里关闭思考的请求被拒（400 “Reasoning is mandatory”），档案为出错：这是模型层规格 §7.3 的判定（不是一键拉取的范围），可作为模型层的后续。
- GLM（`https://api.z.ai/api/anthropic`）：带 key 时第一个列表地址就拿到 11 个模型；列表里是小写的 `glm-5.3`，按 MD-14 手填的 `GLM-5.3` 照 §6.4 算作另一个 id，服务也认它，探针完成、工具调用已验证。
- z.ai 的 Anthropic 形状列表用驼峰的 `hasMore`、`lastId`（规格写的是 `has_more`、`last_id`），按原来的规格认不出 Anthropic 形状、Detected 写 OpenAI-compatible server；已按上面“规格更正”第 4 条改为两种写法都认。
- 一次完整的 MD-14 运行会花一点额度：首次启动与加入后的 DeepSeek、GLM 探针；录制时 DeepSeek 经本机转发，读版本认作 unknown，会再探测一次。
