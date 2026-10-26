# 选择范围与思考强度（输入框下面一行）

依据：规格 §5.1（选择范围）、§5.10、§9.2、§9.5（`ModelState`、`session.setPick`）、§11.1（思考强度按实际模型）、§11.4（准备中）、
§7.6–§7.7（2026-10-24 补：思考关不掉的模型没有 Off）。
取代 v0 models.md 里范围按钮的文字和菜单；思考强度沿用 v0，可选强度改取当前模型。它在输入框下面一行的位置、悬停的行、不可用、
窄栏和菜单的位置见 [v0 models.md](../../v0/screens/models.md)（2026-10-21 composer-pickers）。
分屏时每一栏各有一组（同 v0）。界面文字的写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

2026-10-26 改（负责人走查 M3，[WP-05](../walkthrough-1026/WP-05.md)）：网络区域删掉。菜单的项不再标区域（原来右侧的“Local · Public”），
按钮悬停的第二行只写当前模型的提供商名（原来是“<提供商名> · <区域>”）。

## 来源

| 来源 | 内容 |
| --- | --- |
| `SessionInfo` 里的 `ModelState`（`session.create`、`session.open`、界面重新载入后接上会话）、`mori.model_state` 事件、`session.setPick` 的结果 | `ModelState`：`pick`、`current`（`<provider>/<model>`）、`blocked`、`thinkingLevel`、`thinkingLevels`、`reasoning`（后三项描述当前模型，§11.1）（协作模式：见 docs/specs/parallel-agents-taskboard.md §12.11：另有 `pickLocked`，对话会话在协作模式下为真）（2026-10-24 补，§7.7：`thinkingLevel` 是 pi `clampThinkingLevel` 按当前模型收紧会话强度后的值，`thinkingLevels` 是 pi `getSupportedThinkingLevels`；档案 `reasoning.off_refused` 的模型编译成 `thinkingLevelMap: { off: null }`（§7.6），这两项里因此没有 `off`，会话的 Off 收紧成 `minimal`） |
| `session.pickOptions` 的结果（只读，§9.5） | 菜单的列表：全部分组、提供商、模型，是否被这个会话的静态校验排除和原因（2026-10-26：不再带区域） |
| pi 的 `thinking_level_changed`、`session.setThinking` 的结果 | 思考强度（同 v0） |
| 会话运行状态 | 准备中（§11.4，`session.prompt` 之后、pi 开始运行之前）与生成中（v0 的“本轮运行中”） |

## 选择范围按钮

“<范围名>”：分组写 id，提供商写名称（§9.2），模型范围不写范围名。
（协作模式：见 docs/specs/parallel-agents-taskboard.md §12.11，2026-10-26 负责人走查 M10、M21 改：协作模式下按钮显示“Task mode · <正在用的模型 id>”和 ▾，仍能打开菜单，菜单里是说明 `Task mode picks the model for each agent`、Task mode 一行、“Manage agents”（2026-10-26 加，依据负责人 2026-10-26 批准的 Customize › Agents 规格：customize-agents.md §6.6 与 §0“已定的”第 4 条“Manage agents 在模型菜单里一直显示”）和“Manage models”（下面“菜单”）；`session.setPick` 被拒绝，`session.pickOptions` 返回空；回到 `off` 后范围仍是你最后选的。按钮上的模式见 [team-switch.md](team-switch.md)“模型按钮上的模式”，拒绝启动见 [team-blocked.md](team-blocked.md)）

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 第一次打开中 | 会话还没打开，还没有过模型状态 | 不显示（同 v0） | — |
| Restart 之后重新打开中 | 会话又在打开，`ModelState` 还是上一次的 | 显示上一次的范围，不可用（v0 models.md“选择范围按钮”） | — |
| 范围是分组或提供商、有当前模型 | `pick` 是分组 id 或提供商 id，`current` 不为 null | “<范围名> · <当前模型 id>”和 ▾；当前模型：回复进行中是本段正在用的，没有段时是静态校验后的第一个候选（§9.2） | 打开菜单 |
| 范围是模型 | `pick` 含 `/` | 模型 id 和 ▾ | 打开菜单 |
| 没有候选 | `current` 为 null（会话被拒绝启动，例如 `no_candidate`、`verifying`、`pick_missing`） | 只显示范围名（`pick_missing` 时就是那个不存在的名字；范围是模型时是模型 id）和 ▾ | 打开菜单 |
| 没有范围 | `pick` 为 null（`no_pick`） | “No model range”和 ▾（临时，走查时可以改） | 打开菜单 |
| 悬停 | — | 有当前模型时“<提供商名>”（例如“DeepSeek”；2026-10-26 改：原来后面还有“ · <区域>”）；没有当前模型时“No model can run in this session”（都是临时，走查时可以改）；这是悬停的第二行，第一行是按钮文字，不可用时第三行是原因（v0 models.md“选择范围按钮”） | — |
| 段内换了模型 | `mori.model_state`（段内换模型后，§9.5） | “<范围名> · <新模型 id>” | — |
| 段结束 | `mori.model_state`（段结束） | 回到静态校验后的第一个候选 | — |
| 准备中 / 生成中 | 会话在准备中或本轮运行中 | 2026-10-26 起按钮可用（不带 `aria-disabled`），可以打开菜单切 Task mode（team-switch.md；负责人走查 M10 的推荐选项）；悬停第三行仍是“Can’t switch models until the response finishes”（§9.2；悬停的三行见 v0 models.md“选择范围按钮”），读屏的描述同样带这一句；菜单里范围的项不可用（下面“菜单”） | 打开菜单；停止后再换范围 |

## 菜单

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 菜单 | 你点了按钮 | 三节，节名“Groups”“Providers”“Models”；Groups 的项写分组 id，Providers 的项写提供商名称，Models 按提供商分小节（小节名是提供商名称），项写模型 id；每项只写名字（2026-10-26 改：右侧的区域标记删掉）；当前范围（`pick`）打勾；三节下面是说明“Applies to this session only. New sessions use the default range from Settings.”，再下面是 Task mode 一行（team-switch.md），然后“Manage agents”（2026-10-26，[customize-agents.md](customize-agents.md)“模型菜单的 Manage agents”），最后一项“Manage models” | ↑ ↓、Enter 选择；Esc、点外面关闭 |
| 协作模式的菜单（2026-10-26） | `ModelState.pickLocked` 为真 | 没有三节；说明 `Task mode picks the model for each agent`（同按钮悬停的第二行，在说明的位置；它是菜单的第一项，上面不画分隔线），下面是 Task mode 一行、“Manage agents”和“Manage models”；打开时焦点在 Task mode 一行上（没有打勾的范围项） | 切 Task mode；Manage agents；Manage models；Esc |
| 回复进行中的菜单（2026-10-26） | 准备中或生成中，`pickLocked` 为假 | 三节照常列出，但每项不可用（`disabled`，↑ ↓ 跳过，打勾的项仍打勾）；说明换成“Can’t switch models until the response finishes”；Task mode 一行、“Manage agents”和“Manage models”可用；打开时焦点在 Task mode 一行上。回复在菜单开着时开始：项变为不可用，焦点原来在某一项上的移到 Task mode 一行；回复结束时项恢复可用 | 切 Task mode；Manage agents；Manage models；Esc |
| 换范围之后 | 你选了一项 | 菜单关闭，焦点回到按钮（下面“切换中”） | — |
| 被排除的项 | 这一项展开后的全部候选都被本会话的静态校验排除（§9.2） | 这一项变淡，悬停写原因：每个候选一行“<provider>/<model> — <原因>”（原因用 §5.3 的界面文字，例如“tool calling not verified yet”“tool calling failed verification”；行的写法临时，走查时可以改）；仍可以选（选了以后由拒绝启动卡说明） | 选择 |
| 某一节为空 | 配置里没有分组（或没有提供商与模型） | 这一节不显示（临时，走查时可以改）；全空时只有底部说明与“Manage models” | — |
| 切换中 | 你选了一项，`session.setPick` 还没返回 | 菜单关闭；按钮显示新的范围、不可用（`data-pending="true"`） | — |
| 已切换 | `session.setPick` 返回 `ModelState` | 按钮按新的 `ModelState` 显示；后台进程写一条 `mori.pick`、重新做静态校验，下一段起生效；被拒绝启动时出现拒绝启动卡，可以发送时卡消失（model-chat.md） | — |
| 切换失败 | `session.setPick` 返回 `error` | 按钮回到原来的范围；从输入框下面一行往上弹出一行“Couldn’t change the model range: <原文>”，下次打开菜单或 10 秒后消失（临时，走查时可以改） | — |
| Manage models | 你点了它 | 打开 设置 → Models | — |
| Manage agents（2026-10-26） | 你点了它 | 菜单关闭，打开 Customize 并选中 Agents，跟随这个会话；操作记录 `Open Customize → Agents`（[customize-agents.md](customize-agents.md)） | — |

## 思考强度

沿用 [v0 models.md](../../v0/screens/models.md)“思考强度”（强度名 Off / Minimal / Low / Medium / High / Extra high / Max、按钮文字“Effort: High”、菜单底部说明、生成中的悬停说明都是 v0 的英文），改动如下
（协作模式：见 docs/specs/parallel-agents-taskboard.md §12.11：思考强度按钮不变，协作模式下照常可用，只作用于对话会话）：

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 按当前模型 | `ModelState.thinkingLevels`、`reasoning`（当前的实际模型，不是会话的虚拟模型） | 支持思考时可选的强度取这个模型的；不支持时同 v0“不可选”，菜单里的说明（§9.2）：“This model isn’t marked “Supports thinking”, so Mori doesn’t send thinking parameters and the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit this model in Settings → Models and check “Supports thinking”.”，说明下的按钮“Open settings”（临时，走查时可以改）打开 设置 → Models | 打开菜单；Open settings |
| 思考关不掉（2026-10-24 补，§7.7、§9.2） | `ModelState.reasoning` 为真、`thinkingLevels` 里没有 `off`（当前模型的档案 `reasoning.off_refused`，见“来源”） | 按钮照常“Effort: <强度>”，悬停同 v0“Set the effort level for this session”；菜单只列 `thinkingLevels` 里的强度：没有 Off（不列出，不是变淡），从 Minimal 起，当前的打勾；原来的底部说明“Applies to this session only. Set each model’s default for new sessions in Settings.”下面另起一行“This model can’t turn thinking off.” | 打开菜单；↑ ↓、Enter 选一档；Esc |
| 会话是 Off、当前模型没有 Off（2026-10-24 补，§7.7） | 会话的强度是 Off（在能关思考的模型上选了 Off 再换范围、重新打开强度记为 Off 的会话、新会话的默认强度是 Off），`ModelState.thinkingLevel` 是 pi 收紧后的 `minimal` | 按钮“Effort: Minimal”，菜单里 Minimal 打勾；会话记录里的强度仍是 Off（虚拟模型有全部七档，pi 只在每次请求时按实际模型收紧，§11.1）；这个模型收到的请求都带 `minimal`：对话、压缩与重建经虚拟模型路由由 pi 收紧，§11.2 换模型后重发按新模型收紧，都不发“关闭思考”（§7.7，MP-39）；换到能关思考的模型后按钮回到“Effort: Off” | 选另一档（会话从此记那一档） |
| 没有当前模型 | `current` 为 null | 不显示思考按钮（同 v0 models.md“思考强度”：没有当前模型时不显示 Effort 按钮） | — |
| 段内换到推理模型 | `mori.model_state`（段内换模型）的 `reasoning` 变为真 | 菜单的强度随之变为可选（MP-35）；按钮仍因生成中不可用 | — |
| 段内换到思考关不掉的模型（2026-10-24 补，§7.7） | `mori.model_state`（段内换模型）的 `thinkingLevels` 没有 `off` | 菜单随之没有 Off、有“This model can’t turn thinking off.”；会话是 Off 时按钮变为“Effort: Minimal”，换模型后重发的请求按新模型收紧、带 `minimal`（§7.7、§11.2）；按钮仍因生成中不可用；段结束后按回到的第一个候选显示 | — |
| 准备中 / 生成中 | 同选择范围按钮 | 按钮不可用，悬停同 v0“Can’t change effort until the response finishes”（准备中也用这句） | — |
| 新会话 | `session.create` 的 `ModelState.thinkingLevel` | 第一个候选的 `modelThinkingLevels` → `defaultThinkingLevel` → medium（§11.1）（2026-10-24 补：取到 Off 而第一个候选没有 Off 时显示 Minimal，同上“会话是 Off、当前模型没有 Off”） | — |
| 重新打开 | pi 从会话记录恢复强度 | 显示恢复后的强度（例如改成 high 后关闭再打开，仍是 high）（2026-10-24 补：恢复的是 Off 而当前模型没有 Off 时显示 Minimal） | — |

## 窄栏

见 [v0 models.md](../../v0/screens/models.md)“窄栏”：选择范围按钮的上限、最窄和截短的先后（先截当前模型 id、再截范围名，
比权限的模式名和 Effort 先截）都写在那里，这里不重复。读屏名“Model range: <按钮文字>”，按钮文字里的“ · ”换成“, ”（“Model range: fast, deepseek-chat”；读屏名里不用“ · ”，见 ui-strings.md；临时，走查时可以改）。
v0 的“ (deleted)”不再出现：范围指向不存在的名字时由拒绝启动卡说明（`pick_missing`）。

## 反例

- 在输入框下改范围不改设置里的 Default model range；新会话仍用设置里的默认范围。
- 准备中（消息已显示、还没开始生成）不能改范围和思考强度（2026-10-26 起范围菜单能打开，只是项不可用，只能切 Task mode）。
- 菜单列出配置里的全部分组、提供商、模型，不只“有 key 的”（v0 只列 pi 能用的模型；没有 key 的提供商照样能用，§4.1）。
- 被排除的项变淡但仍可以选。
- 改了范围后，正在进行的那一段不受影响，下一段才按新范围选。
- （2026-10-24，§7.7）思考关不掉的模型的菜单里没有 Off，不是把 Off 变淡；没标 Supports thinking 的模型仍是全部强度变淡加原来的说明和
  “Open settings”，不出“This model can’t turn thinking off.”。
- （2026-10-24，§7.7）显示 Minimal 不改会话记录：会话记的仍是 Off，换到能关思考的模型后回到 Off；也不改设置里的 Default effort。
- （2026-10-24，§7.7）没有标记的模型（例如 `fake-coder`）菜单仍有 Off，Off 时请求不带思考参数（MP-39）。
- （2026-10-24，§7.7）菜单只看 `ModelState.reasoning` 与 `thinkingLevels`，界面不自己读档案判断有没有 Off。
- （2026-10-24，§7.7）不按地址或接口区分，也不提示你取消勾选 Supports thinking：有标记的模型收到的每个请求都带强度，哪个地址都不会收到
  “关闭思考”。唯一的已知限制是 Minimal 没有探针测过、只在 OpenRouter 上实测过（§7.7 末尾、proposal §10），菜单不为它加说明。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：没有范围时“No model range”；悬停“<提供商名>”与没有当前模型时的
“No model can run in this session”；
被排除项的悬停每个候选一行“<provider>/<model> — <原因>”；空节不显示；切换失败从输入框下面一行上方弹出；
不支持思考说明下的“Open settings”；读屏名称“Model range: …”；窄栏先截模型 id 再截范围名。
（2026-10-24，§7.7 给了文字，没给位置与点选的细节）“This model can’t turn thinking off.”放在原来的底部说明下面、单独一行，
不是菜单项、不能聚焦（临时，走查时可以改）；会话是 Off 而显示 Minimal 时点 Minimal 不发 `session.setThinking`（它已经是显示的当前强度，
同 v0 点当前项），会话仍记 Off（临时，走查时可以改）。
（2026-10-26，WP-09）回复进行中范围菜单能打开（负责人走查 M10 的推荐选项），项用 `disabled`（↑ ↓ 跳过）而不是藏起来，说明换成
“Can’t switch models until the response finishes”；协作模式的菜单把说明 `Task mode picks the model for each agent` 放在原来说明的位置；
这两种菜单打开时焦点在 Task mode 一行上（都是临时，走查时可以改）。

## 需要规格回答

- 菜单要对**每一项**判断“展开后全部候选都被本会话静态校验排除”，但 `ModelState.blocked.candidates` 只覆盖当前范围；
  其他分组、提供商、模型的静态校验结果没有字段给出，界面自己也算不全（项目配置 `.mori/models.json` 的 `groups` 缩小不在
  `models.get` 里，§5.3 的选择器在内核）。数据从哪里来，规格没说。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 选择范围按钮 | 每一栏输入框下面一行（`.composer-bottom`）里 `data-testid="model-button"`（沿用 v0），`data-pick` 为 `pick`（没有时不带），`data-current` 为 `current`（没有时不带），切换中 `data-pending="true"`；悬停的描述元素 `data-testid="model-tip"`（在按钮外面） |
| 菜单 | `data-testid="model-menu"`（沿用 v0）；节 `[data-section]`（`groups` / `providers` / `models`）；项 `role="menuitemradio"`，`data-pick` 为这一项的选择范围字符串（2026-10-26：`data-zone` 与区域标记 `.pick-zone` 删掉），被排除的带 `data-excluded="true"`，回复进行中 `disabled`；说明 `data-testid="model-menu-note"`（三种文字：一般、回复进行中、协作模式，都是这一个元素）；Task mode 一行 `data-testid="team-switch"`（team-switch.md）；“Manage agents” `data-action="manage-agents"`（2026-10-26，在 `.task-mode-group` 里）；“Manage models” `data-action="manage-models"` |
| 按钮上的模式（2026-10-26） | 选择范围按钮的 `data-team-mode`（`off` / `once` / `always`），`pickLocked` 时 `data-locked="true"` |
| 切换失败 | `data-testid="pick-error"` |
| 思考按钮与菜单 | 同 v0：`data-testid="thinking-button"`（`data-level`、`data-reasoning`，切换中 `data-pending="true"`）、`data-testid="thinking-menu"`；不支持思考时的“Open settings” `data-action="open-settings"` |
| 强度项（2026-10-24 写明） | `thinking-menu` 里 `role="menuitemradio"`、`data-level` 为强度（现有代码）；思考关不掉时没有 `[data-level="off"]`；会话是 Off 而当前模型没有 Off 时按钮 `data-level="minimal"`、`[data-level="minimal"]` 的 `aria-checked="true"` |
| 思考关不掉的说明（2026-10-24，§7.7） | `thinking-menu` 里 `data-testid="thinking-off-note"`，文字“This model can’t turn thinking off.”；`thinkingLevels` 有 `off` 或模型没标 Supports thinking 时没有这个元素 |
