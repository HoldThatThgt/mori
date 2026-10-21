# 设计说明：模型、Effort、权限和上下文用量移到输入框下面一行（2026-10-21）

这一步只是设计，没有改代码、没有跑测试；这次的改动只有文档（`docs/` 下这些文件和 `app/README.md` 两行）。
状态表在 [screens/models.md](screens/models.md)（模型、Effort、圆环、菜单、窄栏）、[screens/approval.md](screens/approval.md)（权限菜单）、
[screens/chat.md](screens/chat.md)（顶栏、输入框下面一行、各状态下这一行的样子），临时默认值在 [defaults.md](defaults.md)。
这里记下为什么、怎样估的宽度、我自己定了什么，以及实现和测试要改的地方。

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

## 改后的样子

```
顶栏    | composer-pickers > Give split-pane titles more room with English labels    [右栏] [x] |
                                                                  （x 只在分屏时）
输入框  +--------------------------------------------------------------------------------------+
        | （引用芯片）                                                                         |
        | 文字框                                                                               |
        | [Ask each time v]             [deepseek-chat v] [Effort: High v] (圆环) [-> Send]    |
        +--------------------------------------------------------------------------------------+

分屏 280px 的一栏、生成中有字（最挤；示意，省略号前留几个字母由 Chromium 决定）：
        +---------------------------------------+
        | [Ask …] [de…] [Unava…] (圆环) [v] [■] |
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
  Shift+Tab 回会话树从 8 次变成 5 次。
- 顶栏下的横幅（pi 关于"没有默认模型"的说明 `modelNotice`、信任横幅、扩展错误）位置不变。

## 照 Claude 桌面版（键取自 Claude 的 `ion-en-US.json`）

| Mori | Claude 的原词（键）和它在 Claude 里的位置 | 用法 |
| --- | --- | --- |
| 模型按钮读屏名 | "Model: {name}"（`0ZMx/tNv6m`） | 原来就是 |
| 没有模型时的悬停 | "Select model"（`e15QX1hh5v`） | 原来就是 |
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
| 不可用的原因（生成中以外） | 沿用 Mori 按钮位置的说明："Mori’s background process crashed"、"Restarting…"、"Starting…"、"Session didn’t open" | 权限、模型、Effort 不可用时悬停的第二行和读屏的描述（见"我自己定的"第 11 条） |
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
- 模型按钮最长 160 / 120px，最窄 40px（≤ 340px 时 36px）。
- Effort："Effort: Unavailable ▾" 125.9px、"Unavailable ▾" 91.1px、"Unavailable" 73.1px（最宽的强度；≤ 340px 69.1px；
  "Extra high" 64.8px，"High" 37.3px）；最窄 40px（≤ 340px 时 36px）。
- 最窄的宽度里字有多宽：≤ 460px（没有 ▾）时权限 32px、模型 28px、Effort 28px；宽于 460px 时有 ▾，
  同样的最窄里字只剩约 10–14px。下面算下来宽于 460px 的各档最挤时也截不到最窄，只是写清楚。
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
| > 760px | 全部带文字："Ask each time ▾"、模型（最长 160px）▾、"Effort: High ▾"、圆环、"Send" / "Stop" / "Queue ▾"；间距 8px |
| ≤ 760px | 模型按钮最长 120px |
| ≤ 680px | Effort 去掉"Effort: "，只显示强度（"High ▾"） |
| ≤ 600px | "Send" / "Stop" / "Queue"只有图标（各 32px，▾ 24px；名字在读屏名和悬停说明里） |
| ≤ 460px | 权限、模型、Effort 去掉 ▾；间距 4px |
| ≤ 400px | 生成中有字时"Queue"收进只有 ▾ 的"More send options"（菜单里"Queue for later"和"Steer"），"Stop"不动 |
| ≤ 340px | "Send" / "Stop"图标按钮 28px；权限、模型、Effort 左右内边距各 4px |

这样还放不下时依次截短，前一项截到它的最窄才轮到下一项；截短的加"…"，全文在悬停说明的第一行和读屏名里：

1. 不能发送时按钮位置的说明（最窄 48px；悬停说明和横幅里有全文）；
2. 模型 ID（最窄 40px，≤ 340px 时 36px；" (deleted)"最后截）；
3. 权限的模式名（最窄 44px，≤ 340px 时 40px）；
4. Effort 的强度（最窄 40px，≤ 340px 时 36px）。

圆环、"Send" / "Stop" / ▾ 不收。模型先于模式名截，照负责人的意思（模式名截断，即使模型按钮因此更挤）：
模式名关系到会不会不经询问就执行；Effort 最后，因为常用的强度（"High""Low""Max""Off"）本来就短，截了也省不了多少。

逐档的数（最挤的情况：生成中、输入框有字，"Ask each time"，"Effort: Unavailable"，模型 ID 很长、想占满上限；
"下沿"是这一档最窄、最挤的宽度）：

| 会话面板 | 这一行 | 用的档 | 模型以外各项加间距 | 模型 | 权限 | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 761px（> 760 的下沿） | 683 | > 760 | 103.7 + 125.9 + 26 + 100.1 + 77.6 + 40 = 473.3 | 209.7，取 160 | 完整 | 完整 |
| 760px | 682 | ≤ 760 | 473.3 | 208.7，取 120 | 完整 | 完整 |
| 681px（下沿） | 603 | ≤ 760 | 473.3 | 129.7，取 120 | 完整 | 完整 |
| 680px | 602 | ≤ 680 | 103.7 + 91.1 + 26 + 100.1 + 77.6 + 40 = 438.5 | 163.5，取 120 | 完整 | 完整 |
| 601px（下沿） | 523 | ≤ 680 | 438.5 | 84.5 | 完整 | 完整 |
| 600px | 522 | ≤ 600 | 103.7 + 91.1 + 26 + 56 + 32 + 40 = 348.8 | 173.2，取 120 | 完整 | 完整 |
| 461px（下沿） | 407 | ≤ 600 | 348.8 | 58.2 | 完整 | 完整 |
| 460px | 406 | ≤ 460 | 85.7 + 73.1 + 26 + 56 + 32 + 20 = 292.8 | 113.2 | 完整 | 完整 |
| 401px（下沿） | 347 | ≤ 460 | 292.8 | 54.2 | 完整 | 完整 |
| 400px | 346 | ≤ 400 | 85.7 + 73.1 + 26 + 24 + 32 + 20 = 260.8 | 85.2 | 完整 | 完整 |
| 341px（下沿） | 287 | ≤ 400 | 260.8 | 26.2，不到最窄，取 40 | 85.7 − 13.8 = 71.9（截断） | 完整 |
| 340px | 286 | ≤ 340 | 81.7 + 69.1 + 26 + 24 + 28 + 20 = 248.8 | 37.2（比最窄多约 1px） | 完整 | 完整 |
| 280px | 226 | ≤ 340 | 圆环、▾、"Stop"和间距 26 + 24 + 28 + 20 = 98，三个按钮共 128 | 36（最窄） | 128 − 36 − 69.1 = 22.9，不到最窄，取 40（截断） | 128 − 36 − 40 = 52（截断） |
| 279px（右边一栏） | 225 | ≤ 340 | 98，三个按钮共 127 | 36（最窄） | 40（截断） | 51（截断） |

宽于 400px 的各档在下沿最挤时模式名完整、模型按钮至少约 54px；400px 起最挤时才截模式名。340px 时模型只比最窄多约 1px，
实测宽几 px 时模式名会截一点（这一档允许）。280px 时三个按钮都接近最窄，Effort 比它的最窄多 16px（右边一栏 15px），
留给估算的误差。其他常见宽度：370px（800 宽窗口分屏，≤ 400 档）316 − 260.8 = 55.2，模型约 55px、模式名完整；
300px（800 宽窗口右栏打开，≤ 340 档）246 − 98 = 148，模型 36px、权限 148 − 36 − 69.1 ≈ 43px（截断）、Effort 完整；
490px（1200 宽窗口右栏打开，≤ 600 档）436 − 348.8 ≈ 87px。

其他状态在 280px 一栏（≤ 340 档）：

- 空闲、"Effort: High"：圆环 26 +"Send" 28 + 4 个间距 16 = 70，三个按钮共 156：权限 81.7 + Effort 33.3 = 115，
  模型约 41px，模式名完整。"Unavailable"时 156 − 81.7 − 69.1 ≈ 5，模型取 36，权限 156 − 36 − 69.1 ≈ 51px（截断）。
- 生成中有字、"High"：128 − 36 − 33.3 ≈ 59，权限约 59px（"Ask each time"截断；"Allow all"约 54px，完整）。
- 后台进程退出：圆环 26 + 4 个间距 16 = 42，剩 184；说明先收到 48px，三个按钮共 136：模型 36，权限 136 − 36 − 69.1 ≈ 31，
  取 40，Effort 60；"High"时权限 136 − 36 − 33.3 ≈ 67px。悬停看说明的全文，横幅里也有。Restart 之后重新打开中相同
  （模型、Effort、圆环保留，"Starting…"约 50px，也收到 48px）。
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

顶栏（会话名很长、项目名收到 40px 时会话名能用的宽度）：

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

- 模型菜单、Effort 菜单和"Queue"的下拉：右边对齐自己按钮的右边（照 Claude 的模型菜单右端对齐）；这样会伸出这一行的
  左端时往右挪，左边贴这一行的左端（left = max(0, 按钮右边 − 菜单宽)）；菜单最宽是这一行的宽。
- 权限菜单：左边对齐这一行的左端（就是按钮的左边）。圆环详情：右边对齐这一行的右端（260px，这一行更窄时收到这一行的宽）。
- 打开时量按钮和这一行的位置来算（高度本来就要量），这一行的宽度变了时重算。

审查建议宽于 600px 时模型菜单左边对齐模型按钮、Effort 菜单右边对齐 Effort 按钮；后一半照做（就是上面的规则），前一半不用：
有空余时 `margin-left: auto` 把模型推到右边，ID 短、右边只有"Off ▾"、圆环和"Send"时，模型按钮左边到这一行右端
只有约 220px（例如 680px 一栏空闲、ID "o3"：44 + 8 + 46.6 + 8 + 26 + 8 + 79.7），260px 的菜单会伸出这一行。

高度：最高 min(440px, 这一行的上边到顶栏下边 − 12px)。这一行贴在会话面板底部，草稿变高时往上长的是 `.composer` 的上边，
这一行不动，所以这个距离只随窗口高度变：打开时量，窗口大小变了时重算。菜单不以 `.composer` 定位，正是因为草稿很长时
`.composer` 的上边会升高约 280px。

## 我自己定的（请你走查时看）

1. **截短的顺序和最窄宽度**（负责人定了权限只有文字、模式名截断；顺序和数是我定的）：不能发送的说明 → 模型 ID →
   模式名 → Effort 的强度；最窄依次 48 / 40 / 44 / 40px（≤ 340px 时模型 36、权限 40、Effort 36px）。权限在最窄时
   显示模式名的开头几个字母（量到的是"Ask …"、"Allo…"），开头不同，加上"Allow all"的警示色，最窄时两种模式也分得出。
   宽于 400px 的各档在最挤时都不截模式名。各项都是这一行的直接子项、`flex-shrink` 相邻差 1e6，才排得出这个先后。
2. **截短的按钮，悬停说明的第一行是全文**：权限"Permission mode: Ask each time"、模型"<连接名> · <模型 ID>"（原来就是）、
   Effort"Effort: High"；第二行是原来的说明或不可用的原因。读屏名里也是全文（原来就是）。原来权限、Effort 的悬停里没有
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
   `--color-warn-text`（新的颜色，`color-mix(in srgb, var(--color-warn) 75%, var(--color-text))`，#8d641f，在 `--color-line` 上
   4.38:1、白底上 5.28:1；原来的警示色在 `--color-line` 上只有 2.84:1）。代价：填得很少（几个百分点）时圆环看起来
   几乎是空的，数在悬停说明和读屏名里。
10. **圆环详情不算阻塞的浮层**（与选区浮层一样不挡 Alt+数字和 Ctrl+N）：它只是看数，又是 26px 的小目标、容易误点。
    模型、Effort、权限菜单仍算阻塞，但新的批准卡或询问卡来了时关闭，焦点回到按钮。
11. **这一行的按钮不可用时用 `aria-disabled`**，仍能 Tab 到、读屏能读到原因；按钮消失时焦点移到文字框。原因除了生成中的两句
    （"Can’t switch models until the response finishes"、"Can’t change effort until the response finishes"），其他状态沿用
    按钮位置的说明：后台进程退出"Mori’s background process crashed"、重新载入中"Restarting…"、Restart 之后重新打开中
    "Starting…"、打开失败"Session didn’t open"（只有权限按钮还在）、第一次打开中"Starting…"（也只有权限按钮）。
    原因代替悬停的第二行（例如不再说"Set the effort level for this session"）。权限按钮的样式加 `[aria-disabled='true']`
    （现在只有 `:disabled` 和 `:not(:disabled):hover`）。
12. **菜单往上打开**，对齐方式见"菜单的位置"：任何宽度都右边对齐自己的按钮、放不下时挪进这一行（权限菜单左对齐、圆环详情
    右对齐这一行）；最高 min(440px, 这一行上边到顶栏下边 − 12px)；权限菜单加上原来没有的高度上限。
13. **顺手补上的原有缺口**（只是现在挤在同一行才显出来）：后台进程退出时权限菜单也关闭；"Queue"的下拉点外面关闭、
    打开时焦点进菜单、↑ ↓、Esc 回到 ▾；Tab 把焦点移到菜单外面时关闭（例外见 models.md"Tab 移出时关闭"）。
14. **Restart 之后重新打开中**模型、Effort 和圆环保留上一次的值（不可用），不像第一次打开那样藏起来，这一行不会突然变空；
    **打开失败**时藏起模型、Effort 和圆环（没有会话可切）。
15. **顶栏的项目名**最长 160px、先收短到 40px 再截会话名，≤ 320px 不显示（Claude 是先藏项目名；Mori 保留"项目 › 会话"的顺序）。
    原来 660px（分屏 690px）以下就不显示项目名，现在 370px 的分屏一栏里也还在。
16. **F8 报告的"Current view"加两项**："Pane width"（焦点所在那一栏 `.chat-pane` 的宽度，这一行按它分档；分屏右边那一栏
    比 `.pane-slot` 窄 1px，分屏时比例不在报告里）和"Effort"（"High"、"Unavailable"等）。上下文用量不加（报告里有截图）。
17. **没有加**：Claude 的三个快捷键；"Compact session"。
18. **悬停说明两行，读屏的描述只有第二行**：三个按钮都设 `aria-describedby`，指向一个藏起来的元素，里面只有第二行。
    不这样 Chromium 会把整个 `title` 当成描述：第一行和名字重复（"Permission mode: Ask each time"念两遍），模型的
    "<连接名> · <ID>"连" · "一起念。模型按钮能用时没有第二行，描述是连接名（藏起来的元素里只有连接名）。
19. **"Allow all"的文字改用 `--color-warn-text`**（#8d641f，在它 12% 的底色上 4.65:1）：原来的警示色 #b78022 在同一底色上
    只有 3.02:1，不到 12px 文字要的 4.5:1；现在文字是唯一的标志，窄时还会截成几个字母。底色仍是警示色的 12%，看起来仍是警示。
    不支持思考时 Effort 的字（`--color-faint` 在 `--color-surface` 上 3.08:1）也不到 4.5:1，这个按钮能点，所以改用
    `--color-muted`（与能用时同色），"Unavailable"这个字已经说明了状态（原来的问题，这次一起改）。
20. **圆环的悬停提示**在悬停和键盘焦点时都显示；Esc 先关详情，详情没开时 Esc 藏起提示（WCAG 1.4.13），焦点留在圆环；
    提示藏起时再按 Esc 才按 chat.md 的顺序停止生成。

## 实现要改的地方（下一步，供参考）

- `app/src/renderer/src/components/ChatPane.tsx`：`TopBar` 去掉 `ModelMenu`、`ThinkingMenu`、`PermissionMenu`、`UsageChip`，
  只留面包屑、右栏开关和"Close pane"；`notReadyText` 照旧传给 `Composer`。
- `Composer.tsx`：`ComposerButtons` 变成这一行，各项都是 `.composer-bottom` 的直接子项、依次是 `PermissionMenu`、`ModelMenu`、
  有 `tab.model` 时 `ThinkingMenu`、圆环、不能发送的说明或"Queue"的 `.split-button`、"Stop" / "Send"（不再包右边一组、
  不包模型和 Effort）；删掉 `.composer-spacer`，改用 `.composer-bottom > .permission + * { margin-left: auto }`。模型和 Effort 显示的条件：
  `phase !== 'failed'` 且（`phase !== 'opening'` 或已经有 `tab.model`，即 Restart 之后的重新打开）。三个菜单的不可用用 `aria-disabled`。
  这一行里不能再有 textarea 或 input（`focusComposer`、`useFocusBack`、拖会话引用都找 `.composer textarea`）。
- 新的圆环组件（按钮 + 自画的悬停提示 + 详情浮层）：`data-testid="usage"`、`aria-expanded`、`aria-controls`、`data-state`、
  `data-percent`、`data-tokens`（各状态的值见 models.md"界面测试用的标识"；`aria-controls` 只在详情开着时设）；
  详情 `data-testid="usage-details"`；悬停提示在键盘焦点时也显示，Esc 能藏起；
  用 `useOutsideClose`，不用阻塞的 `useOverlay`（登记成不挡 Alt+数字和 Ctrl+N 的一种，与选区浮层相同）；不发命令。
- `PermissionMenu.tsx`：去掉按钮上的 `shield` 图标，只留 `.permission-text`（模式名，`text-overflow: ellipsis`）和 ▾；
  按钮不可用时关闭菜单（可以改用 `useSwitchMenu`）；悬停两行，第一行"Permission mode: {mode}"，第二行按模式换，
  不可用时是原因（"我自己定的"第 11 条）。
- `ThinkingMenu.tsx` 和 `ModelMenu.tsx`：悬停的第一行是全文（"Effort: {name}"、"<连接名> · <模型 ID>"），第二行是原来的
  说明或不可用的原因（含后台进程退出、重新载入、重新打开中）。
- 三个按钮都设 `aria-describedby`，指向藏起来的、只有第二行的元素（模型按钮能用时是连接名），不让 `title` 变成描述
  （"我自己定的"第 18 条）。
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
- `IssueDialog.tsx`：`tabFields` 加"Effort"，`currentView` 加"Pane width"。
- 样式：删掉只为顶栏按钮存在的规则——`chat.css` 的 `.breadcrumb` 的 `min-width: 36px` 和那段注释、`.topbar-actions` 里的按钮、
  `.usage-chip`、`.permission-menu` 往下居中的定位、760 / 660 / 600 / 500 / 400px 的顶栏 `@container`（包括 ≤ 400px 藏起
  `.permission-text` 的那条）；`models.css` 往下居中的
  `.switch-menu`、`calc(100vh - 80px)`、600 / 400px 两档；`split.css` 690px 一档。新加这一行的 `@container`（760 / 680 / 600 /
  460 / 400 / 340px，每档的内容见"宽度估算"）、截短的 `flex-shrink` 和 `min-width`、往上打开、
  `.composer-bottom { position: relative; min-height: 33px }`、高度上限，和顶栏的项目名规则（160px、先收短、
  ≤ 400px 收小内边距、≤ 320px 不显示）。顶栏的规则只写在 `.chat-pane > .topbar` 下（设置、Review、Customize 页也用 `.topbar`）。
  还要改的：
  - 删掉 `models.css` 的 `@container (max-width: 720px)`（模型按钮最长 120px 改到 760px 一档）；
  - `.model-switch, .thinking-switch { flex-shrink: 0 }` 改掉：截短的四项按"宽度估算"的"实现"设 `flex-shrink`
    （说明 1e18、模型 1e12、权限 1e6、Effort 1）和 `min-width`，其余各项 `flex-shrink: 0`；
  - ≤ 600px 只有图标的"Send"、"Stop"、"Queue"：`width: 32px`（≤ 340px 时"Send"、"Stop" 28px）；`.split-toggle` 在这一档
    `width: 24px; padding: 7px 4px`（现在是 32px）；
  - 权限按钮加 `[aria-disabled='true']` 的样式（同模型按钮：变淡、`cursor: default`、悬停不变色）；
  - 新的颜色 `--color-warn-text`（`color-mix(in srgb, var(--color-warn) 75%, var(--color-text))`）：`.permission-button.all`
    的文字和圆环 75–89% 的填充；有填充时圆环的底圈用 `--color-line`，空圆环用 `--color-faint`；
  - `.thinking-button.unsupported` 的字改用 `--color-muted`。
- 代码注释里写"顶栏"的地方跟着改：`ChatPane.tsx:1,42,131`、`ModelMenu.tsx:1,16,31,131`、`ThinkingMenu.tsx:1,66`、
  `PermissionMenu.tsx:1-4,49`、`modelActions.ts:1`、`actionLog.ts:83`。操作记录的文字不变（没有一条写了位置）。
- 不加后台进程命令；`session.setMode`、`session.setModel`、`session.setThinking`、`session.state` 照旧。

## 测试要改的地方

都在 `app/tests/ui/`。行号是 2026-10-21 `16f9ab1` 的，后面写了函数名，行号对不上时按函数名找。
要保留的：`data-testid`（model-button、thinking-button、permission-button、usage、model-menu、thinking-menu、
permission-menu、permission-allowed、confirm-dialog、session-title、close-pane）、`usage` 每栏唯一、
模型按钮的 textContent 只有 ID、Effort 的 textContent 带"Effort: "前缀（窄时藏起也在）、权限按钮只有模式名一段文字
（截短只是 CSS，textContent 仍是全名）、读屏名、菜单项的上下顺序（↓ 的次数）、选了之后焦点回按钮、第一次打开中不显示模型和 Effort。

会失败、要重写的：

- `m3-app.mjs:295-315` `keyboardPath`：Shift+Tab 回会话树 ≤ 8 次、路径里依次有权限 → 思考 → 模型，改成 5 次（右栏开关 →
  左栏分隔线 → 底部两个按钮 → 会话行），再加一项：从文字框 Tab 往后依次是权限 → 模型 → Effort → 圆环（"Send"不可用时跳过）。
- `m6-app-slash.mjs:1044-1062` `shiftTabPath`：`presses === 8` 改成 5，文件头 :15 和 :1040-1042 的说明跟着改。
- `m3-real.mjs:662-664`：≤ 8 改成 ≤ 5。
- `m6-app-slash.mjs:835-871` `paneBars`、`:900-922` `barProblems`、`:952-974` `menusOutside`：分成顶栏和这一行两部分。顶栏：
  项目名、›、会话名的宽度和全文、两个按钮、不溢出不裁切；这一行：权限的文字（任何宽度都没有图标，原来的 `permissionIcon`
  检查改成"没有 `shield`"）、Effort 前缀 / ▾、模型宽度 / ▾ / 读屏名 / 悬停、圆环、发送组，在 `.composer` 里不溢出不裁切。
  阈值按 models.md"窄栏"的新表（760 / 680 / 600 / 460 / 400 / 340px），500px 藏用量那一档去掉；文字检查（"Model: <id>"、
  "<连接名> · <id>"、"Effort: <x>"、"Permission mode: <mode>"）留着，悬停按两行查：权限第一行"Permission mode: <mode>"、
  第二行"Change the permission mode"（"Allow all"时"Edits, writes, and commands will run without asking."）；Effort 第一行
  "Effort: <x>"、第二行"Set the effort level for this session"。
  `menusOutside` 留着上下左右都在面板里的检查。
- `m6-app-slash.mjs` 的版面步骤 `wideLayout`（:996）、`midLayout`（:1023）、`narrowLayout`（:1065）、
  `splitLayout`（:1114）、`splitRight`（:1191）、`narrowSplit`（:1206）按新档改说明和期望；
  `bandLayout`（:1149-1177）只为分辨原来的阈值，整段按新的档重写。
- `m6-app-settings.mjs:1886-1952` `bucketOf` / `narrowSample` / `narrowProblems` / `narrowTopbar`
  （截图 `10-narrow-topbar`）：按新表分档，步骤和截图改名；`topbarMenu` 里 `:673-674` 调 `noteSmall` 的选择器加上圆环。
- `m6-helpers.mjs:182-195` `topbarState` 改名、加这一行的宽度；`:198-210` `menuInside` 加上下方向（`top ≥ 面板上边`、
  不伸出窗口底部）。
- 点外面关菜单：`m6-app-settings.mjs:692`（`topbarMenu`）、`m6-replay.mjs:510-514` 点文字框关模型菜单，往上打开的菜单可能盖住文字框中间，
  改成点对话流或顶栏的会话名，或先检查点的位置不在菜单里。
- `m1-replay.mjs:154-155` 读 `.composer-bottom` 的 innerText 找"Stop""Queue"：默认 1200 宽时仍是文字，能过；限定到发送组，
  或改用读屏名找按钮。
- `page.mjs:58-63` `usageTokens` 和 `m1-replay.mjs:74-75` 读悬停说明里的"About X / Y tokens"：悬停改成"Context ≈ 15.4k / 128k (12%)"，
  改成读 `data-tokens`；用到它的 `m1-app.mjs:106-110`（`firstMessage`）、`m1-real.mjs:93,118` 不变。新会话第一条消息之前 `data-tokens` 是 `0`、
  `data-state="empty"`，增长的检查从第一次回复之后开始比。
- F8 的"Current view"加了"Pane width"和"Effort"：逐项比较字段列表的 `m2-app.mjs:1058-1068`、`m2-replay.mjs:750-760`、
  `m5-app.mjs:294-306`（`followFocus`）、`m2-real.mjs:562-567`、`m7-app.mjs:1709-1727`、`m7-real.mjs:71` 要加这两项（只查有没有某一项的不用改）。

覆盖不到这一行、要补上的：

- `m1-layout.mjs:93`、`m1-real.mjs:233-238` 的溢出检查列表已有 `.composer-bottom`，加圆环和发送组。
- `m5-app.mjs:350-374` `crampedRight`（800×600 分屏约 370px）：溢出检查加这一行，记录"标题行不溢出"改成"标题行和输入框下面一行都不溢出"。
- `m5-helpers.mjs:240-246` `smallText` 只查 `.topbar *`，加这一行、圆环的悬停提示和详情（没有小于 12px 的字）。
- `m2-app.mjs:926-940` `composerVisible`、`:956-983` `minWindow`：800×600 时除了"Stop"、"Allow once"、"Deny"，也查权限、模型、
  Effort 按钮和圆环完整可见、没被盖住。
- 只改记录说明里的"顶栏"二字、逻辑不变的：`m1-app.mjs:110`；
  `m1-replay.mjs:75,247-264`（`noModelTopBar` 可以改名）；
  `m2-app.mjs:255`；`m2-real.mjs:136,194,348`；`m2-replay.mjs:160,567`；`m6-helpers.mjs:2,89,98,133,181`；
  `m6-app-settings.mjs`、`m6-real.mjs`、`m6-replay.mjs` 里写"顶栏"的说明（调查列出了行号）。`m6-record.mjs:158-160,180-181` 的说明也存在
  `fixtures/m6/model-switch.json`、`thinking.json` 的 `description` 里，fixture 不手改，留着。
- 不受影响：会话名、"Toggle changes"、"Close pane"仍在顶栏的检查；设置、Review、Customize 页自己的 `.topbar`；
  `m5-app.mjs:472-491`（`jumpBack`）从文字框 Shift+Tab 两次到引用芯片（芯片仍在文字框上面）。

新加的检查（每条后面是它验证的状态表）：

所有宽度都是 `.chat-pane` 的宽度（分屏右边那一栏比 `.pane-slot` 窄 1px）。

1. 分屏时会话名有地方（chat.md"顶栏"）：1280 宽分屏（约 510px）、1180 宽分屏（约 460px）、401px、400px、370px（800 宽分屏）、
   321px、320px、300px（800 宽右栏打开）、分屏 280px，很长的会话名要么完整显示，要么占满顶栏剩下的地方（面板 − 内边距 −
   项目名和 › − 两个按钮 − 间距，差 2px 以内），460px 时至少 280px、280px 时至少 185px；项目名 ≤ 160px，会话名截断时项目名
   已收到 40px；≤ 400px 时两个图标按钮 28px、内边距收小；321px 时项目名还在，≤ 320px 时没有项目名和 ›。
2. 这一行在每一档、每种状态下（空闲、刚发出、生成中、生成中有字、"Starting…"、后台进程退出、Restart 之后重新打开中、
   打开失败"Session didn’t open"）都不换行、不超出输入框（chat.md"输入框下面一行"的状态表、models.md"窄栏"），宽度用 279px（右边一栏）、
   280px、300px、340px、341px、370px、400px、401px、460px、461px、490px、600px、601px、680px、681px、740px、760px、761px、930px
   （各档的上沿和下沿）；这一行高 33px（不能发送时也是）；
   每档该显示的东西都在（文字、▾、"Effort: "、发送组的文字或图标、圆环），收起的在读屏名和悬停说明里。
   Restart 之后重新打开中模型、Effort、圆环仍在（不可用）；打开失败时没有模型、Effort、圆环。
   权限按钮任何宽度、两种模式下都没有图标（按钮里只有 ▾ 一个 svg，≤ 460px 时一个也没有）、模式名的文字看得见（宽 ≥ 最窄）；
   "Allow all"在 280px 最挤时看得见的文字仍不同于"Ask each time"，警示色只是多一层；"Allow all"的文字和底色的对比度 ≥ 4.5:1
   （读计算后的颜色算）。只有图标时"Send"、"Stop"、"Queue"各 32px、▾ 24px（≤ 340px "Send"、"Stop" 28px）。
   宽于 400px 时 ▾ 菜单里没有"Queue for later"，只有"Steer"；≤ 400px 时依次是"Queue for later"、"Steer"，项的读屏名就是这两个词
   （没有" · "和快捷键），`aria-keyshortcuts` 是"Enter"、"Control+Enter"。不能发送的说明截短时悬停说明是全文。
3. 截短（models.md"窄栏"、composer-pickers.md"宽度估算"）：每个宽度、每种状态下量权限、模型、Effort 和不能发送的说明是否截短
   和各自的宽度。"是否截短"不能用 `scrollWidth > clientWidth`：审查时看得见"…"的那次两者都是 74。要比装字那个元素的
   `getBoundingClientRect().width` 和全文的宽（同字体的 canvas `measureText`，或一个 `width: max-content` 的藏起来的副本），
   窄 0.01px 以上就算截短。查先后：模式名截短时模型已在最窄（差 1px 以内）；Effort 截短时模型和权限都在最窄；
   模型截短时不能发送的说明已在最窄。宽于 400px 时"Ask each time"、"Effort: Unavailable"、`<很长的 ID> (deleted)`、生成中有字也不截
   模式名；280px 最挤时三个按钮都不窄于最窄（40 / 36 / 36px），圆环 26px、"Stop"和 ▾ 完整。截短的按钮看得见"…"，悬停的第一行和
   读屏名是全文；"(deleted)"比 ID 后截。用"Extra high""Medium"和"Allow all"各走一次 280px。不比截短后的字面（"Ask …"之类
   由 Chromium 决定）。
4. 菜单（models.md"菜单的位置与键盘"）：模型、Effort、权限、"Queue"的下拉、圆环详情往上打开，整个在会话面板和窗口里，不盖到顶栏；
   圆环详情在 601、680、740、761px、生成中有字、"Effort: Unavailable"时也在面板里；模型、Effort 菜单和"Queue"的下拉右边对齐
   自己的按钮，或（放不下时）左边贴这一行的左端，任何宽度都不伸出这一行；用很短的模型 ID（例如"o3"）、空闲、680px 和 930px
   各开一次模型菜单；权限菜单对齐左端；800×600、右栏打开、草稿 220px 高时菜单不出窗口、不盖顶栏，草稿 1 行和 220px 高时
   菜单的最高相同；有 30 条"Allowed for this session"时权限菜单
   在菜单里滚动。同时只开一个。自动关按"什么时候自动关"那张表逐行查：开着模型菜单时发送 → 关；开着权限菜单时排队的消息开始
   新的一轮 → 不关；后台进程退出 → 权限菜单关、圆环详情不关；清空草稿 → "Queue"的下拉关。
5. Tab 移出（models.md"Tab 移出时关闭"）：Tab 到菜单外面的按钮 → 关；打开模型菜单、按 F8、按 Esc → 菜单仍开着、焦点在原来那一项；
   点模型菜单底部的说明 → 不关；打开权限菜单、点"Allowed for this session:" → 不关。
6. 键盘（models.md"键盘"、"不可用时、按钮消失时的焦点"）：Shift+Tab 5 次回会话树；从文字框 Tab 往后是权限 → 模型 → Effort → 圆环；
   生成中模型、Effort 仍能 Tab 到、读屏描述是不可用的原因；菜单里 ↑ ↓ Enter Esc，焦点回按钮；菜单开着、文字框里有字时在菜单里
   按 Enter 只选项、不发送也不排队；菜单开着时 Alt+1 和 Ctrl+N 不起作用；按钮消失时焦点到文字框，逐个查："Stop"上、本轮结束；
   "Queue"或 ▾ 上、本轮结束或清空草稿；"Send"上按 Enter 发出；模型或 Effort 上、打开失败。Restart 之后重新打开中焦点留在
   原来的按钮上（按钮不可用但还在）。不可用的原因（读屏的描述和悬停第二行）逐个状态查：生成中、后台进程退出
   "Mori’s background process crashed"、重新载入中"Restarting…"、重新打开中"Starting…"；读屏的描述里没有第一行、没有" · "。
   400px 和 280px、生成中有字：Tab 到 ▾、Enter 打开 → 焦点在"Queue for later"，↓ 到"Steer"，Esc 回 ▾；选"Queue for later"真的排队
   （排队区多一条"Queued"）。
7. 新卡片来了（models.md"新的批准卡或询问卡来了"）：开着模型菜单时来了批准卡 → 菜单关、焦点在模型按钮、Alt+1 答了这张卡；
   开着圆环详情时来了批准卡 → 详情关，Alt+1 答了。
8. 圆环（models.md"上下文用量（圆环）"）：没有数据不显示；还没有消息（新会话：`data-state="empty"`、`data-tokens="0"`、悬停和读屏名
   "Context window"、详情里那句话）；有用量（悬停"Context ≈ …k / …k (N%)"、读屏名"Usage: Context approximately … of … tokens (N%)"、
   读屏的描述里没有"/"）；1,000,000 的窗口写成"1M"，999,950 写成"1M"（不是"1000k"）；≥ 75%、≥ 90% 的颜色（用合成端点的小上下文窗口）；刚压缩完
   （`fixtures/m1/compaction.json`：`data-state="compacted"`、底圈虚线、没有 `data-tokens`）；点开详情、开着时用量刷新详情跟着变；
   Esc 关闭、焦点在圆环；Tab 到圆环时悬停提示显示，Esc 藏起提示、不停止生成；`aria-controls` 只在详情开着时有；
   有填充时底圈是 `--color-line`、空圆环是 `--color-faint`；点开不发命令（回放时没有多出的命令）；后台进程退出后圆环保留最后的用量、详情仍能打开；分屏两栏各一个；
   没有小于 12px 的字。
9. F8 的"Current view"里"Model""Permission mode"照旧，多了"Effort"和"Pane width"（焦点所在那一栏 `.chat-pane` 的宽度；
   分屏时在右边那一栏按一次，比 `.pane-slot` 窄 1px）。

用真实模型走一遍（AGENTS.md 第 2 条，实现之后跑，断言改成新位置）：`m1-real`（用量随回复增长，读 `data-tokens`）、
`m2-real`（权限菜单在这一行、切到"Allow all"、按钮文字变成"Allow all"并用警示色、没有图标）、`m3-real`（Shift+Tab 5 次）、`m6-real`（在这一行换模型和 Effort，
下一条回复来自新模型；含一次分屏里的一栏）。fixture 不重录：这次不改后台进程的事件和命令，回放用的 fixture 内容不变；
这是有意跳过录制这一步，在这一步的检查记录里写明。

## 文档

这次改了：`app-v0.md` 5.1、5.7、5.11、5.12、第 7 节 M6 一行、第 11 节；`v0/screens/models.md`（重写）、`chat.md`、`approval.md`、
`split.md`、`layout.md`、`sessions.md`、`settings.md`、`README.md`；`v0/defaults.md`；`v0/ui-strings.md`（上下文、权限按钮、
模型和 Effort 的悬停、不可用的原因、发送和排队按钮几行；原来顶栏宽度的实现记录标为被本文取代）；`app/README.md` 第 15、81 行（"顶栏"的模型和思考菜单改成输入框下面一行）。
不改：`v0/m1-checks.md` 到 `m7-checks.md`（当时的记录，例如 m3、m6 里"Shift+Tab 8 次"），这一步自己的检查记录里写明改了什么；
`docs/specs/model-providers.md`（:268、:625、:626、:665）和 `docs/proposals/model-providers.md`（:226、:228、:232）里的"顶栏切换模型"
（不在 v0 里；主工作区的 `v1-model-providers` 分支正在改 specs，这里不动免得冲突）。给 v1 的提醒：v0 的模型切换已经在输入框下面一行，
那几处的"顶栏"合并后要改成"输入框下面一行"或"会话里手动切换模型"。

## 没有验证的

- 所有宽度都是按字形宽度和现在的 CSS 算的，没有在 App 里量；实现后按实测调阈值，可能比上表差几 px。
- `flex-shrink` 相邻差 1e5 以上能排出截短先后、差 1000 不行，是审查时在 Edge 的草稿页里试的，不是在 App 里。
- Claude 桌面版的样子来自它的文档、字串表和本机安装包里的代码（设计审查时读的），没有打开 Claude 对照截图。
- "pi 在还没有消息时给 0"是读 pi 1.3.0 的 `getContextUsage()` 得出的，没有在真实会话里记一次。

## 待你决定

- 截短的顺序（模型 ID 先于模式名，Effort 最后）和最窄宽度——见"我自己定的"第 1 条。
- ≤ 400px 就收起"Queue"、≤ 340px 收小发送按钮和内边距——见"我自己定的"第 4、5 条。
- 权限、Effort 的悬停加上全名一行——见"我自己定的"第 2 条。
- "Allow all"的文字改深、不支持思考时 Effort 的字不再变淡、有填充时圆环的底圈改浅——见"我自己定的"第 9、19 条（为了对比度）。
