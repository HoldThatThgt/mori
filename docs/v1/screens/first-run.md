# 首次启动

依据：规格 §4.5（迁移与迁移失败）、§4.1（配置读不出）、§7.4（首次启动保存后跑探针）、§9.1“首次启动表单”、§9.4、§9.5、§12；
拉取模型的部分按 [一键拉取模型构建规格](../../specs/model-discovery.md)（本文件称“发现规格”）§3.3、§3.4（Detected、API type、名称、区域）、
§5.1–§5.4（`models.discover`、取消、`models.firstRun` 收多个模型与默认范围）、§6.1–§6.4（提供商表单、清单、列表错误、Add a model ID）、§6.6（首次启动表单）、§9（key）。
取代 [v0 connection.md](../../v0/screens/connection.md) 的连接表单与首次启动；“首次启动之后：打开文件夹”沿用 v0，
2026-10-26 起测试连接成功就进入主窗口，在那里打开文件夹（负责人走查 M2，见下面“测试成功之后：主窗口”）。
表单为英文（规格 §9.1、发现规格 §6），写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的文字规格没给，是本表定的。
清单的行、标记、默认勾选与改值的规则和设置页的提供商表单相同，见 [models-settings.md](models-settings.md)“清单”；本表只写首次启动不同的地方，
以及发现规格 §6.2 定下的、首次启动测试要看的几条。

## 来源

| 来源 | 内容 |
| --- | --- |
| `config.get` 的结果 | `firstRun`（`model-config.json` 不存在，且没有迁移成）、`migrationError`（迁移失败的原文）、`configError`（配置存在但读不出） |
| `models.discover` 的结果 | `DiscoverResult`（发现规格 §5.2）：`error`、`cancelled`、`server`（`kind`、`version`）、`api`、`baseUrl`（建议的 Base URL）、`name`、`anthropicShape`、`listError`、`models`（`DiscoveredModel[]`）、`truncated`；`notListed` 与每行的 `added` 只对已有提供商，首次启动里总是空、为假 |
| `models.discoverCancel` 的结果 | `{ error }`；被取消的那次 `models.discover` 返回 `cancelled: true` |
| `models.firstRun` 的结果 | `{ providerId, error }`：一次写入提供商、勾选的全部模型、key 和 `normalDefault`（发现规格 §5.4） |
| `connection.test` 的结果 | `{ providerId, modelId: 第一个勾选的模型 }` 的测试结果（成功 / 失败 / 已取消）；成功时结果文字带到主窗口（界面状态 `connected`，只在这次运行里） |
| `shared/models.ts` | `suggestZone`（按 Base URL 框里的地址预选区域，发现规格 §3.4）、`SERVER_KIND_LABELS`（Detected 一行的种类名，发现规格 §3.3） |
| 你的操作 | 填 Base URL 与 API key、Fetch models（含拉取后再点）、拉取中的 Cancel、勾选与改值、Select all、Clear selection、过滤、Add to list、More settings、选区域、Test connection；这张表单里最后填过的 key（只在表单内存里，发现规格 §6.6） |

## 进入与不进入

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 读取中 | 启动后 `config.get` 还没返回 | 整窗“Loading…”（临时，走查时可以改），不显示表单 | — |
| 读取失败 | `config.get` 报错 | “Couldn’t load model settings: <原文>” | 重新打开 App |
| 首次启动 | `config.get` 的 `firstRun` 为真 | 整窗只有首次启动表单：标题“Connect a model”，说明“Enter the base URL and API key, then fetch the models.”（发现规格 §6.6）；表单在“开始”的状态（下表） | 填写；Fetch models |
| 迁移失败 | `firstRun` 为真且 `migrationError` 不为 null（`models.json` 读不出、或明文 key 加密失败，§4.5） | 表单上方“Couldn’t import your previous model settings: <原文>”（临时，走查时可以改）；表单在“开始”的状态，两个框为空 | 同首次启动 |
| 已有配置 | `firstRun` 为假、`configError` 为 null | 不显示表单，进入三栏布局（迁移刚成功时直接打开 设置 → Models，见 models-settings.md） | — |
| 配置读不出 | `configError` 不为 null | 不显示表单，进入三栏布局；会话一律按 `config_invalid` 拒绝启动（model-chat.md）；设置 → Models 只显示这条错误 | — |

## 表单字段

从上到下的顺序（发现规格 §6.1、§6.6）。拉取之前只有前三项；拉取之后其余各项出现，前三项仍在原处。

| 字段 | 写到哪里 | 说明 |
| --- | --- | --- |
| Base URL | `baseUrl` | 必填，http 或 https URL；占位“http://host:8000/v1”（沿用 v0/ui-strings.md）；拉取中只读。拉取后结果的 `baseUrl`（建议的 Base URL）与你填的不同（两边去掉首尾空白和结尾的 `/` 后比较）时框里换成它，这次替换不算你改了 Base URL；拿到了列表时下面一行“Updated to <url> so the model list loads.”，列表错误时只换框、不写这一行（发现规格 §6.1 第 3 项）。拉取后你改了它，回到“开始” |
| API key | 主进程加密保存，`keys: [{ ref: <id>#1, label: "Key 1" }]` | 可空（空时请求不带认证头，§8.4）；密码框；拉取中只读；占位文字：没保存过时“Optional”（临时，走查时可以改）；保存过、提供商存着这张表单保存的 key（某次保存时框里有 key，且之后没有带着不同的 origin、框空着保存），且 Base URL 框的地址与保存的提供商是同一个 origin 时“Saved. Leave empty to keep it.”（发现规格 §6.6）；其余情形都是“Optional”：每次都框空着保存、从没发过 key，已存的 key 因带着不同的 origin、框空着保存被删，或 Base URL 框的 origin 与保存的不同（2026-10-23 负责人决定，见下“保存后改到别的 origin”）；不回填明文。拉取时作为 `keySecret` 只用于这次拉取，不存、不进模型池、不写日志（发现规格 §5.1、§9）；点 Test connection 保存时才加密保存。保存后框清空，表单把这张表单保存时最后发出的那个 key 留在内存里（之后框空着保存不改它；提供商没有 key 时内存里也没有）：之后再拉取而框是空的、占位是“Saved. Leave empty to keep it.”时用它作为 `keySecret`；它不显示，框空时保存不再发送（照旧保留已存的 key），表单关闭就丢掉（发现规格 §6.6）。拉取后你改了它，回到“开始” |
| Fetch models | — | `models.discover`（`target.kind: 'new'`）；Base URL 不是 http/https URL 时不可用；拉取中为“Fetching models…”，不可用。拉取后仍在 API key 下方，再点就是再拉一次：清单、列表错误和手填的行从头来（发现规格 §6.1） |
| Detected | — | 一行“Detected: <种类名> <版本>”：种类名按 `SERVER_KIND_LABELS`，`unknown` 且 `anthropicShape` 为假时写“OpenAI-compatible server”，为真时写“Anthropic-compatible server”；`server.version` 为 null 时不写版本；没拿到列表（`server` 为 null）时不显示（发现规格 §3.3、§6.1） |
| Name | 提供商 `name`；提供商 `id` 由它生成（§4.1） | 必填；预填结果的 `name`（Base URL 的主机名，端口不是协议默认端口时加“:<端口>”，发现规格 §3.4）。你在这张表单里改过之后，再拉取不覆盖；没改过时每次拉取按新结果重新预填（发现规格 §6.1） |
| API type | `api` | “OpenAI-compatible (Chat Completions)”、“OpenAI Responses”、“Anthropic Messages”（§9.1）；预填结果的 `api`：只看地址，有 Anthropic 提示（路径里有一段 `anthropic`，或主机是 `api.anthropic.com`）为 Anthropic Messages，没有为 OpenAI-compatible，列表的形状不改它；OpenAI Responses 只能手选（发现规格 §3.4）。你改过之后，再拉取时作为 `target.api` 发出、不被覆盖；改它不清掉清单（发现规格 §6.1） |
| Network zone | `zone` | 必选；Local / Intranet / Public；拉取后界面用 `shared/models.ts` 的 `suggestZone` 按 Base URL 框里的地址（可能已换成建议的地址）预选建议值（发现规格 §3.4，§12 的规则）。你在这张表单里选过之后，再拉取不覆盖；没选过时每次拉取重新预选（发现规格 §6.1） |
| 清单（Models (N)） | `models`：勾选的行，按清单顺序 | 行、勾选、标记、提示、改值的检查、过滤框都见 [models-settings.md](models-settings.md)“清单”（发现规格 §6.2）。其中：Select all、Clear selection 只作用于显示着的、能勾的行；行数（含手填的行）超过 20 时有过滤框，按 id 子串过滤、不分大小写，被藏起来的勾选行照样保存；“Default”只在值仍是 Mori 的默认值时标，你改成别的值就不标（2026-10-26 改，原来是“Not reported”、改了值也留着）；列表为空（`models` 为空、`listError` 为 null）时“Models (0)”，下面一句“The server didn’t list any models.”，再下面是 Add a model ID。首次启动里没有“Added”的行（`added` 只对已有提供商）。Family 不显示，按结果的 `family` 原样保存 |
| 列表错误 | — | 没拿到列表时代替清单，见状态表“列表错误”。手填的行列在错误一句下面，样子同清单的行；没有“Models (N)”标题、Select all、Clear selection 和过滤框（发现规格 §6.3） |
| Add a model ID | 加进清单末尾的一行 | Model ID 输入框和“Add to list”；id 按 §4.1 检查，与清单里的行重复时“Model IDs must be unique within a provider.”；加进来的行勾上、标“Entered by you”，Context window、Max output 取默认值并标“Default”（发现规格 §6.4；2026-10-26 改，原来是“Not reported”，只在值仍是默认值时标，见 models-settings.md“清单的行”） |
| More settings | `compat` 的字段 | 点开后只有 Compatibility options（每个勾选框是 §9.1 的标签，下面一行小字说明，沿用 english-ui；2026-10-26 改（负责人走查 M1）：同 Edit provider，图例下面先一行说明“Mori already adjusts requests for well-known services such as DeepSeek. Check an option only if this server rejects requests.”，勾选框只剩五个，见 models-settings.md“提供商表单：Edit”）；首次启动没有 Concurrency per key；API type 不是 OpenAI-compatible 时不显示 More settings（发现规格 §6.6） |
| 探针代价 | — | Test connection 上方一句“Each model is verified with up to 13 short requests.”（发现规格 §6.6、§11；proposal §12 第 5 条）；拿到列表和列表错误时都有 |
| Test connection | — | 拉取后出现在表单底部（代替提供商表单底部的 Add 与 Cancel）；见状态表 |

首次启动表单没有关闭表单的“Cancel”（发现规格 §6.6；拉取中的“Cancel”照样有）。表单关闭（测试成功后进入三栏布局）时，
正在进行的拉取先取消（`models.discoverCancel`，发现规格 §6.1 的规则；测试中 Fetch models 不可用，所以这时没有拉取在进行），
内存里的 key 一起丢掉。
表单没有 Concurrency per key（写默认值 4，`MODEL_LIMITS.concurrencyDefault`）和 Default effort for new sessions
（清单不设新会话的思考强度：勾了 Supports thinking 的模型，新会话按 pi 设置的 `defaultThinkingLevel`，之后在设置 → Models 的 Edit 里改，发现规格 §5.4）。
字段错误的文字同 [models-settings.md](models-settings.md)“字段错误的文字”。

## 状态表

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 开始 | 表单刚出现；或拉取后你改了 Base URL 或 API key（清单、列表错误、手填的行都清掉，Name 等字段一起收起，发现规格 §6.1）；或拉取已取消 | 只有 Base URL、API key、“Fetch models”；Base URL 不是 http/https URL 时 Fetch models 不可用，改过的 Base URL 旁显示字段错误“Base URL must be an http or https URL.” | 填写；Fetch models |
| 拉取中 | 你点了 Fetch models（第一次，或拉取后再点）：`models.discover`（`target: { kind: 'new', baseUrl: Base URL 框的值, api: 你在 API type 里改过的值，没改过为 null, keySecret: API key 框的值；框为空、且 API key 的占位是“Saved. Leave empty to keep it.”（这张表单保存过、提供商存着它保存的 key、Base URL 框的地址与保存的提供商是同一个 origin，见“表单字段”的 API key）时为内存里的 key（发现规格 §6.6；origin 的条件是 2026-10-23 负责人决定），否则为 null }`） | 按钮“Fetching models…”，不可用；旁边“Cancel”；Base URL、API key 只读（发现规格 §6.1）；没有关闭表单的 Cancel | Cancel（`models.discoverCancel`） |
| 已取消 | `models.discover` 返回 `cancelled: true` | 回到开始，显示“Fetch cancelled” | Fetch models |
| 拉取的命令失败 | `models.discover` 返回 `error`（Base URL 或 key 不合格，例如“API key contains characters that cannot be sent in a header”，发现规格 §5.1） | 回到开始，Fetch models 下方原文（位置临时，走查时可以改） | 修改后再 Fetch models |
| 拉取后 | `models.discover` 返回，`error` 为 null、`cancelled` 为假、`listError` 为 null | 依次：Base URL、API key 与“Fetch models”（仍在 API key 下方）；Detected 一行；建议的 Base URL 不同（去掉首尾空白和结尾 `/` 后比较）时换掉框里的值并显示“Updated to <url> so the model list loads.”；Name、API type、Network zone 预填（你在这张表单里改过的不覆盖）；清单（models-settings.md“清单”：默认勾选、“Default”（2026-10-26 起取代“Not reported”）、“Not a chat model”、“Can’t add this model: …”、两种提示、行数超过 20 时的过滤框、“Showing the first 1,000 models.”；列表为空时“Models (0)”和“The server didn’t list any models.”）；Add a model ID；More settings（API type 为 OpenAI-compatible 时）；探针代价一句；Test connection | 改 Name、API type、区域；勾选、改值；Select all；Clear selection；过滤；Add to list；More settings；Test connection；再点 Fetch models；改 Base URL 或 API key 回到开始 |
| 列表错误 | `models.discover` 返回，`listError` 不为 null | 不显示 Detected（`server` 为 null）；建议的 Base URL 不同时照样换框，但不写“Updated to …”一行（发现规格 §6.1 第 3 项）；Name、API type、Network zone 照样预填；清单的位置换成列表错误的一句（四种文字见 models-settings.md“列表错误”，发现规格 §6.3；`unreachable` 的 `detail` 为连接错误或“Timed out after 15s”，发现规格 §5.2）和“You can still add model IDs below.”；手填的行列在这句下面，样子同清单的行，没有“Models (N)”标题、Select all、Clear selection 和过滤框；Add a model ID；More settings；探针代价一句；Test connection（还没有手填的行时勾选数为 0，不可用） | Add to list；改值、勾选手填的行；Test connection；再点 Fetch models；改 Base URL 或 API key 回到开始 |
| 再拉一次 | 拉取后你再点 Fetch models；或改了 Base URL、API key 回到开始后再点 | 清单、列表错误、手填的行从头来（勾选按新结果的默认勾选）；Name、API type、Network zone、More settings 里你改过的值留着、不被新结果覆盖，没改过的按新结果重新预填；改过的 API type 作为 `target.api` 发出（发现规格 §6.1、§3.4） | 同拉取后或列表错误 |
| 改 API type | 拉取后你改了 API type | 清单、手填的行和勾选都不变；More settings 随 API type 显示或隐藏（不是 OpenAI-compatible 时不显示，发现规格 §6.6） | — |
| 区域为 Public | 你在 Network zone 选了 Public（或预选为 Public） | 区域下方“Public providers must be allowed per project. You’ll be asked when you open a folder.”（发现规格 §6.6：说明不变） | 改选 |
| 填写 | 拉取后你改了任一字段或勾选 | 字段错误时字段旁英文错误；勾选数为 0、勾选的行有错误、或 Name、Network zone 有错误时 Test connection 不可用 | Test connection |
| 保存中 | 你点了 Test connection，表单有改动（从没保存过也算有改动，临时，走查时可以改）：`models.firstRun`（`providerId` 第一次为 null，之后为上次返回的 id；`provider` 为 Name、Base URL 框、API type、Network zone、Concurrency per key 的默认值、兼容选项；`models` 为勾选的行，按清单顺序，过滤框藏起来的勾选行也算；API key 框为空时 `keySecret` 为 null，保留已存的 key，内存里的 key 不再发送） | 按钮“Saving…”（临时，走查时可以改），不可用 | — |
| 保存失败 | `models.firstRun` 返回 `error`（配置写失败时本次新存的 key 已删除） | “Couldn’t save: <原文>”（临时，走查时可以改）；不开始测试 | 修改后再试 |
| 已保存 | `models.firstRun` 返回 `providerId`、`error` 为 null | API key 框清空；提供商存着 key 时（这次或之前的保存发过 key，且没有被带着另一个 origin、框空着的保存删掉）占位“Saved. Leave empty to keep it.”，否则“Optional”（发现规格 §6.6 的“同现在”，2026-10-23 负责人决定）；提供商存着 key 时，这张表单保存时最后发出的那个 key 留在表单内存里，不显示，没有 key 时内存里也没有；接着开始测试 | — |
| 保存后再拉取 | 保存过、提供商存着 key（占位为“Saved. Leave empty to keep it.”）之后你改了 Base URL（同一个 origin，例如只改路径）回到开始再 Fetch models，或再点 Fetch models，API key 框是空的 | `models.discover` 的 `keySecret` 为内存里的 key（保存时最后发出的那个）：要 key 的服务不会因为框空而报 `rejected`（发现规格 §6.6、MD-11）；框里仍是空的 | 同拉取中 |
| 保存后改到别的 origin | 保存过之后你把 Base URL 改成另一个 origin（协议、主机或端口不同），API key 框是空的（2026-10-23 负责人决定，发现规格 §6.6） | API key 的占位为“Optional”（不是“Saved. Leave empty to keep it.”）；Fetch models 不带内存里的 key（`keySecret` 为 null，要 key 的服务报 `rejected`），因为这时保存会按 §4.1 删除已存的 key；改回保存时的 origin 后占位与内存里的 key 恢复；带着不同的 origin、框空着保存之后内存里的 key 丢掉，占位为“Optional”（Base URL 框已是新保存的 origin 也一样） | 在 API key 框填 key；同拉取中 |
| 测试中 | 保存成功后（或表单没改动时）`connection.test`（`{ providerId, modelId: 第一个勾选的模型 }`，发现规格 §6.6） | 按钮“Testing…”（临时，走查时可以改），旁边“Cancel”；没有 30 秒总时限：排队按 §8.2，每次尝试按首个内容的时限（120 秒），`server` 不重试 | Cancel（`connection.testCancel`） |
| 测试已取消 | `connection.test` 返回已取消 | “Test cancelled”（临时，走查时可以改）；表单留着，不进入主窗口 | 再次测试 |
| 测试失败 | `connection.test` 返回 `error` | “Connection failed: <原文>”（§9.1；没有原文时“Connection failed: No response”）；表单留着，不进入主窗口。（2026-10-26 补，规格 §8.3：什么都不改再点 Test connection 照样把请求发给服务，结果是服务这一次的回答，例如又是“Connection failed: 401: …”或“… 404 …”；原来模型池记下的 `auth`、`not_found` 挡住这次测试，结果是不发请求的“Connection failed: Connection error.”。） | 修改，再 Test connection；或不改再测 |
| 测试成功 | `connection.test` 返回成功 | 表单关闭，进入三栏布局（下面“测试成功之后：主窗口”）；结果文字“Connected · First token Nms · Total Nms”，有思考内容时加“ · Includes thinking”，有正文时加“ · Response: <前 200 字>”（§9.1），显示在主窗口的 Open a folder 提示里；不等探针跑完（2026-10-26 负责人走查 M2） | 见“测试成功之后：主窗口” |
| 再次保存同一张表单 | 保存过、测试没有成功（失败、已取消）之后你改了字段或勾选，再点 Test connection | `models.firstRun` 带上次的 `providerId`：整体替换这个提供商和它的全部模型（换成这次勾选的行），`normalDefault` 按这次的勾选数重写，不新建第二个提供商（发现规格 §5.4、MP-33）；这次勾选的模型重新开始探针；测试的是这次第一个勾选的模型 | — |

## 测试成功之后：主窗口

测试连接成功时首次启动结束（界面状态 `firstRun` 置为假），不停在表单上，也不等探针（2026-10-26 负责人走查 M2：
原来测试成功后还要在表单下方找“Open folder…”）。首次启动表单保存后，后台进程照样对勾选的每个模型自动跑第 0–7 步
（§7.4、发现规格 §5.4），表单关闭不停止它们；首次启动里不再显示探针状态，验证进度显示在打开文件夹后会话的拒绝启动卡上
（下一节），各模型的结果在设置 → Models 的模型行上看。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 进入主窗口 | `connection.test` 返回成功 | 三栏布局；中栏是 v0 的 Open a folder 提示（[v0 connection.md](../../v0/screens/connection.md)“首次启动之后：打开文件夹”）：标题“Open a folder”，标题下面一行测试成功的结果文字“Connected · …”（同状态表“测试成功”，成功的颜色），说明“Choose a project folder to start a session.”（侧栏有会话时换成“Pick a session on the left to continue, or open a folder to start a new session.”，[v0 sessions.md](../../v0/screens/sessions.md)），按钮“Open folder…” | Open folder…（中栏的提示或侧栏）；Ctrl+N（没有会话时等于 Open folder…）；点侧栏的会话 |
| 打开了会话 | 有会话放进中栏（新建或打开已有的） | “Connected · …”一行不再显示，这次运行里也不再出现（只显示一次）；之后中栏没有会话时的 Open a folder 提示同 v0 | — |
| 进入主窗口：读屏（2026-10-26 补） | 同“进入主窗口” | “Connected · …”一行带 `role="status"`（读屏把它当状态消息；同设置页测试结果用的 `NoticeLine`） | — |
| 打开失败（2026-10-26 补） | 有会话放进中栏，但新建或打开报错（`session.create`、`session.open`、`trust.check`，同 [v0 sessions.md](../../v0/screens/sessions.md)“新建或打开失败”，例如项目文件夹已不存在） | 同“打开了会话”：会话一放进中栏“Connected · …”一行就清掉，这次运行里不再出现；中栏是这个会话的横幅“Failed to open session: <原文>”；删掉它（Delete…）、中栏回到 Open a folder 提示时没有这一行 | 同 v0 sessions.md“新建或打开失败” |

## 打开文件夹之后

沿用 [v0 connection.md](../../v0/screens/connection.md)“首次启动之后：打开文件夹”（2026-10-26 起从主窗口的 Open a folder 提示打开，见上一节）。
新会话的范围是首次启动写下的 `normalDefault`（发现规格 §5.4）：

- 只勾了一个模型：`<provider>/<model>`，就是这个模型（同现在）；
- 勾了多个模型：提供商 id，候选是它的模型、按清单顺序（规格 §5.1 的展开），输入框下面一行的范围按钮写“<提供商名称> · <当前模型 id>”（model-menu.md）。

会话是否能发送看拒绝启动卡（model-chat.md）：

- 区域为 Public：项目还没授权，卡上有“Allow public for this project”，点了进 设置 → Models 的 Project access，
  焦点在这个项目，勾 Public 并确认后可以发送（MP-33）；
- 范围里没有通过的模型：有还在探针中的为 `verifying`，卡上“Verifying <provider>/<model>…”，探针结束自动重新校验；
  探针都判定失败为 `no_candidate`（规格 §4.6）：卡上“This session can’t start: no model fits.”，候选一行写原因
  （tool calling 判定失败为“tool calling failed verification”，探针出错没有结果为“tool calling not verified yet”），
  操作有“Verify now”（只对还没验证的候选）、“Change model…”、“Open settings”。这就是原来表单下方探针状态的去处
  （“Verifying tool calling…”、“Tool calling failed verification: …”、“Couldn’t verify: …”与“Verify again”从首次启动删掉）。
  勾了多个模型时，只要其中一个已验证就可以发送，不必等测试的那个模型。

## 反例

- 已经有配置（含迁移成功）时不显示首次启动表单；配置存在但读不出时也不显示。
- Fetch models 只发读取信息的请求，不发对话请求、不写配置、不按项目区域过滤；点 Test connection 之前配置里什么也没有（发现规格 §0）。
- 拉取时的 key 只在这次拉取里用：不写文件、不写日志、不进 F8（发现规格 §5.1、§9）。表单不回填 key 明文；内存里留着的 key 也不显示，
  框为空时不随保存再发送，表单关闭就丢掉（发现规格 §6.6）。
- 拉取中不能改 Base URL 和 API key；改 API type 不清掉清单，只有改 Base URL、API key 或再点 Fetch models 才从头来（发现规格 §6.1）。
- 再拉一次不覆盖你改过的 Name、API type、Network zone 和兼容选项（发现规格 §6.1）。
- 测试失败或取消后换勾选的模型再测，配置里仍只有一个提供商（MP-33、MD-11）。
- 测试成功后不停在表单上，也不等探针跑完；测试失败、已取消、保存失败时不进入主窗口，表单同现在（2026-10-26）。
- “Connected · …”只在进入主窗口后的 Open a folder 提示里显示一次；打开会话之后不再出现（打开失败的也算，2026-10-26 补）。
- 勾了多个模型时 Test connection 只测第一个勾选的；其余的只跑探针。首次启动里不显示任何模型的探针状态。
- 没拿到列表（列表错误）时，手填 Model ID 后照样能完成首次启动（MD-11）。
- 服务报告不是聊天模型的行（“Not a chat model”）默认不勾；服务不报告类型、能加入的行有多个时都不勾（发现规格 §6.2）。
- 测试连接没有 v0 的 30 秒总时限，也不做原地重试。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：读取中“Loading…”、读取失败“Couldn’t load model settings: ”；
迁移失败的前缀“Couldn’t import your previous model settings: ”；API key 没保存过时的占位“Optional”；兼容选项的标签与说明沿用 english-ui；
从没保存过的表单点 Test connection 先保存；“Saving…”“Testing…”“Test cancelled”；保存失败的前缀“Couldn’t save: ”；
`models.discover` 返回 `error` 时原文显示在 Fetch models 下方。
实现时定的（2026-10-23，临时，见 [discovery-checks.md](../discovery-checks.md) 的 A20）：内存里的 key 是上次保存成功时发出的那个 key；
“表单有改动”指提供商字段与勾选的模型（含改过的值）和上次保存的不同，或 API key 框不空；保存中、测试中 Base URL、API key 只读，
Fetch models 不可用；表单回到开始或开始新的一次拉取时，测试结果一起清掉（2026-10-26 起表单上没有探针状态与 Open folder…，
测试成功就进入主窗口，留在表单上的只有失败、已取消与保存失败的文字）；有清单时表单加宽到 720px。
2026-10-26 定的（临时，走查时可以改）：“Connected · …”在 Open a folder 提示的标题下面、说明上面，带 `role="status"`
（2026-10-26 补进本表，WP-01 记录“按推荐定下的”第 2 条）；打开失败的会话也算“打开了会话”（同上第 3 条）。
标题“Connect a model”与说明、拉取与清单的文字（含“The server didn’t list any models.”）、Max output 随窗口变的规则、
拉取中两个框只读、再拉一次时保留你改过的值与区域的预选、Base URL 换框与说明句的条件、探针代价一句（在 Test connection 上方）、
More settings 在非 OpenAI-compatible 时不显示、保存后 API key 的占位“Saved. Leave empty to keep it.”与内存里的 key，
都已由发现规格 §6 给出，不再是本表定的。保存过、提供商却没有 key 时（每次都框空着保存，或 key 因改 origin 被删）占位仍是“Optional”：
照这次之前首次启动表单的做法（只在存着 key 时写已保存，发现规格 §6.6 的“同现在”），不是本表另定的。

## 需要规格回答

目前没有。原来的九条都已由发现规格回答，并已写进上面各表：

1. 已回答：发现规格 §3.4。新地址的建议区域：界面照现在的规则用 `shared/models.ts` 的 `suggestZone` 按 Base URL 预选，不经 `models.get`。
2. 已回答：发现规格 §6.6。首次启动有探针代价一句“Each model is verified with up to 13 short requests.”，在 Test connection 上方（proposal §12 第 5 条）。
3. 已回答：发现规格 §6.6。表单把这张表单里最后填过的 key 留在内存里；保存后框为空时再拉取用它作为 `keySecret`；它不显示，框空时保存不再发送，表单关闭就丢掉。
4. 已回答：发现规格 §6.1。拉取中 Base URL、API key 只读。
5. 已回答：发现规格 §6.1。拉取后 Fetch models 仍在 API key 下方；再点就从头来，清单、列表错误和手填的行清掉。
6. 已回答：发现规格 §6.1。Name、API type、Network zone、More settings 里你改过的值不被下次拉取覆盖，没改过的重新预填；改过的 API type 作为 `target.api` 发出。
7. 已回答：发现规格 §6.6。首次启动没有关闭表单的 Cancel，拉取中的 Cancel 照样有。
8. 已回答：发现规格 §6.6。API type 不是 OpenAI-compatible 时不显示 More settings。
9. 已回答：发现规格 §6.1 第 3 项。两边去掉首尾空白和结尾的 `/` 后比较，不同才换框；“Updated to <url> so the model list loads.”只在拿到列表时显示，列表错误时只换框、不写说明。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 表单 | `data-testid="connection-form"`（沿用 v0，`tests/ui/page.mjs` 用它）；区域单选 `input[name="zone"][value]`；Public 的说明 `data-testid="zone-public-note"`；字段错误 `[data-testid="field-error"][data-field]` |
| 读取中 | `data-testid="first-run-loading"` |
| 迁移失败 | `data-testid="migration-error"` |
| 拉取 | “Fetch models” `data-action="fetch-models"`（拉取前后同一个按钮）；拉取中的“Cancel” `data-action="fetch-cancel"`；拉取的状态 `data-testid="fetch-status"`，`data-state` 为 `fetching`（拉取中）/ `cancelled`（“Fetch cancelled”）；拉取中 Base URL、API key 两个输入框带 `readonly`（同 models-settings.md）；首次启动没有关闭表单的 `data-action="close-form"` |
| 认出的服务 | `data-testid="detected-server"`，`data-kind` 为 `ServerKind`（`unknown` 时文字按 `anthropicShape`）；Base URL 换掉时的说明 `data-testid="base-url-note"`（只在拿到列表时有） |
| 列表错误 | `data-testid="list-error"`，`data-kind` 为 `rejected` / `unreachable` / `no_list` / `invalid`；列表错误时手填的行同样是 `discovered-row`，在 `list-error` 之后，没有 `select-all`、`clear-selection`、`checklist-filter` |
| 清单 | 同 [models-settings.md](models-settings.md)：`data-testid="checklist"`；“Select all” `data-action="select-all"`、“Clear selection” `data-action="clear-selection"`；过滤框 `data-testid="checklist-filter"`；“Showing the first 1,000 models.” `data-testid="checklist-truncated"`；行 `[data-testid="discovered-row"][data-model="<id>"]`，`data-chat` 为 `true` / `false` / `unknown`，不能加入的带 `data-unusable="true"`（首次启动没有 `data-added`）；行的勾选框 `input[name="pick"]`；行内输入框的 `data-field` 用 `settings/fields.tsx` 模型字段的名字：`contextWindow`、`maxTokens`（`TextRow` 的 `field`，也是字段错误的 `data-field`）、`reasoning`、`image`（`ModelDraft` 的键）；“Default” `[data-testid="default-value"][data-field]`（2026-10-26 改，取代“Not reported”的 `not-reported`）；标记 `[data-testid="row-tag"][data-kind]`（`not-chat` / `unusable` / `entered`）；提示 `[data-testid="row-hint"][data-kind]`（`no_tools` / `trained_window`） |
| Add a model ID | 一行 `data-testid="manual-model"`，Model ID 输入框 `data-field="id"`，“Add to list” `data-action="add-to-list"` |
| More settings | `data-testid="more-settings"`（API type 不是 OpenAI-compatible 时不存在） |
| 探针代价 | `data-testid="probe-cost-note"`（Test connection 上方） |
| 结果文字 | `data-testid="form-message"`（沿用 v0）：测试失败、已取消与保存失败；测试成功时表单关闭，结果在主窗口的 `connected` |
| 按钮 | “Test connection” `data-action="test"`；测试中的取消 `data-action="test-cancel"`（同 models-settings.md） |
| 主窗口的 Open a folder 提示 | `data-testid="open-folder"`（沿用 v0）；其中测试成功的结果 `data-testid="connected"`（只在进入主窗口后、打开会话之前）。首次启动表单里没有 `probe-status` 与 `open-folder`（2026-10-26） |
