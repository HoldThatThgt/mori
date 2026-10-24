# composer-pickers 检查记录（模型、Effort、权限和上下文用量移到输入框下面一行）

日期：2026-10-21 至 2026-10-22（下面的时刻都是 git 提交用的 −04:00）。机器：Windows 11（10.0.28000），Node 24.19.0；
Electron 44.9.0；pi 1.3.0；electron-builder 26.17.0；playwright-core 1.64.1。
分支 `composer-pickers`，基于 `app-v0` 的 `046a9ca`（v1-taskboard 合入之后；本机和 origin 的 `app-v0` 都是它），
12 个提交：`cde2f24`（状态表和方案）、`9a7e8f9`（设计改到 v1 的选择范围按钮上）、`09f10bb`（实现和测试）、
`797bbf6`（第一轮测试和静态审查后的修正）、`5b2bcdb`（顶栏放下协作开关）、`4b7f5fc`（开发构建全部套件跑下来后的修正；
另含两处内核的竞态修正，见"交付了什么"最后一行）、`3a9a669`（视觉走查的修正）、`c673735`（真实模型走查的修正）、
`f8066b2`（打包版的修正）、`8adedda`（这份记录）、`a40910e`（最终审查后的修正"composer-pickers: final review fixes"，见"最终审查之后改的"），
以及按日志核对这份记录后的更正"composer-pickers: check record corrections"（只改这份记录；要合并的是这最后一个提交）。本机还留着 v1 合入前停下的
`composer-pickers-wip-prev1`（`d21ff35`，不合并，合并后可删）。
设计说明在 [composer-pickers.md](composer-pickers.md)（为什么、宽度怎样估的、每处按推荐定的），这里记做了什么、测了什么、
哪里和方案不同、还有什么没验证。分支没有推送，也没有合并进 `app-v0`（合并由发起这一步的会话在最后做）。
合入 `app-v0` 之后又与 v1-memory 合并，经过和合并后的结果见"合入 v1-memory（origin/app-v0 54f0758）之后"；
一键拉取模型合入之后两处测试的时序修正见最后一节"合入一键拉取模型（ab57183）之后：两处测试的时序"。

## 状态

按 AGENTS.md 的完成顺序：状态表（`cde2f24`，[screens/models.md](screens/models.md)、[chat.md](screens/chat.md)、
[approval.md](screens/approval.md) 等）→ 从真实会话录 fixture（**有意跳过**：这一步不改后台进程的命令和事件，
回放用的 fixture 内容不变，m1–m7 和 `fixtures/v1/` 都没有重录，见"按推荐定的"第 75 条）→ 界面测试 → 实现 →
用真实模型走一遍（DeepSeek 和 GLM，开发构建和打包程序各一遍；最终审查的修正之后只重走了 `m5-real`，见"未验证"）→ 你走查。
只差你走查，以及你认可有意跳过的 fixture 录制一步（按 AGENTS.md"缺一步不算完成"，见"fixture"和"还没处理、等你定的"）。
M2–M7 和英文界面的走查也还没签收（[english-ui-checks.md](english-ui-checks.md)"状态"）；这一步改了它们走查要看的几处：
模型（v1 的选择范围按钮）、Effort、权限按钮不在顶栏了，在输入框里文字框下面那一行；上下文用量从"Context 12%"变成
Effort 后面的小圆环；顶栏只有"项目名 › 会话名"、协作开关、右栏开关（分屏时还有"Close pane"）；
从文字框 Shift+Tab 回会话树是 6 次（M6 记的是 8 次，TaskBoard 合入后是 9 次）。
真实端点是你在 Mori 里加密保存的那一份数据（`%TEMP%\mori-real-data`，DeepSeek 和 GLM 两个提供商）；只作 `--source`，
要 `--user-data` 的脚本用 `tests/ui/lib.mjs` 的 `scratchUserData` 复制出来的临时副本，跑完已删除；没有读取、打印或解密 key。

结果一览（最终审查的修正之后、在最后的代码上；一个套件接一个跑，详细见"测试"的"结果"）：

- 合成端点的整机测试（m0–m7 含新的 `m6-app-row`、v1 模型层、TaskBoard、`m6-mcp-cost`）开发构建 1672 项、打包程序 1671 项
  （`tb-app-roles` 打包版按设计少 1 项），全部通过，两边各有 1 项 KNOWN（pi #9129）；另 `m6-pi-config --check` 开发构建通过；
- 界面回放 505 项（m1–m7 407、v1 43、TaskBoard 55）、单元 374 项、TaskBoard 单元 327 项，开发构建上全部通过；
- 真实模型走查（m0–m7、`v1-models-real`、`tb-real`）开发构建和打包程序各 321 项全部通过，各 2 项 KNOWN
  （`m1-real` 刚压缩完的圆环看没看到、`m3-real` 的模型行为）；这些跑在最终审查之前的代码上，之后只重走了 `m5-real`
  （两边 19 / 19）；几项要重跑或改了测试才过，见"测试"；
- 打包程序 `app.asar` 里的 `out/` 与 `app/out/` 327 个文件 SHA-256 全部相同（最后的代码重新打包后又比了一次）；
- 覆盖检查：模型层规格和 TaskBoard 规格（`node tests/spec-coverage.mjs`、`--spec taskboard`），开发构建和 `--packaged`
  四个都 exit 0（"every item is covered on every listed layer"）。

## 你决定的（2026-10-21）

| 问题 | 你的回答 | 现在的做法 |
| --- | --- | --- |
| 分屏一栏约 460px 时会话名被挤到约 2 个字符（英文界面走查时提的） | 把模型、Effort、权限按钮从顶栏移到输入框下面一行，像 Claude 桌面版 | 输入框里文字框下面那一行（原来只有发送 / 停止的 `.composer-bottom`）：左端权限按钮，右边选择范围按钮、Effort、上下文用量圆环，最右发送 / 停止 / 排队；顶栏只留"项目名 › 会话名"和这一栏的按钮。460px 的分屏一栏里会话名从 36px 变成 258px（有协作开关时实测） |
| Effort 放在哪 | 仍是单独一个按钮（不像 Claude 那样放进模型菜单） | `ThinkingMenu.tsx` 的按钮和菜单不变，搬进这一行 |
| 上下文用量 | 改成模型按钮旁边的小圆环（像 Claude） | 新组件 `UsageRing.tsx`：14px 的环，顺序是模型、Effort、圆环，然后是发送组；悬停"Context ≈ 15.4k / 128k (12%)"，读屏名"Usage: Context approximately 15,360 of 128,000 tokens (12%)"，点开是 Claude 那样的详情 |
| 权限按钮 | 只有文字（"Ask each time ▾" / "Allow all ▾"），不选"只留图标"；窄时模式名截断，即使模型按钮因此更挤 | 任何宽度都没有盾牌图标；放不下时模式名截断加"…"，全名在悬停第一行和读屏名里；"Allow all"保留警示色（文字改深一点，见第 36、59 条） |
| 怎样往下做（2026-10-21 晚） | 不用等你，每处选推荐的做法、在最后的报告里列出来，你之后再看；做完合并进 `app-v0` | 每处选择都列在下面"按推荐定的"；分支做完、验证完，由发起这一步的会话合并（这份记录写下时还没合并） |
| v1 合入后的要求（[../v1/models-checks.md](../v1/models-checks.md)"你决定的"第 8 条） | english-ui 和这一步在 v1 之后合并时，顶栏的范围菜单搬进输入框下面那一行，"thinking"的说法改成 Effort | 范围按钮和菜单在这一行（v1 的 `RangeMenu`，往上打开，"按推荐定的"第 1–16 条），思考强度的按钮和菜单叫 Effort；models-checks.md 只改了走查步骤 2、4、7 里的位置（记录本身不改） |

[composer-pickers.md](composer-pickers.md)"负责人的决定"记着同样的几条；由此定下的临时默认值登记在 [defaults.md](defaults.md)。

## 照 Claude 桌面版

用词和样子照装在本机的 Claude 桌面版（英文字串表 `ion-en-US.json` 的键，见 composer-pickers.md"照 Claude 桌面版"一表）：
这一行的顺序（左端模式选择，靠右模型、用量圆环，最右发送）、只有文字的模式按钮、圆环的悬停和详情（"Context window"、
"Send a message to see context usage."）、"Queue for later"、"More send options"、"Applies to this session only"。
借用了 Claude 别处的字串的地方（"Permission mode: {mode}" 是 Claude 定时任务卡片上的一行，"Set the effort level for this
session" 和"Change the permission mode"是 /effort、/permissions 命令的说明）也记在那张表里。没有打开 Claude 截图对照
（见"未验证"）。

## 按推荐定的（负责人以后看）

你不在时每处有几种做法的，都选了推荐的那一种（例外是第 4 条，照你的要求）。下面是全部：v1 合入之后的 16 条、原设计我自己
定的、实现和测试里另定的、静态审查后改的、TaskBoard 合入后的、测试和验证里的做法、最终审查后改的，以及各阶段报告里与方案
不同的地方。"出处"指 composer-pickers.md 的小节，或做这件事的阶段。

### v1 合入之后（composer-pickers.md"v1 之后的调整"最后一节）

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 1 | 选择范围按钮任何宽度最长 200px，去掉"≤ 760px 最长 120px"那一档 | 保留 160 / 120px（分组、提供商范围在 800 宽单栏和所有分屏里几乎只剩范围名）；不设上限（很长时这一行看起来全是它） | W1 |
| 2 | 范围按钮的悬停三行：按钮文字 / "<提供商名> · <区域>" / 不可用的原因 | 两行，原因顶掉提供商和区域（生成中看不到发到哪个区域） | H1 |
| 3 | 读屏名用 v1 的"Model range: <按钮文字>" | Claude 的"Model: {name}"（按钮显示的不一定是一个模型） | T1-A |
| 4 | 准备中、生成中不能换的原因用"Can’t switch models until the response finishes"（v1 合入 app-v0 时已是这句，代码、规格 §9.2、测试常量一致）。**这一条不是推荐的做法**：照你的要求不改这句（composer-pickers.md T2） | 草稿推荐的规格原句"Can’t change the model while generating" | T2 |
| 5 | Effort 不能换的原因"Can’t change effort until the response finishes"，准备中也用 | 准备中不给原因，或另写一句 | T3 |
| 6 | 范围菜单底部"Applies to this session only. New sessions use the default range from Settings."和"Manage models"（不加"…"） | v1 原来的"Applies to this session."和"Manage models…" | T4-A、T5-A |
| 7 | 切换失败"Couldn’t change the model range: <原文>" | 别的写法 | T6 |
| 8 | 不支持思考的说明用合并后的句子（内容照 v1，写法照术语表） | v1 原句 | T7 |
| 9 | 没有范围、没有当前模型、区域照 v1："No model range"、"No model can run in this session"、Local / Intranet / Public、"Zone not confirmed" | Claude 的"Select model"（是"去选一个"的提示，不说明为什么不能跑） | T9 |
| 10 | 准备中的"Queue"在 ≤ 400px 也是单个图标按钮，≤ 340px 28px | 收进只有一项的 ▾（省 8px，多点一下） | P1 |
| 11 | 切换失败那一行从这一行往上浮出 | 放到输入框上方、拒绝启动卡的位置（会把输入区顶高一行、10 秒后又落回） | E1 |
| 12 | 文档分工：v0 models.md 管这一行（位置、宽度、悬停的行、不可用和焦点、窄栏、菜单的位置），按钮的字、菜单内容、拒绝启动以 v1 model-menu.md 为准 | 都并进 model-menu.md、models.md 只留圆环 | D1 |
| 13 | 规格和 proposal 里的"顶栏"改成"输入框下面一行"或"范围菜单"（只改位置的说法） | 不改、在 §9.2 加一条注 | S1 |
| 14 | 切换中范围按钮和 Effort 都加 `data-pending="true"`（两个按钮共用一个切换中的值） | 不加，测试只能靠 `[data-running]` 和悬停去猜 | — |
| 15 | F8 的"Current view"加"Model range"（`tab.pick`，没有时"None"） | 不加 | — |
| 16 | 后台进程和共用类型注释里的"顶栏菜单"改成不写位置的"范围菜单" | 改成"输入框下面一行的菜单"（界面再挪时又过时） | — |

### 原设计我自己定的（composer-pickers.md"我自己定的"和"待你决定"）

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 17 | 放不下时依次截短：不能发送的说明 → 选择范围（先截当前模型 id，再截范围名）→ 模式名 → Effort 的强度；最窄 48 / 40 / 44 / 40px（≤ 340px 时范围 36、权限 40、Effort 36px）；宽于 400px 时最挤也不截模式名 | 模式名先于模型截；Effort 先截（常用强度本来就短，截了省不了多少） | 第 1 条 |
| 18 | 各项都是 `.composer-bottom` 的直接子项，用相差很大的 `flex-shrink`（说明 1e18、范围 1e12、权限 1e6、Effort 1）排出先后；删掉 `.composer-spacer`，改用 `.permission + * { margin-left: auto }` | 把右边几项包成一组（排不出先后，审查时在 Edge 里试过）；差 1000 倍（不够）；写脚本控制先后 | "宽度估算""实现" |
| 19 | 会截短的按钮悬停第一行是全文（"Permission mode: Ask each time"、范围按钮的文字、"Effort: High"），第二行是说明或原因 | 悬停只有说明（截短后鼠标用户看不到全名） | 第 2 条 |
| 20 | 会话面板 ≤ 600px 时"Send"、"Stop"、"Queue"只有图标（各 32px，▾ 24px），新图标 `queue` | 一直带字（1200 宽窗口右栏打开的 490px 一栏里模型按钮没有地方） | 第 3 条 |
| 21 | ≤ 400px 生成中有字时收起"Queue"（▾ 菜单里"Queue for later"和"Steer"），"Stop"不动 | 原设计在 ≤ 340px 才收；收起"Stop" | 第 4 条 |
| 22 | ≤ 340px "Send"、"Stop"收到 28px，三个按钮左右内边距 4px | 不收（280px 一栏最挤时三个按钮都在最窄、没有余量） | 第 5 条 |
| 23 | 还没有消息时圆环为空，悬停和读屏名"Context window"，详情里"Send a message to see context usage."，不显示"0%" | 原来的"Context <1%"（pi 的 0 不含系统提示词，不是真的用量） | 第 6 条 |
| 24 | 百分比照 Claude 四舍五入，不再写"<1%" | 保留"<1%" | 第 7 条 |
| 25 | 刚压缩完时圆环的底圈是虚线，说明沿用 Mori 的"Just compacted. Context usage shows after the next response." | 和"还没有消息"一样的空圆环 | 第 8 条 |
| 26 | 圆环颜色照 Claude 分档（< 75% 强调色、75–89% 警示色、≥ 90% 危险色），环 14px（Claude 12px），详情 260px 宽、4px 的条；有填充时底圈 `--color-line`，空圆环 `--color-faint`；警示色的填充用新的 `--color-warn-text` | 12px；底圈一律 `--color-faint`（与三种填充几乎一样亮，看不出填到哪里） | 第 9 条 |
| 27 | 圆环详情不算阻塞的浮层（不挡 Alt+数字和 Ctrl+N）；模型、Effort、权限菜单仍算阻塞，但新的批准卡或询问卡来了时关闭、焦点回按钮 | 详情做成抢焦点的对话框；三个菜单开着时新卡来了不关 | 第 10 条 |
| 28 | 这一行的按钮不可用时用 `aria-disabled`（仍能 Tab 到、读屏读得到原因），能用时不带这个属性（不写"false"）；按钮消失时焦点回文字框；原因沿用按钮位置原有的说明（"Mori’s background process crashed"、"Restarting…"、"Starting…"、"Session didn’t open"） | 真的 `disabled`（Tab 不到、读不到原因）；另写一套原因 | 第 11 条 |
| 29 | 菜单往上打开：范围、Effort 菜单和"Queue"的下拉右边对齐自己的按钮，放不下时挪进这一行；权限菜单左对齐这一行；圆环详情右对齐这一行；最高 min(440px, 这一行上边到顶栏下边 − 12px)；范围菜单宽 min(300px, 这一行) | 审查建议的宽于 600px 时模型菜单左对齐模型按钮（短 id 时 300px 的菜单会伸出这一行） | 第 12 条、"菜单的位置" |
| 30 | 顺手补上原有的缺口：后台进程退出时权限菜单也关；"Queue"的下拉点外面关、打开时焦点进菜单、↑ ↓、Esc 回 ▾；Tab 把焦点移到菜单外面时关 | 留到别的步骤 | 第 13 条 |
| 31 | Restart 之后重新打开中，范围按钮、Effort、圆环保留上一次的值（不可用）；打开失败时藏起它们 | 和第一次打开一样藏起（这一行会突然变空） | 第 14 条 |
| 32 | 顶栏的项目名最长 160px，先收短到 40px 再截会话名，≤ 320px 不显示 | 照 Claude 先藏项目名；原来 660px（分屏 690px）以下就不显示 | 第 15 条 |
| 33 | F8 的"Current view"加"Pane width"（焦点所在那一栏 `.chat-pane` 的宽度）和"Effort"；上下文用量不加（报告里有截图） | 不加；连用量一起加 | 第 16 条 |
| 34 | 不做 Claude 的 Ctrl+Shift+M / I / E 快捷键和"Compact session"（方案没有要求） | 做 | 第 17 条 |
| 35 | 悬停两行，读屏的描述只有第二行（`aria-describedby` 指向藏起来的元素）；范围按钮的描述是第二行（" · "换成", "），不可用时加". <原因>" | 让 `title` 当描述（第一行和名字重复，念两遍） | 第 18 条 |
| 36 | "Allow all"的文字用 `--color-warn-text`（底色上 5.09:1，悬停时 4.66:1）；不支持思考时 Effort 的字用 `--color-muted`（不再变淡） | 原来的警示色（3.02:1）；`--color-faint`（3.08:1） | 第 19 条 |
| 37 | 圆环的悬停提示在悬停和键盘焦点时都显示；Esc 先关详情，详情没开时 Esc 藏起提示、焦点留在圆环（WCAG 1.4.13），再按才停止生成 | 只在悬停时显示；Esc 直接停止生成 | 第 20 条 |

"我自己定的"第 21、22 条与上面第 10、1、14、15 条相同，不重复列。

### 实现和测试编写时另定的（各阶段报告里的偏差）

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 38 | 去掉 v1 的 `useSwitchMenu`，范围菜单也用这一行共用的菜单钩子（新的 `rowMenu.ts`），所以它也在 Tab 移出、新卡来了时关 | 保留 v1 的钩子（范围菜单的行为和另三个不同） | 实现 |
| 39 | "Queue ▾"一对里的主按钮类名 `.queue-main`，准备中的单个按钮 `.queue-button`，≤ 400px 藏主按钮的规则碰不到后者 | 同一个类名 | 实现 |
| 40 | "Send"、"Stop"、"Queue"任何宽度都带 `aria-label` 和 `title`（不只在只有图标时） | 只有图标时才带 | 实现 |
| 41 | F8 不在会话页时"Pane width: None"，没有当前模型时"Effort: None" | "Hidden"（v1 之前那次实现用的）；不写这一项 | 实现 |
| 42 | 去掉 Effort 的 `.unsupported` 类（它只用来变淡，第 36 条不再变淡） | 留着不用 | 实现 |
| 43 | `pick-error` 最宽 320px 来自 CSS 变量 `--row-max-width` | 写死在规则里 | 实现 |
| 44 | 范围按钮的描述把每一个" · "都换成", "（多个区域时"Local, Public"） | 只换第一个 | 实现 |
| 45 | 顶栏原来 ≤ 600px 的内边距规则去掉，只留 400px 和 320px 两档 | 留着 | 实现 |
| 46 | 点"Send"马上把焦点放回文字框，不等按钮消失 | 等按钮消失 | v1 之前那次实现 |
| 47 | 只有图标的"Send"、"Stop"、"Queue"与宽同高（32px，≤ 340px 28px），这一行仍是 33px | 保持原来的高度 | v1 之前那次实现 |
| 48 | 圆环的悬停提示只在键盘焦点时显示（鼠标点击得到的焦点不显示）；只因键盘焦点显示时不接鼠标（`pointer-events: none`，否则盖住文字框底部、挡住点击） | 鼠标焦点也显示；一律接鼠标 | v1 之前那次实现 |
| 49 | 这一行的菜单按 Esc 关上时，只在焦点原本在菜单里或掉到 body 上时回到按钮（否则在批准卡理由框里打字时按 Esc，焦点被拿走，下一下 Esc 变成停止生成） | 一律回到按钮 | v1 之前那次实现 |
| 50 | 新卡来了或按钮变得不可用时，只在焦点原本在那个控件里时才把焦点放回按钮 | 一律放回 | v1 之前那次实现 |
| 51 | 项目名靠很大的 `flex-shrink`（1e6）先收短，最长 160px、最窄 40px | 用脚本量 | v1 之前那次实现 |
| 52 | F8 字段的顺序："Model range"在"Model"前，"Effort"在"Model"后，"Pane width"在"Window size"后（[screens/f8.md](screens/f8.md)） | 别的顺序 | 实现 |
| 53 | 新加的 `m6-app-row.mjs` 加进 `package.json` 的 `test:m6-app`，端口 4364、4365。v1 之前开始实现时 `m6-app-settings` 已过 2000 行（2050 行），所以另起一个文件；`046a9ca`（v1、TaskBoard 合入后）上它是 1213 行（这一步改过后 1228 行），仍保留拆分（这一行的行为本来就和设置页无关） | 塞进已有文件 | 测试编写、核对 |
| 54 | `m6-helpers` 的 `rangeDescription` 也把每一个" · "换成", "，与 App 和另四个 helper 一致 | 只换最后一个 | 核对 |

### 静态审查之后改的（2026-10-22，`797bbf6`）

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 55 | 右栏开关：鼠标主键按下时，到这一下点完（或在别处松开之后）才把焦点切到这一栏；鼠标按下时的原生焦点照常（不用脚本 `focus()`，鼠标点后没有焦点环）；右键和键盘照旧按下就切。是 [split.md](screens/split.md)"焦点所在的一栏"的例外，已写进 split.md | 按下就切（另一栏的右栏状态不同时两栏变宽、开关被挤走，这一下点空）；取消 mousedown、点完用脚本 `focus()`（第一版修正，鼠标点后会出现焦点环） | 审查第 1、2、25 条 |
| 56 | 圆环的悬停提示只在焦点在圆环上时占 Esc；只因鼠标停在上面显示时，Esc 也藏起提示，但这一下照常停止生成、拒绝焦点所在的批准卡（分屏时以焦点所在的一栏为准） | 悬停时也占这一下 Esc（文字框里按 Esc 停不了生成，另一栏悬停的提示吃掉这一栏的 Esc） | 审查第 3 条 |
| 57 | 范围按钮的读屏名把" · "换成", "（"Model range: fast, deepseek-chat"）；按钮文字和悬停第一行仍是" · "。各状态表原来写的" · "违反 ui-strings.md"读屏名里不用 · 和 /"，改了状态表 | 保留" · "（名字和描述不一致） | 审查第 19 条 |
| 58 | 范围菜单每一项的读屏名只有名字，区域（逗号分隔）和被排除的原因在读屏的描述里 | 名字里带"Local · Public" | 审查第 26 条 |
| 59 | `--color-warn-text` 从 75% 改成 70%（#855f1e），"Allow all"悬停时也够 4.5:1 | 75%（悬停时 4.25:1）；把悬停底色降到 14%（悬停几乎看不出变化） | 审查第 20 条 |
| 60 | 权限按钮变得不可用时，开着的"Switch to “Allow all”?"确认框按取消关上，焦点回按钮（写进 approval.md） | 留着确认框、在 approval.md 说明这时确认会怎样 | 审查第 5 条 |
| 61 | 圆环的颜色分档按四舍五入后显示的百分比（与悬停、读屏里的数一致），写进 models.md 和 defaults.md | 按 pi 的原值（74.5% 时显示"75%"却还是强调色） | 审查第 4 条 |
| 62 | 圆环悬停时的底色用 `--color-surface`（空圆环的底圈 3.08:1） | 全局悬停底色（2.82:1，不到 3:1）；空圆环改用 `--color-muted` | 审查第 22 条 |
| 63 | `m6-app-slash.mjs` 超过 2000 行，各档的边界和拒绝启动两节搬到新的 `m6-app-bands.mjs`，记录的名字不变 | 搬进 `m6-app-row.mjs` | 审查第 9、21 条 |
| 64 | 一些 12px 的字对比度不到 4.5:1（`.composer-wait`、`.menu-hint`、被排除的菜单项、`.pick-error`、宽于 600px 的"Stop"和"Send"），都是这一步之前就有的颜色，没有改，记为已知 | 一起改成 `--color-muted` 和更深的危险色 | 审查第 23 条 |
| 65 | 切换中范围按钮和 Effort 没有 `aria-describedby`，Chromium 可能把 `title` 当描述；"Send"等的描述可能和名字重复。静态看不出，当时没有改（最终审查后改了切换中的两个按钮，见第 97 条） | 把 `title` 挪到外层；接受并改状态表 | 审查第 24 条 |

### TaskBoard 合入之后（composer-pickers.md"TaskBoard 合入之后"）

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 66 | 协作开关窄栏的阈值从 860px 降到 600px：宽于 600px 完整文字，≤ 600px 只有状态点（与发送组只剩图标是同一档）。实测"Team: Until done" 105.1px、状态点 19px，601px 一栏完整文字时会话名约 315px，和 1280 宽分屏只有状态点时（307px）差不多 | 规格原稿的"Team ●"（约 55px，窄栏会话名再少约 36px）；不设阈值（280px 一栏会话名只剩约 90px）；保留 860px | 按推荐定的第 1 条 |
| 67 | 协作开关按这一栏的宽度收成状态点，不看会话名放不放得下（600px 一栏里这个会话名其实还放得下"Team: Off"） | 量会话名决定（要脚本） | 视觉走查 |
| 68 | Stop team 是发送组里的一项（发送组的 `RowButton`，在"Stop"或"Send"前面），≤ 600px 只有图标（最终审查后改成 ≤ 760px，第 105 条），`data-testid="stop-team"` 不变；按钮消失时焦点回文字框 | 保持带字的按钮（≤ 600px 时这一行更挤，400px 以下放不下） | 按推荐定的第 2 条 |
| 69 | 协作模式下锁定的模型按钮（`pickLocked`，规格 §12.11）放在这一行原来模型按钮的位置，同样的截短规则（`ModelMenu` 分到 `LockedModelButton` 或 `RangeMenu`） | 放在别处；锁定时不显示 | 按推荐定的第 3 条 |
| 70 | 去掉 TaskBoard 为挤下顶栏加的收紧：面包屑至少 105px、分屏 ≤ 600px 按钮间距 6px / 图标按钮 28px、≤ 400px 间距 2px / 图标按钮 24px（与 chat.css ≤ 400px 的 28px 冲突） | 留着 | rebase 阶段 |
| 71 | 被拒绝启动时 `/team on`、`/team off` 仍能发（发送组的"不可用"排除它们），排队区的待判断消息、权限菜单的协作模式说明照 TaskBoard | 拒绝启动时一律不能发 | rebase 阶段 |
| 72 | 测试里会话名的下限从 460px 280px / 280px 185px 改成 253px / 168px（`m5-app` 原来 279px 用 167px，最终审查后与 `m6-helpers` 一样用 168px）：顶栏多了协作开关；量到 258 / 173px，余量仍是 5px | 保持原来的下限（会失败）；为了下限把阈值再提高 | rebase 阶段 |
| 73 | TB-53 改成把这一栏调到 601px 和 600px（右栏打开）比阈值的两边；`tb-replay` 的 TB-53 阈值改成 600px | 只查一个宽度 | rebase 阶段 |

### 测试和验证里的做法

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 74 | 合并冲突时两边的意思都留：文档里 TaskBoard 加的"（协作模式：……）"注都挪到新位置；规格 §10 表留 TaskBoard 的"落点"一列，"顶栏只显示"改成"范围按钮只显示" | 选一边 | rebase 阶段 |
| 75 | fixture 不重录：这一步不改后台进程的命令和事件，m1–m7 和 `fixtures/v1/` 的录制内容不变（AGENTS.md 第 2 条的录制一步有意跳过）；`m6-record` 的说明也存在 `fixtures/v1/*.json` 的 `description` 里，没有手改 | 重录 | 设计 |
| 76 | "Extra high"在 v1 里选不到（模型配置不给 pi 需要的映射），280px 的检查用 Medium、High、Minimal；最宽的"Unavailable"在每一档都走 | 手写一个 xhigh 的提供商（v1 之前那次用过） | 测试编写 |
| 77 | "开着范围菜单时来了批准卡"不会发生（生成中范围菜单打不开，卡只在生成中来），改用权限菜单、"Queue"的下拉和圆环详情 | — | 测试编写 |
| 78 | "刚压缩完"的圆环回放里看不到，在 `m1-app`（让 pi 每轮压缩）和 `m1-real` 里查；`m6-app-row` 关掉 pi 的自动压缩（否则颜色测试的小上下文窗口会马上被压缩） | 重录压缩的 fixture | 测试编写 |
| 79 | 几处 synthetic 的做法：经 `window.mori` 的 `session.prompt` 开始生成（不动焦点）；在文字框上派发 Enter（菜单开着时进入准备中）；`models.setDefaults` 不允许任何区域来让拒绝启动卡出现、消失；回放桥的 `failNext`；m2 的 30 条"Allowed for this session"由测试加进页面（假的端点给不出 30 个工具名）；颜色测试用几百 token 上下文窗口的模型；准备中用一个总是回 429 的第二个合成端点 | 用真的点击和按键（会先关掉浮层） | 测试编写 |
| 80 | 分屏的宽度靠拖中线；到了阈值同一边、差 1px 以内算到了，没到算失败 | 改窗口大小（单栏最窄约 300px） | 测试编写 |
| 81 | `m4` 走查 4 拖选前把那一段滚到视野底部（`dragSelect` 的 block 'end'），不改程序；`m4-real` 同样改了 | 改 `BOTTOM_SLACK` 或跟随的规则（程序照规则，没错） | 开发构建全部跑 |
| 82 | 内核：`model-config.json` 和模型档案的改名替换用 board.json 已有的 Windows 重试，挪到新的 `renameRetry.ts` 共用 | 各写一份；只在测试里等 | 开发构建全部跑 |
| 83 | 内核：task 会话中途换模型时，等到 `Date.now()` 真的过了 hideUntil 再写 `mori.task_restart`（`waitPast`） | 多等固定的几毫秒 | 开发构建全部跑 |
| 84 | `mcpConfig.ts`、`main/credentials.ts` 的同步改名替换没有加重试（没有套件因它失败） | 一起加 | 开发构建全部跑 |
| 85 | `tb-app-stop` TB-42 等删除的确认框关上（主进程删完 `teams/<id>` 才返回）再看目录 | 加固定等待 | 开发构建全部跑 |
| 86 | `4b7f5fc` 在本机 amend 过一次，把测试修正和文档说明并进同一个提交（没有推送过） | 另起一个提交 | 开发构建全部跑 |
| 87 | `m0-real`"只连配置的端点"认 `model-config.json` 里每个提供商的地址（v1 启动时读每个已配置模型的服务版本，连 GLM 是对的） | 只认第一个提供商 | 真实模型走查 |
| 88 | `m6-real` 读范围按钮的 `textContent`（innerText 在两个 flex 子项之间加换行，造成假的失败），与测试说明一致 | innerText | 真实模型走查 |
| 89 | `tb-real` 第一遍测试代理记下一次 GLM 的"socket hang up"，重跑，没有改检查（Mori 取消请求也会记成这句，不知道是哪一种） | 放宽这项检查 | 真实模型走查 |
| 90 | `tb-app-roles` TB-03 在打包版里把对照（开发构建的 base）系统提示词里 pi 文档的路径前缀换成打包版的 `resources/app.asar/node_modules/`，其余逐字节比较；打包版按设计少一步 | 另建打包版的对照；打包版跳过 TB-03 | 打包版 |
| 91 | `m1-real` 走查 8 按会话文件照 pi 的 `getContextUsage` 规则判断有没有用量（`usageAfterCompaction`）；models.md"刚压缩完"一行写上这种情形 | 按"最后一项是回复"判断（4 遍里 1 遍误报） | 打包版 |
| 92 | `m1-real` 走查 3 的反例两遍没过（模型把命令写成 `ls does-not-exist-dir; echo "exit=$?"`，以 0 结束），重跑，没有改测试 | 改提示词或检查 | 打包版 |
| 93 | 打包版没有跑 `v1-models-existing.mjs --exe`：它只是用 `--exe` 重跑同样的 m0–m7 App 套件，这些已直接跑过；所以打包版的 MP-37 / TB-46 汇总文件没有写（最终审查后在 `a40910e` 的打包程序上跑了，见第 101 条） | 再跑一遍（约 48 分钟） | 打包版 |
| 94 | 视觉走查：280px 在分屏左栏量（单栏最窄约 300px）；"准备中"截的是有字的（单个"Queue"）；0% 的圆环用 1,000,000 的窗口，50 / 80 / 95% 用按实测 783 token 定的窗口，刚压缩完用另一个开着自动压缩的实例；"Team: Until done"没有截（要有未完成的请求） | — | 视觉走查 |

### 最终审查之后改的（2026-10-22 晚，"composer-pickers: final review fixes"）

最终审查（31 条）里属实的都改了；没有改的两条见表后。

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 95 | 会话面板 ≤ 340px、有 Stop team（协作模式下后台有 Agent）时收起排队的按钮：生成中有字的"Queue ▾"（这一档只剩 ▾）、准备中有字的"Queue"（`chat.css` 的 `.composer-bottom:has(> .stop-team-button)`）；Enter 照样排队、Ctrl+Enter 插话；焦点在收起的按钮上时回到文字框、开着的"Queue"下拉关上（`rowMenu.ts` 新的 `useHiddenFallback`）。不收时 280–295px 一栏最挤超出约 16px（准备中约 20px），收起后最挤 214px | 把 Stop team 收进 ▾ 的菜单（准备中没有 ▾，要另一种做法；鼠标插话能留着）；收起圆环（规格说圆环任何宽度都在） | 审查第 2 条，原"还没处理、等你定的"第 1 条 |
| 96 | 分屏时顶栏右边一组的按钮（协作开关、右栏开关、"Close pane"）用鼠标主键按下时都到点完才切焦点（`ChatPane.tsx` `isTopBarAction`），写进 split.md"右栏开关" | 只给协作开关加；不改 | 审查第 3 条，原"还没处理"第 2 条 |
| 97 | 切换中范围按钮和 Effort 带空的 `aria-description`（没有描述时 Chromium 不再拿 `title` 当描述，Electron 44 里用 CDP 的无障碍树量过：`aria-description=""` 和指向空元素的 `aria-describedby` 都让描述为空，`aria-describedby=""` 不行；名字与 `title` 相同时本来就没有描述）。`m6-app-row` 的切换中检查加上这一条 | 审查建议的把 `title` 挪到外层（会动这一行的直接子项和很多测试读 `title` 的地方） | 审查第 8 条 |
| 98 | `m5-app` 279px 的会话名下限从 167px 改成 168px，与 `m6-helpers` 相同（279px 一栏算出 172px） | 两处都用 167px（放宽） | 审查第 14 条 |
| 99 | `chat.md`、`team-switch.md`、`docs/v1/defaults.md` 里会话名的宽度改成 App 里量到的 307 / 258 / 193 / 173 / 223px | 留着估算的约数 | 审查第 14 条 |
| 100 | 新加的检查：`tb-app-stop` 的 `row` 一步（TB-54：后台有 Agent、对话在回复、输入框有字时，单栏 930–300px 和分屏右栏 296–279px 这一行不溢出，锁定的模型按钮、Stop team 的宽和只有图标、≤ 340px 收起；键盘按 Stop team 后焦点回文字框；新的合成脚本 `tb-stop-row`、`tb-stop-row2`）；`m6-helpers` 认得 Stop team 和 `data-locked`；`m5-app` 的 `teamOther` 和改过的 `closeKeeps`（两栏右栏状态不同时用鼠标点另一栏的协作开关和"Close pane"）；`m2-app` 的 `confirmOnKernelExit`（"Switch to “Allow all”?"开着时后台进程退出）；`m3-app-live` 的 `extCardClosesRow`（扩展的询问卡来了时权限菜单和圆环详情关上，合成扩展加了 `/mori-late`）；`v1-models-existing.mjs` 的 App 套件加上 `m6-app-row` | 不加 | 审查第 7、9、10 条 |
| 101 | 在最后的代码的开发构建上重跑 TB-46 汇总（`v1-models-existing.mjs --id TB-46`），在重新打的包上跑 `--exe`（第 93 条没跑的那一遍），两个覆盖检查的开发和 `--packaged` 四种都要绿。做到了，见"最终审查之后重跑" | 在合并说明里写明两个覆盖检查只因汇总过时是红的 | 审查第 1 条 |
| 102 | 注释和记录说明里剩下的"顶栏"改掉：`modelSession.ts`、`modelTypes.ts`、`roles.ts`、`shared/models.ts` 的注释；`tb-app-models` 的注释和 TB-38 一条记录的说明（编号不变）；`team-stop.md`、`team-blocked.md` 的状态表和旧的"Can't change the model while generating" | 不改 | 审查第 4、5、6 条 |
| 103 | `unit/modelConfig.test.mjs` 里四处 `mkdtempSync` 的临时目录用完删掉（`t.after`），这个文件不再在 `%TEMP%` 留下 `mori-config-*`、`mori-project-*`（`modelLayer`、`modelMigrate`、`modelProfiles` 等别的单元测试仍留下 `mori-layer-*`、`mori-project-*`、`mori-migrate-*`、`mori-profiles-*`，没有改） | 不管 | 审查第 26 条 |
| 104 | 4px 间距时焦点环离按钮 1px 写进 models.md"窄栏"、chat.md"顶栏"和 defaults.md | 只写在 CSS 注释里 | 审查第 11 条 |
| 105 | Stop team ≤ 760px 就只有图标（原来和"Stop"一样 ≤ 600px）：第 100 条新加的 TB-54 检查量出来，带字的 Stop team（约 110px）在 601px 的面板里、生成中有字、"Effort: Unavailable"时把模式名截到不到两个字母，违反"宽于 400px 时不截模式名"；按最挤估算 601–708px 都会这样，760px 留出余量。单栏 TB-54 的宽度加上每条边界的两侧（930、761、760、709、681、680、601、600、461、460、401、400、341、340、300px，第 106 条又加了 521、520px） | 让模式名在这时也能截（改规格）；Stop team 一直只有图标 | 最终审查后跑 `tb-app-stop` 时发现 |
| 106 | 有 Stop team 时"Queue"从 ≤ 520px 起就收起、只留 ▾（没有时是 ≤ 400px）：同样是 TB-54 量出来的，461px、401px 的面板生成中有字时模式名被截；按最挤估算 401–426px、461–482px 都会这样。单栏 TB-54 的宽度再加上 521、520px | Stop team 在 ≤ 520px 收进 ▾ 的菜单（准备中没有 ▾） | 同上 |
| 107 | `m5-real` 走查 2 按 Esc 之前，先数右栏有几条助手消息，等发出后新出现的那一条超过 40 个字（原来用 `querySelector` 加 `:last-of-type`，取到的是走查 1 写 notes.md 那一轮的消息，见"测试中发现并已修正的问题"第 17 条）；只改测试 | 改等待的时长；放宽"只停左栏"的检查 | 中断后的重跑 |

上面第 95、96、97、105、106 条是最终审查之后替你定的界面行为（没选的做法在各行），走查时可以改。

没有改的：
- **"Send"、"Stop"、"Queue"的读屏描述**（审查第 8 条的后半）：Chromium 把 `title` 当描述，"Send (Enter)"、"Stop response (Esc)"、
  "Queue for later (Enter)"比名字多出快捷键或说法，名字和 `title` 完全相同时 Chromium 不给描述；没有状态表不许这样，
  所以不改（改的话要另找地方放快捷键提示）。
- **把 `4b7f5fc` 里的内核修正拆成单独的提交**（审查第 12 条）：要改写已有的提交历史，所以没有拆。合并由发起这一步的会话做，
  请在合并提交的说明里写明"与方案不同"一节最后"合并时要写明的"几项。

## 开工前查的事实

设计时查过的都在 [composer-pickers.md](composer-pickers.md)：装在本机的 Claude 桌面版这一行的样子和字串（"照 Claude 桌面版"）、
现在的按钮宽度和各档按 Segoe UI 字形估的宽度（"宽度估算"）、v1 的选择范围按钮和菜单（"v1 之后的调整"）、TaskBoard 的
协作开关和 Stop team（"TaskBoard 合入之后"），以及 pi 1.3.0 的 `getContextUsage()` 在还没有消息时给 0。这里不重复。

## 交付了什么

| 方案要求（[composer-pickers.md](composer-pickers.md)、状态表） | 实现 |
| --- | --- |
| 顶栏只留"项目名 › 会话名"和这一栏的按钮 | `ChatPane.tsx` `TopBar`：面包屑、协作开关（TaskBoard，右边一组第一个）、右栏开关、分屏时"Close pane"；会话还没打开好时协作开关不可用（`notReady`）。`chat.css`：项目名 160 / 40px、≤ 400px 内边距和 28px 图标按钮、≤ 320px 不显示项目名；去掉为顶栏按钮存在的旧规则 |
| 输入框下面一行：权限、选择范围、Effort、圆环、发送组 | `Composer.tsx`：各项都是 `.composer-bottom` 的直接子项；`PermissionMenu.tsx`（只有文字，悬停两行，不可用时 `aria-disabled`、关菜单和确认框）、`ModelMenu.tsx`（v1 的范围按钮，三行悬停、`model-tip`、`data-pending`、`pick-error` 往上浮出；锁定时 `LockedModelButton`）、`ThinkingMenu.tsx`（`aria-disabled`、两行悬停、`data-pending`）、新的 `UsageRing.tsx`、`rowMenu.ts`（这一行菜单共用：往上打开的位置、Tab 移出、新卡来了、不可用时关、焦点规则）；`menu.ts` 加 `useTabOutClose` |
| 各档的收紧和截短 | `chat.css`、`models.css`：680 / 600 / 460 / 400 / 340px 的 `@container`、`flex-shrink` 1e18 / 1e12 / 1e6 / 1 和最窄宽度、`min-height: 33px`、往上打开和高度上限；有 Stop team 时的三档（最终审查后加）：≤ 760px Stop team 只有图标、≤ 520px 收起"Queue"、≤ 340px 收起排队的按钮；`tokens.css` 的 `--color-warn-text`；4px 间距的两档焦点环离按钮 1px；`split.css` 去掉分屏 ≤ 690px 不显示项目名的规则、改注释 |
| 协作开关和 Stop team（TaskBoard 合入后） | `team.css` 阈值 600px；`TeamSwitch.tsx` 注释；Stop team 是发送组的 `RowButton`；分屏时顶栏右边一组的按钮都到点完才切焦点（`ChatPane.tsx` `isTopBarAction`，最终审查后从只有右栏开关扩大）；`rowMenu.ts` 的 `useHiddenFallback`（排队的按钮因 Stop team 收起时焦点回文字框） |
| 读屏的描述（最终审查后） | `ModelMenu.tsx`、`ThinkingMenu.tsx`：切换中没有描述时带空的 `aria-description` |
| F8 的"Current view" | `IssueDialog.tsx`：Model range、Effort、Pane width |
| 图标 | `icons.tsx` 加 `queue`、去掉只有权限按钮在用的 `shield` |
| 只改注释（"顶栏菜单"→"范围菜单"） | `kernel/commands.ts`、`modelSession.ts`、`selector.ts`、`sessions.ts`、`shared/models.ts`、`state/actionLog.ts`、`actions.ts`、`settings.ts`、`settings/Defaults.tsx`、`state/modelActions.ts` |
| 测试中发现的内核问题 | 新的 `kernel/renameRetry.ts`（`agents.ts` 原有的重试挪过来，`modelConfig.ts`、`modelProfiles.ts` 也用）；`modelSession.ts` 的 `waitPast` |

后台进程没有加命令、没有改事件；`session.setMode`、`session.setPick`、`session.pickOptions`、`session.setThinking` 照旧。
文档：状态表 models.md（重写）、chat.md、approval.md、split.md、layout.md、sessions.md、settings.md、f8.md、
`docs/v0/screens/README.md`；[defaults.md](defaults.md)、[ui-strings.md](ui-strings.md)、`docs/app-v0.md`、`app/README.md`
（`test:m6-app` 的说明、这份记录的状态一行）；v1 的 model-menu.md、model-chat.md、models-settings.md、team-switch.md、
`docs/v1/screens/README.md`、`docs/v1/defaults.md`、`docs/v1/models-checks.md`（走查步骤 2、4、7 的位置）；最终审查后又改了
team-stop.md、team-blocked.md 的位置说法。`docs/specs/model-providers.md`、`docs/proposals/model-providers.md` 里写"顶栏"的
地方只改位置的说法；`docs/specs/parallel-agents-taskboard.md` 改的是 §0（第 42 行）、§5.2、§5.5、§12.1、§12.11、§13.1、§15
和 §17 的验收与测试表（TB-38、TB-53、m6-app-slash / m3-app 两行）：除了位置的说法，还改了一个值——协作开关的窄栏阈值
从 860px 改成 600px（§13.1、§15、TB-53，第 66 条），§17 里 Shift+Tab 的次数写成 6。截图 8 张在 [composer-pickers/](composer-pickers/)。

## 与方案不同、或需要你注意的地方

和 [composer-pickers.md](composer-pickers.md) 的方案不同的地方都在"按推荐定的"里，按出处分：

1. 实现和测试里另定的写法：第 38–54 条（共用的菜单钩子 `rowMenu.ts`、类名、F8 的顺序、新文件 `m6-app-row.mjs` 等）。
2. 静态审查之后改的行为：第 55–65 条（右栏开关点完才切焦点、圆环提示和 Esc、读屏名里的逗号、颜色）。
3. TaskBoard 合入之后的顶栏和这一行：第 66–73 条（协作开关的阈值 860 → 600px、Stop team 在发送组里、锁定的模型按钮）。
4. 测试和验证里的做法：第 74–94 条（fixture 不重录、两处内核修正、几处测试的修正、打包版当时没有跑 `--exe` 汇总）。
5. 最终审查之后改的：第 95–107 条（Stop team ≤ 760px 只有图标、有 Stop team 时 ≤ 520px 收起"Queue"、≤ 340px 收起排队的
   按钮、顶栏右边一组都点完才切焦点、切换中没有描述、新加的检查、`m5-real` 的等待）。
6. 方案的"测试要改的地方"里"Extra high 在 280px"一条做不到（v1 选不到，第 76 条），仍是缺口。

### 合并时要写明的（与这一行无关、一起带进 `app-v0` 的改动）

- **两处内核的竞态修正**（`4b7f5fc`，开发构建全部跑时查出来的，第 82、83 条，"测试中发现并已修正的问题"第 8、9 条）：
  - `app/src/kernel/renameRetry.ts`（新文件）：把 `agents.ts` 里 board.json、AGENTS.md 原有的 Windows 改名替换重试挪出来共用，
    `modelConfig.ts`（`model-config.json`）、`modelProfiles.ts`（模型档案）也改用它。修的是 MP-24：另一个进程开着文件时
    改名替换 EPERM，设置页"Move up"之后马上"Remove"，移除丢了。单元检查：`unit/modelConfig.test.mjs` 的"MP-01 a
    model-config.json held open by another reader for a moment is still replaced"（去掉修正时 EPERM 失败）。
  - `app/src/kernel/modelSession.ts` 的 `waitPast`：task 会话中途换模型时，等 `Date.now()` 真的过了 hideUntil 再写
    `mori.task_restart`、再继续。修的是 TB-39 单元检查偶尔失败（Node 的计时器可能比 `Date.now()` 早到）；检查是 TaskBoard 单元
    里原有的 TB-39。
- **别的范围的测试修正**：`tb-app-stop` TB-42 等删除确认框关上再看目录（`4b7f5fc`，第 85 条）；`tb-app-roles` TB-03 打包版
  系统提示词里 pi 文档的路径（`f8066b2`，第 90 条）；`m0-real`"只连配置的端点"认每个提供商（`c673735`，第 87 条）；
  `m4-app`、`m4-real` 走查 4 拖选前滚到底边（`4b7f5fc`，第 81 条）；`m5-real` 走查 2 的等待（`a40910e`，第 107 条）；
  `unit/modelConfig.test.mjs` 用完删临时目录（`a40910e`，第 103 条）。
- **留给之后的一步**：`mcpConfig.ts`、`main/credentials.ts` 的同步改名替换还没有同样的重试（第 84 条，没有套件因它失败）；
  `m5-replay.mjs` 第 462 行（助手消息）、`m1-real.mjs` 第 184 行（工具卡）有和第 107 条同样的 `querySelector` 加
  `:last-of-type` 写法（取到的不一定是最后一条），没有改，那两处现在没有失败；`m5-real.mjs` 第 66、266 行这一步之前就超过
  120 个字（123、125），也没有改。

## fixture（从真实会话录制）

**有意跳过**（第 75 条，要你认可）：这一步只改界面，后台进程的命令和事件、pi 的事件都没有变，m1–m7 的录制和
`fixtures/v1/`、`fixtures/tb/` 的录制内容不变，回放照常用它们（开发构建上 m1–m7、v1、TaskBoard 的回放都通过）。
回放里看不到的状态（"刚压缩完"的圆环、准备中）改在整机测试和真实走查里查（第 78 条）。`m6-record` 的说明也存在
`fixtures/v1/*.json` 的 `description` 里，没有手改。

## 测试

`app/tests` 下 51 个文件有改动（m0–m7、v1、TaskBoard 的界面测试和 helper，`unit/modelConfig.test.mjs`、
`unit/selector.test.mjs`、合成端点的脚本），其中新增 5 个：`m2-helpers.mjs`、`m6-app-row.mjs`、`m6-app-bands.mjs`、
`v1-models-row-helpers.mjs`、`v1-models-session-setup.mjs`；`package.json` 的 `test:m6-app` 加了 `m6-app-row`。
新加的检查对照 composer-pickers.md"测试要改的地方"的 11 条（顶栏会话名的地方、这一行每档每种状态不换行不溢出、截短的先后、菜单的位置、Tab 移出、键盘和焦点、新卡来了、圆环、F8、
拒绝启动卡的"Change model…"、准备中）。没有删掉检查；删掉的只是方案去掉的行为（盾牌图标、160 / 120px 的上限和 760 / 720px
两档、≤ 660 / 690px 不显示项目名、≤ 500px 藏用量、会话名至少 36px、"Set the permission mode for this session"、
Shift+Tab 8 次、Effort 变淡的颜色比较、读 `.disabled` 判断不可用）。

新加和改得多的测试文件：

| 测试 | 覆盖什么 |
| --- | --- |
| `m6-app-row.mjs`（新） | 这一行的行为：圆环的各状态、悬停和详情、Esc 的顺序、颜色；生成中、切换中（`data-pending`、没有读屏描述）、准备中；菜单往上打开的位置、同时只开一个、Tab 移出、新的批准卡来了时关；按钮消失时焦点回文字框；权限按钮的字和对比度；F8 的三项 |
| `m6-app-bands.mjs`（新，由 `m6-app-slash` 启动） | 各档的边界（单栏 930–300px、分屏 279–681px 的每条边界两侧）、截短的先后、拒绝启动卡、后台进程退出和打开失败时这一行的样子（量的函数在 `m6-helpers.mjs` 的 `paneProblems`） |
| `m6-helpers.mjs`（改） | 顶栏和这一行的量法与规则（`topProblems`、`rowProblems`：几项、宽度、最窄、截短的先后、▾、发送组）；最终审查后认得 Stop team、锁定的模型按钮和 `teamRunning` / `teamTyped` 两种状态 |
| `m2-helpers.mjs`（新） | m2 三个套件共用的读法：这一行的权限按钮和其余几项、往上打开的权限菜单的位置、对比度、F8"Current view"新加的三项 |
| `v1-models-row-helpers.mjs`、`v1-models-session-setup.mjs`（新） | v1 套件里这一行各项、截短和弹出层位置的读法；`v1-models-app-session` 的测试准备（那个文件加了这一行的检查后过了 2000 行，做法不变地挪出来） |
| `m5-app.mjs`（改） | 分屏时顶栏会话名的地方、分屏各栏的这一行和菜单、点另一栏的右栏开关 / 协作开关 / "Close pane"不落空 |
| `tb-app-stop.mjs`（改，最终审查后） | TB-54 `row`：后台有 Agent 时这一行在单栏 930–300px、分屏 296–279px 的样子，键盘按 Stop team 后焦点 |
| `m2-app.mjs`、`m3-app-live.mjs`（改，最终审查后） | "Allow all"确认框在后台进程退出时按取消关上（看确认框关上、焦点回权限按钮、Restart 后仍是"Ask each time"；没有截下发给后台进程的命令）；扩展的询问卡来了时权限菜单和圆环详情关上 |
| `m5-real.mjs`（改，中断后的重跑） | 走查 2 等右栏新出现的回复（第 107 条） |

### 结果

#### 最终审查之后重跑（最后的代码，"composer-pickers: final review fixes"）

程序（`app/src`）最后一处改动在 10-22 16:22；之后开发构建 16:24（`dev-build.log`），打包 18:31–18:33（`npm run dist:dir`，
`dev2-dist.log`），`app.asar` 的 `out/` 与 `app/out/` 327 个文件、14,476,467 字节，SHA-256 全部相同、两边没有多出的文件
（`pkg2-asar-prove.log`）。这之后只改了测试 `m5-real.mjs`（第 107 条）和文档，没有再构建。都是一个接一个跑，日志在本会话草稿
目录 `runs-cp3` 的 `dev-*`（16:24–17:40）、`dev2-*`（17:41–18:33）、`pkg2-*`（18:34–19:40）、`wrap-*`（19:43–20:22）和
`final-*`（提交前的覆盖检查、`npm run check`、单元）。最后一个会话起先把这三样写成了 `fin-*.log`，盖掉了 10-22 08:24 起那一批（`4b7f5fc` 的构建）的
`fin-check.log`、`fin-unit.log`、`fin-cov.log`（那一批的结果还在 `fin-summary.txt`：check 通过、单元 374、覆盖 exit 1），
之后改名为 `final-*`：

| 测试 | 开发构建 | 打包程序（`dist/win-unpacked/Mori.exe`） |
| --- | --- | --- |
| `npm run check`、`npx electron-vite build` | 通过（改 `m5-real.mjs` 之后、提交前又跑了 `npm run check`） | `npm run dist:dir` 通过；`out/` 哈希相同（上面） |
| 静态审查（函数长度、入参、行宽） | 改过的 `src/` 函数都不超过 50 行、5 个入参（解构的一个参数对象算一个）；改动的行（含测试）都不超过 120 个字；改过的测试文件里仍有三个这一步之前就超过 50 行的函数（`page.mjs` `pageHelpers` 147 行、`m6-record.mjs` `installRecorder` 59 行、`m4-app.mjs` `streamingFeedback` 53 行），没有拆 | 同左 |
| 单元 `npm run test:unit` / TaskBoard 单元 `test:tb-unit` | 374 / 327 | 不适用 |
| `v1-models-existing.mjs --id TB-46`（m0–m7 App，现在含 `m6-app-row`；v1 App；开发构建还有单元和全部回放；同时写 MP-37） | exit 0（第二遍；第一遍 m1-app 1 项失败，见"中间几轮"），1 项 KNOWN（#9129） | `--exe` exit 0，1 项 KNOWN（第 93 条当时没跑的那一遍） |
| 其中 `m0-smoke` | 18 项通过，1 项 KNOWN（pi #9129） | 同左 |
| 其中 `m1-app` / `m2-app` / `m3-app` / `m4-app` / `m5-app` | 47 / 93 / 157 / 62 / 55 | 47 / 93 / 157 / 62 / 55 |
| 其中 `m6-app-settings` / `-tools` / `-slash`（含 `m6-app-bands`）/ `-row` / `-mcp-shared` | 60 / 142 / 106 / 45 / 49 | 60 / 142 / 106 / 45 / 49 |
| 其中 `m7-app` | 110 | 110 |
| 其中 `v1-models-app-settings` / `-switch` / `-session` | 141 / 78 / 146 | 141 / 78 / 146 |
| 其中界面回放 m1 / m2 / m3 / m4 / m5 / m6 / m7、`v1-models-replay` | 94 / 110 / 60 / 26 / 26 / 66 / 25、43 | 不适用 |
| `tb-app-roles` / `-modes` / `-flow` / `-ask` / `-handoff` / `-sched` / `-models` / `-stop` / `-misc` | 45 / 58 / 43 / 35 / 55 / 24 / 32 / 46 / 20 | 44 / 58 / 43 / 35 / 55 / 24 / 32 / 46 / 20（`-modes` 是单独重跑的那一遍，见"中间几轮"） |
| `tb-replay` | 55 | 不适用 |
| `m6-mcp-cost` / `m6-pi-config --check` | 5 / 通过 | 5 / 没有跑 |
| `m5-real`（真实模型，改测试之后） | 19 / 19 | 19 / 19 |
| 覆盖检查 `node tests/spec-coverage.mjs` | exit 0："every item is covered on every listed layer" | `--packaged` exit 0 |
| 覆盖检查 `--spec taskboard` | exit 0 | `--packaged` exit 0 |

上表 `m2-app` 93、`m3-app` 157、`m5-app` 55、`tb-app-stop` 46 比审查之前多的是新加的检查（第 100 条）。别的真实走查没有在
最后的代码上重跑（见"未验证"）。

#### 中断和怎样做完的

最终审查是两个审查各写一份（15 条和 16 条，共 31 条；第 95–107 条和"没有改的"是对它们的处理）。做修正的会话 10-22 14:47 开始，
16:22 改完程序，16:24 起依次跑 `dev`、`dev2`、`pkg2` 三批；19:19（打包版那一批跑到 `tb-app-modes` 时）它因网络错误
（API 502）中断，没有提交，也没有把重跑的结果写进这份记录。后台的 `pkg2` 一批照常跑完（19:40）。之后另一个会话
（19:43–20:22）单独重跑了 `tb-app-modes --exe`、两边的 `m5-real`（中间修了第 107 条的测试问题）和两个覆盖检查；最后一个会话
逐条核对了 31 条审查意见在改动里的落实情况，补上这份记录（上表、中间几轮、协调的时间、未验证），跑了 `--packaged` 的两个
覆盖检查、`npm run check` 和单元，提交成"composer-pickers: final review fixes"。中断之后程序没有改，测试只改了 `m5-real.mjs`。

#### 最终审查之前（`8adedda`）

下面这张表是最终审查之前的结果，留作对照。

开发构建一列各数来自哪一个构建（审查第 16 条按日志核对过）：m0–m7 App（m4-app 除外）、m2–m7 回放和
`v1-models-app-switch` / `-session` / `v1-models-replay` 的数，来自 `5b2bcdb` 构建上的单独运行（05:48–06:38，`full-*.log`）；
换成 `4b7f5fc` 的内核（renameRetry、waitPast）后，它们在最后一次 TB-46 汇总（09:52–10:40，`last-*.log`）里以同样的数
又通过一次。在 `4b7f5fc` 上单独跑的是单元、TaskBoard 单元、`v1-models-app-settings`、`m6-app-row`、`tb-*` 和 m4-app（`fix-*`）；
`3a9a669`（焦点环的 CSS 和一处注释）之后重跑的是 m6-app-row、m6-app-slash、m5-app、m3-app、m1-replay（数与之前相同，
`vis-*`）；两个构建的渲染进程的包相同，内核的包差 renameRetry、waitPast 两处。真实走查跑在 `3a9a669` 的构建上；`c673735`、
`f8066b2` 只改测试和文档。打包程序一列是 `c673735` 上打的包（含全部程序改动）。都是一个接一个跑：

| 测试 | 开发构建 | 打包程序（`dist/win-unpacked/Mori.exe`） |
| --- | --- | --- |
| `npm run check`、`npx electron-vite build` | 通过 | `npm run dist:dir`（含 check 和构建）通过；`app.asar` 的 `out/` 与 `app/out/` 327 个文件哈希相同 |
| 静态审查（函数长度、入参、行宽） | 改过的 `src/` 函数都不超过 50 行、5 个入参；`npm run check` 查 `src/` 的行宽；改过的测试文件里还有三个这一步之前就超过 50 行的函数（`page.mjs` `pageHelpers` 147 行、`m6-record.mjs` `installRecorder` 59 行、`m4-app.mjs` `streamingFeedback` 53 行），没有拆 | 同左 |
| 单元 `npm run test:unit` | 374 项通过（多 1 项 MP-01 被别的读者开着时的替换，去掉修正时 EPERM 失败） | 不适用 |
| TaskBoard 单元 `test:tb-unit` | 327 项通过 | 不适用 |
| `m0-smoke` | 18 项通过，1 项 KNOWN（pi #9129） | 同左 |
| `m1-app` / `m2-app` / `m3-app` / `m4-app` / `m5-app` | 47 / 92 / 156 / 62 / 53 | 47 / 92 / 156 / 62 / 53 |
| `m6-app-settings` / `m6-app-tools` / `m6-app-slash`（含 `m6-app-bands`） / `m6-app-mcp-shared` / `m6-app-row` | 60 / 142 / 106 / 49 / 45 | 60 / 142 / 106 / 49 / 45 |
| `m6-mcp-cost` | 没有跑 | 5 |
| `m7-app` | 110 | 110 |
| 界面回放 m1（含 `m1-layout` 的检查）/ m2 / m3 / m4 / m5 / m6 / m7 | 94 / 110 / 60 / 26 / 26 / 66 / 25 | 不适用 |
| `v1-models-app-settings` / `-switch` / `-session` | 141 / 78 / 146 | 141 / 78 / 146 |
| `v1-models-replay` | 43 | 不适用 |
| `tb-app-roles` / `-modes` / `-flow` / `-ask` / `-handoff` / `-sched` / `-models` / `-stop` / `-misc` | 45 / 58 / 43 / 35 / 55 / 24 / 32 / 43 / 20 | 44 / 58 / 43 / 35 / 55 / 24 / 32 / 43 / 20 |
| `tb-replay` | 55 | 不适用 |
| `v1-models-existing.mjs --id TB-46`（这一步之前就有的 m0–m7 App 套件、v1 App、单元、全部回放，同时写 MP-37 的结果；当时还不含新的 `m6-app-row`，也不含 `m6-mcp-cost`） | 2125 项通过，1 项 KNOWN（#9129），1 项失败：它自己的覆盖一步，当时还没有 `v1-models-real.json` | 没有跑（第 93 条） |
| 覆盖检查 `node tests/spec-coverage.mjs` | 开发构建当时 exit 1（只差 MP-27 真实层）；真实走查写出结果之后（写这份记录时重跑）exit 0："every item is covered on every listed layer" | `--packaged` exit 1：只差 MP-37 App（第 93 条） |
| 覆盖检查 `--spec taskboard` | 写这份记录时重跑 exit 1，只差 TB-46 回放：`tb-replay-existing.json` 是在真实层结果写出之前那次 TB-46 汇总写的，里面记着模型层覆盖检查失败（MP-27 真实层）。TB-04 / 08 / 34 / 37 / 45 的真实层现在都有 | `--packaged` exit 1：TB-46 App（第 93 条）和同一格 TB-46 回放 |

上表的数都是一个套件单独跑、以 0 退出的那一遍（TB-46 汇总除外，见表里）。几处要对着 `app/test-results` 看时注意：
`m0-smoke.json`、`m0-real.json` 的文件名不带 `-packaged`，现在存的是打包程序那一遍（target 是 `Mori.exe`），开发构建的
18 + 1 KNOWN 和 7 / 7 只在日志里（`runs-cp3` 的 `full-m0-smoke`、`real-m0-real-2`）；KNOWN 的个数按日志里的 KNOWN 行数，
JSON 的 `known` 标记还标着通过了的模型行为检查（例如 `m3-real.json` 80 项通过、3 项标 known，`m6-real.json` 50 + 6），
所以和这里的数不一样。

### 中间几轮（都已修正，见"测试中发现并已修正的问题"）

| 轮 | 结果 |
| --- | --- |
| 第一轮（`6217bfe` 上的 `b97595f`，10-22 01:30–02:02） | m0 18 + 1 KNOWN、m1-app 47、m2-app 92、m4-app 62、m5-app 50、m6-app-settings 60、m6-app-tools 142、m6-app-mcp-shared 49、m7-app 110，回放 m2 110、m3 60、m4 26、m6 66、m7 25 通过；失败 8 项：m3-app 1（150 / 1）、m6-app-slash 3（103 / 3）、m6-app-row 1（43 / 1）、m1-replay 2（92 / 2）、m5-replay 1（17 / 1）。重跑时 m3-app 156、m6-app-slash 106、m1-replay 94、m5-replay 26；m6-app-row 又两遍 43 / 1（`runs-cp2` 的 s2：`providerRange` 等会话菜单超时；s3：`providerRange` 量到 740px 而不是 600px），第 4 条的两处修正之后第四遍 44 |
| v1 那一轮（10-22 02:37–02:56） | 单元 373、`v1-models-app-settings` 141、`-switch` 78 通过；`-session` 144 / 2（MP-23 469px 一栏，是 App 的右栏开关问题；MP-35 换强度），`v1-models-replay` 42 / 1（注入的错误被算成页面报错） |
| rebase 到 `046a9ca` 之后（10-22 05:00–05:45） | check、build、单元 373 两遍（这几遍来自当时的工作流报告，没有留日志）；m3-app 156、`m3-real` 80 项通过加 2 项 KNOWN（模型行为，`fit-m3-real.log`）、m6-app-slash 106、m6-app-row 45、m5-app 53、`tb-app-roles` 45（第一遍 36 / 2，缺 TB-03 的 base 构建，`tb-build-base.mjs` 建好后通过）、`tb-app-stop` 43、`tb-replay` 55。另有一次只为打印会话名宽度的 m5-app `--only` 部分运行，里面 `longSource` 点引用芯片超时失败；完整的 m5-app 那一遍和之后每一遍都通过，这个部分运行没有再跑 |
| 开发构建全部跑（10-22 05:48–10:40） | m4-app 5 遍里 3 遍 59 / 3（流式输出时拖选选中上一行）；`tb-unit` 一遍 326 / 1（TB-39）；`v1-models-app-settings` 在一次 TB-46 汇总里 127 / 2（MP-24 EPERM）；`tb-app-stop` 在最后的构建上一遍 42 / 1（TB-42 看得太早）。修正后：m4-app 单独 3 遍和最后一次汇总都通过，`tb-unit` 连续 6 遍 327（日志只留了 `full3`、`fin` 两遍，另外四遍来自工作流报告），`v1-models-app-settings` 141，`tb-app-stop` 43 |
| 最终审查后的修正（10-22 15:37–16:21，`rev1`–`rev5`） | `m6-app-row` 45、`m2-app` 93、`m3-app` 157 第一遍就通过。`m5-app` 53 / 2、54 / 1：新加的 `teamOther` 结束时两栏右栏的状态和原来不同，后面的 `divider`、`crampedRight` 量错（改成回到 `toggleOther` 结束时的样子、等右栏出现），第三遍 55。`tb-app-stop` 新的 TB-54 四遍没过（45 / 1、37 / 2、37 / 5、45 / 1）：第一遍量出 601px 时带字的 Stop team 把模式名截掉（改成第 105 条）；第二遍窗口窄于 1024px 时左栏是图标栏、右键菜单打不开（量分屏前先把窗口放回 1200 宽）；第三遍拆开量法后，关掉一栏时焦点还没落定就按 Stop team、出错后没停下这个会话的 Agent，后面的步骤跟着失败（等焦点落定，出错时也按 Stop team）；第四遍量出 461px、401px 截模式名（改成第 106 条）；第五遍 46 |
| 最后的代码，开发构建（16:24–17:40，`dev`） | TB-46 汇总第一遍 exit 1：`m1-app` 46 / 1，"主进程被强行结束时不留下 Mori 的进程"把一个 hdc.exe（PID 16020，10-22 00:37 起就在运行，不是 Mori 起的）和一个 conhost.exe 算成了残留的子孙进程：hdc.exe 记着的父进程 PID 35524 早已不在，按 PID 的父子关系往下找时撞上了被重用的 PID。没有改测试，整个汇总重跑一遍（`dev2`）通过；所以两个覆盖检查在 `dev` 那一批里 exit 1、在 `dev2` 里 exit 0 |
| 最后的代码，打包程序（18:34–19:40，`pkg2`） | `tb-app-modes --exe` 52 项通过之后，重启那一步 Playwright 报"Process failed to launch!"，exit 1；19:43 单独重跑 58 / 0。查过没有留下的 Mori、Electron 进程，主进程没有单实例锁、也不会提前退出；为什么在那一批里起不来没有查到 |
| 真实走查重跑（19:43–20:22，`wrap`） | `m5-real` 开发构建 19 / 0；打包程序 18 / 1：走查 2"在左栏按 Esc 只停左栏"失败（左栏没有"Stopped"，右栏已经写完），是测试的问题（第 107 条，"测试中发现并已修正的问题"第 17 条）；改测试后开发构建、打包程序各 19 / 0 |

开发构建全部跑那一段，起头时一个跑套件的脚本在它的监视结束后还在跑，和两次 m4 探测、一次 m4-app 重跑、下一批的开头
（`tb-unit`、`tb-app-roles` / `-modes` / `-flow`）有一段重叠，那几遍不算"一个接一个"；它们后来都单独重跑过，
在最后的构建上又跑过一遍，上表的数都来自单独跑的那几遍。

### 真实模型走查

开发构建和打包程序各一遍，一个接一个，对你数据里的 DeepSeek 和 GLM（`m0-real` 用 `scratchUserData` 复制的临时副本）。
截图看过：这一行的选择、圆环、发送 / 停止的位置、窄栏、后台进程退出、协作模式都和状态表一致。

| 走查 | 开发构建 | 打包程序 | 说明 |
| --- | --- | --- | --- |
| `m0-real` | 7 / 7 | 7 / 7 | 开发构建第一遍 6 / 1："只连配置的端点"看到连 198.18.0.93（api.z.ai，也配置了的 GLM），测试只认第一个提供商；改测试（第 87 条）后通过 |
| `m1-real` | 40 项通过，1 项 KNOWN | 40 项通过，1 项 KNOWN | 300px 时这一行照规格截短：模型 36px、模式名截断、Effort 完整。打包版跑了 4 遍：第 1 遍走查 8 失败（第 91 条），第 2、3 遍走查 3 的反例失败（第 92 条），第 4 遍全过；改测试后开发构建重跑 40 + 1 KNOWN。KNOWN 是这次看没看到刚压缩完的圆环 |
| `m2-real` | 39 / 39 | 39 / 39 | 批准卡在这一行上方；"Allow all"确认框；只有文字的警示色"Allow all"；F8 |
| `m3-real` | 82 项通过，1 项 KNOWN | 同左 | Shift+Tab 不超过 6 次，第一步"Toggle changes"、第二步"Team: …"；KNOWN 是模型行为（重新打开后 DeepSeek 不列出 `project_hello`），Mori 这边的检查通过 |
| `m4-real` | 16 / 16 | 16 / 16 | 拖选的已知时机问题没有出现。`test-results/m4-real/4-error.png` 是 10-21 留下的（还是旧的顶栏），这个脚本现在不写它 |
| `m5-real` | 19 / 19 | 19 / 19 | 右栏打开的分屏约 280px 一栏："Ask e…"、"rea…"、"Unavailable"、圆环、发送图标，一行放得下。开发构建完整的 19 / 19 之后又单独跑过一次走查 1（`--only 1`，4 / 4，没有留日志，原因没有记下，可能是重截截图），`test-results/m5-real.json` 当时只存着那 4 项；最终审查之后两边都在最后的代码上完整重跑（19 / 19，见"最终审查之后重跑"），现在的 JSON 是完整的那一遍 |
| `m6-real` | 56 / 56 | 56 / 56 | 开发构建第一遍 55 / 1（innerText，第 88 条）。范围菜单从这一行往上打开、Effort 菜单、分屏一栏里换范围后下一条回复来自新模型 |
| `m7-real` | 27 / 27 | 27 / 27 | F8 导出里有 Model range、Effort、Pane width |
| `v1-models-real` | 11 / 11 | 11 / 11 | 你的数据里有能用的 GLM（`glm/GLM-5.3`），MP-27 完整跑了：回复开始时和回复中途真的 401 时换模型，重启后回到第一选择 |
| `tb-real`（`MORI_APP_DIR=.tb-runs/real`，`tb-build.mjs real` 构建） | 24 / 24 | 24 / 24 | 开发构建第一遍 23 / 1（第 89 条），重跑通过；打包版第一遍通过。协作模式的截图：锁定的范围按钮、这一行的"Stop team"和"Stop"、输入框上方的后台批准卡 |

### 视觉走查

开发构建、合成端点，截图看了一遍：会话面板 930、861、860、761、680、600、460、400、340、300px（窄于 740px 时右栏打开）、
分屏左栏 280px 和 1184×735 的分屏；空闲、生成中有字、准备中有字、拒绝启动、"Allow all"、"Effort: Unavailable"
（空闲和生成中有字）、圆环 0 / 50 / 80 / 95%、刚压缩完；930 和 300px 时打开权限、范围、Effort 菜单、"Queue"的 ▾ 和圆环详情；
930、460、400、300px 时 Tab 过这一行和顶栏看焦点环；协作开关"Team: Off"每个宽度、"Team: On" 930–300px。
152 个样本用 `m6-helpers` 的 `paneProblems` 量过（`shots-idle.log` 和 `shots-rest.log` 144 个，`shots-fix.log` 8 个
"Team: On"），除了截图脚本自己标错的两处（拒绝启动时分屏右栏也被拒绝启动，脚本按空闲查；协作模式下范围按钮是锁定的样子，
当时量的函数不认识，最终审查后 `m6-helpers` 认得了）都没有问题；菜单的位置量了 20 处（空闲 8 处、其余 4 处，焦点环修正后
重截空闲的 8 处），都对。（这里原来写的"161 个样本、18 处"数错了：161 是两个 JSON 里全部不是焦点和报错的记录，还含 12 条
菜单位置和 5 条圆环读数；18 是菜单截图的张数，拒绝启动时的 menu-model-930 / 300 盖掉了空闲的两张。）

对照规格和 Claude 的输入框那一行：任何宽度都一行；截短的先后是说明 → 范围 → 模式名 → Effort；圆环 < 75% 强调色、75–89%
较深的警示色、≥ 90% 危险色，刚压缩完是虚线；菜单都往上打开、在面板里、不盖顶栏，对齐照规格；协作开关宽于 600px 完整文字，
≤ 600px 只有状态点，会话名总是拿剩下的地方。改了焦点环（"测试中发现并已修正的问题"第 13 条）；改后重跑 m6-app-row 45、
m6-app-slash 106、m5-app 53、m3-app 156、m1-replay 94，都通过。

放进文档的 8 张（[composer-pickers/](composer-pickers/)，合成端点，没有 key 和个人信息，焦点环修正之前截的，里面都没有焦点环）：

| 文件 | 内容 |
| --- | --- |
| [idle-930.png](composer-pickers/idle-930.png) | 930px 空闲：顶栏"项目名 › 会话名"、"Team: Off"、右栏开关；这一行权限在左，范围、"Effort: Medium"、圆环、"Send"在右 |
| [generating-draft-unavailable-280.png](composer-pickers/generating-draft-unavailable-280.png) | 分屏 280px、生成中有字、"Unavailable"（最挤）：模式名、范围、Effort 都截到接近最窄，圆环、▾、"Stop"完整 |
| [generating-draft-split-1184x735.png](composer-pickers/generating-draft-split-1184x735.png) | 1184×735 分屏，左栏生成中有字（发送组只有图标），右栏空闲 |
| [preparing-draft-400.png](composer-pickers/preparing-draft-400.png) | 400px 准备中有字：单个"Queue"图标按钮（不收起）和"Stop" |
| [blocked-460.png](composer-pickers/blocked-460.png) | 460px 拒绝启动：输入框上方的卡，这一行没有 Effort，"Send"不可用 |
| [allow-all-300.png](composer-pickers/allow-all-300.png) | 300px "Allow all"：警示色的模式名，顶栏的协作开关只有状态点 |
| [range-menu-300.png](composer-pickers/range-menu-300.png) | 300px 范围菜单往上打开、收在这一行的宽度里 |
| [rings-930.png](composer-pickers/rings-930.png) | 930px 圆环 0% / 50% / 80% / 95% / 刚压缩完（五张截图里这一段拼在一起，放大 2 倍） |

全部截图和量的数在本会话的草稿目录（`runs-cp3\shots\`、`shots-idle.json`、`shots-rest.json`），不提交。

### 打包版

`npm run dist:dir` 之后逐个文件比较 `dist/win-unpacked/resources/app.asar` 里的 `out/` 和 `app/out/`：327 个文件、
14,474,018 字节，SHA-256 全部相同，两边都没有多出的文件（清单 `e1a74ffb…`）；提交之后又比了一次，`out/` 没有变（这一次没有留日志）。
对 `Mori.exe`（`--exe`，从 Bash 传正斜杠路径）跑了上表"打包程序"一列的全部 App 套件和全部真实走查。程序没有改；改的是两处测试的
预期（第 90、91 条）。这是 TaskBoard 的 App 套件第一次跑 `--exe`（[../v1/team-checks.md](../v1/team-checks.md) 第 119 行还写着
只跑过开发构建，那份是 TaskBoard 的记录，没有改，打包版的结果记在这里）。

## 测试中发现并已修正的问题

1. **分屏时点另一栏的"Toggle changes"会点空**（v1 那一轮 `v1-models-app-session` 的"MP-23 469px pane"失败查出来的，
   这一步之前就有）：一栏按下鼠标时就把焦点切到这一栏，另一栏开着右栏、这一栏没开时，右栏先换成这一栏的状态（关上）、
   两栏变宽，开关从约 x 800 移到约 x 1180，松开时已经不在鼠标下面，这一下丢了（469 = (1200 − 260) / 2 − 1）。第一版修正
   取消 mousedown、点完用脚本 `focus()`；审查指出这会让鼠标点完出现焦点环、右键和"按下在别处松开"也不再切焦点，改成第 55 条
   的做法（`ChatPane.tsx` `isRightToggle`）。`m5-app` 新加 `toggleOther`：用鼠标点另一栏的开关一下（焦点切过去、右栏开着并
   列出这一栏的改动、两栏宽度不变）、键盘按两下 Enter、右键按下就切，开发构建和打包程序都通过；`v1-models-app-session`
   的 279px 一栏也通过。协作开关和"Close pane"在同一组、会被同样挤动，当时没有加同样的处理；最终审查后改了（第 96 条）。
2. **本轮结束时"Stop"被重用成"Send"**（实现时的探测发现）：焦点留在变成不可用的"Send"上、掉到 body；给两个按钮各自的 key，
   焦点回到文字框。
3. **v1 之前那次实现里发现、带进现在代码的两处**（`rowMenu.ts`、`UsageRing.tsx` 取自那次）：批准卡理由框里打字时按 Esc 关
   "Queue"的下拉会把焦点拿走（第 49 条）；键盘焦点显示的圆环提示盖住文字框底部、挡住点击（第 48 条）。
4. **第一轮的 8 项失败，都是测试的问题**：Playwright 1.64 把 `aria-disabled="true"` 的按钮当成不可点，`click()` 等 30 秒
   （改成 `force` 点击，另加 `elementFromPoint` 命中检查，免得点在盖住的按钮上也算过）；按钮消失后焦点下一帧才回文字框
   （等最多 1 秒）；`split-approvals` 的 fixture 里两栏的批准卡是先后来的，不会同时有两张；Effort 的最窄宽度在外层
   `.thinking-switch` 上，字放得下时按钮本身可以更窄；测试用的长模型 id 在任何宽度都被 200px 上限截，不是被挤；
   `ringNoBlock` 按 Ctrl+N 后没等新会话打开好；窗口窄于 1024px 时左栏变成图标栏、会话行藏起，`providerRange` 拿不到右键菜单
   （600px 改在右栏打开时量）。
5. **v1 那一轮另两项测试的问题**：换强度时 `data-level` 先变，`chooseThinking` 没等 `data-pending` 消失就返回；
   回放故意让 `session.setPick` 失败两次，App 每次照规定记一条错误日志，被算成页面报错（改成每次注入只扣掉那一条）。
6. **静态审查（spec、规则、测试三个角度，30 条）**：除第 55–65 条外，还改了 `v1-models-replay` `watchPane` 里同名的两个键
   （后一个盖掉前一个，C1 的按钮状态没记下来）、新加分屏的准备中 279 / 280px 和单栏 740 / 490 / 370 / 321 / 320px、
   `providerRange` 核对真的到了声称的宽度、MP-23 强制点击前加命中检查、m1-replay 的报错只扣注入的那几条、最窄宽度一律量在
   这一行的直接子项上、`chooseModel` / `chooseThinking` 等切换完、原生 `disabled` 算问题、`placeAll` 记下没打开的浮层、
   `fitPane` 宽于 760px 时先回到 1200 宽窗口、`pageHelpers` 从 169 行缩到 147 行（仍超过 50 行，之前就超）。
7. **TaskBoard 合入之后顶栏挤**：TaskBoard 为挤下协作开关加的收紧在新顶栏里不需要了，还与 chat.css 冲突，去掉并重调阈值
   （第 66–73 条）；Shift+Tab 从 9 次变成 6 次，三个套件跟着改。
8. **MP-24 在设置里移除一个 key 后又出现**（开发构建全部跑时一次汇总里失败，截图是 `EPERM: operation not permitted, rename
   model-config.json.<uuid>.tmp -> model-config.json`）：Windows 上另一个进程开着文件时改名替换失败，"Move up"之后马上
   "Remove"，移除丢了。改用重试（第 82 条）；新的单元检查去掉修正时 EPERM 失败、加上时通过。
9. **TB-39 单元检查偶尔失败**：Node 的计时器可能比 `Date.now()` 早到（草稿里量过 3000 次里 10 次），`mori.task_restart.at`
   会等于前半段最后一条消息的时间、那一条没被藏起；改成 `waitPast`（第 83 条），之后连续 6 遍通过。
10. **m4 走查 4 生成中拖选，5 遍里 3 遍选中上一行**：这一行让对话流矮了一点，把那一段滚到中间后它下面只剩约 23px
    （`BOTTOM_SLACK` 24px），对话流照规则恢复跟随，量好坐标到按下鼠标之间流入一行，字被推上去一行（每行 28 个汉字）。
    程序没改，测试改滚到底边（第 81 条）。原因来自一次探测量到的 23px 和选区偏移的算术，没有在失败的那一遍里埋点记录。
11. **TB-42 删除会话后 `teams/<id>` 还在**：会话文件删掉时侧栏那一行就没了，测试在这时看目录，主进程还没删完（第 85 条）；
    失败那一遍留下的目录属于没保存的 stopprep 会话，删除本身是对的。
12. **`TeamSwitch.tsx` 的过时注释**："不宽于 860px""模型、思考强度、权限按钮之前"改成 600px 和"右栏开关之前"。
13. **4px 间距时焦点环压到旁边的按钮**（视觉走查）：全局焦点环是离按钮 2px 的 2px 线，伸出 4px；这一行 ≤ 460px、顶栏 ≤ 400px
    时按钮间距只有 4px，环碰到旁边的按钮，后面的按钮还盖住一截（圆环的环被"Send"盖住右边）。这两档里焦点环离按钮 1px
    （`chat.css`），两边各留 1px，实心的"Send"环和按钮之间仍有白缝；460、400、300px 放大截图确认过。
14. **真实走查的两处测试问题**：`m0-real` 只认第一个提供商（第 87 条）；`m6-real` 用 innerText（第 88 条）。
15. **打包版的两处测试问题**：TB-03 拿打包版的系统提示词和开发构建逐字节比，pi 写进去的自己文档的路径两边差 111 个字
    （第 90 条）；`m1-real` 走查 8 在 pi 去掉被截断的回复、没有可压缩的时候误报（第 91 条）。
16. **设计阶段的审查**：设计在实现前经过三轮审查（照 Claude 桌面版、17 条宽度和读屏的问题、v1 合入后的 15 条），都改在
    composer-pickers.md 里，那里记着每轮改了什么。
17. **`m5-real` 走查 2 等错了消息**（打包程序那一遍失败）：按 Esc 之前等"右栏的回复超过 40 个字"，选择器
    `.pane-slot[data-side="right"] [data-testid="assistant"]:last-of-type` 取到的是右栏里第一条不是一轮结尾的助手消息，即走查 1
    写 notes.md 那一轮；那一遍它没有思考，只有约 22 个字，这一等跑满 120 秒，左栏 37 秒的命令早已跑完，Esc 没有可停的。
    证据：截图 1-both 到 2-f8 隔了 163 秒（120 秒超时加两次 20 秒的等空闲）；草稿目录里加了记录的副本量到匹配的就是那条消息
    （带 142 字的思考时 179 个字），同一个副本里左栏在 Esc 之后 500 毫秒内停下，所以 App 的 Esc 和焦点是对的。改成先数右栏的
    助手消息，等新出现的那一条超过 40 个字（第 107 条）。同一检查里还有一个小的时间差没有改：它在等左栏空闲（最多 20 秒）
    之后才看右栏是否还在生成，只在加了 500 毫秒停顿的副本里看到过，真实的几遍里没有出现。
18. **最终审查后新加的 TB-54 量出来的两处**：带字的 Stop team 在 601–708px、有 Stop team 时 401–426px 和 461–482px 的面板里，
    生成中有字、"Effort: Unavailable"时模式名被截到一两个字母，违反"宽于 400px 时不截模式名"；改成第 105、106 条。

## 和别的会话的协调

同时在这台机器上的还有 v1 模型层（"unified provider"）、v1 界面文字跟术语表（string-polish）、TaskBoard 三个会话和一个
看着所有会话的会话。界面测试用固定端口（4319–4371、4500–4559；TaskBoard 自己的在 4600–4699），所以约定轮流跑。

| 时刻（−04:00） | 事 | 这一步怎样做 |
| --- | --- | --- |
| 10-21 18:37 | v1 会话要把 v1 合进 `app-v0`，请 2–4 小时内不要跑 m0–m7 | 停下正在实现的工作流（还没跑任何套件），把写到一半、针对旧模型菜单的代码停在 `composer-pickers-wip-prev1`（`d21ff35`），`composer-pickers` 回到设计提交；同时只读地对照 v1 改设计（得出第 1–16 条） |
| 10-21 22:29 | v1 合入 `app-v0`（`6a57fd4`），端口空出 | rebase 到 `6a57fd4`（`34384ef`），套用设计的改动、审查后提交 `caaa166`（即现在的 `9a7e8f9`） |
| 10-21 22:47–23:54 | 约定的顺序：TaskBoard → string-polish → 这一步；TaskBoard 跑 TB-46，string-polish 合入 `2e67197` | 这段时间先审查、提交改过的设计（23:30），之后写实现和测试（不占固定端口；实现和核对用的探测脚本连 4701–4715 的合成端点） |
| 10-21 23:55、10-22 00:20 | TaskBoard 请在顶栏给协作开关留位置：会话名后面、右栏开关前面；后合并的一方重算会话名的宽度、重调档位。它的临时收紧都在 team.css | 写进 composer-pickers.md"给 TaskBoard 留的位置"和 chat.md；顶栏右边一组（`.topbar-actions`）本来就是一个容器 |
| 10-22 00:14 | v1-glossary-settings 合入 `app-v0`（`6217bfe`，里面已有 `2e67197`） | — |
| 10-22 00:20–00:27 | TaskBoard 用 10 分钟跑 m3-app、m5-app、m6-app-slash | 等它 |
| 10-22 01:21–01:29 | 提交实现（`c3ba82d`），直接 rebase 到 `6217bfe`（01:26，`02fd4ef`），再 amend 成 `b97595f`（01:29） | 通知 TaskBoard 后开始第一轮（固定端口） |
| 10-22 02:57 | TaskBoard 要 2 小时跑完整的 TB-46 | 停下工作流（第一轮和 v1 那一轮已经跑完），把端口交给它；这段时间只做静态的诊断、审查和修正（不起 Electron） |
| 10-22 03:45 | TaskBoard 因负载失败一项，要再 2 小时干净地重跑 | 同意，继续静态工作 |
| 10-22 04:27 | TaskBoard 跑完，端口空出 | — |
| 10-22 04:32（04:35 收到通知） | TaskBoard 合入 `app-v0`（`046a9ca`）并推送（它的负责人要求的）；看着所有会话的会话也提醒 rebase 的目标是 `046a9ca` | 04:42 先提交第一轮和静态审查的修正（`073cafc`），04:45–04:57 rebase 到 `046a9ca`（成为 `797bbf6`），按约定把协作开关放进顶栏、重调阈值和宽度（05:45 `5b2bcdb`，第 66–73 条） |
| 10-22 04:35 以后 | 这台机器上的测试端口都归这一步（其他会话同意） | 之后的全部套件、视觉、真实走查、打包版、最终审查后的重跑仍一个接一个跑 |

时刻按 `git reflog`（`app-v0` 和 `composer-pickers`）核对过；收到通知的时刻（18:37、22:47、23:55、00:20、02:57、03:45、04:27、
04:35）来自当时的消息，reflog 里没有。之后这一步自己的提交：08:44 `d77971f`，09:52 amend 成 `4b7f5fc`（第 86 条），
11:25 `3a9a669`，12:05 `c673735`，13:52 `f8066b2`，14:17 `8adedda`。

## 你走查时看的（建议的步骤）

1. 1200 宽窗口打开一个会话：顶栏只有"项目名 › 会话名"、"Team: Off"、右栏开关；输入框下面一行左端权限，右边范围、Effort、
   圆环、"Send"。
2. 打开分屏，拖中线到一栏约 280px：两栏顶栏的会话名都还看得见一段，项目名不显示；这一行生成中有字时模式名、范围、Effort 截到
   接近最窄（"Ask e…"之类），圆环、▾、"Stop"完整。
3. 发一条消息看圆环：悬停"Context ≈ … / … (N%)"，点开是详情，Esc 先关详情；空会话是空圆环、"Send a message to see context usage."。
4. 点范围、Effort、权限按钮：菜单都往上打开、在这一栏里、不盖顶栏；生成中范围和 Effort 不可用、悬停说原因。
5. 分屏、一栏右栏开着另一栏关着时，用鼠标点另一栏的右栏开关、协作开关、"Close pane"：都是一下就成。
6. 协作模式下让后台有 Agent：一栏窄于 760px 时 Stop team 只有图标；生成中打字时，窄于 520px 的一栏只剩 ▾（菜单里有
   "Queue for later"），分屏约 280px 的一栏里 ▾ 也收起，只有 Stop team 和"Stop"，Enter 照样排队、Ctrl+Enter 插话。
7. F8："Current view"里有 Model range、Effort、Pane width。

## 还没处理、等你定的

- **跳过的 fixture 录制**（第 75 条）：AGENTS.md 第 2 条的完成顺序里有"从真实会话录 fixture"，这一步有意跳过（后台进程的命令和
  事件没有变，原有的录制照常回放）。按 AGENTS.md"缺一步不算完成"，要你认可这样做。
- **≤ 340px 有 Stop team 时收起排队的按钮**（第 95 条，最终审查后按推荐定的）：这时只能用 Enter 排队、Ctrl+Enter 插话，没有
  点的按钮；想在最窄时也能用鼠标插话，可以改成把 Stop team 收进 ▾ 的菜单（准备中另想办法）。
- **pi 去掉被截断的回复、又没有可压缩的时候**（打包版的 `m1-real` 看到的）：上下文很小时，pi 把因长度截断的回复（stopReason
  `length`，输出没到 maxTokens）用 `context_edit` 从上下文去掉、准备压缩后重试；没有可压缩的就不重试、也不发事件。这条回复
  留在对话流里，没有任何说明，下一条消息时模型看不到它。这是 pi 的行为，这一步之前就有，要不要提示等你定。
- 600px 一栏里协作开关只剩状态点，哪怕会话名还放得下"Team: Off"（第 67 条）；用量很少时圆环几乎看不见，50% 时有点像加载中的
  转圈（第 26 条为了对比度选的）；准备中、生成中不可用的范围按钮和 Effort 字很淡（462px 分屏生成中有字时范围按钮只剩"fa…"，
  是 461–600px 一档最挤时的样子）。
- 一些 12px 的字对比度不到 4.5:1，是这一步之前就有的颜色（第 64 条）。
- [composer-pickers.md](composer-pickers.md)"待你决定"一节：截短的顺序和最窄宽度、≤ 400px 收起"Queue"和 ≤ 340px 收小、
  悬停加全名一行、几处为了对比度改的颜色，以及上面"按推荐定的"全部。

## 未验证

- **你的走查**（这一步的，以及还没签收的 M2–M7、英文界面）。
- **最终审查的修正之后，真实模型走查只重走了 `m5-real`**：`m0-real` 到 `m4-real`、`m6-real`、`m7-real`、`v1-models-real`、
  `tb-real` 开发构建跑在 `3a9a669` 的构建上、打包程序跑在 `c673735` 上打的包上（两者的程序代码都与 `8adedda` 相同），
  没有在最后的代码上重跑。最终审查改了这一行的行为（Stop team ≤ 760px 只有图标、有 Stop team 时 ≤ 520px 和 ≤ 340px
  收起排队的按钮、顶栏右边一组点完才切焦点、切换中带空的 `aria-description`），这些只由合成端点的整机测试在两种构建上测过；
  `tb-real` 的协作模式截图是改之前的样子。
- **只能用手看的几项**（静态审查后的待验证清单列的，测试只覆盖了其中能自动查的部分）：鼠标点"Toggle changes"之后没有焦点环、
  按下拖出开关再松开时这一栏才得到焦点（视觉走查只看了 Tab 到的焦点环）；鼠标停在圆环上、焦点在文字框时按 Esc 停止生成并藏起
  提示，以及分屏时另一栏悬停的情况；范围菜单每一项的读屏名和描述，以及"Send"、"Stop"、"Queue"的描述，要在 DevTools 的
  无障碍面板里看（切换中两个按钮没有描述是在 Electron 44 里用 CDP 的无障碍树量过的写法，App 里只由 `m6-app-row` 核对属性）；
  空圆环悬停时的底色。"Switch to “Allow all”?"开着时后台进程退出的情形最终审查后由 `m2-app` 的 `confirmOnKernelExit` 测了。
- **一键导出安装包**（`build-installer.cmd`，NSIS 安装包）没有用这一步的代码跑；打包只做了 `dist:dir`。TB-03 的路径修正没有对
  NSIS 装到别的位置的程序检查过（它假定 pi 在 `<exe 所在目录>/resources/app.asar/node_modules` 下，与 `dist:dir` 一致）。
- `m0-real --setup`（交互的首次启动）没有跑，`m0-real` 用的是临时副本。
- 深色模式没有看；原生的 `title` 悬停提示截不到图，只由测试核对了文字；"Team: Until done"没有截图；没有打开 Claude 桌面版截图对照。
- 只在合成端点的整机测试里测过、真实走查没有走到的：扩展的询问卡来了时关这一行的菜单（最终审查后 `m3-app-live` 测了权限菜单和
  圆环详情）；"Extra high"在 280px（v1 选不到，第 76 条，仍是缺口）；换范围失败的 `pick-error` 只在回放里出现过（开发构建触发不了）；
  ≤ 340px 有 Stop team 时收起排队的按钮（`tb-app-stop` 的 TB-54，`tb-real` 没有走到窄栏）。Stop team 出现、焦点正好在
  "Queue ▾"上时焦点回文字框（`useHiddenFallback`）没有测试走到：要在后台 Agent 开始的那一刻焦点在 ▾ 上，时机凑不出来。
- "pi 在还没有消息时给 0"（composer-pickers.md"没有验证的"）没有在真实会话里记过，没有哪个真实走查看空的圆环。
- `m6-pi-config --check` 只在开发构建上跑了（最终审查后），打包版没有；`m6-mcp-cost` 最终审查后两边都跑了（各 5 项）。
- 打包版那一批里 `tb-app-modes --exe` 在重启一步"Process failed to launch!"的原因没有查到（单独重跑通过，见"中间几轮"）；
  开发构建第一遍 TB-46 汇总里 `m1-app` 的残留进程检查被重用的 PID 误报（同上），检查本身没有改，以后还可能这样误报。
- 切换中两个按钮没有读屏描述，是在单独的 Electron 44 页面里用 CDP 的无障碍树量的写法；App 里 `m6-app-row` 只核对了属性
  （没有 `aria-describedby`、`aria-description` 为空），没有在 App 里读无障碍树。
- `m1-real` 走查 3 的反例看模型怎样写命令，打包版 4 遍里 2 遍没过（第 92 条），仍是会偶尔失败的检查；可以把它标成 KNOWN
  （模型行为）或把提示词写死命令，等你定。
- `tb-real` 第一遍那次 GLM"socket hang up"的原因（上游断开还是 Mori 取消了请求）不知道，重跑没有再出现。
- m4 拖选问题的原因是推算的（见第 10 条），修正后 4 遍都通过，失败率原来是 5 遍里 3 遍。
- `mcpConfig.ts`、`main/credentials.ts` 的同步改名替换仍没有重试（第 84 条）。
- 打包版和视觉走查清理临时目录时，视觉走查用的通配符可能也删掉了更早几轮留在 `%TEMP%` 的合成端点运行目录（没有你的数据）；
  更早会话留下的 `mori-v1-real-data-*`、`mori-v1-real-*`、`mori-tb-real-*` 还在 `%TEMP%`。这一步打包版真实走查留下的四个项目目录
  （`mori-v1-real-kcigMV`、`mori-tb-real-ask-Zy2mXw`、`mori-tb-real-team-sg0TIV`、`mori-tb-real-approval-UBUs1Z`，只有
  `project/`，没有数据副本）原来漏删了，最终审查后做修正的会话删了（提交之后核对过，四个都已不在）。`unit/modelConfig.test.mjs`
  以前每跑一次留下几个 `mori-config-*` 目录（现在 `%TEMP%` 里有 231 个，审查意见里写的"几千个"数错了），
  最终审查后改成用完就删（第 103 条），已经留下的没有删。
- **最终审查之后的重跑又在 `%TEMP%` 留下 566 个 `mori-*` 目录**（10-22 14:47 以后建的：各套件的合成数据目录、项目目录和
  单元测试的 `mori-team-*`、`mori-migrate-*`、`mori-profiles-*`、`mori-layer-*` 等；名字里没有 `real`，`m5-real` 只把你的数据
  当 `--source`，没有留下副本）。最后一个会话要删它们时被自动模式的权限拦下，**没有删**；清单在本会话草稿目录的
  `todelete.txt`，要你或之后的会话删。同一时段 `%TEMP%` 里还有不是 Mori 测试建的目录（`mori-dbg-*`、`spec04-*`、
  `har-gui-sdk-*` 等），不在清单里。清单是 20:33 写的；之后提交前跑的单元（20:44）又留下 25 个（`mori-layer-*` 5 个、
  `mori-migrate-*` 11 个、`mori-profiles-*` 8 个、`mori-project-*` 1 个，第 103 条之外的单元测试建的），也不在清单里。
- 真实走查时自动模式的分类器拦下了一条会列出 `credentials.json` 里引用名（不含值）的命令，没有换别的办法去看，脚本照常自己处理
  副本里的 key。
- `docs/v1/team-checks.md` 第 119 行仍写着 TaskBoard 的 App 和真实套件没有跑过 `--exe`（是 TaskBoard 的记录，没有改）。

## 合入 v1-memory（origin/app-v0 54f0758）之后

2026-10-22 至 10-23，分支 `app-v0-sync`（worktree `nifty-fermi-f01b04`），从本机 `app-v0` 的 `1212474`（这一步合入之后）开出。

**为什么**：负责人要提交、合并并推送；这时 `origin/app-v0` 已经前进到 `54f0758`（v1-memory：提示词拆分和记忆，
同样在 `046a9ca` 上合入），与本机的 `app-v0` 分叉，两边都改了 36 个文件，不能直接推送。于是在新分支上把
`origin/app-v0` 合进来，两边的功能都保留。提交：`ba08acf`（合并）、`fe975ea`（把 v1-memory 放进这一行的布局）、
`8cf3860`（合并后的修正）和这份记录。`1212474` 和 `54f0758` 都是它们的祖先，`app-v0` 可以快进；快进和推送由发起
这一步的会话做，这里没有推送，也没有碰主 checkout。

**冲突和怎样解决**：

- `ChatPane.tsx`：保留这一步的开头说明，加上记忆的新会话提示；保留记忆的 import，去掉 `ContextUsage`（上下文用量
  在 `Composer.tsx`）。`IssueDialog.tsx`：import 合成 `uiIssues`（`View`、`issuesChanged`、`openIssues`）加 Effort 用的
  `Tab`、`THINKING_LABELS`；设置页、记忆页、Customize 页上"Pane width"为"None"。`icons.tsx`：`queue` 和 `memory` 都留；
  `state/settings.ts`：`showSettingsSection` 和"范围菜单"的说法都留。
- 文档（`app/README.md`、`docs/app-v0.md`、model-providers.md、f8.md、ui-strings.md）逐行保留两边；f8.md 是这一步的
  字段表加 v1 的"Review 变成 Memory"。
- `m2-app`：留 v1-memory 的"View in Settings"检查和这一步的 `{ ...input, facts }` 字段检查。`m4-helpers` / `m4-app`：
  两边各修了生成中拖选的同一个时序问题，合并后第五个参数是 `block`（`false` 时不滚），`m4-app` 用 v1-memory 的
  `selectWhileStreaming`，`m4-real` 照旧传 `'end'`。`tb-app-roles`（TB-03）：v1-memory 的 `comparable`（去掉 memory
  工具、身份段和记忆分节）套在这一步的 `baseSystem(ctx)`（打包版的安装位置）外面，改名了一个遮住同名函数的局部变量。
  `v1-models-existing` 去掉 `m7-app`、保留 `m6-app-row`；`v1-models-record` 合并开头说明。
- m7 的测试文件（v1-memory 随工作回顾删了，这一步改过）照删。这一步加在 `m7-app.mjs` 的 F8"Current view"检查移到
  `mem-app-settings.mjs`：会话里存的报告一条（`m2-helpers.mjs` 的 `paneFacts` / `f8ViewProblems`），设置页 UI issues、
  记忆页、Customize 页上"Pane width: None"（新的 `offPaneViewProblems`，代替工作回顾页上的那条）。`m7-replay`、
  `m7-real` 的同类检查由 `m2-replay`、`m5-replay`、`m2-real`、`m5-real` 覆盖（会话里按的；`m2-real` 另有设置页上
  "Pane width: None"），没有另外移。

**另外的调整**：memory.md §9.1、§10.4 和 memory-enhance.md 里在"顶栏"的范围、Effort 改成输入框下面一行，§14.4 记下
移过来的检查（`fe975ea`）。v1-memory 没有往顶栏、这一行或 F8 加东西，Tab / Shift+Tab 的次数不变，ui-strings.md 没有要加的
词。`app/package-lock.json` 没有变，不用 `npm ci`。合并后第一遍 `mem-replay` 的 MEM-17（"off then on again … the status
line uses the saved time"）失败：fixture 里下次运行的时刻是内核按录制机器的时区（UTC+8）算的，回放按这台机器的时区
（America/New_York）显示成 22:44，不是保存的 10:44；`origin/app-v0` 自己的构建上同样失败（在临时 worktree 里查的，已删），
与合并无关。在测试的根上改（`8cf3860`）：`mem-record.mjs` 把录制机器的 IANA 时区写进 fixture 的 `timeZone`；
`mem-replay` 用它设页面（CDP `Emulation.setTimezoneOverride`）和自己预期的文字（`process.env.TZ`，
`mem-replay-helpers.mjs` 新的 `useZone`），没有 `timeZone` 的 fixture 照旧用本机时区；用合并后的构建重录了
`mem-settings.json`（38 步，顺序不变，只有临时路径、id、时刻不同）；memory.md §14.1 注明。检查没有放宽。

**开发构建的结果**（合成端点；一个接一个跑，日志在会话草稿目录 `runs-sync/`）：

- 合并后第一遍（`fe975ea` 的构建）：`npm run check`、`electron-vite build` 通过；单元 374、TaskBoard 单元 329、记忆单元
  222；`mem-app-settings` 83（v1-memory 的 80 加移过来的 3 条）、`mem-app-prompt` 46、`mem-app-tool` 54、`mem-app-page` 104、
  `mem-app-enhance-a` 75、`mem-app-enhance-b` 30、`mem-app-team` 50、`m2-app` 94、`m4-app` 62、`m6-app-settings` 60、
  `m6-app-row` 45、`tb-app-roles` 45、`tb-app-flow` 43；回放 `m2-replay` 110、`m4-replay` 27、`tb-replay` 53 全部通过；
  `mem-replay` 61 / 62（MEM-17，见上）。
- `8cf3860` 上重新 `electron-vite build` 后的全部一遍（修正只改测试，没有再构建）：`npm run check` 通过；单元 374、
  TaskBoard 单元 329、记忆单元 222；7 个 `mem-app` 套件同上（46、54、104、75、30、50、83）；`mem-replay` 62 / 62（另用
  `TZ=Asia/Shanghai` 跑 `--only mem-settings,mem-enhance` 模拟负责人的 UTC+8 机器，18 / 18）。
- 汇总 `v1-models-existing --id TB-46` exit 0：`m0-smoke` 18 加 1 项 KNOWN（pi #9129 留下的 sleep 进程，不计入退出码）、
  `m1-app` 47、`m2-app` 94、`m3-app` 157、`m4-app` 62、`m5-app` 55、`m6-app-settings` 60、`m6-app-tools` 142、
  `m6-app-slash` 106、`m6-app-row` 45、`m6-app-mcp-shared` 49、`v1-models-app-settings` 141、`v1-models-app-switch` 78、
  `v1-models-app-session` 146、单元 374、m1–m6 回放 94 / 110 / 60 / 27 / 26 / 66、`v1-models-replay` 43、覆盖检查 exit 0。
- 汇总 `--id MEM-35`（v1-memory 自己的汇总，含 TB-46 的全部）exit 0：同上的套件和数（`m0-smoke` 同一项 KNOWN），加
  `tb-app-roles` 45、`tb-app-modes` 58、`tb-app-flow` 43、`tb-app-ask` 35、`tb-app-handoff` 55、`tb-app-sched` 24、
  `tb-app-models` 32、`tb-app-stop` 46、`tb-app-misc` 20、TaskBoard 单元 329、`tb-replay` 53，两个覆盖检查 exit 0。
  `tb-build-base` 没有重建（`.tb-runs/base` 已有，固定的 `2e67197`）。
- 覆盖检查：模型层和 `--spec taskboard` 不带 `--allow-missing-real` exit 0；`--spec memory --allow-missing-real` exit 0
  （package.json 的 `test:memory` 和记忆规格在这台机器上就这样跑），不带这个参数 exit 1，只缺真实层（没有
  `mem-real.json`，例如 MEM-34）。

**打包版（冒烟）**：在 `8cf3860` 的代码上 `npm run dist:dir`（其中 `npm run check` 通过；electron-builder 26.17.0）。
逐个文件比较 `dist/win-unpacked/resources/app.asar` 里的 `out/` 和 `app/out/`：327 个文件、14,713,691 字节，SHA-256
全部相同，两边都没有多出的文件（清单 `d6dc72f8…`）。`--exe dist/win-unpacked/Mori.exe`：`m0-smoke` 18 加 1 项 KNOWN
（pi #9129，同开发构建）exit 0，`m1-app` 47 / 47。`git diff 1212474 HEAD` 里 v1-memory 改了主进程和 preload：
`main/review.ts` 换成 `main/issues.ts`（设置页 UI issues 的列出、截图、导出、在资源管理器里选中、打开文件夹）、
`main/index.ts` 注册它、`main/feedback.ts`（注释、一个类型标注、`feedbackDir` 不再导出，行为不变）、`preload/index.ts`
（工作回顾的接口换成 UI issues 的）；`app/package.json` 只改了 scripts（去掉 `test:m7-*`，加 `test:mem-unit`、
`test:memory`），`electron-builder.yml` 没有改。所以另用 `--exe` 跑了用到这几处的 App 套件，全部通过：
`mem-app-settings` 83 / 83（UI issues 页走 `issues.ts` 和 preload 的新接口；设置页、记忆页、Customize 页和会话里的 F8）、
`m2-app` 94 / 94（F8 截图、保存、在资源管理器里选中，`feedback.ts`）、`m4-app` 62 / 62（保存对内容的反馈，
`mori:save-feedback`）、`mem-app-enhance-a` 75 / 75（主进程存的反馈由内核从 `<userData>/feedback` 读作增强的依据，
MEM-27、MEM-19）。程序没有改。按负责人 2026-10-23 的新测试做法，打包版只做冒烟（打包和主进程没改时只跑 `m0-smoke`、
`m1-app`；这次主进程改了，所以加了上面四个），**完整的打包版一遍跳过了**：其余 App 套件没有跑 `--exe`，打包程序上的
真实走查也没有跑。

**没有重跑的**：真实模型走查。这一步合并前跑过 m0–m7 的 `*-real`、`v1-models-real`、`tb-real`（见上面"真实模型走查"
和"未验证"），合并后没有在开发构建或打包程序上再走。v1-memory 那边其实**没有跑过**真实模型：
[../v1/memory-checks.md](../v1/memory-checks.md) 记着它的机器没有带 key 的数据目录，`mem-real.mjs` 写好了、没有对真实端点
跑过（只跑过改成合成端点的副本，26 / 26），模型层和 TaskBoard 的真实层也没有重跑；所以"两边都跑过真实走查"只对这一步成立，
记忆的真实层（MEM-05、MEM-10、MEM-22、MEM-34）至今没有人跑过。m7 的套件已删；一键导出安装包（`build-installer.cmd`，NSIS）
没有跑。

**没有验证的**：

- 记忆规格的真实层：没有 `mem-real.json`（见上），覆盖检查只能带 `--allow-missing-real` 过；模型层和 TaskBoard 的
  真实层用的是 `test-results` 里这一步合并前留下的 `v1-models-real.json`、`tb-real.json`。合并后的代码（提示词拆分、
  记忆工具、身份段）没有对真实模型跑过。
- 其余五个 mem fixture 还没有 `timeZone`，回放时用本机时区；在 New York 和 `Asia/Shanghai` 下都通过，要写进时区得重录。
- 移到 `mem-app-settings` 的 3 条 F8 检查没有 MEM 编号，记忆规格的覆盖检查把它们列为不计入。
- `tb-app-roles` 比对的基线 `.tb-runs/base` 是之前建的，没有重建。
- 上面"未验证"一节里这一步自己的各项，合并没有改变。

## 合入一键拉取模型（ab57183）之后：两处测试的时序

2026-10-24，分支 `claude/distracted-liskov-473288`，从 `app-v0` 的 `ab57183` 开出。只改了测试（`m6-app-bands.mjs`、`m6-helpers.mjs`），
程序没有改。[../v1/discovery-checks.md](../v1/discovery-checks.md)"合并到 app-v0"记着 `m6-app-slash` 的两条失败；
两条的原因都在测试怎么等，不是一键拉取模型带来的：

- "280px、生成中有字、Effort "High""：`waitRunningAt` 把发送中（`data-sending`）也算作开始生成，`layoutReport` 量到的是
  发送中的单个"Queue"（`Composer.tsx` 的 `SendGroup`），没有 ▾"More send options"。现在等开始只认 `data-running="true"`，
  等结束仍要生成和发送都结束。量"生成中有字"和"生成中"的三处（`bandTyped`、`bandSingle`、`bandEffort`）都用它，一起改好了。
- "拒绝启动：从文字框 Tab 依次是权限 → 范围 → 圆环"：会话树的"Open in split view"（`SessionTree.tsx` 的
  `sessionAction`）在菜单关上之后才调 `focusComposer()`。它先等一帧，浮层还没退出时最多再等 5 帧，锁屏时帧被节流，
  晚得更多。`splitOpen` 原来不等它，于是晚到的聚焦把焦点从权限按钮拉回文字框。现在 `splitOpen` 等右栏就绪之后，
  再等焦点落进焦点所在一栏的文字框，然后再等两帧。所有调用它的地方都因此不受影响：`ensureSplit`、`bandBlocked`、
  `m6-app-slash` 的 `splitLayout`、`m6-app-row` 的 `prepSplit` 和 `providerRange`、`m6-real` 的走查 8。

**结果**（开发构建，合成端点，一个接一个跑，开始和结束时都没有锁屏（没有 `LogonUI`））：`npm run check`、build、`test:unit` 372
都通过；`m6-app-slash` 连续三遍 106 / 106（每遍约 3.3 分钟）；`m1-app` 47 / 47，其中"复制代码"那条在屏幕解锁时通过，
锁屏时剪贴板为空的情况与 [english-ui-checks.md](english-ui-checks.md) 记的相同；`m6-app-row` 45 / 45。按测试分层只跑了
第 1、2 层。完整回归、打包版和真实模型走查没有跑，因为只改了测试的等待，模型看到的和做的都没变。

**没验证**：没有在锁屏时重跑。原来的两条失败都出现在锁屏时；现在的等待在锁屏时只会更久，不会更早结束，但没有实测。

**一并查到的**：一次只读审查确认这两处修正没有问题，每个修正一位审查者，每条发现再由一位审查者尝试驳倒。审查还发现
`m5-app.mjs` 的 `splitRows`、`splitRight`、`effortAt280` 等的是 `.stop-button`。这个按钮在发送中也会出现，三处接着都按
"生成中"量，属于同一类时序问题，锁屏时可能偶发失败（还没有看到它失败过）。负责人随后让一起改：`m5-helpers.mjs` 新加
`waitPaneRunning`（只认 `data-running="true"`），三处改用它；`waitPaneIdle` 的第一步也改用它，行为不变。之后 `npm run check`、
build、`test:unit` 372 通过，`m5-app` 55 / 55，`m6-replay` 66 / 66（它也用 `waitPaneIdle`），屏幕没锁。

**推送前的完整回归**（AGENTS.md 测试分层第 3 条，开发构建，2026-10-24，没有锁屏）：`npm run check`、build、`test:md-unit` 197，
`md-app-form` 82、`md-app-card` 68、`md-app-firstrun` 114、`md-replay` 69，都通过；`v1-models-existing.mjs --id MD-15`
（m0–m6、`v1-models-*`、`tb-*`、`mem-*` 的 App 套件，各回放、单元、覆盖检查与标记检查）3582 项通过、1 项 KNOWN（pi #9129），
只有 `m5-app` 一项失败（54 / 55），汇总和覆盖检查里的另外 10 条失败都是它连带的：

- "分屏 280px、生成中有字：…Esc 回到 ▾…"：Esc 之后焦点在 body 上，不在 ▾"More send options"上（Tab 的路径、菜单的
  第一项和 ↓ 之后的一项都对）。之后在同一个构建上把 `m5-app` 交替跑了 6 遍：这个分支的测试 3 遍都是 55 / 55；
  `ab57183` 的 `m5-app.mjs`、`m5-helpers.mjs` 3 遍里 2 遍失败在"Effort 是"Medium"和"Minimal""（就是上面修的那类），
  Esc 这条 6 遍都没有再出现。一次只读分析（三个角度各一位，再由一位逐条核实）确认它与这个分支的两次提交无关：ba5f24e
  只改 m6 的文件，`m5-app` 不导入它们；e03daf0 只让 `splitRows` 开始量的时刻晚到真的在生成，离 Esc 还有整轮宽度的扫描和
  `popoverChecks`，Esc 那一刻两种写法的状态相同。原因没有查到（可信度低）：正常的 Esc 路径同步地把焦点放回 ▾；要落到 body，
  ▾ 当时必须不可用或已卸载（它用真的 `disabled`，别的三个按钮用 `aria-disabled`），或者有一次落在不能获得焦点处的点击，
  这次的数据里都看不到。没有改测试，也没有改程序。下一次失败时，在 `queueForLater` 的细节里记下焦点所在的一栏、这一栏的
  `data-running` / `data-sending`、▾ 是否还在、是否 `disabled`，以及拒绝启动卡，就能分清。另一个可做的是在 `useRowMenu`
  的 `dismiss` 之后，焦点没落到按钮上时回到文字框（models.md"不可用或按钮消失时"）；这是程序的改动，没有做。
