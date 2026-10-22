# 顶栏的选择范围与思考强度

依据：规格 §5.1（选择范围）、§5.10、§9.2、§9.5（`ModelState`、`session.setPick`）、§11.1（思考强度按实际模型）、§11.4（准备中）。
取代 [v0 models.md](../../v0/screens/models.md) 的“模型”表；思考强度沿用 v0，可选强度改取当前模型；窄栏规则沿用 v0（去掉“ (deleted)”）。
分屏时每一栏各有一组（同 v0）。界面文字的写法按 [v0/ui-strings.md](../../v0/ui-strings.md)。标了“（临时，走查时可以改）”的文字规格没给，是本表定的。

## 来源

| 来源 | 内容 |
| --- | --- |
| `SessionInfo` 里的 `ModelState`（`session.create`、`session.open`、界面重新载入后接上会话）、`mori.model_state` 事件、`session.setPick` 的结果 | `ModelState`：`pick`、`current`（`<provider>/<model>`）、`blocked`、`thinkingLevel`、`thinkingLevels`、`reasoning`（后三项描述当前模型，§11.1） |
| `models.get` 的结果 | 菜单的列表：全部分组、提供商、模型，每个提供商的名称与区域 |
| pi 的 `thinking_level_changed`、`session.setThinking` 的结果 | 思考强度（同 v0） |
| 会话运行状态 | 准备中（§11.4，`session.prompt` 之后、pi 开始运行之前）与生成中（v0 的“本轮运行中”） |

## 选择范围按钮

“<范围名>”：分组写 id，提供商写名称（§9.2），模型范围不写范围名。区域写作 Local / Intranet / Public，未确认时“Zone not confirmed”（临时，走查时可以改）。

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 打开中 | 会话还没打开 | 不显示（同 v0） | — |
| 范围是分组或提供商、有当前模型 | `pick` 是分组 id 或提供商 id，`current` 不为 null | “<范围名> · <当前模型 id>”和 ▾；当前模型：回复进行中是本段正在用的，没有段时是静态校验后的第一个候选（§9.2） | 打开菜单 |
| 范围是模型 | `pick` 含 `/` | 模型 id 和 ▾ | 打开菜单 |
| 没有候选 | `current` 为 null（会话被拒绝启动，例如 `no_candidate`、`verifying`、`pick_missing`） | 只显示范围名（`pick_missing` 时就是那个不存在的名字；范围是模型时是模型 id）和 ▾ | 打开菜单 |
| 没有范围 | `pick` 为 null（`no_pick`） | “No model range”和 ▾（临时，走查时可以改） | 打开菜单 |
| 悬停 | — | 有当前模型时“<提供商名> · <区域>”（例如“DeepSeek · Public”）；没有当前模型时“No model can run in this session”（都是临时，走查时可以改） | — |
| 段内换了模型 | `mori.model_state`（段内换模型后，§9.5） | “<范围名> · <新模型 id>” | — |
| 段结束 | `mori.model_state`（段结束） | 回到静态校验后的第一个候选 | — |
| 准备中 / 生成中 | 会话在准备中或本轮运行中 | 按钮不可用，悬停“Can’t switch models until the response finishes”（§9.2） | 停止后再切 |

## 菜单

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 菜单 | 你点了按钮 | 三节，节名“Groups”“Providers”“Models”；Groups 的项写分组 id，Providers 的项写提供商名称，Models 按提供商分小节（小节名是提供商名称），项写模型 id；每项右侧标区域：提供商与模型标它的区域，分组标它的成员涉及的全部区域（按 Local、Intranet、Public 的顺序，“ · ”分隔，例如“Local · Public”）；当前范围（`pick`）打勾；底部说明“Applies to this session only. New sessions use the default range from Settings.”，最后一项“Manage models” | ↑ ↓、Enter 选择；Esc、点外面关闭 |
| 被排除的项 | 这一项展开后的全部候选都被本会话的静态校验排除（§9.2） | 这一项变淡，悬停写原因：每个候选一行“<provider>/<model> — <原因>”（原因用 §5.3 的界面文字，例如“network zone not confirmed”“zone public is not allowed for this project”“tool calling not verified yet”；行的写法临时，走查时可以改）；仍可以选（选了以后由拒绝启动卡说明） | 选择 |
| 某一节为空 | 配置里没有分组（或没有提供商与模型） | 这一节不显示（临时，走查时可以改）；全空时只有底部说明与“Manage models” | — |
| 切换中 | 你选了一项，`session.setPick` 还没返回 | 菜单关闭；按钮显示新的范围、不可用 | — |
| 已切换 | `session.setPick` 返回 `ModelState` | 按钮按新的 `ModelState` 显示；后台进程写一条 `mori.pick`、重新做静态校验，下一段起生效；被拒绝启动时出现拒绝启动卡，可以发送时卡消失（model-chat.md） | — |
| 切换失败 | `session.setPick` 返回 `error` | 按钮回到原来的范围；按钮下方一行“Couldn’t change the model range: <原文>”，下次打开菜单或 10 秒后消失（临时，走查时可以改） | — |
| Manage models | 你点了它 | 打开 设置 → Models | — |

## 思考强度

沿用 [v0 models.md](../../v0/screens/models.md)“思考强度”（强度名 Off / Minimal / Low / Medium / High / Extra high / Max、按钮文字“Effort: High”、菜单底部说明、生成中的悬停说明都是 v0 的英文），改动如下：

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| 按当前模型 | `ModelState.thinkingLevels`、`reasoning`（当前的实际模型，不是会话的虚拟模型） | 支持思考时可选的强度取这个模型的；不支持时同 v0“不可选”，菜单里的说明（§9.2）：“This model isn’t marked “Supports thinking”, so Mori doesn’t send thinking parameters and the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit this model in Settings → Models and check “Supports thinking”.”，说明下的按钮“Open settings”（临时，走查时可以改）打开 设置 → Models | 打开菜单；Open settings |
| 没有当前模型 | `current` 为 null | 不显示思考按钮（沿用 v0“没有可用模型时不显示思考按钮”） | — |
| 段内换到推理模型 | `mori.model_state`（段内换模型）的 `reasoning` 变为真 | 菜单的强度随之变为可选（MP-35）；按钮仍因生成中不可用 | — |
| 准备中 / 生成中 | 同选择范围按钮 | 按钮不可用，悬停同 v0“Can’t change effort until the response finishes”（准备中也用这句） | — |
| 新会话 | `session.create` 的 `ModelState.thinkingLevel` | 第一个候选的 `modelThinkingLevels` → `defaultThinkingLevel` → medium（§11.1） | — |
| 重新打开 | pi 从会话记录恢复强度 | 显示恢复后的强度（例如改成 high 后关闭再打开，仍是 high） | — |

## 窄栏

沿用 v0 的分步收紧；收起的文字仍在读屏名称和悬停说明里。按钮的读屏名称“Model range: <按钮文字>”（临时，走查时可以改）。
放不下时先截“<当前模型 id>”，再截“<范围名>”，最窄 40px（同 v0“先截模型 ID”，临时，走查时可以改）。
v0 的“ (deleted)”不再出现：范围指向不存在的名字时由拒绝启动卡说明（`pick_missing`）。

## 反例

- 在顶栏选范围不改设置里的 Default model range；新会话仍用设置里的默认范围。
- 准备中（消息已显示、还没开始生成）不能改范围和思考强度。
- 菜单列出配置里的全部分组、提供商、模型，不只“有 key 的”（v0 只列 pi 能用的模型；没有 key 的提供商照样能用，§4.1）。
- 被排除的项变淡但仍可以选。
- 改了范围后，正在进行的那一段不受影响，下一段才按新范围选。

## 本表定下的界面细节

规格没给、本表定的（都是临时，走查时可以改）：没有范围时“No model range”；悬停“<提供商名> · <区域>”与没有当前模型时的
“No model can run in this session”；区域未确认写“Zone not confirmed”；分组的区域按 Local、Intranet、Public 排；
被排除项的悬停每个候选一行“<provider>/<model> — <原因>”；空节不显示；切换失败在按钮下方一行显示；
不支持思考说明下的“Open settings”；读屏名称“Model range: …”；窄栏先截模型 id 再截范围名。

## 需要规格回答

- 菜单要对**每一项**判断“展开后全部候选都被本会话静态校验排除”，但 `ModelState.blocked.candidates` 只覆盖当前范围；
  其他分组、提供商、模型的静态校验结果没有字段给出，界面自己也算不全（项目配置 `.mori/models.json` 的 `groups` 缩小不在
  `models.get` 里，§5.3 的选择器在内核）。数据从哪里来，规格没说。

## 界面测试用的标识

| 元素 | 标识 |
| --- | --- |
| 选择范围按钮 | 每一栏里 `data-testid="model-button"`（沿用 v0），`data-pick` 为 `pick`（没有时不带），`data-current` 为 `current`（没有时不带） |
| 菜单 | `data-testid="model-menu"`（沿用 v0）；节 `[data-section]`（`groups` / `providers` / `models`）；项 `role="menuitemradio"`，`data-pick` 为这一项的选择范围字符串，`data-zone`（分组为空格分隔的区域列表），被排除的带 `data-excluded="true"`；底部说明 `data-testid="model-menu-note"`；“Manage models” `data-action="manage-models"` |
| 切换失败 | `data-testid="pick-error"` |
| 思考按钮与菜单 | 同 v0：`data-testid="thinking-button"`（`data-level`、`data-reasoning`）、`data-testid="thinking-menu"`；不支持思考时的“Open settings” `data-action="open-settings"` |
