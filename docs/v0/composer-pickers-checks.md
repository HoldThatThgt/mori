# composer-pickers 检查记录（模型、Effort、权限和上下文用量移到输入框下面一行）

日期：2026-10-21 至 2026-10-22（下面的时刻都是 git 提交用的 −04:00）。机器：Windows 11（10.0.28000），Node 24.19.0；
Electron 44.9.0；pi 1.3.0；electron-builder 26.17.0；playwright-core 1.64.1。
分支 `composer-pickers`，基于 `app-v0` 的 `046a9ca`（v1-taskboard 合入之后；本机和 origin 的 `app-v0` 都是它），
9 个提交：`cde2f24`（状态表和方案）、`9a7e8f9`（设计改到 v1 的选择范围按钮上）、`09f10bb`（实现和测试）、
`797bbf6`（第一轮测试和静态审查后的修正）、`5b2bcdb`（顶栏放下协作开关）、`4b7f5fc`（开发构建全部套件跑下来后的修正）、
`3a9a669`（视觉走查的修正）、`c673735`（真实模型走查的修正）、`f8066b2`（打包版的修正），加上这份记录的提交。
设计说明在 [composer-pickers.md](composer-pickers.md)（为什么、宽度怎样估的、每处按推荐定的），这里记做了什么、测了什么、
哪里和方案不同、还有什么没验证。分支没有推送，也没有合并进 `app-v0`（合并由发起这一步的会话在最后做）。

## 状态

按 AGENTS.md 的完成顺序：状态表（`cde2f24`，[screens/models.md](screens/models.md)、[chat.md](screens/chat.md)、
[approval.md](screens/approval.md) 等）→ 从真实会话录 fixture（**有意跳过**：这一步不改后台进程的命令和事件，
回放用的 fixture 内容不变，m1–m7 和 `fixtures/v1/` 都没有重录，见"按推荐定的"第 75 条）→ 界面测试 → 实现 →
用真实模型走一遍（DeepSeek 和 GLM，开发构建和打包程序各一遍）→ 你走查。只差你走查。
M2–M7 和英文界面的走查也还没签收（[english-ui-checks.md](english-ui-checks.md)"状态"）；这一步改了它们走查要看的几处：
模型（v1 的选择范围按钮）、Effort、权限按钮不在顶栏了，在输入框里文字框下面那一行；上下文用量从"Context 12%"变成
Effort 后面的小圆环；顶栏只有"项目名 › 会话名"、协作开关、右栏开关（分屏时还有"Close pane"）；
从文字框 Shift+Tab 回会话树是 6 次（M6 记的是 8 次，TaskBoard 合入后是 9 次）。
真实端点是你在 Mori 里加密保存的那一份数据（`%TEMP%\mori-real-data`，DeepSeek 和 GLM 两个提供商）；只作 `--source`，
要 `--user-data` 的脚本用 `tests/ui/lib.mjs` 的 `scratchUserData` 复制出来的临时副本，跑完已删除；没有读取、打印或解密 key。

结果一览（一个套件接一个跑；哪些跑在哪一个构建上见"测试"的"结果"）：

- 合成端点的整机测试（m0–m7、v1 模型层、TaskBoard）开发构建 1660 项、打包程序 1664 项（多一个 `m6-mcp-cost` 5 项，
  `tb-app-roles` 打包版按设计少 1 项），全部通过，两边各有 1 项 KNOWN（pi #9129）；
- 界面回放 505 项（m1–m7 407、v1 43、TaskBoard 55）、单元 374 项、TaskBoard 单元 327 项，开发构建上全部通过；
- 真实模型走查（m0–m7、`v1-models-real`、`tb-real`）开发构建和打包程序各 321 项全部通过，各 2 项 KNOWN
  （`m1-real` 刚压缩完的圆环看没看到、`m3-real` 的模型行为）；几项要重跑或改了测试才过，见"测试"；
- 打包程序 `app.asar` 里的 `out/` 与 `app/out/` 327 个文件 SHA-256 全部相同；
- 覆盖检查：模型层规格（`node tests/spec-coverage.mjs`）开发构建 exit 0；TaskBoard 规格还差一格（TB-46 回放），
  是一份在真实层结果写出之前生成的汇总文件过时了，见"未验证"。

## 你决定的（2026-10-21）

| 问题 | 你的回答 | 现在的做法 |
| --- | --- | --- |
| 分屏一栏约 460px 时会话名被挤到约 2 个字符（英文界面走查时提的） | 把模型、Effort、权限按钮从顶栏移到输入框下面一行，像 Claude 桌面版 | 输入框里文字框下面那一行（原来只有发送 / 停止的 `.composer-bottom`）：左端权限按钮，右边选择范围按钮、Effort、上下文用量圆环，最右发送 / 停止 / 排队；顶栏只留"项目名 › 会话名"和这一栏的按钮。460px 的分屏一栏里会话名从 36px 变成 258px（有协作开关时实测） |
| Effort 放在哪 | 仍是单独一个按钮（不像 Claude 那样放进模型菜单） | `ThinkingMenu.tsx` 的按钮和菜单不变，搬进这一行 |
| 上下文用量 | 改成模型按钮旁边的小圆环（像 Claude） | 新组件 `UsageRing.tsx`：14px 的环，顺序是模型、Effort、圆环，然后是发送组；悬停"Context ≈ 15.4k / 128k (12%)"，读屏名"Usage: Context approximately 15,360 of 128,000 tokens (12%)"，点开是 Claude 那样的详情 |
| 权限按钮 | 只有文字（"Ask each time ▾" / "Allow all ▾"），不选"只留图标"；窄时模式名截断，即使模型按钮因此更挤 | 任何宽度都没有盾牌图标；放不下时模式名截断加"…"，全名在悬停第一行和读屏名里；"Allow all"保留警示色（文字改深一点，见第 36、59 条） |
| 怎样往下做（2026-10-21 晚） | 不用等你，每处选推荐的做法、在最后的报告里列出来，你之后再看；做完合并进 `app-v0` | 每处选择都列在下面"按推荐定的"；分支做完、验证完，由发起这一步的会话合并（这份记录写下时还没合并） |

[composer-pickers.md](composer-pickers.md)"负责人的决定"记着同样的几条；由此定下的临时默认值登记在 [defaults.md](defaults.md)。

## 照 Claude 桌面版

用词和样子照装在本机的 Claude 桌面版（英文字串表 `ion-en-US.json` 的键，见 composer-pickers.md"照 Claude 桌面版"一表）：
这一行的顺序（左端模式选择，靠右模型、用量圆环，最右发送）、只有文字的模式按钮、圆环的悬停和详情（"Context window"、
"Send a message to see context usage."）、"Queue for later"、"More send options"、"Applies to this session only"。
借用了 Claude 别处的字串的地方（"Permission mode: {mode}" 是 Claude 定时任务卡片上的一行，"Set the effort level for this
session" 和"Change the permission mode"是 /effort、/permissions 命令的说明）也记在那张表里。没有打开 Claude 截图对照
（见"未验证"）。

## 按推荐定的（负责人以后看）

你不在时每处有几种做法的，都选了推荐的那一种。下面是全部：v1 合入之后的 16 条、原设计我自己定的、实现和测试里另定的、
审查后改的、TaskBoard 合入后的，以及各阶段报告里与方案不同的地方。"出处"指 composer-pickers.md 的小节，或做这件事的阶段。

### v1 合入之后（composer-pickers.md"v1 之后的调整"最后一节）

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 1 | 选择范围按钮任何宽度最长 200px，去掉"≤ 760px 最长 120px"那一档 | 保留 160 / 120px（分组、提供商范围在 800 宽单栏和所有分屏里几乎只剩范围名）；不设上限（很长时这一行看起来全是它） | W1 |
| 2 | 范围按钮的悬停三行：按钮文字 / "<提供商名> · <区域>" / 不可用的原因 | 两行，原因顶掉提供商和区域（生成中看不到发到哪个区域） | H1 |
| 3 | 读屏名用 v1 的"Model range: <按钮文字>" | Claude 的"Model: {name}"（按钮显示的不一定是一个模型） | T1-A |
| 4 | 准备中、生成中不能换的原因用"Can’t switch models until the response finishes"（v1 合入 app-v0 时已是这句，代码、规格 §9.2、测试常量一致） | 草稿推荐的规格原句"Can’t change the model while generating" | T2 |
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
| 53 | 新加的 `m6-app-row.mjs`（`m6-app-settings` 已过 2000 行）加进 `package.json` 的 `test:m6-app`，端口 4364、4365 | 塞进已有文件 | 测试编写、核对 |
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
| 65 | 切换中范围按钮和 Effort 没有 `aria-describedby`，Chromium 可能把 `title` 当描述；"Send"等的描述可能和名字重复。静态看不出，没有改 | 把 `title` 挪到外层；接受并改状态表 | 审查第 24 条 |

### TaskBoard 合入之后（composer-pickers.md"TaskBoard 合入之后"）

| # | 定了什么 | 没选的做法 | 出处 |
| --- | --- | --- | --- |
| 66 | 协作开关窄栏的阈值从 860px 降到 600px：宽于 600px 完整文字，≤ 600px 只有状态点（与发送组只剩图标是同一档）。实测"Team: Until done" 105.1px、状态点 19px，601px 一栏完整文字时会话名约 315px，和 1280 宽分屏只有状态点时（307px）差不多 | 规格原稿的"Team ●"（约 55px，窄栏会话名再少约 36px）；不设阈值（280px 一栏会话名只剩约 90px）；保留 860px | 按推荐定的第 1 条 |
| 67 | 协作开关按这一栏的宽度收成状态点，不看会话名放不放得下（600px 一栏里这个会话名其实还放得下"Team: Off"） | 量会话名决定（要脚本） | 视觉走查 |
| 68 | Stop team 是发送组里的一项（发送组的 `RowButton`，在"Stop"或"Send"前面），≤ 600px 只有图标，`data-testid="stop-team"` 不变；按钮消失时焦点回文字框 | 保持带字的按钮（≤ 600px 时这一行更挤，400px 以下放不下） | 按推荐定的第 2 条 |
| 69 | 协作模式下锁定的模型按钮（`pickLocked`，规格 §12.11）放在这一行原来模型按钮的位置，同样的截短规则（`ModelMenu` 分到 `LockedModelButton` 或 `RangeMenu`） | 放在别处；锁定时不显示 | 按推荐定的第 3 条 |
| 70 | 去掉 TaskBoard 为挤下顶栏加的收紧：面包屑至少 105px、分屏 ≤ 600px 按钮间距 6px / 图标按钮 28px、≤ 400px 间距 2px / 图标按钮 24px（与 chat.css ≤ 400px 的 28px 冲突） | 留着 | rebase 阶段 |
| 71 | 被拒绝启动时 `/team on`、`/team off` 仍能发（发送组的"不可用"排除它们），排队区的待判断消息、权限菜单的协作模式说明照 TaskBoard | 拒绝启动时一律不能发 | rebase 阶段 |
| 72 | 测试里会话名的下限从 460px 280px / 280px 185px 改成 253px / 168px（279px 167px）：顶栏多了协作开关；量到 258 / 173px，余量仍是 5px | 保持原来的下限（会失败）；为了下限把阈值再提高 | rebase 阶段 |
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
| 93 | 打包版没有跑 `v1-models-existing.mjs --exe`：它只是用 `--exe` 重跑同样的 m0–m7 App 套件，这些已直接跑过；所以打包版的 MP-37 / TB-46 汇总文件没有写 | 再跑一遍（约 48 分钟） | 打包版 |
| 94 | 视觉走查：280px 在分屏左栏量（单栏最窄约 300px）；"准备中"截的是有字的（单个"Queue"）；0% 的圆环用 1,000,000 的窗口，50 / 80 / 95% 用按实测 783 token 定的窗口，刚压缩完用另一个开着自动压缩的实例；"Team: Until done"没有截（要有未完成的请求） | — | 视觉走查 |

## 和别的会话的协调

同时在这台机器上的还有 v1 模型层（"unified provider"）、v1 界面文字跟术语表（string-polish）、TaskBoard 三个会话和一个
看着所有会话的会话。界面测试用固定端口（4319–4371、4500–4559；TaskBoard 自己的在 4600–4699），所以约定轮流跑。

| 时刻（−04:00） | 事 | 这一步怎样做 |
| --- | --- | --- |
| 10-21 18:37 | v1 会话要把 v1 合进 `app-v0`，请 2–4 小时内不要跑 m0–m7 | 停下正在实现的工作流（还没跑任何套件），把写到一半、针对旧模型菜单的代码停在 `composer-pickers-wip-prev1`（`d21ff35`），`composer-pickers` 回到设计提交；同时只读地对照 v1 改设计（得出第 1–16 条） |
| 10-21 22:29 | v1 合入 `app-v0`（`6a57fd4`），端口空出 | rebase 到 `6a57fd4`（`34384ef`），套用设计的改动、审查后提交 `caaa166`（即现在的 `9a7e8f9`） |
| 10-21 22:47–23:54 | 约定的顺序：TaskBoard → string-polish → 这一步；TaskBoard 跑 TB-46，string-polish 合入 `2e67197` | 这段时间先审查、提交改过的设计（23:30），之后写实现和测试（不占固定端口；实现和核对用的探测脚本连 4701–4715 的合成端点） |
| 10-21 23:55、10-22 00:20 | TaskBoard 请在顶栏给协作开关留位置：会话名后面、右栏开关前面；后合并的一方重算会话名的宽度、重调档位。它的临时收紧都在 team.css | 写进 composer-pickers.md"给 TaskBoard 留的位置"和 chat.md；顶栏右边一组（`.topbar-actions`）本来就是一个容器 |
| 10-22 00:20–00:27 | TaskBoard 用 10 分钟跑 m3-app、m5-app、m6-app-slash | 等它 |
| 10-22 01:21–01:29 | 提交实现（`c3ba82d`），开始 rebase 到 `2e67197`；rebase 中途 `app-v0` 又到了 `6217bfe`（v1-glossary-settings），在 `6217bfe` 上做完（`b97595f`）；`2e67197` 没有单独 rebase，它在 `6217bfe` 里 | 通知 TaskBoard 后开始第一轮（固定端口） |
| 10-22 02:57 | TaskBoard 要 2 小时跑完整的 TB-46 | 停下工作流（第一轮和 v1 那一轮已经跑完），把端口交给它；这段时间只做静态的诊断、审查和修正（不起 Electron） |
| 10-22 03:45 | TaskBoard 因负载失败一项，要再 2 小时干净地重跑 | 同意，继续静态工作 |
| 10-22 04:27 | TaskBoard 跑完，端口空出 | — |
| 10-22 04:35 | TaskBoard 合入 `app-v0`（`046a9ca`）并推送（它的负责人要求的）；看着所有会话的会话也提醒 rebase 的目标是 `046a9ca` | rebase 到 `046a9ca`（`797bbf6`），按约定把协作开关放进顶栏、重调阈值和宽度（`5b2bcdb`，第 66–73 条） |
| 10-22 04:35 以后 | 这台机器上的测试端口都归这一步（其他会话同意） | 之后的全部套件、视觉、真实走查、打包版仍一个接一个跑 |

## 交付了什么

| 方案要求（[composer-pickers.md](composer-pickers.md)、状态表） | 实现 |
| --- | --- |
| 顶栏只留"项目名 › 会话名"和这一栏的按钮 | `ChatPane.tsx` `TopBar`：面包屑、协作开关（TaskBoard，右边一组第一个）、右栏开关、分屏时"Close pane"；会话还没打开好时协作开关不可用（`notReady`）。`chat.css`：项目名 160 / 40px、≤ 400px 内边距和 28px 图标按钮、≤ 320px 不显示项目名；去掉为顶栏按钮存在的旧规则 |
| 输入框下面一行：权限、选择范围、Effort、圆环、发送组 | `Composer.tsx`：各项都是 `.composer-bottom` 的直接子项；`PermissionMenu.tsx`（只有文字，悬停两行，不可用时 `aria-disabled`、关菜单和确认框）、`ModelMenu.tsx`（v1 的范围按钮，三行悬停、`model-tip`、`data-pending`、`pick-error` 往上浮出；锁定时 `LockedModelButton`）、`ThinkingMenu.tsx`（`aria-disabled`、两行悬停、`data-pending`）、新的 `UsageRing.tsx`、`rowMenu.ts`（这一行菜单共用：往上打开的位置、Tab 移出、新卡来了、不可用时关、焦点规则）；`menu.ts` 加 `useTabOutClose` |
| 各档的收紧和截短 | `chat.css`、`models.css`：680 / 600 / 460 / 400 / 340px 的 `@container`、`flex-shrink` 1e18 / 1e12 / 1e6 / 1 和最窄宽度、`min-height: 33px`、往上打开和高度上限；`tokens.css` 的 `--color-warn-text`；4px 间距的两档焦点环离按钮 1px |
| 协作开关和 Stop team（TaskBoard 合入后） | `team.css` 阈值 600px；`TeamSwitch.tsx` 注释；Stop team 是发送组的 `RowButton` |
| F8 的"Current view" | `IssueDialog.tsx`：Model range、Effort、Pane width |
| 图标 | `icons.tsx` 加 `queue`、去掉只有权限按钮在用的 `shield` |
| 只改注释（"顶栏菜单"→"范围菜单"） | `kernel/commands.ts`、`modelSession.ts`、`selector.ts`、`sessions.ts`、`shared/models.ts`、`state/actionLog.ts`、`actions.ts`、`settings.ts`、`settings/Defaults.tsx`、`state/modelActions.ts` |
| 测试中发现的内核问题 | 新的 `kernel/renameRetry.ts`（`agents.ts` 原有的重试挪过来，`modelConfig.ts`、`modelProfiles.ts` 也用）；`modelSession.ts` 的 `waitPast` |

后台进程没有加命令、没有改事件；`session.setMode`、`session.setPick`、`session.pickOptions`、`session.setThinking` 照旧。
文档：状态表 models.md（重写）、chat.md、approval.md、split.md、layout.md、sessions.md、settings.md、f8.md、README.md；
[defaults.md](defaults.md)、[ui-strings.md](ui-strings.md)、`docs/app-v0.md`；v1 的 model-menu.md、model-chat.md、
models-settings.md、team-switch.md、README.md、`docs/v1/defaults.md`、`docs/v1/models-checks.md`（走查步骤 2、4、7 的位置）；
`docs/specs/model-providers.md`、`docs/specs/parallel-agents-taskboard.md` §13.1、§15、§16 和
`docs/proposals/model-providers.md` 里写"顶栏"的地方（只改位置的说法）。截图 8 张在 [composer-pickers/](composer-pickers/)。

## 测试

`app/tests` 下 48 个文件有改动（m0–m7、v1、TaskBoard 的界面测试和 helper，`unit/modelConfig.test.mjs`、
`unit/selector.test.mjs`、合成端点的一行注释），其中新增 5 个：`m2-helpers.mjs`、`m6-app-row.mjs`、`m6-app-bands.mjs`、
`v1-models-row-helpers.mjs`、`v1-models-session-setup.mjs`；`package.json` 的 `test:m6-app` 加了 `m6-app-row`。
新加的检查对照 composer-pickers.md"测试要改的地方"的 11 条（顶栏会话名的地方、这一行每档每种状态不换行不溢出、截短的先后、菜单的位置、Tab 移出、键盘和焦点、新卡来了、圆环、F8、
拒绝启动卡的"Change model…"、准备中）。没有删掉检查；删掉的只是方案去掉的行为（盾牌图标、160 / 120px 的上限和 760 / 720px
两档、≤ 660 / 690px 不显示项目名、≤ 500px 藏用量、会话名至少 36px、"Set the permission mode for this session"、
Shift+Tab 8 次、Effort 变淡的颜色比较、读 `.disabled` 判断不可用）。

### 结果

开发构建一列：多数套件跑在 `4b7f5fc` 的构建上；`3a9a669` 只改了焦点环的 CSS 和一处注释，重新构建后在开发构建上重跑了
m6-app-row、m6-app-slash、m5-app、m3-app、m1-replay（数与之前相同）；真实走查跑在 `3a9a669` 的构建上；`c673735`、`f8066b2`
只改测试和文档。打包程序一列是 `c673735` 上打的包（含全部程序改动）。都是一个接一个跑：

| 测试 | 开发构建 | 打包程序（`dist/win-unpacked/Mori.exe`） |
| --- | --- | --- |
| `npm run check`、`npx electron-vite build` | 通过 | `npm run dist:dir`（含 check 和构建）通过；`app.asar` 的 `out/` 与 `app/out/` 327 个文件哈希相同 |
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
| `v1-models-existing.mjs --id TB-46`（m0–m7 App、v1 App、单元、全部回放，同时写 MP-37 的结果） | 2125 项通过，1 项 KNOWN（#9129），1 项失败：它自己的覆盖一步，当时还没有 `v1-models-real.json` | 没有跑（第 93 条） |
| 覆盖检查 `node tests/spec-coverage.mjs` | 开发构建当时 exit 1（只差 MP-27 真实层）；真实走查写出结果之后（写这份记录时重跑）exit 0："every item is covered on every listed layer" | `--packaged` exit 1：只差 MP-37 App（第 93 条） |
| 覆盖检查 `--spec taskboard` | 写这份记录时重跑 exit 1，只差 TB-46 回放：`tb-replay-existing.json` 是在真实层结果写出之前那次 TB-46 汇总写的，里面记着模型层覆盖检查失败（MP-27 真实层）。TB-04 / 08 / 34 / 37 / 45 的真实层现在都有 | `--packaged` exit 1：TB-46 App（第 93 条）和同一格 TB-46 回放 |

上表的数都是一个套件单独跑、以 0 退出的那一遍（TB-46 汇总除外，见表里）。

### 中间几轮（都已修正，见"测试中发现并已修正的问题"）

| 轮 | 结果 |
| --- | --- |
| 第一轮（`6217bfe` 上的 `b97595f`，10-22 01:30–02:02） | m0 18 + 1 KNOWN、m1-app 47、m2-app 92、m4-app 62、m5-app 50、m6-app-settings 60、m6-app-tools 142、m6-app-mcp-shared 49、m7-app 110，回放 m2 110、m3 60、m4 26、m6 66、m7 25 通过；失败 8 项：m3-app 1（150 / 1）、m6-app-slash 3（103 / 3）、m6-app-row 1（43 / 1）、m1-replay 2（92 / 2）、m5-replay 1（17 / 1）。重跑时 m3-app 156、m6-app-slash 106、m1-replay 94、m5-replay 26、m6-app-row 44 |
| v1 那一轮（10-22 02:37–02:56） | 单元 373、`v1-models-app-settings` 141、`-switch` 78 通过；`-session` 144 / 2（MP-23 469px 一栏，是 App 的右栏开关问题；MP-35 换强度），`v1-models-replay` 42 / 1（注入的错误被算成页面报错） |
| rebase 到 `046a9ca` 之后（10-22 05:00–05:45） | check、build、单元 373 两遍；m3-app 156、`m3-real` 80、m6-app-slash 106、m6-app-row 45、m5-app 53、`tb-app-roles` 45（第一遍 36 / 2，缺 TB-03 的 base 构建，`tb-build-base.mjs` 建好后通过）、`tb-app-stop` 43、`tb-replay` 55。另有一次只为打印会话名宽度的 m5-app `--only` 部分运行，里面 `longSource` 点引用芯片超时失败；完整的 m5-app 那一遍和之后每一遍都通过，这个部分运行没有再跑 |
| 开发构建全部跑（10-22 05:48–10:40） | m4-app 5 遍里 3 遍 59 / 3（流式输出时拖选选中上一行）；`tb-unit` 一遍 326 / 1（TB-39）；`v1-models-app-settings` 在一次 TB-46 汇总里 127 / 2（MP-24 EPERM）；`tb-app-stop` 在最后的构建上一遍 42 / 1（TB-42 看得太早）。修正后：m4-app 单独 3 遍和最后一次汇总都通过，`tb-unit` 连续 6 遍 327，`v1-models-app-settings` 141，`tb-app-stop` 43 |

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
| `m5-real` | 19 / 19 | 19 / 19 | 右栏打开的分屏约 280px 一栏："Ask e…"、"rea…"、"Unavailable"、圆环、发送图标，一行放得下 |
| `m6-real` | 56 / 56 | 56 / 56 | 开发构建第一遍 55 / 1（innerText，第 88 条）。范围菜单从这一行往上打开、Effort 菜单、分屏一栏里换范围后下一条回复来自新模型 |
| `m7-real` | 27 / 27 | 27 / 27 | F8 导出里有 Model range、Effort、Pane width |
| `v1-models-real` | 11 / 11 | 11 / 11 | 你的数据里有能用的 GLM（`glm/GLM-5.3`），MP-27 完整跑了：回复开始时和回复中途真的 401 时换模型，重启后回到第一选择 |
| `tb-real`（`MORI_APP_DIR=.tb-runs/real`，`tb-build.mjs real` 构建） | 24 / 24 | 24 / 24 | 开发构建第一遍 23 / 1（第 89 条），重跑通过；打包版第一遍通过。协作模式的截图：锁定的范围按钮、这一行的"Stop team"和"Stop"、输入框上方的后台批准卡 |

### 视觉走查

开发构建、合成端点，截图看了一遍：会话面板 930、861、860、761、680、600、460、400、340、300px（窄于 740px 时右栏打开）、
分屏左栏 280px 和 1184×735 的分屏；空闲、生成中有字、准备中有字、拒绝启动、"Allow all"、"Effort: Unavailable"
（空闲和生成中有字）、圆环 0 / 50 / 80 / 95%、刚压缩完；930 和 300px 时打开权限、范围、Effort 菜单、"Queue"的 ▾ 和圆环详情；
930、460、400、300px 时 Tab 过这一行和顶栏看焦点环；协作开关"Team: Off"每个宽度、"Team: On" 930–300px。
161 个样本用 `m6-helpers` 的 `paneProblems` 量过，除了截图脚本自己标错的两处（拒绝启动时分屏右栏也被拒绝启动，脚本按空闲查；
协作模式下范围按钮是锁定的样子，量的函数不认识）都没有问题；18 处菜单位置都对。

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
14,474,018 字节，SHA-256 全部相同，两边都没有多出的文件（清单 `e1a74ffb…`）；提交之后又比了一次，`out/` 没有变。
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
   的 279px 一栏也通过。协作开关在同一组、会被同样挤动，没有加同样的处理（见"未验证"）。
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

## 还没处理、等你定的

- **分屏 280–295px 一栏、协作模式下有后台 Agent（有 Stop team）、生成中、输入框有字时这一行放不下**：权限、范围、Effort 已到最窄
  （40 / 36 / 36px），Stop team 多出 28px 加一个间距，按估算超出约 16px，宽于约 296px 时放得下。没有改，也没有测试走到这种情况。
  可选的做法：这时收起 Stop team 的位置，或把它放进"Stop"旁的菜单。models.md"窄栏"记着这件已知的溢出。
- **分屏时用鼠标点另一栏的协作开关**：它和右栏开关在同一组、会被同样挤动，但只有右栏开关有"点完才切焦点"的处理；两栏的右栏
  状态不同时可能要点两次。没有改，没有测。
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
- **只能用手看的几项**（静态审查后的待验证清单列的，测试只覆盖了其中能自动查的部分）：鼠标点"Toggle changes"之后没有焦点环、
  按下拖出开关再松开时这一栏才得到焦点（视觉走查只看了 Tab 到的焦点环）；鼠标停在圆环上、焦点在文字框时按 Esc 停止生成并藏起
  提示，以及分屏时另一栏悬停的情况；"Switch to “Allow all”?"开着时后台进程退出，确认框关上、没有发 `approval.setMode`
  （没有任何测试走到）；范围菜单每一项的读屏名和描述、切换中范围按钮和 Effort 的描述（`title` 会不会变成描述）、
  "Send"、"Stop"、"Queue"的描述，都要在 DevTools 的无障碍面板里看；空圆环悬停时的底色。
- **覆盖检查的最终一遍**：TaskBoard 规格的 TB-46 回放一格来自真实层结果写出之前的 TB-46 汇总（`tb-replay-existing.json`），
  要在现在的结果上再跑一次 `v1-models-existing.mjs --id TB-46`（约 48 分钟）才能变绿；打包版的 MP-37、TB-46 App 两格要跑
  `v1-models-existing.mjs --exe`（第 93 条）。
- **一键导出安装包**（`build-installer.cmd`，NSIS 安装包）没有用这一步的代码跑；打包只做了 `dist:dir`。TB-03 的路径修正没有对
  NSIS 装到别的位置的程序检查过（它假定 pi 在 `<exe 所在目录>/resources/app.asar/node_modules` 下，与 `dist:dir` 一致）。
- `m0-real --setup`（交互的首次启动）没有跑，`m0-real` 用的是临时副本。
- 深色模式没有看；原生的 `title` 悬停提示截不到图，只由测试核对了文字；"Team: Until done"没有截图；没有打开 Claude 桌面版截图对照。
- 只在合成端点的整机测试里测过、真实走查没有走到的：问询卡（询问卡）来了时关这一行的菜单（只测了批准卡，问询卡的版本没有测试）；
  "Extra high"在 280px（v1 选不到，第 76 条）；换范围失败的 `pick-error` 只在回放里出现过（开发构建触发不了）。
- `tb-real` 第一遍那次 GLM"socket hang up"的原因（上游断开还是 Mori 取消了请求）不知道，重跑没有再出现。
- m4 拖选问题的原因是推算的（见第 10 条），修正后 4 遍都通过，失败率原来是 5 遍里 3 遍。
- `mcpConfig.ts`、`main/credentials.ts` 的同步改名替换仍没有重试（第 84 条）。
- 打包版和视觉走查清理临时目录时，视觉走查用的通配符可能也删掉了更早几轮留在 `%TEMP%` 的合成端点运行目录（没有你的数据）；
  更早会话留下的 `mori-v1-real-data-*`、`mori-v1-real-*`、`mori-tb-real-*` 还在 `%TEMP%`，只删了这一步自己建的。
- 真实走查时自动模式的分类器拦下了一条会列出 `credentials.json` 里引用名（不含值）的命令，没有换别的办法去看，脚本照常自己处理
  副本里的 key。
- `docs/v1/team-checks.md` 第 119 行仍写着 TaskBoard 的 App 和真实套件没有跑过 `--exe`（是 TaskBoard 的记录，没有改）。
