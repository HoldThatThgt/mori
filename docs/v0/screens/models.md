# 输入框下面一行：选择范围、思考强度与上下文用量（M6；v1 起是选择范围；2026-10-21 从顶栏移来）

依据：方案 5.1（输入框下面一行）、5.12、第 11 节"已决定"2026-10-21 一条；pi 行为见 [../m6-checks.md](../m6-checks.md)。
这一行从左到右有哪几项、各状态下这一行的样子见 [chat.md](chat.md)"输入框下面一行"；权限按钮和它的菜单见 [approval.md](approval.md)。
分屏时每一栏各有一行（[split.md](split.md)）。为什么这样改、宽度怎样估、测试要改哪些见 [../composer-pickers.md](../composer-pickers.md)。
选择范围按钮的文字、菜单的三节、换范围和失败、拒绝启动见 [../../v1/screens/model-menu.md](../../v1/screens/model-menu.md)、
[model-chat.md](../../v1/screens/model-chat.md)；这里只写它在这一行里的位置、宽度、悬停、不可用和焦点。

> v1：见 docs/specs/model-providers.md §5.10、§9.2：v0 的模型按钮改为选择范围（分组、提供商或模型），思考强度按当前的实际模型。

## 来源

| 来源 | 内容 |
| --- | --- |
| `SessionInfo`（`session.create`、`session.open`、界面重新载入后接上会话） | `ModelState`：`pick`、`current`（`<provider>/<model>`）、`blocked`、`thinkingLevel`、`thinkingLevels`、`reasoning`（后三项描述当前的实际模型，规格 §11.1）；`contextUsage` |
| `session.setPick` / `session.setThinking` 的结果，和 `mori.model_state` 事件 | `ModelState`（换了范围、配置或档案变化、探针结束、段内换模型时发出，规格 §9.5） |
| pi 的 `thinking_level_changed` 事件 | 新的强度（例如换模型后 pi 改了强度） |
| `session.pickOptions`（只读） | 范围菜单的各项：全部分组、提供商、模型，按这个会话的项目做静态校验（变淡与原因）（2026-10-26 起不带区域）；会话打开后、`pick` / `current` / `blocked` 变了、每次打开菜单时读 |
| 会话运行状态 | 准备中（`sending`，pi 还没开始，规格 §11.4）与生成中 |
| `session.state` → pi `getContextUsage()` | 上下文用量 `{ tokens, contextWindow, percent }`；打开会话、`turn_end`、`compaction_end`、`agent_settled` 后刷新（M1 起，不加命令）。pi 的类型说明是"Estimated context tokens"：最后一次回复报的用量，加上之后的消息按字数估，不告诉哪一部分是估算。2026-10-26 起（WP-12）同一个结果和会话信息里还有分项 `contextBreakdown`（后台进程按 pi 会话算，见下面"详情里的分项"） |

## 位置

- 在输入框（`[data-testid="composer"]`）里、文字框下面那一行（`.composer-bottom`），照 Claude 桌面版 prompt box 下面那一行：
  左端是权限按钮；右边一组依次是选择范围按钮（读屏名"Model range: …"）、Effort 按钮、上下文用量的小圆环，最右端是
  "Send" / "Stop" / "Queue ▾"。这个顺序是负责人 2026-10-21 定的，也是装在本机的 Claude 桌面版右边那一组的顺序
  （模型、单独的 Effort、圆环，再往右是发送）。
- 各项都是这一行（`.composer-bottom`）的直接子项：不把右边几项包成一组，也不把范围按钮和 Effort 包在一起。截短的先后靠
  `flex-shrink`，它只在兄弟之间分宽度（见"窄栏"）；菜单都以这一行定位（见"菜单的位置与键盘"）。
- 权限后面的第一项（通常是范围按钮）用 `.composer-bottom > .permission + * { margin-left: auto }` 推到右端，
  不再用 `.composer-spacer` 占位（它是 flex 项，会多出一个间距）。
- 顶栏不再有这几项，只留会话名和这一栏的按钮（[chat.md](chat.md)"顶栏"）。
- 这一行在文字框后面，页面里的顺序与看到的顺序相同：从文字框按 Tab 依次是权限按钮 → 选择范围按钮 → Effort 按钮 → 圆环 →
  "Queue"、"More send options"、"Stop"（准备中、生成中）或"Send"（输入为空或拒绝启动时 `disabled`，跳过）。范围、Effort、
  权限按钮不可用时用 `aria-disabled`，仍在 Tab 路径上（见"不可用时、按钮消失时的焦点"）。引用芯片在文字框上面，
  从文字框 Shift+Tab 仍先到芯片（M4）。拒绝启动卡在输入框上方，不在这一行里。
- 这一行不换行：高度与原来的按钮区相同（约 33px，由"Send"决定），输入框不因为多了这几项变高；`min-height: 33px`，
  不能发送时（这一行只有权限按钮和说明，约 22px）也不变矮。
- 悬停说明有两行或三行时（下面各表），读屏的描述不含第一行：按钮的 `aria-describedby` 指向一个藏起来的元素，
  不让 Chromium 把整个 `title` 当成描述（第一行和读屏名重复，范围按钮的" · "还会念出来）。

## 选择范围按钮

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 第一次打开中 | `phase` 为 opening，还没有过模型状态（`pick`、`current`、`blocked` 都是 null） | 不显示 | — |
| Restart 之后重新打开中 | `phase` 又变成 opening，`ModelState` 还是上一次的 | 按钮显示上一次的文字，不可用（第三行"Starting…"） | — |
| 打开失败 | `phase` 为 failed（按钮位置"Session didn’t open"，横幅"Failed to open session: …"） | 不显示（没有打开的会话可以改范围） | — |
| 能用 | 会话打开、空闲 | 按钮文字和 ▾（v1 model-menu.md"选择范围按钮"：分组或提供商时"<范围名> · <当前模型 id>"，模型时只有模型 id；窄时截断，见"窄栏"）；读屏名"Model range: <按钮文字>"，按钮文字里的" · "换成", "（"Model range: fast, deepseek-chat"；读屏名里不用" · "，模型 id 里的"/"是数据、照原样）；悬停第一行是按钮文字，第二行"<提供商名>"（没有当前模型时"No model can run in this session"；2026-10-26 起不带" · <区域>"）；读屏的描述是第二行 | 打开菜单 |
| 拒绝启动 | `blocked` 不为 null | 同"能用"（这时 `current` 通常为 null：只有范围名，或"No model range"）；输入框上方是拒绝启动卡（`data-testid="blocked-card"`），"Send"不可用；卡上的"Change model…"打开这个菜单 | 打开菜单改范围 |
| 菜单 | 你点了按钮，或点了拒绝启动卡的"Change model…" | v1 model-menu.md"菜单"（Groups、Providers、Models 三节，被排除的变淡（2026-10-26 起不标区域），当前范围打勾，底部"Applies to this session only. New sessions use the default range from Settings."，最后一项"Manage models"打开 设置 → Models）；往上打开，宽 min(300px, 这一行的宽)（见"菜单的位置与键盘"） | ↑ ↓、Enter 选择；Esc 关闭；点外面关闭 |
| 切换中 | 你选了一项，`session.setPick` 还没返回 | 按钮显示你选的范围、不可用（`aria-disabled`、`data-pending="true"`，变淡，焦点留在按钮上）；悬停只有第一行；Effort 这时也不可用、也带 `data-pending`（两个按钮共用一个切换中的值） | — |
| 已切换 / 切换失败 | `session.setPick` 的结果 | v1 model-menu.md；失败时"Couldn’t change the model range: <原文>"从这一行往上弹出、右边对齐按钮，下次打开菜单或 10 秒后消失 | — |
| 准备中、生成中 | 发了消息到本轮结束（`sending` 或 `running`） | 按钮不可用（`aria-disabled`）；悬停第三行和读屏描述的后半"Can’t switch models until the response finishes"（第一、二行不变）；开着的菜单关闭 | 停止后再改 |
| 后台进程退出、重新载入中 | 同 chat.md"后台进程退出" | 按钮不可用；第三行和读屏描述的后半是按钮位置的说明："Mori’s background process crashed"，重新载入中"Restarting…"；开着的菜单关闭 | "Restart" |

v0 的"No models available"、" (deleted)"和"Default"标记不再出现：没有能用的模型、范围指向不存在的名字（`pick_missing`）时，
由拒绝启动卡说明（[../../v1/screens/model-chat.md](../../v1/screens/model-chat.md)"拒绝启动卡"）。

## 思考强度

思考强度在界面上叫"Effort"（按钮"Effort: <强度>"，菜单的读屏名"Effort"）。它仍是选择范围按钮右边单独的一个按钮
（负责人 2026-10-21 定；Claude 的文档把 effort 放在模型菜单里，装在本机的 Claude 桌面版是模型右边单独一个 Effort）。
各档的文字：off "Off"、minimal "Minimal"、low "Low"、medium "Medium"、high "High"、xhigh "Extra high"、max "Max"。
可选的强度和是否支持思考都按当前的实际模型（`current`），不是会话的范围（v1 model-menu.md"思考强度"）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 第一次打开中、打开失败、没有当前模型 | 同选择范围按钮；`current` 为 null（拒绝启动等） | 不显示 Effort 按钮 | — |
| Restart 之后重新打开中 | 同选择范围按钮（`current` 不为 null 时） | 显示上一次的强度，不可用（原因"Starting…"） | — |
| 支持思考 | `reasoning` 为真（当前的实际模型） | 按钮"Effort: High ▾"（窄时"High ▾"，再窄时强度截断，见"窄栏"）；悬停两行，"Effort: High"和"Set the effort level for this session"；读屏名总是"Effort: High"；可选的强度取 `thinkingLevels`（当前模型的） | 打开菜单 |
| 不支持思考 | `reasoning` 为假 | 按钮"Effort: Unavailable ▾"，可以点开（字用 `--color-muted`，与能用时同色：原来变淡的 `--color-faint` 在底色上只有 3.08:1，"Unavailable"这个字已经说明了状态）；悬停两行，"Effort: Unavailable"和"This model isn’t marked “Supports thinking”"；菜单里的强度都不可用，说明"This model isn’t marked “Supports thinking”, so Mori doesn’t send thinking parameters and the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit this model in Settings → Models and check “Supports thinking”."；"Open settings"打开 设置 → Models（`data-action="open-settings"`） | 打开菜单看说明；"Open settings" |
| 菜单 | 你点了按钮 | `thinkingLevels` 里的强度（从上到下 Off → Max），当前的打勾；底部说明"Applies to this session only. Set each model’s default for new sessions in Settings."；往上打开 | ↑ ↓、Enter；Esc |
| 切换中 / 已切换 / 失败 | `session.setThinking` | 切换中同选择范围按钮（按钮显示你选的强度，`aria-disabled`、`data-pending="true"`；范围按钮这时也不可用）；已切换按返回的 `ModelState`；失败时对话流里一张错误卡（原文，同 v0），按钮回到原来的强度 | — |
| 准备中、生成中 | 发了消息到本轮结束 | 按钮不可用（`aria-disabled`）；悬停的第二行和读屏的描述"Can’t change effort until the response finishes"（第一行仍是"Effort: High"） | — |
| 段内换到推理模型 | `mori.model_state` 的 `reasoning` 变为真 | 菜单的强度变为可选（MP-35）；按钮仍因生成中不可用 | — |
| 后台进程退出、重新载入中 | 同选择范围按钮 | 按钮不可用；悬停的第二行和读屏的描述同选择范围按钮的原因（"Mori’s background process crashed"等，不再是"Set the effort level for this session"）；开着的菜单关闭 | — |
| 重新打开的会话 | pi 按会话记录里最后一条 `thinking_level_change` 恢复 | 显示恢复后的强度 | — |

## 上下文用量（圆环）

原来顶栏上的"Context 12%"改成 Effort 按钮右边的一个小圆环（照 Claude 桌面版的 usage ring，它在模型和 Effort 之后），
只有图标、没有文字；是一个按钮，Tab 能停在上面，点它或按 Enter / Space 打开详情。只显示上下文这一部分（Claude 的圆环里
还有套餐用量，Mori 没有这个数据）。圆环任何宽度都在、不收起。

数字的写法照 Claude：悬停说明是"Context {summary}"，summary 是"≈ " + "{used} / {max} ({pct}%)"——Claude 对估算的用量在前面加
"≈ "，pi 的数都是估算（见"来源"），所以总是加。数 1,000 起写成 k、保留一位小数、".0"去掉（15,360 → 15.4k，128,000 → 128k），
1,000,000 起写成 M（1,000,000 → 1M；也是一位小数、去掉".0"），不到 1,000 照写；999,950 到 999,999 按 k 会进成"1000k"，
写成"1M"；百分比四舍五入到整数（同 Claude，不写"<1%"）。
读屏名照 Claude 的"Usage: {parts}"，只把" / "换成" of "（ui-strings.md 规定读屏名不用" / "）、写完整的数、
"≈"写成"approximately"："Usage: Context approximately 15,360 of 128,000 tokens (12%)"。

悬停说明不用原生 `title`：圆环的读屏名在 `aria-label` 里，再加 `title` 时 Chromium 把它当成描述，读屏会接着念出"/"。
悬停说明是自己画的小提示（`aria-hidden`），鼠标悬停和键盘焦点落在圆环上时都显示；Esc 先关详情，详情没开时藏起提示
（WCAG 1.4.13），焦点留在圆环，这一下不停止生成。只因鼠标停在圆环上显示、焦点不在圆环上（在文字框、批准卡上，或在另一栏）时，
Esc 同样藏起提示，但不占这一下：照 chat.md"Esc 的顺序"停止生成或拒绝焦点所在的批准卡，分屏时以焦点所在的一栏为准
（2026-10-22 审查时定：提示不算浮层，鼠标停在哪里不该改变 Esc 做什么）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 不显示 | 第一次打开中、打开失败；或 pi 返回空（没有模型，或模型的上下文长度不是正数） | 没有圆环（同原来不显示用量） | — |
| 还没有消息 | `tokens` 为 0：pi 在第一次运行开始时才把系统提示词和工具说明写进对话（一条 system 消息），之前对话里什么都没有，估出来就是 0；`contextBreakdown` 为 null | 空圆环（只有底圈，实线）；悬停"Context window"；读屏名"Context window"，描述（`aria-describedby`）"Send a message to see context usage." | 打开详情 |
| 有用量 | `tokens`、`contextWindow`、`percent`；`contextBreakdown` | 圆环从正上方顺时针按百分比填充，强调色；悬停"Context ≈ 15.4k / 128k (12%)"；读屏名"Usage: Context approximately 15,360 of 128,000 tokens (12%)"；描述是详情里显示的各分项（"System prompt approximately 505 tokens (0.4%), System tools approximately 1,123 tokens (0.9%), …, Free space approximately 96,256 tokens (75.2%)"，见"详情里的分项"） | 打开详情 |
| 快满 | 四舍五入后显示的百分比 ≥ 75（与悬停、读屏里的数一致：74.5% 显示"75%"，也用警示色） | 填充改用警示色（较深的 `--color-warn-text`）；≥ 90 用危险色（照 Claude 的分档，登记在 defaults.md）。不靠颜色也看得出：有填充时底圈是浅的 `--color-line`，三种填充和它的对比度都 ≥ 3:1，填到哪里看得出（空圆环的 `--color-faint` 底圈和填充几乎一样亮，所以有填充时换掉） | 同上 |
| 刚压缩完 | `tokens` 为 null（pi：压缩之后还没有算用量的回复；上下文太小被截断、pi 从上下文去掉的回复不算，这时对话流最后一项是那条回复） | 空圆环，底圈是虚线（与"还没有消息"分得开）；悬停"Context window"；读屏名"Context window"，描述"Just compacted. Context usage shows after the next response." | 打开详情 |
| 详情 | 你点了圆环或在它上面按 Enter / Space | 照 Claude 的用量浮层，从圆环往上弹出（宽 260px，不超过这一行）：第一行左边"Context window"，右边与悬停相同的 summary"≈ 15.4k / 128k (12%)"；下面一条 4px 的分段条，再下面每个分项一行（见"详情里的分项"），一打开就显示（Claude 要再点一下"Context window"那一行才展开；2026-10-26 按推荐定，WP-12）。还没有消息、刚压缩完时右边空着，条和分项的位置换成那句说明（"Send a message to see context usage."，或"Just compacted. Context usage shows after the next response."）。开着时用量刷新，详情跟着变 | Esc 关闭，焦点留在圆环；点外面或 Tab 移走也关闭（焦点在新的位置）；再点圆环关闭 |
| 回放旧的录制 | 录制早于分项（`session.state`、会话信息里没有 `contextBreakdown`），按没有 | 有用量时详情只有第一行（没有条和分项），描述没有分项；只在界面测试的回放里出现，App 里有用量时总有分项 | 同"详情" |
| 后台进程退出、Restart 之后重新打开中 | 同 chat.md"后台进程退出" | 圆环和详情保留最后一次读到的用量和分项（同原来；重新打开时 `contextUsage`、`contextBreakdown` 不清空） | 打开详情 |

- 详情是不抢焦点的浮层：里面没有能停的东西（分项也只是字，不做 Claude 那样能点开的"Context window"一行和
  "MCP tools"、"Memory files"的子列表），焦点一直在圆环上；圆环带 `aria-expanded`，详情开着时还有指向它的
  `aria-controls`（关着时详情不在页面里，不设）。
  详情里的内容都在圆环的读屏名和描述里（分项在描述里），读屏用户不打开详情也不缺信息。
- 详情只是看数，不算阻塞的浮层：与选区浮层一样不挡 Alt+1 / Alt+2 / Alt+3 和 Ctrl+N（批准卡来了照样能答）；焦点在圆环上时 Esc 先关它。
- 点圆环、打开详情都不发任何命令（只用已经刷新到的 `contextUsage` 和 `contextBreakdown`）。
- 不做 Claude 详情里的"Compact session"、"Compacts automatically at {pct}%"和"Last updated {time}. Send a message to refresh."：
  手动压缩不在方案第 4 节里；pi 的自动压缩阈值是留出的 token 数、不是百分比，所以写成分项里的"Autocompact buffer"
  （token 数是准的）；分项和用量同时刷新，不会比用量旧。

### 详情里的分项

2026-10-26 负责人走查 M11（"show detail of Context window, like claude"）加的。名字照 Claude 桌面版用量浮层里的分项
（它显示 Claude Code `/context` 给的分项），只列 Mori 算得准的几项；数都由后台进程给（`contextBreakdown`，
`kernel/contextBreakdown.ts`），界面不自己算。

| 分项 | 是什么 | 来源 |
| --- | --- | --- |
| System prompt | 系统提示词里除下面几项以外的全部：preamble（Mori 的身份段）、tools、rules、docs、addendum、cwd、mori_team 等分节，和不分节的正文 | pi-ai `getCurrentSystemMessage(session.messages)`：重放对话里每一条 system 消息之后的当前提示词（分节按名字替换、null 删掉） |
| System tools | 发给模型的工具说明（名字、说明、参数，按 JSON 算），MCP 的除外 | 同上的 `toolsAdded`（重放之后的当前工具）；按 pi `getAllTools()` 的 `sourceInfo.path` 分 |
| MCP tools | MCP 服务的工具说明（`sourceInfo.path` 为 `builtin:mcp`）；只算已经声明给模型的（在 `toolsAdded` 里），还没声明的（deferred、codemode 方式）不算 | 同上 |
| Memory files | AGENTS.md（project_context 分节）和记忆的四个分节（taste、strategy、review、facts）合成一项（Claude 把 CLAUDE.md 和记忆都算在"Memory files"里；2026-10-26 按推荐定，WP-12） | 同上 |
| Skills | 技能列表（skills 分节） | 同上 |
| Messages | 余下的：`tokens` 减去上面五项，不小于 0（对话里的消息、工具结果、回复，加上估算的误差）；这样各项加起来等于第一行的用量，同 Claude | pi `getContextUsage()` |
| Autocompact buffer | pi 自动压缩留出的 token 数（`reserveTokens`）：用量超过窗口减它时 pi 压缩；关掉了自动压缩时没有这一项 | pi `settingsManager.getCompactionSettings(session.model)`，与 pi 判断要不要压缩时的调用相同（项目 `.pi/settings.json` 能改它） |
| Free space | 窗口 − `tokens` − 留出的，不小于 0 | `contextWindow` |

- 上面五项按 Mori 的估算（`estimateMemoryTokens`：中日韩字符每个 1，其余字符数 ÷ 4 向上取整；记忆页和 AGENTS.md 的
  token 数也这样算），不按 pi 的字数 ÷ 4：负责人的会话里中文的 AGENTS.md 按 pi 算只有 284，按 Mori 算 709，
  第一次请求服务报的 2,354 与 Mori 估的约 2.47k 只差约 5%（pi 的低约 17%）。
- 窗口就是第一行的 `contextWindow`：pi 取最近一次回复的实际模型的窗口（设置里填的 Context window），还没有回复时取
  虚拟模型的（第一个候选的）；pi 判断要不要自动压缩也用回复的那个模型的窗口，所以"Autocompact buffer"和
  "Free space"与 pi 什么时候压缩一致。不是档案里的有效窗口（服务报的更小时取小的），见
  [../../v1/walkthrough-1026/WP-12.md](../../v1/walkthrough-1026/WP-12.md)。
- 顺序固定，照 Claude Code `/context` 的顺序：System prompt、System tools、MCP tools、Memory files、Skills、Messages、
  Autocompact buffer、Free space（Claude 桌面版按大小排；Mori 不排，颜色和位置不随回复跳动）。token 数为 0 的不显示
  （没有 MCP 服务就没有"MCP tools"）。
- 每行：10×10px 的色块、名字（`--color-text`）、"≈ 1.1k"（同第一行的缩写；Autocompact buffer 是设置的值，不加"≈ "）、
  占窗口的百分比，一位小数（"0.1%"，同 Claude 的 `toFixed(1)`；不到 0.05% 写"0.0%"），右对齐、宽 44px（同 Claude）；
  数用 `--color-muted`、百分比用 `--color-text`（同 Claude 的 text-muted / text-primary），等宽数字；字 12px；
  名字太长时截短（260px 里八个名字都放得下）。
- 分段条：同样的顺序从左往右，每段宽按 token 数占比（不为 0 的段至少 2px），段与段之间 2px 的空白；
  Autocompact buffer 是灰色（`--color-faint`），Free space 是条的底色（`--color-line`）；条的总长是窗口（各段加起来
  超过窗口时是各段的和，同 Claude）。前六项的颜色见 defaults.md"上下文分项的颜色"；不靠颜色时看每行的名字和数。
- 读屏的描述：显示出来的各行按同样的顺序，用", "连起来，每项"<名字> approximately <完整的数> tokens (<百分比>)"
  （Autocompact buffer 不写"approximately"）；不用" / "。
- 例子（负责人 2026-10-26 的会话 `01a175e1`，DeepSeek deepseek-flash，窗口 1,048,576，最后一次回复 96,361）：第一行
  "≈ 96.4k / 1M (9%)"；System prompt ≈ 505（0.0%）、System tools ≈ 1.1k（0.1%，read、bash、edit、write、memory）、
  Memory files ≈ 709（0.1%，AGENTS.md）、Messages ≈ 94k（9.0%）、Autocompact buffer 16.4k（1.6%，pi 的默认 16,384）、
  Free space ≈ 935.8k（89.2%）。诊断里按 128,000 的窗口算的例子是错的：这个会话的窗口是 deepseek-flash 设置里的 1,048,576。

## 菜单的位置与键盘

范围菜单、Effort 菜单、权限菜单（approval.md）、"Queue"的下拉（▾"More send options"）和圆环的详情都按这张表；
换范围失败那一行（`pick-error`）只按"左右对齐"和"不出界"两行，见表下。

| 项 | 做法 |
| --- | --- |
| 打开方向 | 往上打开：菜单的下边在这一行上方 6px，盖在文字框和上面的对话流、批准卡上，不挤动布局；菜单里各项从上到下的顺序不变 |
| 定位的参照 | `.composer-bottom` 设 `position: relative`，是任何宽度下所有菜单和圆环详情的参照；各按钮的外层 `position: static`。不以 `.composer`（`slash.css` 里已是 `position: relative`）定位：草稿很长时（文字框最高 220px 加引用芯片）`.composer` 的上边离这一行约 280px，菜单会被推到顶栏上和窗口外 |
| 左右对齐 | 任何宽度同一个规则（打开时量按钮和这一行的位置算）：范围菜单（宽 min(300px, 这一行的宽)）、Effort 菜单和"Queue"的下拉右边对齐自己按钮的右边（"Queue"的下拉是 ▾）；这样会伸出这一行的左端时往右挪，左边贴这一行的左端；最宽不超过这一行。权限菜单左边对齐这一行的左端（也就是权限按钮的左边）。圆环详情右边对齐这一行的右端 |
| 为什么不对齐别的 | 范围菜单不左对齐范围按钮：有空余时范围按钮被 `margin-left: auto` 推到右边，按钮文字很短时它左边到这一行右端只有约 220px，300px 的菜单会伸出去。也不再用范围按钮和 Effort 的外层定位（这一层去掉了，见"位置"） |
| 高度 | 最高 min(440px, 这一行的上边到顶栏下边的距离 − 12px)；超出时在菜单里滚动；权限菜单的"Allowed for this session:"列表也一样（原来没有上限）。这一行贴在会话面板底部，草稿变高时升高的是 `.composer` 的上边，这一行不动，所以这个距离只随窗口高度变：打开时量，窗口大小变了时重算 |
| 不出界 | 菜单整个在这一栏会话面板里（上下左右），也在窗口里；不伸到顶栏上、不被右栏或窗口边挡住 |
| 同时只开一个 | 这一行的菜单、圆环详情和"Queue"的下拉同时只开一个：点别处（包括这一行的另一个按钮）关闭；"Queue"的下拉也这样（原来点外面不关） |
| Tab 移出时关闭 | 只在键盘焦点落到外面一个能停焦点的元素上时关闭：`focusout` 的 `relatedTarget` 不为 null、不在菜单的外层里、也不在盖住窗口的对话框（`.dialog-backdrop, .issue-backdrop`，与 `menu.ts` 的 `useOutsideClose` 相同的例外）里。所以：按 F8 打开报告框不关菜单，关掉报告框后焦点回到原来的菜单项；点菜单里不能停焦点的文字（分组名、底部说明、"Allowed for this session:"、"None"、详情里的字）不关；Alt+Tab 切到别的程序不关 |
| 键盘 | 打开时焦点落在当前打勾的一项（都不可用时落在第一个可用的按钮，例如"Open settings"；"Queue"的下拉落在第一项）；↑ ↓ 在可用的项之间移动、到头回绕；Enter 选择；Esc 关闭，焦点回到打开它的按钮（"Queue"的下拉回到 ▾）；选了范围或强度后菜单关闭、焦点回到按钮；"Manage models"、"Open settings"打开 设置 → Models（v1）。从拒绝启动卡的"Change model…"打开范围菜单时，Esc 或选了一项后焦点回到范围按钮（不回到卡上：选了以后卡可能已经消失） |
| 什么时候自动关 | 见下表 |
| 算作"菜单开着" | 范围、Effort、权限菜单和"Queue"的下拉开着时 Alt+1 / Alt+2 / Alt+3、Ctrl+N 不起作用，Esc 先关它（chat.md、approval.md、sessions.md）；圆环详情不算（见上） |
| 新的批准卡或询问卡来了 | 开着的这一行的菜单和圆环详情关闭，焦点回到打开它的按钮（仍在这一栏里，Alt+1 / 2 / 3 能答）。拒绝启动卡出现、消失不关菜单（它没有要答的，菜单可能就是它打开的） |
| 不会误发送 | 菜单里按 Enter 只选菜单项；只有焦点在文字框里时 Enter 才发送或排队 |

换范围失败那一行（`data-testid="pick-error"`，`role="alert"`）：从这一行往上弹出（下边在这一行上方 6px），左右同范围菜单
（右边对齐范围按钮、放不下时挪进这一行），最宽 min(320px, 这一行的宽)，字可以换行；不算浮层（不挡 Alt+数字、Ctrl+N、Esc）。

什么时候自动关（每个浮层一行；"准备中""生成中"见 chat.md 的状态表；"不能发送"是按钮位置显示"Starting…"、"Restarting…"、
"Mori’s background process crashed"、"Session didn’t open"的几种）：

| 浮层 | 生成开始（准备中、生成中） | 不能发送（后台进程退出、重新载入、打开中、打开失败） | 其他 |
| --- | --- | --- | --- |
| 范围菜单、Effort 菜单 | 关闭（按钮不可用） | 关闭 | 按钮消失时（打开失败；没有当前模型时的 Effort）跟着关 |
| 权限菜单 | 不关（生成中仍可用，同原来） | 关闭（原来不关，一起改） | — |
| 圆环详情 | 不关 | 不关（圆环保留最后的用量） | 只在圆环消失时（打开失败、pi 返回空）跟着关 |
| "Queue"的下拉 | — | 关闭（按钮消失） | 清空草稿或本轮结束、"Queue ▾"消失时跟着关；≤ 340px 时 Stop team 出现、"Queue ▾"收起时也关（见"窄栏""最窄"） |
| 换范围失败那一行 | 不关 | 不关 | 打开范围菜单时、10 秒后消失（v1） |

## 不可用时、按钮消失时的焦点

- 范围、Effort、权限按钮不可用时用 `aria-disabled="true"`（不用 `disabled`；v1 的范围按钮原来用 `disabled`）：仍能 Tab 到，
  点了不开菜单。能用时不带 `aria-disabled`（`aria-disabled={x ? true : undefined}`，同 v1；不写"false"，
  测试等的是这个属性不在）。权限、Effort 不可用的原因同时是悬停说明的第二行和读屏的描述，代替原来的第二行；范围按钮的原因是悬停的
  第三行（第二行仍是提供商名；2026-10-26 起不带区域），读屏的描述是第二行加". "加原因：
  - 准备中、生成中（只有范围按钮、Effort）："Can’t switch models until the response finishes"（范围按钮的第三行）、
    "Can’t change effort until the response finishes"；
  - 后台进程退出："Mori’s background process crashed"；重新载入中："Restarting…"；
  - 打开中（第一次打开时只有权限按钮，Restart 之后的重新打开范围按钮、Effort、权限三个都在，Effort 要有 `current`）："Starting…"；
  - 打开失败（只有权限按钮）："Session didn’t open"。
  这几句就是按钮位置的说明，横幅里有更长的原文。"切换中"原来就这样（不加原因；范围按钮和 Effort 另带 `data-pending="true"`，
  两个按钮共用一个切换中的值，换范围或换强度时两个都带）。切换中两个按钮都没有读屏的描述：没有 `aria-describedby`，带空的
  `aria-description`，不然 Chromium 把 `title` 当成描述（范围按钮会念出" · "；2026-10-22 最终审查后加，Electron 44 里量过）。
  "Send"在输入为空时仍是 `disabled`（同原来）。
  权限按钮要加 `[aria-disabled='true']` 的样式（现在只有 `:disabled` 和 `:not(:disabled):hover`）。
- 焦点所在的这一行的按钮消失时，焦点移到这一栏的文字框（不落到 `body`，否则下一次 Tab 从页面开头走）：
  打开失败时的范围按钮、Effort 按钮；本轮结束时的"Stop"、"Queue"、▾；清空草稿时的"Queue"、▾；
  发出消息时的"Send"（准备中换成"Stop"）；消失的圆环；≤ 340px 时 Stop team 出现、因此收起的"Queue ▾"和准备中的"Queue"
  （`display: none`，`rowMenu.ts` 的 `useHiddenFallback`）。菜单里有焦点的项随菜单关闭消失时，焦点按上面的表回到按钮，按钮也消失时回到文字框。
  Restart 之后重新打开中按钮还在（不可用），焦点留在原来的按钮上。

## 窄栏

这一行按会话面板（`.chat-pane`，这一行的 `@container`）的宽度分步收紧，单栏、分屏相同；分屏右边那一栏的 `.chat-pane`
有 1px 的 `border-left`，比 `.pane-slot` 窄 1px。这一行的宽度约是"面板宽 − 78px"（面板 ≤ 520px 时输入区两边内边距收小，
约"面板宽 − 54px"），最宽约 782px（输入区最宽 860px）。最窄的两种：分屏每栏 280px（这一行约 226px，右边一栏 225px）、
800 宽窗口右栏打开时中栏 300px（约 246px）。阈值按最宽的情况估算（Segoe UI 的字形宽度，12px，发送组 13px）：生成中、输入框有字
（"Queue ▾"和"Stop"）、"Ask each time"、"Effort: Unavailable ▾"、很长的"<提供商名> · <模型 id>"；≤ 400px 时准备中有字
（单个"Queue"比 ▾ 宽 8px，≤ 340px 宽 4px）更挤一点，模式名多截几 px（这两档本来允许截）；逐档的数见
[composer-pickers.md](../composer-pickers.md)"宽度估算"。

权限按钮任何宽度都只有文字（模式名和 ▾），没有图标，照 Claude 的模式选择（负责人 2026-10-21 定）。"Allow all"用警示色，
也写着"Allow all"，不靠颜色也读得出。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 宽 | 会话面板宽于 680px | 权限"Ask each time ▾"；选择范围按钮（最长 200px，任何宽度都是这个上限）；"Effort: High ▾"；圆环；带文字的"Send"、"Stop"、"Queue ▾"；间距 8px | 全部 |
| 稍窄 | ≤ 760px | 协作模式下的 Stop team 只显示图标（32px，读屏名"Stop team"、悬停"Stop all agents in this session"），比"Send"、"Stop"早：带字时约 110px，601–708px 的面板最挤时（生成中有字、"Effort: Unavailable"）会把模式名截到只剩一两个字母（2026-10-22 最终审查后 `tb-app-stop` 量出来的） | 同上 |
| 较窄 | ≤ 680px | Effort 按钮只显示强度："High ▾"、"Unavailable ▾" | 同上 |
| 窄 | ≤ 600px | "Send"、"Stop"、"Queue"只显示图标（Stop team 从 760px 起已经只有图标）（"Send"是圆形的强调色按钮，"Stop"是圆形按钮，"Queue"用新图标 `queue`、连着它的 ▾），名字在读屏名里："Send"（悬停"Send (Enter)"）、"Stop"（悬停"Stop response (Esc)"）、"Queue"（悬停"Queue for later (Enter)"）、▾"More send options"。"Send"、"Stop"、"Queue"各 32px 宽，▾ 24px（原来 32px）。顶栏的协作开关在同一档只剩状态点（[chat.md](chat.md)"顶栏"） | 同上 |
| 有 Stop team、≤ 520px | 协作模式下后台有 Agent，会话面板 ≤ 520px | 生成中有字时"Queue"就收起，只留 ▾（菜单里多出"Queue for later"），同下面"很窄"一档，只是更早：Stop team 多占约 36–40px，不收的话 401–426px 和 461–482px 的面板最挤时（"Effort: Unavailable"）会截模式名（2026-10-22 最终审查后 `tb-app-stop` 量出来的）；焦点在"Queue"上时回到文字框 | 同"很窄" |
| 更窄 | ≤ 460px | 权限、范围、Effort 按钮去掉 ▾，这一行的间距收小到 4px；这一行按钮的键盘焦点环离按钮 1px（全局是 2px，间距只有 4px 时环碰到旁边的按钮、被后面的按钮盖住一截） | 同上 |
| 很窄 | ≤ 400px | 生成中、输入框有字时，"Queue"按钮收起，只留 ▾"More send options"，它的菜单里是"Queue for later"（快捷键提示 Enter）和"Steer"（快捷键提示 Ctrl+Enter）；"Stop"留在原位。准备中有字时的"Queue"只有一个按钮（不能插话，没有 ▾），不收起（32px） | 点 ▾ 选；Enter 排队、Ctrl+Enter 插话、Esc 停止照旧 |
| 最窄 | ≤ 340px | "Send"、"Stop"（和 Stop team）的图标按钮 28px（原来 32px），准备中的"Queue"也收到 28px；权限、范围、Effort 按钮的左右内边距 4px（原来 6px）。协作模式下后台有 Agent（有 Stop team）时，生成中有字的"Queue ▾"（这一档只剩 ▾）和准备中有字的"Queue"收起，Stop team 和"Stop"留着（2026-10-22 最终审查后定，见下面的估算）；焦点在收起的按钮上时回到文字框，开着的"Queue"下拉关上 | 同上；有 Stop team 时 Enter 排队、Ctrl+Enter 插话（输入框的提示写着），没有点的按钮 |
| 放不下 | 这一行的内容比这一行宽（任何一档） | 依次截短，前一项到最窄才轮到下一项：① 不能发送时的说明（"Mori’s background process crashed"、"Starting…"等，最窄 48px，悬停说明和横幅里有全文）；② 选择范围按钮（最窄 40px，≤ 340px 时 36px）：先截当前模型 id（连同它前面的" · "，`.range-model`），截完了才截范围名（`.range-scope`；范围是模型时只有模型 id 一段）；③ 权限的模式名（最窄 44px，≤ 340px 时 40px）；④ Effort 的强度（最窄 40px，≤ 340px 时 36px）。截短处是省略号"…"，前面留几个字母由 Chromium 决定（量到最窄的权限是"Ask …"、"Allo…"），测试不比字面。最窄的数在 ≤ 460px（没有 ▾）时字有 28–32px；宽于 460px 时有 ▾，同样的最窄里字只剩约 8–14px（范围按钮约 8px），但最挤时也截不到那里。各项都是这一行的直接子项，`flex-shrink` 相邻差 1e5 以上（composer-pickers.md"宽度估算"）。不换行、不超出输入框；圆环、"Send" / "Stop" / ▾ 不收 | 同上 |

- 截短只是样式：按钮的文字（textContent）仍是全文，读屏名也是全文（"Permission mode: Ask each time"、"Model range: fast, deepseek-chat"、
  "Effort: Extra high"）；会截短的三个按钮，悬停说明的第一行是全文（权限"Permission mode: Ask each time"、范围按钮
  "<按钮文字>"、Effort"Effort: Extra high"），第二行是说明或不可用的原因（范围按钮的第二行是提供商名，原因在第三行）。收起的"Send"、"Stop"、"Queue"的名字在读屏名
  和悬停说明里。
- 估算的结果：宽于 400px 的各档在最挤时模式名都不截，范围按钮至少约 54px；> 680px 的面板里有空余时它最长 200px，
  放得下常见的"<提供商名> · <模型 id>"（约 170–195px）；≤ 400px 起最挤时才截模式名；
  280px 一栏最挤时是截短的模式名（权限 40px）、范围按钮 36px、截短的强度（Effort 约 52px；准备中有字时 48px，
  旁边是 28px 的"Queue"）、圆环、▾、"Stop"，三个按钮都不窄于最窄。空闲、Effort 是"High"时，280px 也能显示完整的"Ask each time"（范围按钮约 41px）。
- 协作模式下后台有 Agent 时这一行多一个 Stop team（宽于 760px 时带字，约 110px，之后同"Stop"）。不收起排队的按钮的话，分屏
  280–295px 一栏、生成中、输入框有字时这一行会超出约 16px（三个按钮已到最窄：权限 40 + 范围 36 + Effort 36 + 圆环 26 + ▾ 24
  + Stop team 28 + "Stop" 28 + 6 个 4px 的间距 = 242px，这一行约 226px）；准备中有字时（单个 28px 的"Queue"）超出约 20px。
  所以 ≤ 340px 有 Stop team 时收起排队的按钮（"最窄"一行），最挤时是 214px，280px 一栏放得下、还有约 12px。
  `tb-app-stop` 的 TB-54 在单栏 930–300px（每条边界的两侧）和分屏右栏 296 / 281 / 280 / 279px 量过（锁定的模型按钮、
  Stop team 的宽和只有图标、宽于 400px 模式名不截、≤ 340px 收起、不换行不溢出）。没选的做法：把 Stop team 收进 ▾（准备中没有 ▾，还要另一种做法）。

"Queue"的下拉里各项的名字只有文字（"Queue for later"、"Steer"），快捷键是旁边的 `.menu-hint`（`aria-hidden`），
另放在 `aria-keyshortcuts`（"Enter"、"Control+Enter"）里，读屏名里没有" · "。

## 反例

- 模型没标支持思考时，思考强度的选项都不可用（不是只藏起来），并说明原因。
- 在输入框下改范围或思考强度不改设置里的默认范围（Default model range for new sessions）和按模型的默认强度；新会话仍用默认范围
  （v1 规格 §5.10、§11.1）。
- 切到"Off"之后，下一次回复没有思考内容（DeepSeek 实测：pi 发 `thinking: disabled`）。
- 还没有发过消息的会话，圆环不显示"0%"或"<1%"（pi 的 0 不含系统提示词，不是真的用量）。
- 菜单不会伸到顶栏上或窗口外；"Stop"在任何宽度都看得见。
- 权限按钮任何宽度都没有图标、不会只剩图标；最窄时两种模式看得见的开头不同（"Ask …"、"Allo…"），不只差颜色。
- 宽于 400px 时，权限的模式名不会因为范围按钮的文字长而被截短（范围按钮先截）。
- 顶栏上不再有范围按钮、Effort、权限和用量。
- 准备中、生成中范围按钮和 Effort 不会真的 `disabled`（焦点不会掉到页面开头），原因读得到。

## 照 Claude 桌面版

| 交互 | Claude 桌面版 | Mori |
| --- | --- | --- |
| 位置 | prompt box 下面那一行：左边模式选择（mode selector）；右边一组是模型、单独的 Effort、用量圆环（最后），再往右是发送 | 同：左端权限按钮，右边选择范围（v1）、Effort、圆环，最右是发送 / 停止（Claude 的发送 / 停止在输入框里的右下角，Mori 原来就在这一行的右端） |
| 模式选择 | 只有文字的 ghost 按钮，显示模式名，没有图标；变窄时模式名截断；悬停是当前模式的说明，没有说明时是菜单标题"Mode" | 同（负责人 2026-10-21 定）：只有模式名和 ▾（≤ 460px 去掉 ▾），没有图标；变窄时模式名截断加"…"，但比范围按钮后截（见"窄栏"）。悬停第二行照 Claude 是当前模式的说明，第一行是全名"Permission mode: …"（approval.md） |
| 模型菜单 | 一个按钮显示当前模型，读屏名"Model: {name}"；往上打开、右端对齐；当前项打勾，默认模型标"Default"；只作用于当前会话 | 位置、往上打开、右端对齐同 Claude（放不下时挪进这一行）；内容是 v1 的选择范围（分组、提供商、模型三节，被排除的变淡；2026-10-26 起不标区域），没有"Default"标记；读屏名"Model range: …"（不是 Claude 的"Model: {name}"）；底部说明的第一句用 Claude 的"Applies to this session only"，最后"Manage models" |
| 思考强度 | 文档说在模型菜单里选；装在本机的版本是模型按钮右边单独的"Effort"，读屏名"Effort: {name}" | 单独的按钮（负责人 2026-10-21 定），读屏名同 Claude；菜单形式同模型菜单 |
| 用量圆环 | 只有图标的按钮，12px 的环；< 75% 强调色、75–89% 警示色、≥ 90% 危险色；悬停"Context {summary}"，估算的数前面"≈ "；读屏名"Usage: {parts}"；点开往上弹出：一行左边"Context window"、右边 summary，下面 4px 进度条，没有数据时右边空着、进度条的位置换成"Send a message to see context usage." | 同，只有上下文这一部分；环 14px；读屏名里" / "换成" of "、写完整的数；刚压缩完用 Mori 原有的说明、底圈虚线 |
| 窄 | 这一行是 CSS 容器，变窄时模式名和模型名截断，Effort 和圆环不收；不换行 | 同样不换行、圆环不收、模式名和模型名截断；Mori 的按钮比 Claude 的宽（带 ▾、"Effort: "前缀、文字按钮），所以先分几档去掉这些（见"窄栏"），最窄时 Effort 的强度也截；发送 / 停止只有图标同 Claude |
| 发送的下拉 | "More send options"里有"Queue for later"和"Stop" | ▾"More send options"里是"Steer"，≤ 400px 时加上"Queue for later"；"Stop"一直在外面 |
| 没有做 | Ctrl+Shift+M / I / E 打开三个菜单、菜单里按 1–9 选；"Compact session"；套餐用量 | 方案没有要求，不加 |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 这一行 | 每一栏 `[data-testid="composer"]` 里的 `.composer-bottom` |
| 选择范围按钮 | `data-testid="model-button"`（在这一行里），`data-pick`、`data-current`（没有时不带），切换中 `data-pending="true"`；悬停的描述元素 `data-testid="model-tip"`（藏起来，在 `.model-switch` 里、按钮外面）；菜单 `data-testid="model-menu"`，节 `[data-section]`，项 `role="menuitemradio"`、`data-pick`、`data-excluded`（2026-10-26：`data-zone` 删掉）；`data-testid="model-menu-note"`；`data-action="manage-models"`；切换失败 `data-testid="pick-error"`（v1 model-menu.md） |
| 思考按钮 | `data-testid="thinking-button"`（`data-level` 为当前强度，不支持思考时 `data-reasoning="false"`，切换中（换强度或换范围）`data-pending="true"`）；菜单 `data-testid="thinking-menu"`，项 `role="menuitemradio"`，`data-level` |
| 权限按钮 | `data-testid="permission-button"`；模式名在 `.permission-text` 里（是否截短比它的 `getBoundingClientRect().width` 和全文的宽，不用 `scrollWidth`：截短时两者可能相等）；按钮里没有图标，只有 ▾（≤ 460px 时也没有） |
| 圆环 | `data-testid="usage"`（按钮，每栏一个；`aria-expanded`，详情开着时 `aria-controls`；`data-state` 为 `empty` / `compacted` / `used`）。`data-tokens`、`data-percent`：还没有消息时是 `0`、`0`；有用量时是 pi 给的数和四舍五入的百分比；刚压缩完时没有这两个属性。详情 `data-testid="usage-details"`；悬停提示 `data-testid="usage-tip"`（`aria-hidden`）。详情里的分项（2026-10-26 起）：每行 `data-testid="usage-part"`，`data-part` 为分项的键（`systemPrompt`、`systemTools`、`mcpTools`、`memoryFiles`、`skills`、`messages`、`autocompactBuffer`、`freeSpace`）、`data-tokens` 为后台进程给的数；行里 `.usage-swatch`（色块）、`.usage-part-name`、`.usage-part-count`、`.usage-part-percent`；分段条 `data-testid="usage-bar"`，每段 `data-testid="usage-segment"`、`data-part` 同上；读屏的描述（有用量时是分项，没有数据时是那句说明）是圆环 `aria-describedby` 指向的藏起来的元素 |
| 发送、停止、排队 | 类名不变：`.send-button`、`.stop-button`、`.split-button`；准备中只有一个按钮的"Queue"是 `.queue-button`（新的，不在 `.split-button` 里）；只显示图标时名字在 `aria-label`；▾ 菜单的项 `role="menuitem"`，带 `aria-keyshortcuts` |
