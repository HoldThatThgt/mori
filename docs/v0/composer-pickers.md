# 设计说明：模型、Effort、权限和上下文用量移到输入框下面一行（2026-10-21）

设计阶段只改了文档（`docs/` 下这些文件和 `app/README.md` 两行），没有改代码、没有跑测试。
状态表在 [screens/models.md](screens/models.md)（模型、Effort、圆环、菜单、窄栏）、[screens/approval.md](screens/approval.md)（权限菜单）、
[screens/chat.md](screens/chat.md)（顶栏、输入框下面一行、各状态下这一行的样子），临时默认值在 [defaults.md](defaults.md)。
这里记下为什么、怎样估的宽度、我自己定了什么，以及实现和测试要改的地方。
（上面一段是设计时写的。实现、测试、真实模型走查和打包版的结果，以及全部按推荐定的选择，见检查记录
[composer-pickers-checks.md](composer-pickers-checks.md)。）

2026-10-21 合并 v1（`v1-model-providers`）之后：搬进这一行的是 v1 的选择范围按钮
（[../v1/screens/model-menu.md](../v1/screens/model-menu.md)），不是 v0 的模型菜单；改了哪些、按推荐定了哪些见
"v1 之后的调整（2026-10-21）"一节。

## 负责人的决定（2026-10-21，照 Claude 桌面版）

1. 会话面板顶栏上的模型按钮、Effort 按钮和权限按钮移到输入框里、文字框下面那一行（Claude 的 prompt box 下面一行：
   左边模式选择，靠右是模型，用量圆环在模型旁边）。
2. Effort 仍是单独一个按钮（你的选择；Claude 的文档把 effort 放在模型菜单里）。
3. 上下文用量改成模型按钮旁的小圆环，悬停说明、读屏名和点开的详情里有原来"Context 12%""About 15,360 / 128,000 tokens"的信息。
   右边的顺序：模型、Effort、圆环，然后是发送 / 停止 / 排队。
4. 顶栏只留会话名（"项目名 › 会话名"）和这一栏的按钮（"Toggle changes"，分屏时"Close pane"）。目的：分屏时会话名有地方显示
   （原来 460px 的一栏里会话名只剩 36px，约 2 个字母）。
5. 权限按钮照 Claude 的模式选择只有文字（"Ask each time ▾" / "Allow all ▾"），任何宽度都没有盾牌图标、不会只剩图标。
   窄栏里模式名截断加"…"，全名在悬停说明和读屏名里，即使模型按钮因此更挤。"Allow all"保留警示色，也保留文字，
   不靠颜色也读得出。
6. 用词照 Claude 英文界面的原词；界面文字英文，文档正文和代码注释中文；先写状态表，不加后台，诚实。

给 TaskBoard 留的位置（2026-10-21 与 TaskBoard 会话约定）：它的团队开关（`data-testid="team-switch"`）放在顶栏右边一组
（`.topbar-actions`，一个容器）的第一个，在"Toggle changes"前面；后合并的一方重新算会话名能用的宽度、重调 `@container` 的档位。
2026-10-22 TaskBoard 先合入，这边后合并，重算的结果见"TaskBoard 合入之后"。

## 改后的样子

```
顶栏    | composer-pickers > Give split-pane titles more room with English labels  [Team: Off] [右栏] [x] |
                                                                  （x 只在分屏时）
输入框  +--------------------------------------------------------------------------------------+
        | （引用芯片）                                                                         |
        | 文字框                                                                               |
        | [Ask each time v]      [fast · deepseek-chat v] [Effort: High v] (圆环) [-> Send]    |
        +--------------------------------------------------------------------------------------+

分屏 280px 的一栏、生成中有字（最挤；示意，省略号前留几个字母由 Chromium 决定）：
        +---------------------------------------+
        | [Ask …] [fa…] [Unava…] (圆环) [v] [■] |
        +---------------------------------------+
```

- 这一行就是原来只有发送 / 停止的 `.composer-bottom`，高度不变（约 33px，由"Send"决定），输入框不变高，800×600 时
  不多挤批准卡。加 `min-height: 33px`：不能发送时这一行只有权限按钮和说明（约 22px 高），不让输入框跟着变矮。
- 顺序是负责人定的，也是装在本机的 Claude 桌面版的顺序：权限在左端；右边模型、Effort、圆环，最右是发送 / 停止 / 排队。
- 各项都是 `.composer-bottom` 的直接子项：不把右边几项包成一组，也不把模型和 Effort 包在一起。`flex-shrink` 只在兄弟之间
  分宽度，嵌在外层里的按钮排不出"说明 → 模型 → 模式名 → Effort"的截短先后（审查时在 Edge 里试过：嵌套时模型还在收短，
  模式名已经截成"Ask each ti…"；400px 时 Effort 也截了、这一行还溢出 37px）。
- 权限后面的第一项用 `.composer-bottom > .permission + * { margin-left: auto }` 推到右端（通常是模型，打开失败时是说明），
  删掉 `.composer-spacer`（它是 flex 项，用 `gap` 时会多出一个间距）。
- 页面里的顺序与看到的顺序相同，都在文字框后面：从文字框 Tab 往后依次是权限 → 模型 → Effort → 圆环 → 发送组；
  Shift+Tab 回会话树从 8 次变成 5 次（TaskBoard 合入后顶栏多了协作开关，是 6 次，见"TaskBoard 合入之后"）。
- 顶栏下的横幅（信任横幅、扩展错误）位置不变；v1 删掉了 `modelNotice`，没有可用模型时由输入框上方的拒绝启动卡说明
  （[../v1/screens/model-chat.md](../v1/screens/model-chat.md)）。

## 照 Claude 桌面版（键取自 Claude 的 `ion-en-US.json`）

| Mori | Claude 的原词（键）和它在 Claude 里的位置 | 用法 |
| --- | --- | --- |
| 范围按钮读屏名 | Claude 的 "Model: {name}"（`0ZMx/tNv6m`）是一个模型的名字 | 不用：v1 的按钮显示分组、提供商或模型，读屏名 "Model range: <按钮文字>"（v1 定的） |
| 没有当前模型时的悬停 | Claude 的 "Select model"（`e15QX1hh5v`）是去选一个的提示 | 不用：v1 的 "No model can run in this session"，没有范围时按钮上是 "No model range" |
| 范围菜单底部说明 | "Applies to this session only"（`A6a5gAY9+n`） | "Applies to this session only. New sessions use the default range from Settings."（第二句是 v1 的；合并后已是） |
| Effort 按钮读屏名 | "Effort: {name}"（`JtSAKJndrf`） | 原来就是 |
| Effort 按钮悬停 | "Set the effort level for this session"（`ahsycWoxUQ`，Claude 里是 /effort 命令的说明，不是按钮的悬停） | 原来就是，借用；改成两行，第一行是全名"Effort: {name}"（窄时强度会截断），这句在第二行 |
| 权限按钮 | Claude 的模式选择：只有文字的 ghost 按钮，显示模式名，没有图标，变窄时模式名截断 | 同（负责人 2026-10-21 定）：模式名和 ▾，没有图标；≤ 460px 去掉 ▾；放不下时模式名截断加"…"（"Ask each time"、"Allow all"是 Mori 原有的模式名，`IeOHqi8Fbf`、`mlQu8UNVBV` 也是 Claude 的字串） |
| 权限按钮悬停 | Claude 模式选择的悬停是当前模式的说明，没有说明时是菜单标题"Mode"（`mrOnjMzgC4`）；/permissions 命令的说明是"Change the permission mode"（`V5xsNvc+al`） | 改：两行。第一行是全名"Permission mode: {mode}"（模式名截断时靠它看全名）；第二行照 Claude 用当前模式的说明："Allow all"用 Mori 已有的"Edits, writes, and commands will run without asking."（确认框里的那句），"Ask each time"没有说明，用"Change the permission mode"（像 Effort 借 /effort 那样借 /permissions）；不可用时第二行是原因。原来的"Set the permission mode for this session"不再用。读屏的描述只有第二行（`aria-describedby`，见"我自己定的"第 18 条） |
| 权限按钮读屏名 | "Permission mode: {mode}"（`Z1ssd87d9Y`，Claude 里是定时任务卡片上的一行，不是模式选择的名字；Claude 的模式选择的名字就是看得见的模式名） | 原来就是，借用：模式名截断时靠它读出全名，也说明这是什么按钮。看得见的模式名在这个名字的末尾（"Permission mode: "后面），不在开头；名字包含看得见的文字，所以符合 WCAG 2.5.3（只是不是"最好放在开头"的写法） |
| 圆环悬停 | "Context {summary}"（`TbjIUo0AQ5`），summary 是"{used} / {max} ({pct}%)"（`bkyoeRV4fO`），估算的数前面加"≈ " | "Context ≈ 15.4k / 128k (12%)" |
| 圆环读屏名 | "Usage: {parts}"（`9Vq9GCHhLi`） | "Usage: Context approximately 15,360 of 128,000 tokens (12%)"（只把" / "换成" of "、"≈"写成"approximately"） |
| 圆环详情 | "Context window"（`4JvX9ZTEQB`）在左、summary 在右，下面 4px 的条；没有数据时右边空着、条的位置是"Send a message to see context usage."（`4XCjSHnPX/`） | 同 |
| 还没有消息、刚压缩过时的悬停和读屏名 | "Context window" | 读屏的描述是详情里那句话 |
| 刚压缩过的说明 | — | 沿用 Mori 的"Just compacted. Context usage shows after the next response." |
| 发送 / 停止 / 排队 | "Send"（`9WRlF4R2gm`）、"Stop"（`q/uwLTb3Zf`）、"Queue"（`4YDNPC1W1k`）、"More send options"（`XkyX4dFn+l`） | 只有图标时的读屏名 |
| 不可用的原因（生成中以外） | 沿用 Mori 按钮位置的说明："Mori’s background process crashed"、"Restarting…"、"Starting…"、"Session didn’t open" | 权限、Effort 不可用时悬停的第二行、范围按钮的第三行，和读屏的描述（见"我自己定的"第 11 条） |
| 排队的菜单项和悬停 | "Queue for later"（`8RUKIaTN4d`，Claude"More send options"菜单里的一项，也在它的发送悬停里） | ≤ 400px 时 ▾ 菜单里的"Queue for later"；"Queue"按钮的悬停改成"Queue for later (Enter)" |
| 顶栏按钮 | "Toggle changes"（`Kb4W+aA0T3`）、"Close pane"（`Sf+ebwMYFz`） | 原来就是 |

不用的 Claude 文字："{percent}% used"（`06vwLy/x1m`，Claude 里是套餐用量的圆环和那一行）和"{used} of {cap} tokens used"
（`G2opnDc87H`，组织的"Token limit"卡片），都不是上下文的；"Compact session"（`ccakFk0PFz`）和"Compacts automatically at {pct}%"
（`gvI84k5M8Q`）——手动压缩不在方案第 4 节，pi 的阈值是留出的 token 数、不是百分比；套餐用量（Mori 没有数据）。
Claude 的 Ctrl+Shift+M / I / E 快捷键和菜单里按 1–9 也不做（方案没有要求）。

## 宽度估算

字的宽度是按 Segoe UI 的字形宽度算的（读 `segoeui.ttf` / `seguisb.ttf`，按钮里的字 12px，发送组 13px），按钮的内边距、
▾ 和间距按现在的 CSS 加上去（2026-10-21 审查时量的，没有在 App 里量；实现后按实测调，记在这一步的检查记录里）。
下面说的"会话面板"都是 `.chat-pane` 的宽度，这一行的 `@container` 按它分档；分屏右边那一栏有 1px 的 `border-left`，
它的 `.chat-pane` 比 `.pane-slot` 窄 1px（分屏最窄的 280px 一栏在右边时是 279px）。测试里的宽度也都指 `.chat-pane`。

这一行的宽度：面板宽 − 输入区左右内边距 48px（面板 ≤ 520px 时 24px）− 输入框内边距和边框 30px，输入区最宽 860px。

| 会话面板 | 例子 | 这一行 |
| --- | --- | --- |
| 930px | 1200 宽窗口单栏、右栏关闭（测试默认） | 782px（最宽） |
| 740px | 800 宽窗口单栏、右栏关闭 | 662px |
| 490px | 1200 宽窗口单栏、右栏打开 | 436px |
| 460px | 1180 宽窗口分屏、右栏关闭 | 406px |
| 370px | 800 宽窗口分屏 | 316px |
| 300px | 800 宽窗口单栏、右栏打开 | 246px |
| 280px | 分屏最窄的一栏（左边） | 226px |
| 279px | 分屏最窄的一栏在右边（`.pane-slot` 280px） | 225px |

各项（最宽的写法）：

- 权限按钮只有文字（字 12px，左右内边距 8 / 6px，▾ 连同它前面的间距约 18px）："Ask each time ▾" 103.7px、
  去掉 ▾ 85.7px、≤ 340px 81.7px（"Allow all"字重 500，约 76 / 58 / 54px，比它窄）。最窄 44px（≤ 340px 时 40px）。
- 选择范围按钮最长 200px（任何宽度；"<提供商名> · <模型 id> ▾"常见 170–195px），最窄 40px（≤ 340px 时 36px）。
- Effort："Effort: Unavailable ▾" 125.9px、"Unavailable ▾" 91.1px、"Unavailable" 73.1px（最宽的强度；≤ 340px 69.1px；
  "Extra high" 64.8px，"High" 37.3px）；最窄 40px（≤ 340px 时 36px）。
- 最窄的宽度里字有多宽：≤ 460px（没有 ▾）时权限 32px、模型 28px、Effort 28px；宽于 460px 时有 ▾，
  同样的最窄里字只剩约 8–14px。下面算下来宽于 460px 的各档最挤时也截不到最窄，只是写清楚。范围按钮在最窄时：
  宽于 460px 时字只剩约 8px（`.range-model` 已是 0，`.range-scope` 只剩"…"），≤ 460px 字 28px（只看得到范围名的开头几个字母）；
  宽于 460px 的各档最挤时范围按钮至少约 58px（461px，字约 26px）；401px 时约 54px（没有 ▾，字约 42px）。
- 圆环 26px，任何宽度都不变、不收。
- 发送组：带文字时"Send" 79.7px、"Stop" 77.6px、"Queue ▾" 100.1px。只有图标时（≤ 600px）"Send"、"Stop"、"Queue"
  各 32px（`width: 32px`，现在只有图标的 `.button` 带左右 14px 的内边距是 45px），▾ 24px（`.split-toggle` 现在是 32px，
  这一档改成 `width: 24px; padding: 7px 4px`），"Queue"连 ▾ 共 56px；≤ 340px 时"Send"、"Stop" 28px。
  这几个宽度要写进 CSS：▾ 留 32px、"Queue"留 45px 时，461px 一栏最挤时模型只剩约 34px，400px 以上模式名就会被截。
- 不能发送时按钮位置的说明（12px）："Mori’s background process crashed" 187.5px、"Session didn’t open" 103.9px、
  "Restarting…" 62.5px、"Starting…" 50.3px；最窄 48px。
- 间距 8px（≤ 460px 时 4px）。生成中有字时这一行有 6 项（权限、模型、Effort、圆环、"Queue ▾"、"Stop"），删掉
  `.composer-spacer` 之后是 5 个间距；不删就是 6 个，每档少 8px（≤ 460px 时 4px）。下表按删掉算。项的顺序不影响宽度。

每一档去掉什么（单栏、分屏相同；每一档也包含比它宽的各档的改动）：

| 档（会话面板） | 这一档改什么 |
| --- | --- |
| > 680px | 全部带文字："Ask each time ▾"、范围按钮（最长 200px）▾、"Effort: High ▾"、圆环、"Send" / "Stop" / "Queue ▾"；间距 8px |
| ≤ 680px | Effort 去掉"Effort: "，只显示强度（"High ▾"） |
| ≤ 600px | "Send" / "Stop" / "Queue"只有图标（各 32px，▾ 24px；名字在读屏名和悬停说明里） |
| ≤ 460px | 权限、模型、Effort 去掉 ▾；间距 4px |
| ≤ 400px | 生成中有字时"Queue"收进只有 ▾ 的"More send options"（菜单里"Queue for later"和"Steer"），"Stop"不动 |
| ≤ 340px | "Send" / "Stop"图标按钮 28px；权限、模型、Effort 左右内边距各 4px |

这样还放不下时依次截短，前一项截到它的最窄才轮到下一项；截短的加"…"，全文在悬停说明的第一行和读屏名里：

1. 不能发送时按钮位置的说明（最窄 48px；悬停说明和横幅里有全文）；
2. 选择范围按钮（最窄 40px，≤ 340px 时 36px）：先截当前模型 id（连同它前面的" · "，`.range-model`），截完了才截范围名
   （`.range-scope`；范围是模型时只有模型 id 一段）；
3. 权限的模式名（最窄 44px，≤ 340px 时 40px）；
4. Effort 的强度（最窄 40px，≤ 340px 时 36px）。

圆环、"Send" / "Stop" / ▾ 不收。模型先于模式名截，照负责人的意思（模式名截断，即使模型按钮因此更挤）：
模式名关系到会不会不经询问就执行；Effort 最后，因为常用的强度（"High""Low""Max""Off"）本来就短，截了也省不了多少。

逐档的数（最挤的情况：生成中、输入框有字，"Ask each time"，"Effort: Unavailable"，范围按钮的文字很长、想占满上限；
≤ 400px 时准备中有字比它还宽一点，见表下"其他状态"；"下沿"是这一档最窄、最挤的宽度）：

| 会话面板 | 这一行 | 用的档 | 模型以外各项加间距 | 模型 | 权限 | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 761px | 683 | > 680 | 103.7 + 125.9 + 26 + 100.1 + 77.6 + 40 = 473.3 | 209.7，取 200 | 完整 | 完整 |
| 760px | 682 | > 680 | 473.3 | 208.7，取 200 | 完整 | 完整 |
| 681px（下沿） | 603 | > 680 | 473.3 | 129.7 | 完整 | 完整 |
| 680px | 602 | ≤ 680 | 103.7 + 91.1 + 26 + 100.1 + 77.6 + 40 = 438.5 | 163.5 | 完整 | 完整 |
| 601px（下沿） | 523 | ≤ 680 | 438.5 | 84.5 | 完整 | 完整 |
| 600px | 522 | ≤ 600 | 103.7 + 91.1 + 26 + 56 + 32 + 40 = 348.8 | 173.2 | 完整 | 完整 |
| 461px（下沿） | 407 | ≤ 600 | 348.8 | 58.2 | 完整 | 完整 |
| 460px | 406 | ≤ 460 | 85.7 + 73.1 + 26 + 56 + 32 + 20 = 292.8 | 113.2 | 完整 | 完整 |
| 401px（下沿） | 347 | ≤ 460 | 292.8 | 54.2 | 完整 | 完整 |
| 400px | 346 | ≤ 400 | 85.7 + 73.1 + 26 + 24 + 32 + 20 = 260.8 | 85.2 | 完整 | 完整 |
| 341px（下沿） | 287 | ≤ 400 | 260.8 | 26.2，不到最窄，取 40 | 85.7 − 13.8 = 71.9（截断） | 完整 |
| 340px | 286 | ≤ 340 | 81.7 + 69.1 + 26 + 24 + 28 + 20 = 248.8 | 37.2（比最窄多约 1px） | 完整 | 完整 |
| 280px | 226 | ≤ 340 | 圆环、▾、"Stop"和间距 26 + 24 + 28 + 20 = 98，三个按钮共 128 | 36（最窄） | 128 − 36 − 69.1 = 22.9，不到最窄，取 40（截断） | 128 − 36 − 40 = 52（截断） |
| 279px（右边一栏） | 225 | ≤ 340 | 98，三个按钮共 127 | 36（最窄） | 40（截断） | 51（截断） |

范围按钮的上限只决定"有空余时它占多少"（它最先收短），所以上限从 160 / 120px 改成 200px 后"权限""Effort"两列不变。
宽于 400px 的各档在下沿最挤时模式名完整、范围按钮至少约 54px；400px 起最挤时才截模式名。340px 时模型只比最窄多约 1px，
实测宽几 px 时模式名会截一点（这一档允许）。280px 时三个按钮都接近最窄，Effort 比它的最窄多 16px
（右边一栏 15px；准备中有字时 12px），留给估算的误差。其他常见宽度：370px（800 宽窗口分屏，≤ 400 档）316 − 260.8 = 55.2，模型约 55px、模式名完整；
300px（800 宽窗口右栏打开，≤ 340 档）246 − 98 = 148，模型 36px、权限 148 − 36 − 69.1 ≈ 43px（截断）、Effort 完整；
490px（1200 宽窗口右栏打开，≤ 600 档）436 − 348.8 ≈ 87px。

其他状态在 280px 一栏（≤ 340 档）：

- 空闲、"Effort: High"：圆环 26 +"Send" 28 + 4 个间距 16 = 70，三个按钮共 156：权限 81.7 + Effort 33.3 = 115，
  模型约 41px，模式名完整。"Unavailable"时 156 − 81.7 − 69.1 ≈ 5，模型取 36，权限 156 − 36 − 69.1 ≈ 51px（截断）。
- 生成中有字、"High"：128 − 36 − 33.3 ≈ 59，权限约 59px（"Ask each time"截断；"Allow all"约 54px，完整）。
- 后台进程退出：圆环 26 + 4 个间距 16 = 42，剩 184；说明先收到 48px，三个按钮共 136：模型 36，权限 136 − 36 − 69.1 ≈ 31，
  取 40，Effort 60；"High"时权限 136 − 36 − 33.3 ≈ 67px。悬停看说明的全文，横幅里也有。Restart 之后重新打开中相同
  （范围按钮、Effort、圆环保留，"Starting…"约 50px，也收到 48px）。
- 准备中、有字（v1；"Queue"是单个图标按钮 28px，"Stop" 28px）：圆环 26 + 28 + 28 + 5 个间距 20 = 102，三个按钮共 124：
  "Unavailable"时范围按钮 36、权限 124 − 36 − 69.1 ≈ 19，取 40（截断）、Effort 48（截断）；"High"时权限 124 − 36 − 33.3 ≈ 55px
  （"Ask each time"截断）。比生成中有字（▾ 24px）只多 4px，三个按钮都不窄于最窄。
  ≤ 400px 时准备中有字是最挤的情况（单个"Queue" 32px 比 ▾ 宽 8px，≤ 340px 时 28px 比 ▾ 宽 4px）：341px 时范围按钮 40px、
  权限约 64px（截断），340px 时范围按钮 36px、权限约 79px（截掉约 3px）；这两档本来就允许截模式名。
- 拒绝启动、没有当前模型（v1，没有 Effort）："Send" 28 + 圆环 26 + 3 个间距 12 = 66，权限 81.7，范围按钮 226 − 66 − 81.7 ≈ 78px
  （"No model range"去掉 ▾、≤ 340px 内边距 4 / 4px 时是 94.6px，截成约 70px 的字）。圆环不显示时范围按钮约 108px。
- 打开失败、第一次打开中：这一行只有权限按钮和按钮位置的说明，81.7 + 4 +"Session didn’t open" 103.9 ≈ 190，
  任何宽度都放得下。

截短后看得见的字由 Chromium 决定，不是固定的"Ask…"：审查时量到权限 32px 的字画出"Ask …"、"Allo…"，60px 时"Ask eac…"，
Effort 28px 时"Un…"、280px 最挤时"Unava…"。测试不比这些字面，只比宽度和"是否截短"（见"测试要改的地方"第 3 条）。

实现：

- 各项都是 `.composer-bottom` 的直接子项（见"改后的样子"）。截短的先后用相差很大的 `flex-shrink`：说明 1e18、模型 1e12、
  权限 1e6、Effort 1，其余各项 0；相邻两项至少差 1e5。差 1000 倍不够：布局按 1/64px 计，审查时在 Edge 里试过，
  模型收短约 16px 后权限按钮就少了 1/64px，画出"Ask each ti…"；差 1e5 倍时模式名完整。实现后用测试第 3 条的检查确认，
  还不行就改成脚本：前一项到最窄之后才让下一项收短。
- 各项的最窄用 `min-width`，≤ 340px 的最窄跟着内边距改；文字用 `text-overflow: ellipsis`。
- 这一行 `min-height: 33px`。

顶栏（会话名很长、项目名收到 40px 时会话名能用的宽度；还没有协作开关，有开关时见"TaskBoard 合入之后"）：

| 会话面板 | 原来 | 改后 |
| --- | --- | --- |
| 930px 单栏 | 约 260px | 约 770px |
| 510px 分屏（1280 宽） | 36px | 约 335px |
| 460px 分屏 | 36px | 约 285px |
| 370px 分屏（800 宽） | 36px | 约 215px |
| 300px 单栏（800 宽、右栏打开） | 36px | 约 245px（不显示项目名） |
| 280px 分屏 | 36px | 约 190px（不显示项目名） |

## 菜单的位置

`.composer-bottom` 设 `position: relative`，是这一行所有菜单和圆环详情的定位参照；各按钮的外层（`.permission`、
`.model-switch`、`.thinking-switch`、`.split-button`）都是 `position: static`。任何宽度都按同一个规则，不再按 600px 分两种：

- 范围菜单、Effort 菜单和"Queue"的下拉：右边对齐自己按钮的右边（照 Claude 的模型菜单右端对齐）；这样会伸出这一行的
  左端时往右挪，左边贴这一行的左端（left = max(0, 按钮右边 − 菜单宽)）；菜单最宽是这一行的宽。
- 权限菜单：左边对齐这一行的左端（就是按钮的左边）。圆环详情：右边对齐这一行的右端（260px，这一行更窄时收到这一行的宽）。
- 打开时量按钮和这一行的位置来算（高度本来就要量），这一行的宽度变了时重算。
- 范围菜单宽 min(300px, 这一行的宽)；切换失败那一行（`.pick-error`）按同一规则往上弹出、右边对齐范围按钮，
  最宽 min(320px, 这一行的宽)。

审查建议宽于 600px 时模型菜单左边对齐模型按钮、Effort 菜单右边对齐 Effort 按钮；后一半照做（就是上面的规则），前一半不用：
有空余时 `margin-left: auto` 把模型推到右边，ID 短、右边只有"Off ▾"、圆环和"Send"时，模型按钮左边到这一行右端
只有约 220px（例如 680px 一栏空闲、ID "o3"：44 + 8 + 46.6 + 8 + 26 + 8 + 79.7），300px 的范围菜单会伸出这一行。

高度：最高 min(440px, 这一行的上边到顶栏下边 − 12px)。这一行贴在会话面板底部，草稿变高时往上长的是 `.composer` 的上边，
这一行不动，所以这个距离只随窗口高度变：打开时量，窗口大小变了时重算。菜单不以 `.composer` 定位，正是因为草稿很长时
`.composer` 的上边会升高约 280px。

## v1 之后的调整（2026-10-21）

这份设计 rebase 到合并了 v1 模型层的 `app-v0`（`6a57fd4`）之上。v1 把顶栏的模型按钮换成了选择范围按钮（`ModelMenu.tsx`，
[../v1/screens/model-menu.md](../v1/screens/model-menu.md)），所以搬进这一行的是它：`.model-switch` > `button.model-button` >
`.range-scope` + `.range-model` + ▾，旁边是切换失败那一行 `.pick-error`，菜单是 `PickPanel`，各项来自 `session.pickOptions`。
Effort、圆环、权限按钮照原设计不变；位置、顺序、`flex-shrink` 的先后、最窄宽度、往上打开、`aria-disabled`、两行悬停、
焦点规则都照用。v1 的界面文字在合并 English UI 时已按 [ui-strings.md](ui-strings.md) 改过，这里用合并后的字。
负责人要求自己往下做、每处选推荐的做法、列出来以后看：选了什么见本节最后"按推荐定的"。

### 改了什么

1. 按钮的字、读屏名、悬停用 v1 的：按钮"<范围名> · <当前模型 id>"（分组写 id、提供商写名称；范围是模型时只有模型 id；
   没有当前模型时只有范围名；没有范围时"No model range"）；读屏名"Model range: <按钮文字>"（" · "换成", "，2026-10-22 审查时按 ui-strings.md"读屏名里不用 · "改）；悬停分三行，见下表。
2. v0 的" (deleted)"、"No models available"、"Default"标记不再有：范围指向不存在的名字、没有能用的模型时，由输入框上方的
   拒绝启动卡（`data-testid="blocked-card"`）说明，"Send"不可用（[../v1/screens/model-chat.md](../v1/screens/model-chat.md)）。
3. 范围按钮的上限任何宽度都是 200px，去掉"≤ 760px 最长 120px"那一档（见下"宽度"）。
4. 按钮里面截短的先后照 v1：先截当前模型 id（连同前面的" · "，`.range-model`），截完了才截范围名（`.range-scope`）。
5. v1 的 300px 菜单和切换失败那一行（`data-testid="pick-error"`，`role="alert"`）都往上弹出；删掉 v1 `models.css` 里按
   `--topbar-height` 定位的 ≤ 600px 规则。
6. 状态表加上 v1 的"准备中"（取代原设计的"刚发出"）和"拒绝启动"。
7. Effort 显示与否看 `tab.current`（当前的实际模型），不看 v0 的 `tab.model`；可选的强度是 `ModelState.thinkingLevels`。
8. 拒绝启动卡上的"Change model…"打开这一栏这一行里的范围菜单（`openRangeMenu` 按每一栏分开，不跟顶栏绑在一起，代码不用改），
   菜单往上盖住卡。

### 悬停和读屏的描述

原设计的规则是"会截短的按钮，悬停第一行是全文，第二行是说明或不可用的原因，读屏的描述只有第二行"。v1 的悬停
"<提供商名> · <区域>"不含按钮文字，所以范围按钮分成三行：

| 状态 | 悬停第 1 行 | 第 2 行 | 第 3 行 | 读屏的描述（`aria-describedby`） |
| --- | --- | --- | --- | --- |
| 能用、有当前模型 | 按钮文字（"fast · deepseek-chat"） | "<提供商名> · <区域>"（"DeepSeek · Public"） | — | "DeepSeek, Public"（第 2 行，" · "换成", "） |
| 能用、没有当前模型 | 按钮文字（"fast"、"No model range"） | "No model can run in this session" | — | "No model can run in this session" |
| 准备中、生成中 | 按钮文字 | 同上 | "Can’t switch models until the response finishes" | 第 2 行加". "加第 3 行（"DeepSeek, Public. Can’t switch models until the response finishes"） |
| 后台进程退出、重新载入中、Restart 之后重新打开中 | 按钮文字 | 同上 | "Mori’s background process crashed" / "Restarting…" / "Starting…" | 同上 |
| 切换中（`session.setPick` 还没返回） | 你选的范围的文字 | — | — | 没有描述（原设计"切换中不加原因"；v1 这时的悬停是"No model can run in this session"，因为它用 `current: null` 算你选的范围，会让人以为选错了，一起改掉） |

- 藏起来的描述元素（`data-testid="model-tip"`）放在 `.model-switch` 里、按钮外面，不放进按钮：v1 测试读按钮的 textContent
  （`v1-models-app-session.mjs` `topbar()` 期望"No model range"、"m3"）。
- v1 现在是 `title={busy ? BUSY_TITLE : …}`，原因代替了提供商和区域；改成三行以后生成中仍看得到这一段发到哪个区域。

### 不可用、什么时候显示、准备中

- 不可用：v1 用真的 `disabled`（`disabled={disabled || busy}`）。改成原设计的 `aria-disabled="true"`（准备中、生成中、后台进程退出、
  重新载入中、Restart 之后重新打开中），点了不开菜单（`onClick` 里判断）；`useRangeMenu` 的 `disabled` 参数仍传 `notReady || busy`，
  这时拒绝启动卡的"Change model…"打不开菜单（同 v1）。能用时按钮上不带 `aria-disabled`（`aria-disabled={x ? true : undefined}`，
  同 v1；不写"false"）：有三处测试等这个属性不在（见"测试要改的地方"C1）。切换中 v1 已经是 `aria-disabled`，另加
  `data-pending="true"`（只是测试用的标识，界面不变），让测试分得开"切换中"和"不可用"。范围按钮和 Effort 共用一个切换中的值
  （`usePendingSwitch`，按这一栏），所以换范围或换强度时两个按钮都 `aria-disabled`、都带 `data-pending`。
- 什么时候显示：范围按钮 `phase !== 'failed'` 且（`phase !== 'opening'` 或已经有过模型状态：`tab.pick`、`tab.current`、`tab.blocked`
  有一个不为 null；Restart 时 `projects.ts:254` 只清 `sessionId` 和 `phase`，`ModelState` 留着）；Effort 另要 `tab.current`
  （v1 `ChatPane.tsx:148`）。
- 拒绝启动（`blocked` 不为 null）：范围按钮可用（可以在这里改范围）；`current` 为 null 时没有 Effort；"Send" `disabled`（不加原因，
  原因在拒绝启动卡里）；圆环按它原来的规则（pi 返回空时不显示；实现时看一次 `no_candidate` 时 `getContextUsage()` 返回什么）。
  拒绝启动卡出现或消失**不**关这一行的菜单（它没有 Alt+数字要答，而且菜单可能就是它打开的）。
- 准备中（v1：`sending && !running`，发了消息、pi 还没开始）：按钮位置是"Stop"（可用，停止时消息撤回、文字回到输入框）；
  输入框有字时左边是只有一个按钮的"Queue"（v1 `QueueButton steer={false}`：没有 ▾，准备中不能插话）；占位文字
  "Enter to queue · Shift+Enter for new line"；范围、Effort 按钮不可用，权限、圆环可用；开着的范围、Effort 菜单关闭。
  ≤ 600px 时"Queue"只有图标 32px；≤ 400px **不收起**（▾ 菜单里只会剩"Queue for later"一项）；≤ 340px 和"Send"、"Stop"一样 28px。
  准备中又发的消息在排队区标"Queued"、`data-pending`，这时没有"Withdraw"（v1 `QueueArea`），与这一行无关，不改。

### 菜单和切换失败那一行

- 菜单：v1 的 `.model-menu { width: 300px; max-height: min(440px, calc(100vh - 80px)) }`、往下居中的 `.switch-menu`、≤ 600px 以
  `--topbar-height` 贴面板右边，都换成"菜单的位置"的规则：往上打开、右边对齐范围按钮、放不下时挪进这一行，
  宽 min(300px, 这一行的宽)，最高 min(440px, 这一行上边到顶栏下边 − 12px)。280px 一栏里这一行 226px，菜单收到 226px：
  每项的名字（`.switch-text`）截断加"…"，区域（`.pick-zone`，`flex-shrink: 0`）和 ✓ 不收，全名在每项的 `title` 里
  （v1 已有：被排除时是原因，否则是名字）。
- 切换失败那一行 `.pick-error`：v1 在 `.model-switch`（`position: relative`）下方 4px、右对齐；外层改成 `position: static` 以后
  它会以 `.composer-bottom` 定位、落到这一行下面、窗口外。改成从这一行往上弹出（下边在这一行上方 6px），左右与菜单同一个算法，
  最宽 min(320px, 这一行的宽)，`white-space: normal`；不算浮层（不挡 Alt+数字、Ctrl+N、Esc），下次打开菜单或 10 秒后消失
  （v1 原样）。菜单开着时它已经被清掉，不会叠在一起。
- 从拒绝启动卡的"Change model…"（`BlockedCard.tsx:60`、`modelActions.ts:122`）打开时，Esc 或选了一项后焦点回到范围按钮
  （`useSwitchMenu.close`，v1 原样），不回到卡上：选了以后卡可能已经消失，范围按钮就在卡的下面。

### 宽度

按 Segoe UI 12px 的字形宽度（同"宽度估算"），按钮里字以外的部分 32px（左右内边距 8 / 6px，▾ 连同间距 18px）：

| 按钮文字 | 字 | 整个按钮 |
| --- | --- | --- |
| "fake-coder"（合成端点，范围是模型） | 57.0 | 89.0 |
| "deepseek-chat" | 77.6 | 109.6 |
| "No model range" | 86.6 | 118.6 |
| "fast · deepseek-chat"（分组） | 105.8 | 137.8 |
| "DeepSeek · deepseek-chat"（提供商） | 139.7 | 171.7 |
| "Mori endpoint · fake-coder" | 142.3 | 174.3 |
| "DeepSeek · deepseek-reasoner" | 163.1 | 195.1 |

范围是分组或提供商时常见的按钮在 140–195px，原来的上限 160px（> 760px）会截掉，120px（≤ 760px）截掉大半。
这个按钮是这一行第一个收短的（`flex-shrink` 1e12），别的项只有在它收到最窄之后才截，所以上限只决定"有空余时它占多少"，
改上限不会让权限、Effort 更早截短。上限改成任何宽度 200px（上表最长 195.1px）；代价是宽的面板里按钮可能多占 40–80px
（旁边本来就是 `margin-left: auto` 的空白）。800 宽窗口单栏（740px）空闲时这一行其实还空着约 330px
（662 − 权限 103.7 − "Effort: High ▾" 90 − 圆环 26 − "Send" 79.7 − 4 个间距 32），用 120px 的上限只会白白截掉。

v1 按钮里面的做法（`.range-model { flex: 1 1 0; white-space: pre }`、`.range-scope { flex: 0 1 auto }`、
`.range-scope + .range-model { margin-left: -4px }`）留着：它在按钮里面，跟这一行的 `flex-shrink` 互不影响。实现后量一次
"范围是模型、只有 `.range-model` 一段"时按钮是不是按全文算宽（`flex-basis: 0` 时 Chromium 的 max-content 算法；v1 在顶栏里
没出问题，但这一行的宽度检查更严）。

### 按推荐定的（负责人以后看）

草稿（`v1-delta`）里每处有几种做法的，都选了推荐的那一种，只有第 4 条照负责人的要求不照草稿：

1. **范围按钮的上限**：任何宽度 200px，去掉 ≤ 760px 那一档（W1）。没选：W2 保留 160 / 120px（分组、提供商范围在 ≤ 760px，
   即 800 宽窗口单栏和所有分屏里，几乎都截到只剩范围名）；W3 不设上限（很长时这一行看起来全是它）。
2. **范围按钮的悬停**：三行，按钮文字 / 提供商和区域 / 不可用的原因（H1）。没选：H2 两行，原因顶掉提供商和区域，
   生成中看不到这一段发到哪个区域。
3. **读屏名**：保留 v1 的"Model range: <按钮文字>"（T1-A）。没选：Claude 的"Model: {name}"（按钮显示的不一定是一个模型，
   分组时读成"Model: fast · deepseek-chat"）。
4. **准备中、生成中不能换的原因**：保留合并后的"Can’t switch models until the response finishes"（v1 合并 English UI 时已用这句，
   代码、规格 §9.2 和测试常量都是它）。草稿推荐过规格原来的"Can’t change the model while generating"，这一处按负责人的要求不改。
5. **Effort 的原因**：English UI 的"Can’t change effort until the response finishes"，准备中也用（T3）。
6. **菜单底部说明和最后一项**："Applies to this session only. New sessions use the default range from Settings."和"Manage models"
   （T4-A、T5-A：Claude 的开头、术语表"只是跳到另一页的不加…"）；合并后 v1 已是这样，不用再改。
7. **切换失败的字**："Couldn’t change the model range: <原文>"（T6，合并后已是）。
8. **不支持思考的说明**：用合并后的句子（T7：内容照 v1，Mori 不发参数、指向 Settings → Models；写法照术语表）。
9. **没有范围、没有当前模型、区域**：照 v1（T9）："No model range"、"No model can run in this session"、Local / Intranet / Public、
   "Zone not confirmed"；不用 Claude 的"Select model"（它是"去选一个"的提示，不说明为什么不能跑）。
10. **准备中的"Queue"**：≤ 400px 也是单个图标按钮，≤ 340px 28px（P1）。没选：P2 ≤ 400px 收进只有一项的 ▾，省 8px 但多点一下。
11. **切换失败那一行**：从这一行往上浮出（E1）。没选：E2 放到输入框上方、和拒绝启动卡同一位置，不浮动，但会把输入区顶高一行、
    10 秒后又落回去。
12. **v0 models.md 与 v1 model-menu.md 的分工**（D1）：models.md 管"这一行"（位置、宽度、悬停的行、不可用和焦点、窄栏、
    菜单的位置与键盘），按钮的字、菜单的内容、换范围、拒绝启动以 model-menu.md 为准；每件事只写在一处。没选：D2 都并进
    model-menu.md、models.md 只留圆环（v0 的 Effort 规则要搬家，改动更大）。
13. **规格和 proposal 里的"顶栏"**：改成"输入框下面一行"或"范围菜单"，只改位置的说法（S1）。没选：S2 不改、在 §9.2 加一条注
    （改动最小，但规格和界面说法对不上；规格是 v1 测试的依据，MP-23 写着"顶栏选择范围"）。
14. **切换中加 `data-pending="true"`**：范围按钮和 Effort 都加（测试要靠它分开"切换中"和"不可用"；不加时只能用
    `[data-running]` 和悬停第 3 行去猜）。
15. **F8 的"Current view"加"Model range"**：加（可选的一项）。
16. **代码注释里的"顶栏菜单"**：后台进程和共用类型里的（`kernel/commands.ts:74`、`modelSession.ts:739`、
    `selector.ts:2,240,324,326,350`、`sessions.ts:773,793`、`shared/models.ts:402,553,620`）改成不写位置的"范围菜单"，
    免得界面再挪时又过时。

## 我自己定的（请你走查时看）

1. **截短的顺序和最窄宽度**（负责人定了权限只有文字、模式名截断；顺序和数是我定的）：不能发送的说明 → 选择范围（先截当前模型 id，
   再截范围名）→ 模式名 → Effort 的强度；最窄依次 48 / 40 / 44 / 40px（≤ 340px 时模型 36、权限 40、Effort 36px）。权限在最窄时
   显示模式名的开头几个字母（量到的是"Ask …"、"Allo…"），开头不同，加上"Allow all"的警示色，最窄时两种模式也分得出。
   宽于 400px 的各档在最挤时都不截模式名。各项都是这一行的直接子项、`flex-shrink` 相邻差 1e6，才排得出这个先后。
2. **截短的按钮，悬停说明的第一行是全文**：权限"Permission mode: Ask each time"、范围按钮"<按钮文字>"（例如
   "fast · deepseek-chat"）、Effort"Effort: High"；第二行是原来的说明或不可用的原因。范围按钮的第二行是"<提供商名> · <区域>"，
   不可用时第三行是原因（v1 的悬停不含按钮文字，见"v1 之后的调整"）。读屏名里也是全文（原来就是）。原来权限、Effort 的悬停里没有
   当前的模式和强度，截短后鼠标用户就看不到全名。
3. **发送 / 停止 / 排队在会话面板 ≤ 600px 时只有图标**（照 Claude，它一直只有图标）。不这样，"Queue ▾"加"Stop"在 1200 宽窗口、
   右栏打开（490px）时模型按钮没有地方（436 − 438.5 < 0）。代价：右栏打开时常见的 490px 也是图标。只有图标的"Queue"用新图标 `queue`
   （`icons.tsx` 里现在没有）。只有图标时"Send"、"Stop"、"Queue"各 32px，▾ 24px（现在是 32px），宽度估算按这两个数。
4. **≤ 400px 生成中有字时收起"Queue"、留下"Stop"**（原来的设计在 ≤ 340px；权限按钮不再能收成图标，所以提早一档）：
   Enter 本来就排队，停止要一眼看得到；Claude 的"More send options"里也是"Queue for later"和"Stop"。
   原规格"Stop 和 Queue 在同一位置"在这一档改成"Stop 和 ▾"。
5. **≤ 340px "Send" / "Stop"收到 28px，权限、模型、Effort 的左右内边距收到 4px**：不这样 280px 一栏最挤时三个按钮都在最窄、
   一点余量也没有（226 − 26 − 24 − 32 − 20 = 124 = 44 + 40 + 40）。28px 与顶栏 ≤ 400px 时的图标按钮相同，仍大于 24px 的目标下限。
6. **还没有消息时圆环为空**，悬停和读屏名"Context window"，详情里"Send a message to see context usage."，不显示"0%"：
   pi 的 0 不含系统提示词，不是真的用量。原来这时显示"Context <1%"。
7. **百分比照 Claude 四舍五入**，不再写"<1%"（有消息但不到 0.5% 时写"0%"，圆环几乎不填）。
8. **刚压缩完时圆环的底圈是虚线**，与"还没有消息"分得开；说明沿用 Mori 的那句。
9. **圆环的颜色分档照 Claude**（< 75% 强调色，75–89% 警示色，≥ 90% 危险色），环 14px（Claude 12px；Mori 这一行的图标都是 14px），
   详情 260px 宽、4px 的条。底圈：空圆环（还没有消息、刚压缩完）用 `--color-faint`（#8a9098，白底上约 3.2:1）；
   有填充时改用 `--color-line`（#e8eaed）。`--color-faint` 和三种填充几乎一样亮（警示色 1.07:1、强调色 1.32:1、
   危险色 1.33:1），填到哪里看不出来；`--color-line` 上强调色 3.51:1、危险色 3.55:1。警示色的填充改用较深的
   `--color-warn-text`（新的颜色，`color-mix(in srgb, var(--color-warn) 70%, var(--color-text))`，#855f1e，在 `--color-line` 上
   4.79:1、白底上 5.78:1；原来的警示色在 `--color-line` 上只有 2.84:1。2026-10-22 审查时从 75% 改成 70%：75% 的 #8d641f
   在"Allow all"悬停时 20% 的底色上只有 4.25:1，见第 19 条）。代价：填得很少（几个百分点）时圆环看起来
   几乎是空的，数在悬停说明和读屏名里。
10. **圆环详情不算阻塞的浮层**（与选区浮层一样不挡 Alt+数字和 Ctrl+N）：它只是看数，又是 26px 的小目标、容易误点。
    模型、Effort、权限菜单仍算阻塞，但新的批准卡或询问卡来了时关闭，焦点回到按钮。
11. **这一行的按钮不可用时用 `aria-disabled`**，仍能 Tab 到、读屏能读到原因；按钮消失时焦点移到文字框。原因除了准备中和生成中的两句
    （"Can’t switch models until the response finishes"、"Can’t change effort until the response finishes"），其他状态沿用
    按钮位置的说明：后台进程退出"Mori’s background process crashed"、重新载入中"Restarting…"、Restart 之后重新打开中
    "Starting…"、打开失败"Session didn’t open"（只有权限按钮还在）、第一次打开中"Starting…"（也只有权限按钮）。
    原因代替悬停的第二行（例如不再说"Set the effort level for this session"；范围按钮的原因在第三行，第二行仍是提供商和区域）。权限按钮的样式加 `[aria-disabled='true']`
    （现在只有 `:disabled` 和 `:not(:disabled):hover`）。
12. **菜单往上打开**，对齐方式见"菜单的位置"：任何宽度都右边对齐自己的按钮、放不下时挪进这一行（权限菜单左对齐、圆环详情
    右对齐这一行）；最高 min(440px, 这一行上边到顶栏下边 − 12px)；权限菜单加上原来没有的高度上限。
    范围菜单 300px、切换失败那一行也往上弹出。
13. **顺手补上的原有缺口**（只是现在挤在同一行才显出来）：后台进程退出时权限菜单也关闭；"Queue"的下拉点外面关闭、
    打开时焦点进菜单、↑ ↓、Esc 回到 ▾；Tab 把焦点移到菜单外面时关闭（例外见 models.md"Tab 移出时关闭"）。
14. **Restart 之后重新打开中**范围按钮、Effort 和圆环保留上一次的值（不可用；`ModelState` 不清空），不像第一次打开那样藏起来，
    这一行不会突然变空；**打开失败**时藏起范围按钮、Effort 和圆环（没有会话可切）。
15. **顶栏的项目名**最长 160px、先收短到 40px 再截会话名，≤ 320px 不显示（Claude 是先藏项目名；Mori 保留"项目 › 会话"的顺序）。
    原来 660px（分屏 690px）以下就不显示项目名，现在 370px 的分屏一栏里也还在。
16. **F8 报告的"Current view"加三项**："Pane width"（焦点所在那一栏 `.chat-pane` 的宽度，这一行按它分档；分屏右边那一栏
    比 `.pane-slot` 窄 1px，分屏时比例不在报告里；不在会话页时"None"）、"Effort"（"High"、"Unavailable"等，没有当前模型时"None"）和"Model range"
    （`tab.pick`，没有时"None"；v1 的"Model"已是 `tab.current`，报告里应能看出按钮上显示的是什么）。上下文用量不加
    （报告里有截图）。字段的顺序见 [screens/f8.md](screens/f8.md)"保存的内容"。
17. **没有加**：Claude 的三个快捷键；"Compact session"。
18. **悬停说明两行，读屏的描述只有第二行**：三个按钮都设 `aria-describedby`，指向一个藏起来的元素，里面只有第二行。
    不这样 Chromium 会把整个 `title` 当成描述：第一行和名字重复（"Permission mode: Ask each time"念两遍）。范围按钮的描述是
    第二行（" · "换成", "："DeepSeek, Public"），不可用时加". "和原因；藏起来的元素在按钮外面（测试读按钮的 textContent）。
19. **"Allow all"的文字改用 `--color-warn-text`**（#855f1e，在它 12% 的底色上 5.09:1，悬停时 20% 的底色上 4.66:1；
    原来算的 75% 的 #8d641f 只在不悬停时够，悬停时 4.25:1，2026-10-22 审查时改成 70%）：原来的警示色 #b78022 在同一底色上
    只有 3.02:1，不到 12px 文字要的 4.5:1；现在文字是唯一的标志，窄时还会截成几个字母。底色仍是警示色的 12%，看起来仍是警示。
    不支持思考时 Effort 的字（`--color-faint` 在 `--color-surface` 上 3.08:1）也不到 4.5:1，这个按钮能点，所以改用
    `--color-muted`（与能用时同色），"Unavailable"这个字已经说明了状态（原来的问题，这次一起改）。
20. **圆环的悬停提示**在悬停和键盘焦点时都显示；Esc 先关详情，详情没开时 Esc 藏起提示（WCAG 1.4.13），焦点留在圆环；
    提示藏起时再按 Esc 才按 chat.md 的顺序停止生成。只因鼠标停在圆环上显示、焦点在别处时，Esc 也藏起提示，但不占这一下
    （照常停止生成、拒绝焦点所在的批准卡，分屏时以焦点所在的一栏为准；2026-10-22 审查时定）。
21. **准备中**（v1）：按钮位置是"Stop"和（有字时）只有一个按钮的"Queue"；≤ 400px 不收起"Queue"（只有一项，不值得收进 ▾），
    ≤ 340px 收到 28px。
22. **范围按钮的上限 200px、去掉 ≤ 760px 那一档**；**切换中加 `data-pending`**；**F8 加"Model range"**（都是按推荐定的，
    见"v1 之后的调整"最后一节）。

## 实现要改的地方（下一步，供参考）

- `app/src/renderer/src/components/ChatPane.tsx`：`TopBar` 去掉 `ModelMenu`、`ThinkingMenu`、`PermissionMenu`、`UsageChip`，
  只留面包屑、右栏开关和"Close pane"；`notReadyText` 照旧传给 `Composer`；`BlockedCard` 留在 `QueueArea` 和 `Composer` 之间（v1 原样）。
- `Composer.tsx`：`ComposerButtons` 变成这一行，各项都是 `.composer-bottom` 的直接子项、依次是 `PermissionMenu`、`ModelMenu`
  （v1 的选择范围按钮）、有 `tab.current` 时 `ThinkingMenu`、圆环、不能发送的说明或"Queue"的 `.split-button`、"Stop" / "Send"
  （不再包右边一组、不包范围按钮和 Effort）；删掉 `.composer-spacer`，改用 `.composer-bottom > .permission + * { margin-left: auto }`。
  范围按钮显示的条件：`phase !== 'failed'` 且（`phase !== 'opening'` 或已经有过模型状态：`tab.pick`、`tab.current`、`tab.blocked`
  有一个不为 null，即 Restart 之后的重新打开）；Effort 另要 `tab.current`。三个菜单的不可用用 `aria-disabled`。
  合并时 v1 的 `ComposerButtons`（`busy = running || sending`、`QueueButton steer={running}`、拒绝启动时"Send" `disabled`、
  `placeholderText`）和这里重建的 `.composer-bottom` 会冲突：以这里的结构为准，把 v1 的几处条件搬进去；准备中的占位文字改成
  "Enter to queue · Shift+Enter for new line"。准备中的"Queue"是单个按钮（不包 `.split-button`），另给一个类名（例如
  `.queue-button`），让 ≤ 400px 藏"Queue"主按钮的规则不碰它；≤ 400px 不藏、≤ 340px 28px。
  这一行里不能再有 textarea 或 input（`focusComposer`、`useFocusBack`、拖会话引用都找 `.composer textarea`）。
- 新的圆环组件（按钮 + 自画的悬停提示 + 详情浮层）：`data-testid="usage"`、`aria-expanded`、`aria-controls`、`data-state`、
  `data-percent`、`data-tokens`（各状态的值见 models.md"界面测试用的标识"；`aria-controls` 只在详情开着时设）；
  详情 `data-testid="usage-details"`；悬停提示在键盘焦点时也显示，Esc 能藏起；
  用 `useOutsideClose`，不用阻塞的 `useOverlay`（登记成不挡 Alt+数字和 Ctrl+N 的一种，与选区浮层相同）；不发命令。
- `PermissionMenu.tsx`：去掉按钮上的 `shield` 图标，只留 `.permission-text`（模式名，`text-overflow: ellipsis`）和 ▾；
  按钮不可用时关闭菜单（可以改用 `useSwitchMenu`）；悬停两行，第一行"Permission mode: {mode}"，第二行按模式换，
  不可用时是原因（"我自己定的"第 11 条）。
- `ThinkingMenu.tsx`：`disabled={disabled || running}` 改成 `aria-disabled` 加点击时判断（同 `ModelMenu.tsx`）；悬停的第一行是全文
  （"Effort: {name}"），第二行是原来的说明或不可用的原因（含后台进程退出、重新载入、重新打开中）；`usePendingSwitch` 有这一栏的值时
  （换强度或换范围）加 `data-pending="true"`。
- `ModelMenu.tsx`（v1）：`disabled={disabled || busy}` 改成 `aria-disabled` 加点击时判断；`title` 改成三行（"v1 之后的调整"的
  悬停表）；`aria-describedby` 指向 `.model-switch` 里、按钮外的藏起来的元素（`data-testid="model-tip"`）；切换中加 `data-pending`、
  不写"No model can run in this session"；`BUSY_TITLE` 不变（"Can’t switch models until the response finishes"）；`.pick-error`
  往上弹出。`useSwitchMenu` 的 `useEffect(disabled → close)` 留着；`useRangeMenu` 不改。
- 两个按钮能用时都不带 `aria-disabled`：写成 `aria-disabled={unavailable || pending ? true : undefined}`（同 v1 现在的写法），
  不写成 `aria-disabled={unavailable || pending}`（React 会写出 `aria-disabled="false"`，C1 列的三处测试会等不到）。
- `modelActions.ts`：不改（`openRangeMenu` 按 `tab.key`；`pick-error` 的 10 秒、打开菜单时清掉也不改）。
- 三个按钮都设 `aria-describedby`，指向藏起来的元素：权限、Effort 里只有第二行，范围按钮里是第二行（" · "换成", "）
  和不可用时的". <原因>"，不让 `title` 变成描述（"我自己定的"第 18 条）。
- 菜单的位置：各按钮的外层 `position: static`，菜单以 `.composer-bottom` 定位；打开时量按钮和这一行，左右按"菜单的位置"算
  （右边对齐按钮、放不下时挪进这一行），高度按这一行上边到顶栏下边算，窗口或这一行的大小变了时重算。
- `Composer.tsx` 的"Queue"：下拉加点外面关闭、打开时焦点到第一项、`moveMenuFocus`、Esc 焦点回 ▾；项"Steer"的名字只有文字，
  `.menu-hint` 加 `aria-hidden`，项上 `aria-keyshortcuts`；"Queue"按钮悬停"Queue for later (Enter)"。
- 新的 `useTabOutClose`（放在 `menu.ts`）：`focusout` 的 `relatedTarget` 不为 null、不在 root 里、不在 `MODAL` 里时关闭。
- 新的批准卡或询问卡出现时关闭这一行开着的菜单（订阅卡片列表变长）。
- 焦点所在的按钮消失时把焦点放回这一栏的文字框（`focusComposer`）：本轮结束时的"Stop"、"Queue"、▾，开始生成时的"Send"，
  打开失败时的模型、Effort，消失的圆环；Restart 之后重新打开中按钮还在（不可用），焦点不动。
- 收起"Queue"用 CSS 做：≤ 400px 藏起"Queue"主按钮、显示 ▾ 菜单里的"Queue for later"一项；只有图标的发送按钮的名字用
  `aria-label`，悬停用 `title`，不用藏起来的文字（`m1-replay` 读的是 innerText，见下）。
- `icons.tsx`：加 `queue` 图标；`shield` 只有权限按钮在用，去掉。
- `IssueDialog.tsx`：`tabFields` 在"Model"前加"Model range"（`tab.pick`，没有时"None"）、在它后面加"Effort"（没有当前模型时
  "None"），`currentView` 在"Window size"后面加"Pane width"（顺序见 screens/f8.md）。
- 样式：删掉只为顶栏按钮存在的规则——`chat.css` 的 `.breadcrumb` 的 `min-width: 36px` 和那段注释、`.topbar-actions` 里的按钮、
  `.usage-chip`、`.permission-menu` 往下居中的定位、760 / 660 / 600 / 500 / 400px 的顶栏 `@container`（包括 ≤ 400px 藏起
  `.permission-text` 的那条）；`models.css`（v1 版）往下居中的 `.switch-menu`、`.model-menu` 的 `calc(100vh - 80px)`、
  ≤ 600px 那段（`.model-switch, .thinking-switch { position: static }` 留下、改成任何宽度；以 `--topbar-height` 定位的
  `.switch-menu` 删掉）、≤ 400px 那段（▾ 和内边距改到 460 / 340px 两档）；`split.css` 690px 一档。新加这一行的 `@container`
  （680 / 600 / 460 / 400 / 340px，每档的内容见"宽度估算"）、截短的 `flex-shrink` 和 `min-width`、往上打开、
  `.composer-bottom { position: relative; min-height: 33px }`、高度上限，和顶栏的项目名规则（160px、先收短、
  ≤ 400px 收小内边距、≤ 320px 不显示）。顶栏的规则只写在 `.chat-pane > .topbar` 下（设置、Review、Customize 页也用 `.topbar`）。
  还要改的：
  - 删掉 `models.css` 的 `@container (max-width: 720px)`（范围按钮最长 120px 那一档），`.model-switch { max-width: 200px }`
    任何宽度；
  - `.model-switch { flex-shrink: 1; min-width: 40px }`（v1）和 `.thinking-switch { flex-shrink: 0 }` 改掉：截短的四项按"宽度估算"的
    "实现"设 `flex-shrink`（说明 1e18、范围按钮 1e12、权限 1e6、Effort 1）和 `min-width`（范围按钮 40 / 36px），其余各项
    `flex-shrink: 0`；`.range-*` 三条留着；
  - `.pick-error` 的 `top: calc(100% + 4px); right: 0` 改成往上、按范围按钮的右边对齐（打开时量位置算），最宽
    min(320px, 这一行的宽)；
  - ≤ 600px 只有图标的"Send"、"Stop"、"Queue"：`width: 32px`（≤ 340px 时"Send"、"Stop" 28px）；`.split-toggle` 在这一档
    `width: 24px; padding: 7px 4px`（现在是 32px）；
  - 权限按钮加 `[aria-disabled='true']` 的样式（同模型按钮：变淡、`cursor: default`、悬停不变色）；
  - 新的颜色 `--color-warn-text`（`color-mix(in srgb, var(--color-warn) 70%, var(--color-text))`，见"我自己定的"第 19 条）：`.permission-button.all`
    的文字和圆环 75–89% 的填充；有填充时圆环的底圈用 `--color-line`，空圆环用 `--color-faint`；
  - `.thinking-button.unsupported` 的字改用 `--color-muted`。
- 代码注释里写"顶栏"的地方跟着改（行号是 `6a57fd4` 的）：`ChatPane.tsx:1,3,44,133`、`ModelMenu.tsx:1,25,40,204`、
  `ThinkingMenu.tsx:1,68`、`PermissionMenu.tsx:1,49`、`modelActions.ts:1,26,53,121`、`actionLog.ts:83`、`actions.ts:384`、
  `settings.ts:26,125`、`settings/Defaults.tsx:16`、`styles/models.css:2,3,92`、`styles/chat.css:1,5,464,569`；后台进程和共用类型里的
  "顶栏菜单"（`kernel/commands.ts:74`、`modelSession.ts:739`、`selector.ts:2,240,324,326,350`、`sessions.ts:773,793`、
  `shared/models.ts:402,553,620`）改成不写位置的"范围菜单"。操作记录的文字不变（没有一条写了位置）。
  另有几处不写"顶栏"、也会过时的注释：`modelActions.ts:2,71`（"按钮下方一行"，`pick-error` 改成往上弹出）、
  `ThinkingMenu.tsx:70`（"窄于 600px"时只显示强度，改后是 ≤ 680px）、`styles/models.css:38,73`（"菜单居中在按钮下方"、
  "按钮下方一行原文"，这两条规则本来就要重写）。
- 不加后台进程命令，不改事件；`session.setMode`、`session.setPick`、`session.pickOptions`、`session.setThinking`、`session.state`
  照旧（v1 删了 `session.setModel`）。v1 的 fixture（`tests/fixtures/v1/`）也不重录。

## 测试要改的地方

都在 `app/tests/ui/`。行号是合并 v1 之后 `6a57fd4` 的（原来写的是 `16f9ab1` 的），后面写了函数名，行号对不上时按函数名找。
要保留的：`data-testid`（model-button、model-menu、model-menu-note、pick-error、thinking-button、thinking-menu、permission-button、
permission-menu、permission-allowed、usage、confirm-dialog、blocked-card、session-title、close-pane）、`usage` 每栏唯一、
范围按钮的 textContent 只有按钮文字（"<范围名> · <当前模型 id>"、模型 id 或"No model range"；描述元素在按钮外面）和
`data-pick`、`data-current`、Effort 的 textContent 带"Effort: "前缀（窄时藏起也在）、权限按钮只有模式名一段文字
（截短只是 CSS，textContent 仍是全名）、读屏名、菜单项的上下顺序（↓ 的次数）、选了之后焦点回按钮、第一次打开中不显示
范围按钮和 Effort。

v1 已经删掉、这里不用再改的（原来列了）：`m6-app-settings.mjs` 的 `topbarMenu`（原来 :673-674 调 `noteSmall`、:692 点外面关菜单）
和 `switchModelStep`；`m6-replay.mjs` 的 `modelSwitchSettings`、`modelMenu`、`modelSwitch`（原来 :510-514 点文字框关模型菜单）；
`m1-replay.mjs` 的 `noModelTopBar`（原来 :247-264）；`fixtures/m6/model-switch.json`、`thinking.json`（原来要留着的 `description`
也随之没有了）。

v1 的测试读按钮状态的地方共同的改法（下面写"按 C1 / C2"）：

- **C1 不可用**：`el.disabled` 不再表示"准备中 / 生成中 / 后台进程不可用"，改读 `aria-disabled === 'true'` 且没有 `data-pending`；
  "切换中"读 `data-pending === 'true'`。Effort 按钮同样（两个按钮共用一个切换中的值，换范围时 Effort 也带 `data-pending`）。
  能用时按钮上没有 `aria-disabled` 属性（不是"false"，见"实现要改的地方"）：`v1-models-app-session.mjs:385` `choosePick`
  （`!getAttribute('aria-disabled')`）、`m6-real.mjs:388` `switchModel`（`!hasAttribute('aria-disabled')`）、
  `m6-app-settings.mjs:484` `thinkingLevels`（`switching.at(-1) === 'high|null'`）靠它，所以这三处不用改。
- **C2 悬停**：`title` 变成多行（范围按钮三行、Effort 两行）。整串比较改成按 `\n` 分行：范围按钮第 1 行是按钮文字，第 2 行
  "<提供商名> · <区域>"（或"No model can run in this session"），不可用时第 3 行是原因；Effort 第 1 行"Effort: <x>"，第 2 行是
  说明或原因。读屏的描述读 `aria-describedby` 指向的元素。
- 文字常量不用改：合并后 `BUSY_TITLE`（`v1-models-app-session.mjs:42`、`v1-models-replay.mjs:45`）、`MODEL_BUSY`（`m6-real.mjs:49`）
  已是"Can’t switch models until the response finishes"，`MENU_NOTE`（`v1-models-replay.mjs:46`）和"Manage models"也已是合并后的字。
  `v1-models-app-session.mjs:1397`、`:1495` 的记录说明里还写着"Can't change the model while generating"，顺手改成常量的字。
- 只靠 `data-testid` 在一栏里找按钮的不用改（`${PANE} [data-testid="model-button"]` 在这一行里照样找得到）。

会失败、要重写的：

- `m3-app.mjs:296-312` `keyboardPath`：Shift+Tab 回会话树 ≤ 8 次、路径里依次有权限 → 思考 → 模型，改成 5 次（右栏开关 →
  左栏分隔线 → 底部两个按钮 → 会话行），再加一项：从文字框 Tab 往后依次是权限 → 范围 → Effort → 圆环（"Send"不可用时跳过）。
- `m6-app-slash.mjs:1047-1061` `shiftTabPath`：`presses === 8` 改成 5，文件头 :15 和 :1044 的说明跟着改。
- `m3-real.mjs:665-667`：≤ 8 改成 ≤ 5。
- `m6-app-slash.mjs:838` `paneBars`、`:903` `barProblems`、`:955` `menusOutside`：分成顶栏和这一行两部分。顶栏：
  项目名、›、会话名的宽度和全文、两个按钮、不溢出不裁切；这一行：权限的文字（任何宽度都没有图标，原来的 `permissionIcon`
  检查改成"没有 `shield`"）、Effort 前缀 / ▾、范围按钮的宽度 / ▾ / 读屏名 / 悬停、圆环、发送组，在 `.composer` 里不溢出不裁切。
  阈值按 models.md"窄栏"的新表（680 / 600 / 460 / 400 / 340px），500px 藏用量那一档去掉；范围按钮的上限 200px（不再有
  ≤ 720px 的 120px），最窄 40 / 36px。文字检查留着：读屏名 `MODEL_LABEL`（:827，"Model range: fake-coder"，不变）、
  "Effort: <x>"、"Permission mode: <mode>"；悬停按行查：范围按钮第一行"fake-coder"、第二行 `MODEL_TIP`（:828，
  "Mori endpoint · Local"），描述"Mori endpoint, Local"；权限第一行"Permission mode: <mode>"、第二行"Change the permission mode"
  （"Allow all"时"Edits, writes, and commands will run without asking."）；Effort 第一行"Effort: <x>"、第二行
  "Set the effort level for this session"。范围按钮里 `.range-model`、`.range-scope` 分别查是否截短（合成端点的范围是模型，
  只有 `.range-model`；分组范围另走一次 280px，见"新加的检查"第 3 条）。`menusOutside` 留着上下左右都在面板里的检查。
- `m6-app-slash.mjs` 的版面步骤 `wideLayout`（:999）、`midLayout`（:1026）、`narrowLayout`（:1068）、
  `splitLayout`（:1117）、`splitRight`（:1194）、`narrowSplit`（:1209）按新档改说明和期望；
  `bandLayout`（:1152）只为分辨原来的阈值，整段按新的档重写（没有 760px 一档）。
- `m6-app-settings.mjs:1054-1119` `LEVEL_TEXT` / `bucketOf` / `narrowSample` / `narrowProblems` / `narrowTopbar`
  （截图 `10-narrow-topbar`，两条记录在 :1110、:1117）：按新表分档，步骤和截图改名；`LEVEL_TEXT` 已是英文；范围按钮的宽度按
  200px 的上限。
- `m6-app-settings.mjs:403` `thinkingUnsupported`：`plain.color !== ctx.modelColor`（"变淡"）会失败：不支持思考时 Effort 的字改用
  `--color-muted`，和范围按钮同色（"我自己定的"第 19 条）。改成比 `data-reasoning="false"` 和按钮文字"Effort: Unavailable"，
  不比颜色；记录说明里的"样式变淡"跟着改，`buttonState`（:207-215）的说明里"变淡"用的颜色一项可以去掉。
- `m6-helpers.mjs:187` `topbarState` 改名、加这一行的宽度，另加 `.range-scope`、`.range-model` 两段的宽和全文宽；
  `:203` `menuInside` 加上下方向（`top ≥ 面板上边`、不伸出窗口底部），300px 的范围菜单在 280px 一栏里收到这一行的宽也要过。
- 点外面关菜单：往上打开的菜单可能盖住文字框中间，点文字框关菜单的检查要改成点对话流或顶栏的会话名，或先检查点的位置
  不在菜单里（原来列的两处 v1 已删掉；实现时再找一遍还有没有这样点的）。
- `m1-replay.mjs:154` 读 `.composer-bottom` 的 innerText 找"Stop""Queue"：默认 1200 宽时仍是文字，能过；限定到发送组，
  或改用读屏名找按钮。
- `page.mjs:63-65` `usageTokens` 和 `m1-replay.mjs:74-75` 读悬停说明里的"About X / Y tokens"：悬停改成"Context ≈ 15.4k / 128k (12%)"，
  改成读 `data-tokens`；用到它的 `m1-app.mjs:115-129`（`firstMessage`）、`m1-real.mjs:155,180` 不变。新会话第一条消息之前
  `data-tokens` 是 `0`、`data-state="empty"`，增长的检查从第一次回复之后开始比。
- F8 的"Current view"加了"Pane width"、"Effort"和"Model range"：比较字段的 `m2-app.mjs:1062`、`m2-replay.mjs:750-757`、
  `m5-app.mjs:277`（`followFocus`，:301-303）、`m2-real.mjs:570`、`m7-app.mjs:1395`、`m7-real.mjs:74` 逐个看：逐项比较字段列表的
  要加这三项，只查有没有某一项的不用改。

v1 的测试要改的（v1 新加或改过、读顶栏范围按钮和思考按钮的地方）：

- `v1-models-app-session.mjs`：
  - `topbar()`（:368-378）读 `disabled`、`title`、`thinking.disabled`：改名（例如 `pickers()`），返回 `unavailable`、`pending`、
    `tip`（分行）、`described`（描述元素的字），按 C1、C2；`text` 仍读按钮 textContent（描述元素在按钮外面，所以不变）。
  - `menuStep`（:1344 起）MP-23 label：`bar.title === 'Provider One · Local'` 改成 `tip[1] === 'Provider One · Local'`，另比
    `tip[0] === 'g1 · m1'`。MP-23 menu（:1366-1369）的说明和"Manage models"不用改。
  - MP-23 generating（:1397-1399）、preparing（:1495-1497）：
    `busy.disabled && busy.title === BUSY_TITLE && busy.thinking?.disabled` 改成
    `busy.unavailable && busy.tip[2] === BUSY_TITLE && busy.thinking.unavailable`，另比 Effort 的
    `tip[1] === 'Can’t change effort until the response finishes'`（准备中也用这两句）。
  - `watch` 的思考按钮快照（:494，`${button.dataset.reasoning}|${button.disabled}`）改读 `aria-disabled === 'true'`：不改的话
    `button.disabled` 一直是 false，MP-35 段内换模型的断言（:1603，`states.includes('true|true')`）会失败；断言本身不用改。
  - `noPickStep`（:536-554）、no_candidate 的"Change model…"（:631-636）：能过（`openRangeMenu` 按栏），菜单换到这一行、往上盖住卡；
    加位置检查：菜单在 `.composer-bottom` 上方、没盖到顶栏，Esc 后焦点在范围按钮。
- `v1-models-replay.mjs`：
  - `h.button()`（:153-157）读 `disabled`、`pending`（`aria-disabled`）、`title`：改成 `unavailable`、`pending`（`data-pending`）、
    `tip`；`text` 去掉"Model range: "前缀不变。
  - MP-23 replay range 的生成中（:463-465）：`busy?.disabled === true && busy.title === BUSY_TITLE` 改成
    `busy.unavailable && busy.tip[2] === BUSY_TITLE`。
  - `blockedMenu`（:381-393）：常量不用改；加菜单位置检查（同上）。
  - `watchPane`（:174 起）记下的 `disabled` 改按 C1，免得记下的序列没意义（断言只比 `current`、`running`、`errors`、
    `unavailable` 卡数，不会失败）。
- `v1-real-helpers.mjs` `rangeButton`（:232-238）：`disabled`、`title` 按 C1、C2 改，和别的 helper 一致（调用方
  `v1-models-real.mjs:106`、`:138` 只比 `text`、`pick`、`current`，不会失败）。
- `m6-real.mjs`（v1 改过）：`turnStart`（:240 起）返回 `unavailable`、`tip`；走查 8（:1070-1073）改成
  `model.unavailable && model.tip[2] === MODEL_BUSY && thinking.unavailable`，另比
  `thinking.tip[1] === 'Can’t change effort until the response finishes'`；
  走查 1 `switchModel`（:373）的记录（:432-438）里 ``shown.title.startsWith(`${ctx.conn.name} · `)`` 改成比第 2 行
  （`shown.title.split('\n')[1]`）；说明和"Manage models"不用改。
- `m6-replay.mjs`（v1 改过）：`topBar`（:209-219）按 C1、C2；thinking 回放（:396-399）改成读 `unavailable`、按行比
  `modelTip[2]`、`thinkingTip[1]`；`highSeen`（:390-393）的 `pending` 改读 `data-pending`（不然生成中也算切换中）。
- 不用改的（在一栏里按 `data-testid` 找按钮、菜单按页面找）：`v1-models-app-switch.mjs`（`choosePick`、:449-452 的思考按钮）、
  `v1-models-app-settings.mjs`（:293-305 的范围菜单）、`v1-models-app-session.mjs` 的 `choosePick`（:380，:385 等没有
  `aria-disabled`：能用时不带这个属性、加 `data-pending` 后仍对，这几处都在空闲时选；见 C1）、`chooseThinking`（:390）、
  `readMenu`（:1324）、`m6-helpers.mjs` 的
  `chooseModel`（:95）、`chooseThinking`（:104）、`v1-models-real.mjs`、`v1-models-record.mjs`、`v1-switch-helpers.mjs`、
  `v1-models-existing.mjs`。

覆盖不到这一行、要补上的：

- `m1-layout.mjs:93`、`m1-real.mjs:296` 的溢出检查列表已有 `.composer-bottom`，加圆环和发送组。
- `m5-app.mjs:347-367` `crampedRight`（800×600 分屏约 370px）：溢出检查加这一行，记录"标题行不溢出"改成"标题行和输入框下面一行都不溢出"。
- `m5-helpers.mjs:240-242` `smallText` 只查 `.topbar *`，加这一行、圆环的悬停提示和详情、范围菜单和 `pick-error`（没有小于 12px 的字）。
- `m2-app.mjs:927` `composerVisible`、`:957` `minWindow`：800×600 时除了"Stop"、"Allow once"、"Deny"，也查权限、范围、
  Effort 按钮和圆环完整可见、没被盖住。
- 只改记录说明里的"顶栏"二字、逻辑不变的：`m1-app.mjs:129`；`m1-replay.mjs:75`；`m2-app.mjs:255`；`m2-real.mjs:139,197,351`；
  `m2-replay.mjs:160,567`；`m6-helpers.mjs:2,92,103,138,186`；`m6-app-settings.mjs`、`m6-real.mjs`、`m6-replay.mjs`、
  `m6-record.mjs`、`v1-models-*.mjs`、`v1-real-helpers.mjs` 里写"顶栏"的说明（实现时 grep 一次）。`m6-record.mjs` 的说明也存在
  `fixtures/v1/blocked.json`、`range.json`、`thinking.json` 的 `description` 里，fixture 不手改，留着。
- 不受影响：会话名、"Toggle changes"、"Close pane"仍在顶栏的检查；设置、Review、Customize 页自己的 `.topbar`；
  `m5-app.mjs:443`（`jumpBack`）从文字框 Shift+Tab 两次到引用芯片（芯片仍在文字框上面）。

新加的检查（每条后面是它验证的状态表）：

所有宽度都是 `.chat-pane` 的宽度（分屏右边那一栏比 `.pane-slot` 窄 1px）。

1. 分屏时会话名有地方（chat.md"顶栏"）：1280 宽分屏（约 510px）、1180 宽分屏（约 460px）、401px、400px、370px（800 宽分屏）、
   321px、320px、300px（800 宽右栏打开）、分屏 280px，很长的会话名要么完整显示，要么占满顶栏剩下的地方（面板 − 内边距 −
   项目名和 › − 两个按钮 − 间距，差 2px 以内），460px 时至少 280px、280px 时至少 185px（TaskBoard 合入后顶栏有协作开关，
   改成 253px、168px）；项目名 ≤ 160px，会话名截断时项目名
   已收到 40px；≤ 400px 时两个图标按钮 28px、内边距收小；321px 时项目名还在，≤ 320px 时没有项目名和 ›。
2. 这一行在每一档、每种状态下（空闲、准备中、准备中有字、生成中、生成中有字、拒绝启动（`no_pick`：按钮"No model range"、
   没有 Effort）、"Starting…"、后台进程退出、Restart 之后重新打开中、打开失败"Session didn’t open"）都不换行、不超出输入框
   （chat.md"输入框下面一行"的状态表、models.md"窄栏"），宽度用 279px（右边一栏）、280px、300px、340px、341px、370px、400px、
   401px、460px、461px、490px、600px、601px、680px、681px、740px、930px（各档的上沿和下沿）；这一行高 33px（不能发送时也是）；
   每档该显示的东西都在（文字、▾、"Effort: "、发送组的文字或图标、圆环），收起的在读屏名和悬停说明里。
   Restart 之后重新打开中范围按钮、Effort、圆环仍在（不可用）；打开失败时没有范围按钮、Effort、圆环。
   权限按钮任何宽度、两种模式下都没有图标（按钮里只有 ▾ 一个 svg，≤ 460px 时一个也没有）、模式名的文字看得见（宽 ≥ 最窄）；
   "Allow all"在 280px 最挤时看得见的文字仍不同于"Ask each time"，警示色只是多一层；"Allow all"的文字和底色的对比度 ≥ 4.5:1
   （读计算后的颜色算）。只有图标时"Send"、"Stop"、"Queue"各 32px、▾ 24px（≤ 340px "Send"、"Stop" 28px）。
   宽于 400px 时 ▾ 菜单里没有"Queue for later"，只有"Steer"；≤ 400px 时依次是"Queue for later"、"Steer"，项的读屏名就是这两个词
   （没有" · "和快捷键），`aria-keyshortcuts` 是"Enter"、"Control+Enter"。准备中有字时是单个"Queue"（没有 ▾），400px 时仍在、
   ≤ 340px 28px。不能发送的说明截短时悬停说明是全文。
3. 截短（models.md"窄栏"、composer-pickers.md"宽度估算"）：每个宽度、每种状态下量权限、范围按钮、Effort 和不能发送的说明是否
   截短和各自的宽度。"是否截短"不能用 `scrollWidth > clientWidth`：审查时看得见"…"的那次两者都是 74。要比装字那个元素的
   `getBoundingClientRect().width` 和全文的宽（同字体的 canvas `measureText`，或一个 `width: max-content` 的藏起来的副本），
   窄 0.01px 以上就算截短。查先后：模式名截短时范围按钮已在最窄（差 1px 以内）；Effort 截短时范围按钮和权限都在最窄；
   范围按钮截短时不能发送的说明已在最窄；范围按钮里 `.range-model` 先截、`.range-scope` 后截（各量自己的宽和全文宽；
   `.range-model` 的全文带开头的" · "）。用一个提供商范围（"<名字> · <id>" ≥ 170px）：> 680px 时完整显示，600px 时
   `.range-model` 截短、`.range-scope` 完整，280px 最挤时范围按钮 36px、只剩范围名的开头。宽于 400px 时"Ask each time"、
   "Effort: Unavailable"、很长的"<提供商名> · <模型 id>"、生成中有字也不截模式名；280px 最挤时三个按钮都不窄于最窄
   （40 / 36 / 36px），圆环 26px、"Stop"和 ▾ 完整。截短的按钮看得见"…"，悬停的第一行和读屏名是全文。
   用"Extra high""Medium"和"Allow all"各走一次 280px。不比截短后的字面（"Ask …"之类由 Chromium 决定）。
4. 菜单（models.md"菜单的位置与键盘"）：范围、Effort、权限菜单、"Queue"的下拉、圆环详情往上打开，整个在会话面板和窗口里，
   不盖到顶栏；圆环详情在 601、680、740、761px、生成中有字、"Effort: Unavailable"时也在面板里；范围菜单、Effort 菜单和
   "Queue"的下拉右边对齐自己的按钮，或（放不下时）左边贴这一行的左端，任何宽度都不伸出这一行；用很短的范围（例如模型 id
   "o3"）、空闲、680px 和 930px 各开一次范围菜单（300px）；280px 一栏开一次（菜单收到这一行的宽，项名截断、区域完整）；
   换范围失败时（回放里让 `session.setPick` 报错一次）"Couldn’t change the model range: …"的 `pick-error` 从这一行往上弹出、
   在面板里、10 秒后消失、打开菜单时消失；权限菜单对齐左端；800×600、右栏打开、草稿 220px 高时菜单不出窗口、不盖顶栏，
   草稿 1 行和 220px 高时菜单的最高相同；有 30 条"Allowed for this session"时权限菜单在菜单里滚动。同时只开一个。
   自动关按"什么时候自动关"那张表逐行查：开着范围菜单时发送 → 关（准备中）；开着权限菜单时排队的消息开始新的一轮 → 不关；
   后台进程退出 → 权限菜单关、圆环详情不关；清空草稿 → "Queue"的下拉关；拒绝启动卡出现、消失 → 范围菜单不关。
5. Tab 移出（models.md"Tab 移出时关闭"）：Tab 到菜单外面的按钮 → 关；打开范围菜单、按 F8、按 Esc → 菜单仍开着、焦点在原来那一项；
   点范围菜单底部的说明 → 不关；打开权限菜单、点"Allowed for this session:" → 不关。
6. 键盘（models.md"键盘"、"不可用时、按钮消失时的焦点"）：Shift+Tab 5 次回会话树（TaskBoard 合入后 6 次）；从文字框 Tab 往后是权限 → 范围 → Effort → 圆环；
   准备中、生成中范围按钮、Effort 仍能 Tab 到、读屏描述里是不可用的原因（范围按钮的描述是"<提供商名>, <区域>. Can’t switch models
   until the response finishes"）；拒绝启动时范围按钮可用、"Send"跳过（`disabled`）；菜单里 ↑ ↓ Enter Esc，焦点回按钮；
   菜单开着、文字框里有字时在菜单里按 Enter 只选项、不发送也不排队；菜单开着时 Alt+1 和 Ctrl+N 不起作用；按钮消失时焦点到
   文字框，逐个查："Stop"上、本轮结束；"Queue"或 ▾ 上、本轮结束或清空草稿；"Send"上按 Enter 发出；范围按钮或 Effort 上、
   打开失败。Restart 之后重新打开中焦点留在原来的按钮上（按钮不可用但还在）。不可用的原因（读屏的描述、权限和 Effort 的悬停
   第二行、范围按钮的第三行）逐个状态查：准备中、生成中、后台进程退出"Mori’s background process crashed"、重新载入中
   "Restarting…"、重新打开中"Starting…"；读屏的描述里没有第一行；权限、Effort 的描述里没有" · "。
   400px 和 280px、生成中有字：Tab 到 ▾、Enter 打开 → 焦点在"Queue for later"，↓ 到"Steer"，Esc 回 ▾；选"Queue for later"真的排队
   （排队区多一条"Queued"）。
7. 新卡片来了（models.md"新的批准卡或询问卡来了"）：开着范围菜单时来了批准卡 → 菜单关、焦点在范围按钮、Alt+1 答了这张卡；
   开着圆环详情时来了批准卡 → 详情关，Alt+1 答了。
8. 圆环（models.md"上下文用量（圆环）"）：没有数据不显示；还没有消息（新会话：`data-state="empty"`、`data-tokens="0"`、悬停和读屏名
   "Context window"、详情里那句话）；有用量（悬停"Context ≈ …k / …k (N%)"、读屏名"Usage: Context approximately … of … tokens (N%)"、
   读屏的描述里没有"/"）；1,000,000 的窗口写成"1M"，999,950 写成"1M"（不是"1000k"）；≥ 75%、≥ 90% 的颜色（用合成端点的小上下文窗口）；刚压缩完
   （`fixtures/m1/compaction.json`：`data-state="compacted"`、底圈虚线、没有 `data-tokens`）；点开详情、开着时用量刷新详情跟着变；
   Esc 关闭、焦点在圆环；Tab 到圆环时悬停提示显示，Esc 藏起提示、不停止生成；`aria-controls` 只在详情开着时有；
   有填充时底圈是 `--color-line`、空圆环是 `--color-faint`；点开不发命令（回放时没有多出的命令）；后台进程退出后圆环保留最后的用量、详情仍能打开；分屏两栏各一个；
   没有小于 12px 的字。
9. F8 的"Current view"里"Model""Permission mode"照旧，多了"Effort"、"Model range"和"Pane width"（焦点所在那一栏 `.chat-pane` 的宽度；
   分屏时在右边那一栏按一次，比 `.pane-slot` 窄 1px）。
10. 拒绝启动卡的"Change model…"（`v1-models-app-session.mjs` `noPickStep`、no_candidate 那一步，
    `v1-models-replay.mjs` `blockedMenu`）：打开这一栏这一行的范围菜单，菜单往上、在面板里、在 `.composer-bottom` 上方、没盖到顶栏；Esc 后焦点在范围按钮；选一项后卡按
    `ModelState` 消失或换内容，菜单关闭。`no_pick` 时这一行没有 Effort、范围按钮"No model range"、"Send" `disabled`、280px 一栏里
    不溢出。
11. 准备中（MP-34 那一步）：按钮位置是"Stop"，有字时是单个"Queue"（没有 ▾），400px 时"Queue"仍在，范围按钮的描述里是
    "Can’t switch models until the response finishes"、Effort 的是"Can’t change effort until the response finishes"。

用真实模型走一遍（AGENTS.md 第 2 条，实现之后跑，断言改成新位置）：`m1-real`（用量随回复增长，读 `data-tokens`）、
`m2-real`（权限菜单在这一行、切到"Allow all"、按钮文字变成"Allow all"并用警示色、没有图标）、`m3-real`（Shift+Tab 5 次；TaskBoard 合入后 6 次）、
`m6-real`（走查 1：在这一行的范围菜单里选新模型，悬停第二行是"<提供商名> · <区域>"；走查 8：在这一行换 Effort；下一条回复来自
新模型；含一次分屏里的一栏）、`v1-models-real`（MP-27 读 `rangeButton`）。fixture 不重录：这次不改后台进程的事件和命令，回放用的
fixture 内容不变（v1 的 `fixtures/v1/*.json` 也不重录）；这是有意跳过录制这一步，在这一步的检查记录里写明。

## 文档

这次改了：`app-v0.md` 5.1、5.7、5.11、5.12、第 7 节 M6 一行、第 11 节；`v0/screens/models.md`（重写）、`chat.md`、`approval.md`、
`split.md`、`layout.md`、`sessions.md`、`settings.md`、`f8.md`（"Current view"加三项）、`README.md`；`v0/defaults.md`；
`v0/ui-strings.md`（上下文、权限按钮、模型和 Effort 的悬停、不可用的原因、发送和排队按钮几行，"F8 报告"的 Current view 三项；
原来顶栏宽度的实现记录标为被本文取代）；`app/README.md` 第 15、83 行（"顶栏"的模型和思考菜单改成输入框下面一行）。
合并 v1 之后一起改了 v1 的文档（`v1/screens/model-menu.md`、`model-chat.md`、`README.md`、`models-settings.md`）和
`docs/specs/model-providers.md`、`docs/proposals/model-providers.md` 里写"顶栏"的范围菜单（只改位置的说法，"按推荐定的"第 13 条）。
不改：`v0/m1-checks.md` 到 `m7-checks.md`（当时的记录，例如 m3、m6 里"Shift+Tab 8 次"），这一步自己的检查记录里写明改了什么。
`v1/models-checks.md` 的记录不改，只改了走查步骤 2、4、7 里范围菜单和思考强度的位置（实现时改的）；它"你决定的"第 8 条的
合并要求（把顶栏的范围菜单搬进输入框下面那一行，"thinking"的说法改成 Effort）怎样做到的，写在检查记录"你决定的"里。

## 2026-10-22 静态审查后改的（没有跑界面测试）

这台机器上另一个会话在跑界面测试，这一轮只做了静态修改，跑过的只有 `npm run check`、`npx electron-vite build`、
`npm run test:unit`。每一项要用哪个测试验证，记在这一步的验证清单里（实现那一步的检查记录写好前，先看交付说明）。

- 右栏开关（split.md"右栏开关"）：用鼠标主键按在开关上时，到这一下点完（或在别处松开）才把焦点切到这一栏，焦点照常由
  按下鼠标放到开关上；右键、键盘照常。原来在按下那一刻切焦点，右栏先换成这一栏的状态、开关被挤走，这一下点空
  （上一轮诊断时发现的）。这是 split.md"焦点所在的一栏"的例外，已写进 split.md。
- 圆环的悬停提示：只有焦点在圆环上时才在 Esc 的浮层栈里（见"我自己定的"第 20 条）。
- 权限按钮变得不可用时，开着的"Switch to “Allow all”?"确认框按取消关上（approval.md）。
- 范围按钮的读屏名里" · "换成", "（"Model range: fast, deepseek-chat"，ui-strings.md"读屏名里不用 · 和 /"；
  按钮文字和悬停第一行不变）；范围菜单每项的读屏名只有名字，区域（逗号分隔）和被排除的原因在读屏的描述里。
- `--color-warn-text` 从 75% 改成 70%（#855f1e），"Allow all"悬停时也够 4.5:1（见第 9、19 条）；圆环悬停时的底色用
  `--color-surface`，空圆环的底圈够 3:1（defaults.md"上下文用量圆环的样子"）。
- 圆环的颜色分档按四舍五入后显示的百分比（与悬停、读屏里的数一致），写进 models.md 和 defaults.md。
- 测试：`m6-app-slash.mjs` 超过 2000 行，各档的边界和拒绝启动两节搬到 `m6-app-bands.mjs`（记录的名字不变）；
  `m6-app-row` 加分屏 279 / 280px 的准备中、单栏准备中补上 740 / 490 / 370 / 321 / 320px；`m5-app` 加"点另一栏的右栏开关"；
  其余是把检查收严（量到的宽度、点的位置、切换中、最窄量在这一行的直接子项上、错误日志按注入的次数扣）。

还没定、留给走查的（静态看不出来，或是这次没改的老问题）：

- 切换中（`data-pending`）范围按钮和 Effort 没有 `aria-describedby`，Chromium 可能把 `title`（按钮文字，含" · "）当成读屏的
  描述，与"切换中没有描述"不符；"Send""Stop""Queue"的描述可能是"Send (Enter)"之类、和名字重复。要在 DevTools 的
  无障碍面板里看一次再定改法。
- 一些 12px 的字对比度不到 4.5:1，都是这次之前就有的颜色：`.composer-wait`、`.menu-hint`、菜单里被排除的项（`--color-faint`，
  3.22:1；被排除的项变淡是 v1 model-menu.md 定的）、`.pick-error`（4.02:1）、宽于 600px 时的"Stop"和"Send"（约 4.2–4.3:1）。

## TaskBoard 合入之后（2026-10-22）

这一步把 composer-pickers rebase 到合并了 TaskBoard 的 `app-v0`（`046a9ca`）上。按上面"给 TaskBoard 留的位置"，协作开关
（`TeamSwitch.tsx`，`data-testid="team-switch"`，`role="switch"`）是顶栏右边一组（`.topbar-actions`）的第一个，在
"Toggle changes"前面；顶栏从左到右是"项目名 › 会话名"、协作开关、右栏开关、分屏时的"Close pane"。

合并时按两边的意思合的（不是选一边）：

- 协作模式下锁定的模型按钮（`pickLocked`，平行 Agent 规格 §12.11）跟着模型按钮到这一行：`ModelMenu` 在锁定时画只显示模型 id、
  不能打开菜单的按钮（`LockedModelButton`），否则画范围按钮和菜单（`RangeMenu`）。
- Stop team（§11.4、§13.6）进了发送组：在"Stop"或"Send"前面，是这一行的直接子项，用发送组的 `RowButton`
  （≤ 600px 只有图标，最终审查后改成 ≤ 760px；读屏名"Stop team"，按钮消失时焦点回到文字框）；`data-testid="stop-team"` 不变。
- 被拒绝启动时 `/team on`、`/team off` 仍能发（发送组的"不可用"排除它们）；排队区的待判断消息、权限菜单的协作模式说明照 TaskBoard。
- 文档里 TaskBoard 加的"（协作模式：……）"注都留在新位置（chat.md 顶栏一行改成协作开关一项，模型一项的注挪到这一行的表里）。

### 顶栏的宽度（在 App 里量的）

开关的宽：`Team: Off` 66.3px、`Team: On` 65.6px、`Team: Until done` 105.1px、只有状态点 19px（12px Segoe UI）；
和右栏开关之间 8px（≤ 400px 时 4px）。会话名很长、项目名收到 40px 时会话名能用的宽度（`m5-app` 量到的与下面的估算一致）：

| 会话面板 | 没有开关（上面"宽度估算"） | 有开关 |
| --- | --- | --- |
| 930px 单栏 | 约 770px | 约 665px（完整文字） |
| 601px 分屏 | 约 425px | 约 315px（完整文字） |
| 510px 分屏（1280 宽） | 约 335px | 307px（状态点） |
| 460px 分屏 | 约 285px | 258px |
| 401px 分屏 | 约 225px | 199px |
| 400px 分屏 | 约 245px | 224px（≤ 400px 内边距、间距和图标按钮收小） |
| 370px 分屏（800 宽） | 约 215px | 193px |
| 321px 分屏 | 约 170px | 145px |
| 320px 分屏 | 约 235px | 213px（不显示项目名） |
| 300px 单栏（800 宽、右栏打开） | 约 245px | 223px（不显示项目名） |
| 280px 分屏 | 约 190px | 173px（不显示项目名） |

窄栏的阈值从 860px 降到 600px（`team.css`）：宽于 600px 时最宽的"Team: Until done"也给会话名留下约 315px 以上，和 1280 宽
分屏里只有状态点时（307px）差不多；再窄时开关先只剩状态点，不再挤会话名。600px 也是这一行发送组只剩图标的一档，两处一起变。
TaskBoard 为挤下状态点加的两处收紧去掉了：面包屑至少 105px（顶栏不再有模型按钮可以让位）、分屏 ≤ 600px 按钮间距 6px /
图标按钮 28px 和 ≤ 400px 间距 2px / 图标按钮 24px（与 chat.css ≤ 400px 时 28px 的图标按钮冲突，现在也放得下）。

### Tab 停靠点

从新会话的文字框 Shift+Tab 回会话树：M6 是 8 次，TaskBoard 加了协作开关是 9 次，这一步之后是 6 次——右栏开关 → 协作开关 →
左栏分隔线 → 左栏底部的两个按钮 → 会话行（权限、范围、Effort、圆环在文字框后面，不在这条路上）。开关在会话打开中、后台进程
没接上时是 `disabled`、不在 Tab 路径上；测试里的 `ctrlN` 等会话打开好才返回，所以次数是确定的。从文字框往后 Tab 不变
（权限 → 范围 → Effort → 圆环 → 发送组；协作模式下发送组前多一个 Stop team）。

### 测试改的

- `m3-app`（走查 2）：`presses === 6`，路径第一步"Toggle changes"、第二步 `team-switch`、第三步分隔线。
- `m3-real`（走查 2）：不超过 6 次，第一步"Toggle changes"、第二步"Team: …"。
- `m6-app-slash`（`shiftTabPath`）：`presses === 6`，第一步"Toggle changes"、第二步 `team-switch`；文件头和说明跟着改。
- `m6-helpers` `topProblems`：顶栏按钮是协作开关、"Toggle changes"（分屏时再加"Close pane"）；开关宽于 600px 时是完整文字、
  没有状态点，≤ 600px 时只有状态点（≤ 20px）；28px 的检查只看图标按钮；460px 时会话名至少 253px、280px 时至少 168px
  （量到 258、173px，原来是 280、185px）。
- `m5-app`（`titleRoomCheck`）：同样的下限（460px 253px、280px 和 279px 168px；最终审查前 279px 是 167px，改成与 `m6-helpers` 一样，279px 量到 172px），记录里加上量到的会话名宽度。
- `tb-app-roles` TB-53：把这一栏调到 601px 和 600px（右栏打开）比阈值两边：601px 完整文字、600px 只有状态点；`tb-replay`
  TB-53 的阈值改成 600px。
- 记录说明里"顶栏只有会话名和右栏开关"的地方加上协作开关（`m6-app-slash`、`m6-app-bands`）。
- 全部开发构建套件跑下来（2026-10-22）又改的：
  - `m4-app` 走查 4、`m4-real` 走查 4：生成中拖选先把那一段滚到视野底部（`dragSelect` 的 block 'end'），不再滚到中间。
    输入框下面多了一行之后对话流矮了一点，滚到中间时那一段下面只剩约 23px（不到 `BOTTOM_SLACK` 24px），对话流按"在底部"
    恢复跟随；量好坐标到按下鼠标之间流入一行，字被往上推一行，选中的是上一行同一位置的字（5 遍里 3 遍）。程序的行为照规则，没有改。
  - `tb-app-stop` TB-42：删除后等确认框关上（主进程删完 `teams/<id>` 才返回）再看目录；会话列表在会话文件删掉时就去掉那一行，
    原来在这时看，`teams/<id>` 还没删完。
  - 内核：`model-config.json` 与模型档案的改名替换也按 board.json 的做法在 Windows 上重试（`renameRetry.ts`）；task 会话
    中途换模型等到时钟真的过了 hideUntil 再写 `mori.task_restart`（计时器可能比 `Date.now()` 早到）。

### 按推荐定的（负责人以后看）

1. 窄栏阈值 600px、窄时只有状态点（TaskBoard 的样子）。没选：规格原稿的"Team ●"（约 55px，窄栏会话名再少约 36px）；
   不设阈值、任何宽度都是完整文字（280px 一栏会话名只剩约 90px）。
2. Stop team 作为发送组里的一项、≤ 600px 只有图标（最终审查后改成 ≤ 760px：带字时 601–708px 最挤会截模式名）。没选：保持带字的按钮（≤ 600px 时这一行更挤，400px 以下放不下）。
3. 锁定的模型按钮放在这一行原来模型按钮的位置、用同样的截短规则。

### 当时还没处理的（2026-10-22 最终审查后都改了）

- 分屏 280–295px 一栏、生成中、输入框有字、后台有 Agent（有 Stop team）时这一行放不下：权限、范围、Effort 已到最窄
  （40 / 36 / 36px），Stop team 多出 28px 加一个间距，按估算超出约 16px（准备中有字时约 20px）。宽于约 296px 时放得下。
  按推荐定成：≤ 340px 有 Stop team 时收起排队的按钮（"Queue ▾"和准备中的"Queue"），Enter、Ctrl+Enter 照样用
  （models.md"窄栏""最窄"、defaults.md；`tb-app-stop` 的 TB-54 在单栏 930–300px、分屏 296–279px 量过）。
  没选：把 Stop team 放进 ▾ 的菜单（准备中没有 ▾，还要另一种做法）。
- 分屏时用鼠标点另一栏的协作开关：右栏开关为了"按下时右栏跟着换、两栏变宽、松开时点空"在按完才切焦点（`ChatPane.tsx`
  `usePaneFocus`，split.md"右栏开关"），协作开关和"Close pane"也在同一组、会被同样挤动。改成顶栏右边一组的按钮都这样
  （`isTopBarAction`）；`m5-app` 的 `teamOther`、`closeKeeps` 在两栏的右栏状态不同时用鼠标点另一栏的协作开关和"Close pane"。

## 视觉走查（2026-10-22）

在开发构建里对合成端点（synthetic）截图看了一遍：会话面板 930、861、860、761、680、600、460、400、340、300px（单栏，
窄于 740px 时右栏打开）、分屏左栏 280px 和 1184×735 的分屏，状态是空闲、生成中有字、准备中有字、拒绝启动（`no_candidate`）、
"Allow all"、"Effort: Unavailable"（空闲和生成中有字）、圆环 0% / 50% / 80% / 95%、刚压缩完；930 和 300px 时打开权限、范围、
Effort 菜单、"Queue"的 ▾ 和圆环详情；930、460、400、300px 时从文字框 Tab 过这一行、顶栏的协作开关和右栏开关看焦点环；
另把协作开关切到"Team: On"看 930–300px。会话名用很长的"Give split-pane titles more room with English labels"。
截图脚本不是测试套件，没有提交；每张截图同时用 `m6-helpers.mjs` 的 `paneProblems` 量了顶栏和这一行，除了脚本自己标错的
两处（拒绝启动时分屏右栏也被拒绝启动，按空闲查；协作模式下范围按钮是锁定的样子），都没有问题。

改了的：

- **4px 间距时焦点环压到旁边的按钮**：全局的焦点环是 2px 线、离按钮 2px，伸出 4px；这一行 ≤ 460px、顶栏 ≤ 400px 时按钮
  间距只有 4px，环的外沿正好碰到旁边的按钮，后面的按钮还会盖住一截（圆环的环被"Send"盖住右边）。这两档里这一行的按钮和
  顶栏右边一组的按钮，焦点环离按钮 1px（`chat.css`），环和旁边的按钮之间留出 1px，"Send"这种实心按钮的环和按钮之间仍有
  1px 的白缝。
- `TeamSwitch.tsx` 文件头的注释还写着"不宽于 860px"和"模型、思考强度、权限按钮之前"，改成 600px 和"右栏开关之前"。

看了没改的（照规格，或要你定）：

- 协作开关按这一栏的宽度收成状态点（600px，"TaskBoard 合入之后"的"按推荐定的"第 1 条），不看会话名放不放得下：
  600px 一栏里这个会话名其实还放得下"Team: Off"。601px 起是完整文字，没有更早收起。
- 用量很少（0–几 %）时圆环只有很浅的底圈（`--color-line`），50% 时一半强调色的弧看起来有点像加载中的转圈；这是"我自己定的"
  第 9 条为了填充和底圈的对比度选的，没改。
- 准备中、生成中不可用的范围按钮和 Effort 字很淡（不可用的样式），分屏 462px、生成中有字、"Effort: Unavailable"时范围按钮只剩
  "fa…"；这是宽度估算里 461–600px 一档最挤时的样子（▾ 还在），照规格。

放进文档的截图（[composer-pickers/](composer-pickers/)，都是合成端点，没有 key 和个人信息；改焦点环之前截的，这几张里没有焦点环）：

| 文件 | 内容 |
| --- | --- |
| `idle-930.png` | 930px 空闲：顶栏"项目名 › 会话名"、"Team: Off"、右栏开关；这一行权限在左，范围、"Effort: Medium"、圆环、"Send"在右 |
| `generating-draft-unavailable-280.png` | 分屏 280px、生成中有字、"Unavailable"（最挤）：模式名、范围、Effort 都截到接近最窄，圆环、▾、"Stop"完整 |
| `generating-draft-split-1184x735.png` | 1184×735 分屏，左栏生成中有字（发送组只有图标），右栏空闲 |
| `preparing-draft-400.png` | 400px 准备中有字：单个"Queue"图标按钮（不收起）和"Stop" |
| `blocked-460.png` | 460px 拒绝启动：输入框上方的卡，这一行没有 Effort，"Send"不可用 |
| `allow-all-300.png` | 300px "Allow all"：警示色的模式名，顶栏只有状态点 |
| `range-menu-300.png` | 300px 范围菜单往上打开、收在这一行的宽度里 |
| `rings-930.png` | 930px 圆环 0% / 50% / 80% / 95% / 刚压缩完（五张截图里这一段拼在一起，放大 2 倍） |

## 打包版（2026-10-22）

`npm run dist:dir` 之后逐个文件比了 `dist/win-unpacked/resources/app.asar` 里的 `out/` 和 `app/out/`：327 个文件
SHA-256 都相同，两边没有多出的文件。对 `Mori.exe`（`--exe`）跑了 m0-smoke、m1–m7 的 App 套件（含 `m6-app-row`、
`m6-mcp-cost`）、v1 模型层的三个 App 套件、TaskBoard 的九个 App 套件，以及 m0–m7、`v1-models-real`、`tb-real` 的真实走查。
程序没有改；改的是两处测试的预期：

- `tb-app-roles` TB-03：pi 的 system prompt 写着它自己文档的路径（pi 包所在的 `node_modules`），对照构建是开发构建，
  打包版的 pi 在 `resources/app.asar/node_modules`，两边差 111 个字。打包版运行时把对照里这个路径前缀换成打包版的
  （`baseSystem`），其余仍逐字节比较。这是 TaskBoard 的 App 套件第一次跑 `--exe`（team-checks.md 记着之前只跑过开发构建）。
- `m1-real` 走查 8：上下文只有 8000 时最后一条回复常被截断（stopReason `length`，输出没到 maxTokens），pi 把它从上下文去掉
  （`context_edit`，replacement 为 null）准备压缩后重试；刚压缩过、没有可压缩的就不重试，这条回复留在对话流里。压缩之后
  只有这一条回复时 pi 的用量是空的，圆环是"刚压缩完"，原来的测试却按"最后一项是回复"要有用量（4 遍里 1 遍）。现在按会话文件
  照 pi 的规则判断（`usageAfterCompaction`），models.md"刚压缩完"一行也写上这种情形。
- `m1-real` 走查 3 的反例两遍没过：模型把命令写成 `ls does-not-exist-dir; echo "exit=$?"`，以 0 结束，"Done"是对的
  （english-ui-checks.md 记过同样的事）；第三遍模型照原样运行，过了。没有改测试。

看到了、没有改的：上面那条被 pi 去掉的截断回复，界面上照常显示，没有任何说明，下一条消息时模型看不到它。这是 pi 的恢复
没做成时的行为，不是这一步改出来的，等你定要不要提示。

## 没有验证的

- ~~所有宽度都是按字形宽度和现在的 CSS 算的，没有在 App 里量~~（设计时写的，已过时）：实现后各档的宽度、截短的先后和
  会话名的宽度都在 App 里量了（`m6-app-row`、`m6-app-bands`、`m5-app`、`tb-app-stop` 的 TB-54 和视觉走查，见检查记录）。
- `flex-shrink` 相邻差 1e5 以上能排出截短先后、差 1000 不行，是审查时在 Edge 的草稿页里试的，不是在 App 里。
- Claude 桌面版的样子来自它的文档、字串表和本机安装包里的代码（设计审查时读的），没有打开 Claude 对照截图。
- "pi 在还没有消息时给 0"是读 pi 1.3.0 的 `getContextUsage()` 得出的，没有在真实会话里记一次。

## 待你决定

- "TaskBoard 合入之后"的"按推荐定的"3 条和当时"还没处理的"两条（最终审查后按推荐改了，见那一节）。

- "v1 之后的调整"最后一节"按推荐定的"16 条（范围按钮的上限、三行悬停、准备中的"Queue"、切换失败往上浮出、文档分工、
  规格里的"顶栏"等）。

- 截短的顺序（范围按钮先于模式名，Effort 最后；按钮里先截模型 id、再截范围名）和最窄宽度——见"我自己定的"第 1 条。
- ≤ 400px 就收起"Queue"、≤ 340px 收小发送按钮和内边距——见"我自己定的"第 4、5 条。
- 权限、Effort 的悬停加上全名一行——见"我自己定的"第 2 条。
- "Allow all"的文字改深、不支持思考时 Effort 的字不再变淡、有填充时圆环的底圈改浅——见"我自己定的"第 9、19 条（为了对比度）。
