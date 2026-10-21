# 输入框下面一行：模型、思考强度与上下文用量（M6；2026-10-21 从顶栏移来）

依据：方案 5.1（输入框下面一行）、5.12、第 11 节"已决定"2026-10-21 一条；pi 行为见 [../m6-checks.md](../m6-checks.md)。
这一行从左到右有哪几项、各状态下这一行的样子见 [chat.md](chat.md)"输入框下面一行"；权限按钮和它的菜单见 [approval.md](approval.md)。
分屏时每一栏各有一行（[split.md](split.md)）。为什么这样改、宽度怎样估、测试要改哪些见 [../composer-pickers.md](../composer-pickers.md)。

> v1：见 docs/specs/model-providers.md §5.10、§9.2：顶栏的模型按钮改为选择范围（分组、提供商或模型），思考强度按当前的实际模型；状态表见 [../../v1/screens/model-menu.md](../../v1/screens/model-menu.md)。

## 来源

| 来源 | 内容 |
| --- | --- |
| `session.create` / `session.open` 的结果（v1：见 docs/specs/model-providers.md §9.5：`model` 由 `ModelState` 取代） | `model`（provider/id）、`thinkingLevel`、`thinkingLevels`（这个模型可选的强度，pi `getAvailableThinkingLevels()`）、`reasoning`（模型标了支持思考，pi `supportsThinking()`）、`contextUsage` |
| `session.setModel` / `session.setThinking` 的结果，和后台进程的 `mori.model_state` 事件（v1：见 docs/specs/model-providers.md §9.4、§9.5：`session.setModel` 删除，改为 `session.setPick`；`mori.model_state` 带 `ModelState`） | 同上前四项；`mori.model_state` 在你改了这个会话、或在设置里改了它用的模型（换成新的模型对象之后）时发出 |
| pi 的 `thinking_level_changed` 事件 | 新的强度（例如换模型后 pi 改了强度） |
| `config.get` 的 `models`（v1：见 docs/specs/model-providers.md §9.4、§9.5：菜单的列表改由 `models.get` 给出，列出全部分组、提供商、模型） | 模型菜单的列表：pi 现在能用的全部模型（`modelRuntime.getAvailableSnapshot()`，有 key 的），按连接分组，带连接名 |
| `session.state` → pi `getContextUsage()` | 上下文用量 `{ tokens, contextWindow, percent }`；打开会话、`turn_end`、`compaction_end`、`agent_settled` 后刷新（M1 起，不加命令）。pi 的类型说明是"Estimated context tokens"：最后一次回复报的用量，加上之后的消息按字数估，不告诉哪一部分是估算 |

## 位置

- 在输入框（`[data-testid="composer"]`）里、文字框下面那一行（`.composer-bottom`），照 Claude 桌面版 prompt box 下面那一行：
  左端是权限按钮；右边一组依次是模型按钮、Effort 按钮、上下文用量的小圆环，最右端是"Send" / "Stop" / "Queue ▾"。
  这个顺序是负责人 2026-10-21 定的，也是装在本机的 Claude 桌面版右边那一组的顺序（模型、单独的 Effort、圆环，再往右是发送）。
- 各项都是这一行（`.composer-bottom`）的直接子项：不把右边几项包成一组，也不把模型和 Effort 包在一起。截短的先后靠
  `flex-shrink`，它只在兄弟之间分宽度（见"窄栏"）；菜单都以这一行定位（见"菜单的位置与键盘"）。
- 权限后面的第一项（通常是模型）用 `.composer-bottom > .permission + * { margin-left: auto }` 推到右端，
  不再用 `.composer-spacer` 占位（它是 flex 项，会多出一个间距）。
- 顶栏不再有这几项，只留会话名和这一栏的按钮（[chat.md](chat.md)"顶栏"）。
- 这一行在文字框后面，页面里的顺序与看到的顺序相同：从文字框按 Tab 依次是权限按钮 → 模型按钮 → Effort 按钮 → 圆环 →
  "Queue"、"More send options"、"Stop"（生成中）或"Send"（输入为空时 `disabled`，跳过）。模型、Effort、权限按钮不可用时
  用 `aria-disabled`，仍在 Tab 路径上（见"不可用时、按钮消失时的焦点"）。引用芯片在文字框上面，从文字框 Shift+Tab 仍先到芯片（M4）。
- 这一行不换行：高度与原来的按钮区相同（约 33px，由"Send"决定），输入框不因为多了这几项变高；`min-height: 33px`，
  不能发送时（这一行只有权限按钮和说明，约 22px）也不变矮。
- 悬停说明有两行时（下面各表），读屏的描述只有第二行：按钮的 `aria-describedby` 指向一个藏起来、只有第二行的元素，
  不让 Chromium 把整个 `title` 当成描述（第一行和读屏名重复，模型的"<连接名> · <模型 ID>"还会念出" · "）。

## 模型

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 第一次打开中 | 会话还没打开过（`phase` 为 opening，还没有 `model`） | 不显示（M3 起） | — |
| Restart 之后重新打开中 | 你点了"Restart"，每个会话重新 `session.open`（`phase` 又变成 opening，`model` 还是上一次的） | 按钮显示上一次的模型，不可用（原因"Starting…"） | — |
| 打开失败 | `phase` 为 failed（按钮位置"Session didn’t open"，横幅"Failed to open session: …"） | 不显示（没有打开的会话可以切换；不显示过时的模型或"No models available"） | — |
| 有模型（v1：见 docs/specs/model-providers.md §9.2） | `model` | 按钮显示模型 ID 和 ▾（窄时截断，见"窄栏"）；悬停显示"<连接名> · <模型 ID>"，读屏名"Model: <模型 ID>"，读屏的描述是连接名 | 打开菜单 |
| 没有可用模型（v1：见 docs/specs/model-providers.md §4.6：拒绝启动卡） | `model` 为 null | 按钮"No models available"（悬停"Select model"），顶栏下横幅是 pi 的说明（M1 起） | 打开菜单选一个 |
| 菜单（v1：见 docs/specs/model-providers.md §9.2） | 你点了按钮 | 照 Claude 桌面版的模型菜单：按连接分组列出模型，当前的打勾；默认模型后面标"Default"；底部说明"Applies to this session only. New sessions use the default model from Settings."；最后一项"Manage models"打开设置页的"Connections and models"；往上打开（见下"菜单的位置与键盘"） | ↑ ↓、Enter 选择；Esc 关闭；点外面关闭 |
| 切换中（v1：见 docs/specs/model-providers.md §5.10、§9.5 `session.setPick`） | 你选了一个模型，`session.setModel` 还没返回 | 按钮显示新模型、不可用（变淡，焦点留在按钮上） | — |
| 已切换（v1：见 docs/specs/model-providers.md §5.10：写 `mori.pick`，下一段起生效） | `session.setModel` 返回 | 按钮显示新模型；思考强度按返回值更新（pi 换模型时按 `modelThinkingLevels` → `defaultThinkingLevel` → 原来的强度重新定） | 下一条消息由新模型回复 |
| 切换失败（v1：见 docs/specs/model-providers.md §9.5 `session.setPick`） | `session.setModel` 报错（例如 `No API key for …`） | 对话流里一张错误卡，原文；按钮回到原来的模型 | — |
| 生成中（v1：见 docs/specs/model-providers.md §5.10：准备中也不能改） | 本轮运行中（含"刚发出"） | 按钮不可用（`aria-disabled`）；悬停的第二行和读屏的描述"Can’t switch models until the response finishes"（第一行仍是"<连接名> · <模型 ID>"） | 停止后再切 |
| 后台进程退出、重新载入中 | 同 chat.md"后台进程退出" | 按钮不可用；悬停的第二行和读屏的描述是按钮位置的说明："Mori’s background process crashed"，重新载入中"Restarting…"；开着的菜单关闭 | "Restart" |
| 模型已删除（v1：见 docs/specs/model-providers.md §4.6 `pick_missing`、§4.7） | `model` 不在菜单列表里（在设置里删掉了；`models.json` 读不出时不算） | 按钮显示"<ID> (deleted)"，悬停说明也标" (deleted)"。连接里还有别的模型时，会话仍用打开时的设置；连接也删除了时，pi 找不到这个连接，下一条消息失败（错误卡显示 pi 的原文，实测 `No API key found for mori-endpoint-<数字>. Use /login …`；原文里有 API key 字样，错误卡也附"Go to settings"，这个连接已经不在，设置页落在连接列表上） | 打开菜单换一个 |

## 思考强度

思考强度在界面上叫"Effort"（按钮"Effort: <强度>"，菜单的读屏名"Effort"）。它仍是模型按钮右边单独的一个按钮
（负责人 2026-10-21 定；Claude 的文档把 effort 放在模型菜单里，装在本机的 Claude 桌面版是模型右边单独一个 Effort）。
各档的文字：off "Off"、minimal "Minimal"、low "Low"、medium "Medium"、high "High"、xhigh "Extra high"、max "Max"。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 第一次打开中、打开失败、没有可用模型（v1：见 docs/specs/model-providers.md §9.2、§11.1：思考强度描述当前的实际模型） | 同模型；`model` 为 null | 不显示 Effort 按钮 | — |
| Restart 之后重新打开中 | 同模型 | 显示上一次的强度，不可用（原因"Starting…"） | — |
| 支持思考 | `reasoning` 为真 | 按钮"Effort: High ▾"（窄时"High ▾"，再窄时强度截断，见"窄栏"）；悬停两行，"Effort: High"和"Set the effort level for this session"；读屏名总是"Effort: High" | 打开菜单 |
| 不支持思考（v1：见 docs/specs/model-providers.md §9.1：说明里的设置路径改为 Settings → Models，"pi 不发送"改为"Mori 不发送"，见 [../../v1/screens/model-menu.md](../../v1/screens/model-menu.md)） | `reasoning` 为假 | 按钮"Effort: Unavailable ▾"，可以点开（字用 `--color-muted`，与能用时同色：原来变淡的 `--color-faint` 在底色上只有 3.08:1，"Unavailable"这个字已经说明了状态）；悬停两行，"Effort: Unavailable"和"This model isn’t marked “Supports thinking”"；菜单里的强度都不可用，说明"This model isn’t marked “Supports thinking”, so pi doesn’t send thinking parameters and the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit this model in Settings → Connections and models and check “Supports thinking”." | 打开菜单看说明；"Open settings" |
| 菜单 | 你点了按钮 | `thinkingLevels` 里的强度（从上到下 Off → Max），当前的打勾；底部说明"Applies to this session only. Set each model’s default for new sessions in Settings."；往上打开 | ↑ ↓、Enter；Esc |
| 切换中 / 已切换 / 失败 | `session.setThinking` | 同模型 | — |
| 生成中（v1：见 docs/specs/model-providers.md §5.10、§11.4：准备中也不能改） | 本轮运行中（含"刚发出"） | 按钮不可用（`aria-disabled`）；悬停的第二行和读屏的描述"Can’t change effort until the response finishes"（第一行仍是"Effort: High"） | — |
| 后台进程退出、重新载入中 | 同模型 | 按钮不可用；悬停的第二行和读屏的描述同模型（"Mori’s background process crashed"等，不再是"Set the effort level for this session"）；开着的菜单关闭 | — |
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
（WCAG 1.4.13），焦点留在圆环，这一下不停止生成。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 不显示 | 第一次打开中、打开失败；或 pi 返回空（没有模型，或模型的上下文长度不是正数） | 没有圆环（同原来不显示用量） | — |
| 还没有消息 | `tokens` 为 0：pi 只估算对话里的消息，不算系统提示词和工具说明，还没有消息时就是 0 | 空圆环（只有底圈，实线）；悬停"Context window"；读屏名"Context window"，描述（`aria-describedby`）"Send a message to see context usage." | 打开详情 |
| 有用量 | `tokens`、`contextWindow`、`percent` | 圆环从正上方顺时针按百分比填充，强调色；悬停"Context ≈ 15.4k / 128k (12%)"；读屏名"Usage: Context approximately 15,360 of 128,000 tokens (12%)" | 打开详情 |
| 快满 | `percent` ≥ 75 | 填充改用警示色（较深的 `--color-warn-text`）；≥ 90 用危险色（照 Claude 的分档，登记在 defaults.md）。不靠颜色也看得出：有填充时底圈是浅的 `--color-line`，三种填充和它的对比度都 ≥ 3:1，填到哪里看得出（空圆环的 `--color-faint` 底圈和填充几乎一样亮，所以有填充时换掉） | 同上 |
| 刚压缩完 | `tokens` 为 null（pi：压缩之后还没有新的回复） | 空圆环，底圈是虚线（与"还没有消息"分得开）；悬停"Context window"；读屏名"Context window"，描述"Just compacted. Context usage shows after the next response." | 打开详情 |
| 详情 | 你点了圆环或在它上面按 Enter / Space | 照 Claude 的用量浮层，从圆环往上弹出（宽 260px，不超过这一行）：第一行左边"Context window"，右边与悬停相同的 summary"≈ 15.4k / 128k (12%)"；下面一条 4px 的进度条（颜色同圆环）。还没有消息、刚压缩完时右边空着，进度条的位置换成那句说明（"Send a message to see context usage."，或"Just compacted. Context usage shows after the next response."）。开着时用量刷新，详情跟着变 | Esc 关闭，焦点留在圆环；点外面或 Tab 移走也关闭（焦点在新的位置）；再点圆环关闭 |
| 后台进程退出、Restart 之后重新打开中 | 同 chat.md"后台进程退出" | 圆环和详情保留最后一次读到的用量（同原来；重新打开时 `contextUsage` 不清空） | 打开详情 |

- 详情是不抢焦点的浮层：里面没有能停的东西，焦点一直在圆环上；圆环带 `aria-expanded`，详情开着时还有指向它的
  `aria-controls`（关着时详情不在页面里，不设）。
  详情里的内容都在圆环的读屏名和描述里，读屏用户不打开详情也不缺信息。
- 详情只是看数，不算阻塞的浮层：与选区浮层一样不挡 Alt+1 / Alt+2 / Alt+3 和 Ctrl+N（批准卡来了照样能答）；焦点在圆环上时 Esc 先关它。
- 点圆环、打开详情都不发任何命令（只用已经刷新到的 `contextUsage`）。
- 不做 Claude 详情里的"Compact session"和"Compacts automatically at {pct}%"：手动压缩不在方案第 4 节里，
  pi 的自动压缩阈值是留出的 token 数、不是百分比，写出来不准。

## 菜单的位置与键盘

模型菜单、Effort 菜单、权限菜单（approval.md）、"Queue"的下拉（▾"More send options"）和圆环的详情都按这张表。

| 项 | 做法 |
| --- | --- |
| 打开方向 | 往上打开：菜单的下边在这一行上方 6px，盖在文字框和上面的对话流、批准卡上，不挤动布局；菜单里各项从上到下的顺序不变 |
| 定位的参照 | `.composer-bottom` 设 `position: relative`，是任何宽度下所有菜单和圆环详情的参照；各按钮的外层 `position: static`。不以 `.composer`（`slash.css` 里已是 `position: relative`）定位：草稿很长时（文字框最高 220px 加引用芯片）`.composer` 的上边离这一行约 280px，菜单会被推到顶栏上和窗口外 |
| 左右对齐 | 任何宽度同一个规则（打开时量按钮和这一行的位置算）：模型菜单、Effort 菜单和"Queue"的下拉右边对齐自己按钮的右边（"Queue"的下拉是 ▾）；这样会伸出这一行的左端时往右挪，左边贴这一行的左端；最宽不超过这一行。权限菜单左边对齐这一行的左端（也就是权限按钮的左边）。圆环详情右边对齐这一行的右端 |
| 为什么不对齐别的 | 模型菜单不左对齐模型按钮：有空余时模型被 `margin-left: auto` 推到右边，ID 很短时模型按钮左边到这一行右端只有约 220px，260px 的菜单会伸出去。也不再用模型和 Effort 的外层定位（这一层去掉了，见"位置"） |
| 高度 | 最高 min(440px, 这一行的上边到顶栏下边的距离 − 12px)；超出时在菜单里滚动；权限菜单的"Allowed for this session:"列表也一样（原来没有上限）。这一行贴在会话面板底部，草稿变高时升高的是 `.composer` 的上边，这一行不动，所以这个距离只随窗口高度变：打开时量，窗口大小变了时重算 |
| 不出界 | 菜单整个在这一栏会话面板里（上下左右），也在窗口里；不伸到顶栏上、不被右栏或窗口边挡住 |
| 同时只开一个 | 这一行的菜单、圆环详情和"Queue"的下拉同时只开一个：点别处（包括这一行的另一个按钮）关闭；"Queue"的下拉也这样（原来点外面不关） |
| Tab 移出时关闭 | 只在键盘焦点落到外面一个能停焦点的元素上时关闭：`focusout` 的 `relatedTarget` 不为 null、不在菜单的外层里、也不在盖住窗口的对话框（`.dialog-backdrop, .issue-backdrop`，与 `menu.ts` 的 `useOutsideClose` 相同的例外）里。所以：按 F8 打开报告框不关菜单，关掉报告框后焦点回到原来的菜单项；点菜单里不能停焦点的文字（分组名、底部说明、"Allowed for this session:"、"None"、详情里的字）不关；Alt+Tab 切到别的程序不关 |
| 键盘 | 打开时焦点落在当前打勾的一项（都不可用时落在第一个可用的按钮，例如"Open settings"；"Queue"的下拉落在第一项）；↑ ↓ 在可用的项之间移动、到头回绕；Enter 选择；Esc 关闭，焦点回到打开它的按钮（"Queue"的下拉回到 ▾）；选了模型或强度后菜单关闭、焦点回到按钮；"Manage models"、"Open settings"打开设置页 |
| 什么时候自动关 | 见下表 |
| 算作"菜单开着" | 模型、Effort、权限菜单和"Queue"的下拉开着时 Alt+1 / Alt+2 / Alt+3、Ctrl+N 不起作用，Esc 先关它（chat.md、approval.md、sessions.md）；圆环详情不算（见上） |
| 新的批准卡或询问卡来了 | 开着的这一行的菜单和圆环详情关闭，焦点回到打开它的按钮（仍在这一栏里，Alt+1 / 2 / 3 能答） |
| 不会误发送 | 菜单里按 Enter 只选菜单项；只有焦点在文字框里时 Enter 才发送或排队 |

什么时候自动关（每个浮层一行；"刚发出""生成中"见 chat.md 的状态表；"不能发送"是按钮位置显示"Starting…"、"Restarting…"、
"Mori’s background process crashed"、"Session didn’t open"的几种）：

| 浮层 | 生成开始（刚发出、生成中） | 不能发送（后台进程退出、重新载入、打开中、打开失败） | 其他 |
| --- | --- | --- | --- |
| 模型菜单、Effort 菜单 | 关闭（按钮不可用） | 关闭 | 按钮消失时（打开失败；没有可用模型时的 Effort）跟着关 |
| 权限菜单 | 不关（生成中仍可用，同原来） | 关闭（原来不关，一起改） | — |
| 圆环详情 | 不关 | 不关（圆环保留最后的用量） | 只在圆环消失时（打开失败、pi 返回空）跟着关 |
| "Queue"的下拉 | — | 关闭（按钮消失） | 清空草稿或本轮结束、"Queue ▾"消失时跟着关 |

## 不可用时、按钮消失时的焦点

- 模型、Effort、权限按钮不可用时用 `aria-disabled="true"`（不用 `disabled`）：仍能 Tab 到，点了不开菜单，
  不可用的原因同时是悬停说明的第二行和读屏的描述，代替原来的第二行：
  - 生成中（只有模型、Effort）："Can’t switch models until the response finishes"、
    "Can’t change effort until the response finishes"；
  - 后台进程退出："Mori’s background process crashed"；重新载入中："Restarting…"；
  - 打开中（第一次打开时只有权限按钮，Restart 之后的重新打开三个都在）："Starting…"；
  - 打开失败（只有权限按钮）："Session didn’t open"。
  这几句就是按钮位置的说明，横幅里有更长的原文。"切换中"原来就这样（不加原因）。"Send"在输入为空时仍是 `disabled`（同原来）。
  权限按钮要加 `[aria-disabled='true']` 的样式（现在只有 `:disabled` 和 `:not(:disabled):hover`）。
- 焦点所在的这一行的按钮消失时，焦点移到这一栏的文字框（不落到 `body`，否则下一次 Tab 从页面开头走）：
  打开失败时的模型、Effort 按钮；本轮结束时的"Stop"、"Queue"、▾；清空草稿时的"Queue"、▾；
  开始生成时的"Send"；消失的圆环。菜单里有焦点的项随菜单关闭消失时，焦点按上面的表回到按钮，按钮也消失时回到文字框。
  Restart 之后重新打开中按钮还在（不可用），焦点留在原来的按钮上。

## 窄栏

这一行按会话面板（`.chat-pane`，这一行的 `@container`）的宽度分步收紧，单栏、分屏相同；分屏右边那一栏的 `.chat-pane`
有 1px 的 `border-left`，比 `.pane-slot` 窄 1px。这一行的宽度约是"面板宽 − 78px"（面板 ≤ 520px 时输入区两边内边距收小，
约"面板宽 − 54px"），最宽约 782px（输入区最宽 860px）。最窄的两种：分屏每栏 280px（这一行约 226px，右边一栏 225px）、
800 宽窗口右栏打开时中栏 300px（约 246px）。阈值按最宽的情况估算（Segoe UI 的字形宽度，12px，发送组 13px）：生成中、输入框有字
（"Queue ▾"和"Stop"）、"Ask each time"、"Effort: Unavailable ▾"、"<ID> (deleted)"；逐档的数见
[composer-pickers.md](../composer-pickers.md)"宽度估算"。
（v1：见 docs/specs/model-providers.md §9.2：按钮文字改为"<范围名> · <当前模型 id>"，读屏名"Model range: …"，悬停是提供商名和区域，不再有" (deleted)"。）

权限按钮任何宽度都只有文字（模式名和 ▾），没有图标，照 Claude 的模式选择（负责人 2026-10-21 定）。"Allow all"用警示色，
也写着"Allow all"，不靠颜色也读得出。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 宽 | 会话面板宽于 760px | 权限"Ask each time ▾"；模型按钮（最长 160px）；"Effort: High ▾"；圆环；带文字的"Send"、"Stop"、"Queue ▾"；间距 8px | 全部 |
| 稍窄 | ≤ 760px | 模型按钮最长 120px | 同上 |
| 较窄 | ≤ 680px | Effort 按钮只显示强度："High ▾"、"Unavailable ▾" | 同上 |
| 窄 | ≤ 600px | "Send"、"Stop"、"Queue"只显示图标（"Send"是圆形的强调色按钮，"Stop"是圆形按钮，"Queue"用新图标 `queue`、连着它的 ▾），名字在读屏名里："Send"（悬停"Send (Enter)"）、"Stop"（悬停"Stop response (Esc)"）、"Queue"（悬停"Queue for later (Enter)"）、▾"More send options"。"Send"、"Stop"、"Queue"各 32px 宽，▾ 24px（原来 32px） | 同上 |
| 更窄 | ≤ 460px | 权限、模型、Effort 按钮去掉 ▾，这一行的间距收小到 4px | 同上 |
| 很窄 | ≤ 400px | 生成中、输入框有字时，"Queue"按钮收起，只留 ▾"More send options"，它的菜单里是"Queue for later"（快捷键提示 Enter）和"Steer"（快捷键提示 Ctrl+Enter）；"Stop"留在原位 | 点 ▾ 选；Enter 排队、Ctrl+Enter 插话、Esc 停止照旧 |
| 最窄 | ≤ 340px | "Send"、"Stop"的图标按钮 28px（原来 32px）；权限、模型、Effort 按钮的左右内边距 4px（原来 6px） | 同上 |
| 放不下 | 这一行的内容比这一行宽（任何一档） | 依次截短，前一项到最窄才轮到下一项：① 不能发送时的说明（"Mori’s background process crashed"、"Starting…"等，最窄 48px，悬停说明和横幅里有全文）；② 模型 ID（最窄 40px，≤ 340px 时 36px；" (deleted)"最后截）；③ 权限的模式名（最窄 44px，≤ 340px 时 40px）；④ Effort 的强度（最窄 40px，≤ 340px 时 36px）。截短处是省略号"…"，前面留几个字母由 Chromium 决定（量到最窄的权限是"Ask …"、"Allo…"），测试不比字面。最窄的数在 ≤ 460px（没有 ▾）时字有 28–32px；宽于 460px 时有 ▾，同样的最窄里字只剩约 10–14px，但最挤时也截不到那里。各项都是这一行的直接子项，`flex-shrink` 相邻差 1e5 以上（composer-pickers.md"宽度估算"）。不换行、不超出输入框；圆环、"Send" / "Stop" / ▾ 不收 | 同上 |

- 截短只是样式：按钮的文字（textContent）仍是全文，读屏名也是全文（"Permission mode: Ask each time"、"Model: <ID> (deleted)"、
  "Effort: Extra high"）；会截短的三个按钮，悬停说明的第一行是全文（权限"Permission mode: Ask each time"、模型
  "<连接名> · <模型 ID>"、Effort"Effort: Extra high"），第二行是说明或不可用的原因。收起的"Send"、"Stop"、"Queue"的名字在读屏名
  和悬停说明里。
- 估算的结果：宽于 400px 的各档在最挤时模式名都不截，模型按钮至少约 54px；≤ 400px 起最挤时才截模式名；
  280px 一栏最挤时是截短的模式名（权限 40px）、模型 36px、截短的强度（Effort 约 52px）、圆环、▾、"Stop"，
  三个按钮都不窄于最窄。空闲、Effort 是"High"时，280px 也能显示完整的"Ask each time"（模型约 41px）。

"Queue"的下拉里各项的名字只有文字（"Queue for later"、"Steer"），快捷键是旁边的 `.menu-hint`（`aria-hidden`），
另放在 `aria-keyshortcuts`（"Enter"、"Control+Enter"）里，读屏名里没有" · "。

## 反例

- 模型没标支持思考时，思考强度的选项都不可用（不是只藏起来），并说明原因。
- 在输入框下切换模型或思考强度不改设置里的默认（pi 不 persist）；新会话仍用默认模型和它的默认强度。（v1：见 docs/specs/model-providers.md §5.10、§11.1：默认模型改为默认范围 `normalDefault`）
- 切到"Off"之后，下一次回复没有思考内容（DeepSeek 实测：pi 发 `thinking: disabled`）。
- 还没有发过消息的会话，圆环不显示"0%"或"<1%"（pi 的 0 不含系统提示词，不是真的用量）。
- 菜单不会伸到顶栏上或窗口外；"Stop"在任何宽度都看得见。
- 权限按钮任何宽度都没有图标、不会只剩图标；最窄时两种模式看得见的开头不同（"Ask …"、"Allo…"），不只差颜色。
- 宽于 400px 时，权限的模式名不会因为模型 ID 长而被截短（模型先截）。
- 顶栏上不再有模型、Effort、权限和用量。

## 照 Claude 桌面版

| 交互 | Claude 桌面版 | Mori |
| --- | --- | --- |
| 位置 | prompt box 下面那一行：左边模式选择（mode selector）；右边一组是模型、单独的 Effort、用量圆环（最后），再往右是发送 | 同：左端权限按钮，右边模型、Effort、圆环，最右是发送 / 停止（Claude 的发送 / 停止在输入框里的右下角，Mori 原来就在这一行的右端） |
| 模式选择 | 只有文字的 ghost 按钮，显示模式名，没有图标；变窄时模式名截断；悬停是当前模式的说明，没有说明时是菜单标题"Mode" | 同（负责人 2026-10-21 定）：只有模式名和 ▾（≤ 460px 去掉 ▾），没有图标；变窄时模式名截断加"…"，但比模型 ID 后截（见"窄栏"）。悬停第二行照 Claude 是当前模式的说明，第一行是全名"Permission mode: …"（approval.md） |
| 模型菜单 | 一个按钮显示当前模型，读屏名"Model: {name}"；往上打开、右端对齐；当前项打勾，默认模型标"Default"；只作用于当前会话 | 同；按连接分组，最后"Manage models"；右端对齐模型按钮，放不下时挪进这一行 |
| 思考强度 | 文档说在模型菜单里选；装在本机的版本是模型按钮右边单独的"Effort"，读屏名"Effort: {name}" | 单独的按钮（负责人 2026-10-21 定），读屏名同 Claude；菜单形式同模型菜单 |
| 用量圆环 | 只有图标的按钮，12px 的环；< 75% 强调色、75–89% 警示色、≥ 90% 危险色；悬停"Context {summary}"，估算的数前面"≈ "；读屏名"Usage: {parts}"；点开往上弹出：一行左边"Context window"、右边 summary，下面 4px 进度条，没有数据时右边空着、进度条的位置换成"Send a message to see context usage." | 同，只有上下文这一部分；环 14px；读屏名里" / "换成" of "、写完整的数；刚压缩完用 Mori 原有的说明、底圈虚线 |
| 窄 | 这一行是 CSS 容器，变窄时模式名和模型名截断，Effort 和圆环不收；不换行 | 同样不换行、圆环不收、模式名和模型名截断；Mori 的按钮比 Claude 的宽（带 ▾、"Effort: "前缀、文字按钮），所以先分几档去掉这些（见"窄栏"），最窄时 Effort 的强度也截；发送 / 停止只有图标同 Claude |
| 发送的下拉 | "More send options"里有"Queue for later"和"Stop" | ▾"More send options"里是"Steer"，≤ 400px 时加上"Queue for later"；"Stop"一直在外面 |
| 没有做 | Ctrl+Shift+M / I / E 打开三个菜单、菜单里按 1–9 选；"Compact session"；套餐用量 | 方案没有要求，不加 |

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 这一行 | 每一栏 `[data-testid="composer"]` 里的 `.composer-bottom` |
| 模型按钮 | `data-testid="model-button"`（在这一行里）；菜单 `data-testid="model-menu"`，项 `role="menuitemradio"`，`data-model` 为 provider/id（v1：见 docs/specs/model-providers.md §9.2：项改为 `data-pick`，见 v1/screens/model-menu.md） |
| 思考按钮 | `data-testid="thinking-button"`（`data-level` 为当前强度，不支持思考时 `data-reasoning="false"`）；菜单 `data-testid="thinking-menu"`，项 `role="menuitemradio"`，`data-level` |
| 权限按钮 | `data-testid="permission-button"`；模式名在 `.permission-text` 里（是否截短比它的 `getBoundingClientRect().width` 和全文的宽，不用 `scrollWidth`：截短时两者可能相等）；按钮里没有图标，只有 ▾（≤ 460px 时也没有） |
| 圆环 | `data-testid="usage"`（按钮，每栏一个；`aria-expanded`，详情开着时 `aria-controls`；`data-state` 为 `empty` / `compacted` / `used`）。`data-tokens`、`data-percent`：还没有消息时是 `0`、`0`；有用量时是 pi 给的数和四舍五入的百分比；刚压缩完时没有这两个属性。详情 `data-testid="usage-details"`；悬停提示 `data-testid="usage-tip"`（`aria-hidden`） |
| 发送、停止、排队 | 类名不变：`.send-button`、`.stop-button`、`.split-button`；只显示图标时名字在 `aria-label`；▾ 菜单的项 `role="menuitem"`，带 `aria-keyshortcuts` |
