# 统一模型提供商构建规格

状态：构建规格，按 [统一模型提供商 Proposal](../proposals/model-providers.md) 第四版写成，经过两轮评审（偏离 proposal、在 pi 上能否实现、完整与可测、与现有 App 的衔接）和实现中的补充；已实现，除真实模型一层外全部验收通过（见 [v1/models-checks.md](../v1/models-checks.md)）。更新日期：2026-10-21。
2026-10-24 补丁：思考关不掉的模型（proposal §10“思考关不掉的模型”，负责人选定方案 B）：新增 §7.7，改 §4.4、§7.2、§7.3、§7.4、§7.6、§9.1、§9.2、§11.2、§12、§13、§14.1、§14.2（MP-38–MP-40）、§14.3，以及记忆规格 §8、§10.4 的注；§7.7 末尾的三项已在 OpenRouter 上实测（2026-10-24）；已实现（2026-10-24，分支 `claude/v1-reasoning-mandatory-impl-640e42`，检查记录见 [v1/models-checks.md](../v1/models-checks.md)“思考关不掉的模型：实现与检查”）。

本文是 proposal 的实现说明：proposal 讲心智模型，本文讲在 Mori 里怎么做、做到什么算完成。
两者冲突时以 proposal 为准；本文不另加 proposal 没有的行为。proposal 没定、实现又必须有一个值的地方，本文给出临时默认值，
登记在 [v1/defaults.md](../v1/defaults.md)（§12）。

## 0. 范围

**本规格实现**普通模式下的模型层，即今天 App 里的每个会话（主 Agent，就是 v0 的那个 Agent）和后台调用（测试连接、探针、上下文压缩）用到的全部内容：

- Mori 自己的模型配置（分组、提供商、多个 key、模型、网络区域、项目授权与项目配置）、编译到 pi、从 v0 的 `models.json` 迁移；
- 选择范围与选择器、会话启动校验、按可用性换 key 与换模型、重做与重建上下文、候选耗尽；
- 模型档案与探针（含交接写入等级 A/B/C 的判定）、适配层中普通模式用得到的部分；
- 按 key 的模型池（并发、排队、简单优先级、记住不可用）；
- 设置页的模型部分、首次启动表单、输入框下面一行的选择范围、对话流里的提示、阶段行、拒绝启动的说明；
- 现有测试与回放随之调整（§14.4）。

（2026-10-23 注：提供商表单、卡片上的 Add model、首次启动表单和探针第 0 步按一键拉取模型改，见 [model-discovery.md](model-discovery.md) §0。）

**不在本规格实现**的部分只在有平行 Agent 与 TaskBoard 之后才有调用方，规则列在 §10，由那份规格按这些规则实现。

本规格不留“以后再做”的条目：§14 的每一条验收都有对应的测试，`tests/spec-coverage.mjs` 检查每一条都有通过的结果（§14.3）。

界面文字：本规格新增和改写的界面用英文（[app-v0](../app-v0.md) §11，2026-10-21 定）；没有改到的旧界面仍是中文，等英文任务统一改。
文档正文、代码注释仍用中文；代码、日志、错误输出用英文。

## 1. 术语与代码名

| proposal 用语 | 本文与代码中 | 说明 |
| --- | --- | --- |
| 分组 | group，`ModelGroup` | 有序的成员列表，每个成员是提供商 id 或 `<provider>/<model>` |
| 提供商 | provider，`ModelProvider` | 一个端点 |
| API key | key，`ProviderKey` | 提供商下的一个密钥；配置里只存引用 `ref`，密文在 `credentials.json` |
| 模型 | model，`ProviderModel` | 提供商下的一个模型；全名 `<provider>/<model>`，第一个 `/` 之前是提供商 |
| 选择范围 | pick，`ModelPick` | 一个字符串：分组 id、提供商 id，或 `<provider>/<model>` |
| 候选列表 | candidates | 选择范围按 §5.1 展开后的有序模型列表 |
| 一段工作 | reply，`ReplyState` | 普通模式下主 Agent 回答一条消息的过程（§5.2） |
| 能力要求 | requires | 本规格里只有主 Agent 的 `[tool_calling]`（proposal §5）；平行 Agent 规格 §12.2 加上角色的 `requires` |
| 模型档案 | profile，`ModelProfile` | §7 |
| 网络区域 | zone：`local` / `intranet` / `public` | §4.3 |
| 普通模式 | — | 协作模式关闭（协作模式见平行 Agent 规格 §5） |

## 2. 组件与代码落点

模型层在后台进程（`app/src/kernel/`）里实现，是 [app-v0](../app-v0.md) §6“后台进程只做六件事”的第 6 件。

| 组件 | 文件 | 做什么 |
| --- | --- | --- |
| 模型配置 | `kernel/modelConfig.ts` | 读写 `model-config.json`，zod 校验，名字解析，删除的连带改动，项目配置叠加（§4） |
| 迁移 | `kernel/modelMigrate.ts` | 第一次启动时从 `models.json` 迁移（§4.5） |
| 编译 | `kernel/modelCompile.ts` | 把配置注册成 pi 的提供商与模型，按档案设兼容选项，出错回滚（§4.4、§7.6） |
| 选择器 | `kernel/selector.ts` | 纯函数：展开范围、逐项过滤、给出排除原因（§5.3） |
| 会话接线 | `kernel/modelSession.ts` | 每个会话的虚拟模型、流函数包装、换模型、上下文钩子、段的开始与结束（§5、§6、§11） |
| 上下文规则 | `kernel/modelContext.ts` | 纯函数：隐藏、重建、接手判断（§6） |
| 模型池 | `kernel/modelPool.ts` | 按 key 的槽位、排队、优先级、不可用记录、发请求用的 fetch（§8） |
| 失败分类 | `kernel/modelFailure.ts` | 纯函数：HTTP 状态、响应头、响应体、网络错误 → 分类（§5.4） |
| 时长 | `kernel/modelTimings.ts` | §12 的全部时长；纯函数都以参数接收时长和 `now()` |
| 档案 | `kernel/modelProfiles.ts` | 读写 `model-profiles.json`、指纹、能力三态（§7） |
| 探针 | `kernel/probes.ts` | 探针请求与判定（§7.3） |
| 测试连接 | `kernel/config.ts`（改写） | 测试连接改走模型池；只保留 pi 设置的读写（§9.4） |
| 密钥 | `kernel/credentials.ts`、`main/credentials.ts` | key 按 `ref` 存取（§4.1） |
| 进程桥协议 | `shared/models.ts`（新）、`shared/protocol.ts` | 命令、结果与事件（§9.5） |
| 界面 | `renderer/src/components/` 与 `state/` | §9 |

（2026-10-23 注：一键拉取模型新增 `kernel/discoverRead.ts`、`kernel/modelDiscover.ts` 和 `renderer/src/components/settings/Checklist.tsx`，并改 `probes.ts`、`modelProfiles.ts`、`modelCommands.ts`；`kernel/modelLayer.ts` 只加接线（按那边 §5.1 给已有提供商取 key、探针第 0 步的新依赖、`checkVersions` 改用读版本），`kernel/modelTimings.ts` 加发现请求的时限，见 [model-discovery.md](model-discovery.md) §2。）

## 3. 数据文件

| 文件 | 内容 | 谁写 |
| --- | --- | --- |
| `<userData>/model-config.json` | 用户级模型配置（§4.1），包括本机的项目授权 | 后台进程；原子写（先写临时文件再改名） |
| `<userData>/model-profiles.json` | 模型档案（§7.2） | 后台进程 |
| `<userData>/model-migration.json` | 迁移说明（§4.5），你点 Dismiss 后删除 | 后台进程 |
| `<userData>/credentials.json` | key 的密文，`{ <ref>: <base64 密文> }`（M0 起的格式不变） | 主进程（safeStorage） |
| `<project>/.mori/models.json` | 仓库里的项目配置，只能收紧（§4.3） | 你手工写；Mori 只读 |
| `<agentDir>/models.json` | v0 的配置；迁移后不再读，也不改、不删 | — |
| `<agentDir>/settings.json`（pi） | 新会话默认的思考强度（按模型）、`defaultThinkingLevel` 等 pi 设置；不再写默认模型 | 后台进程（沿用 v0） |
| 会话文件（pi） | 自定义条目 `mori.pick`、`mori.model_switch`、`mori.rebuild`（§5.1、§6） | pi 的 `appendCustomEntry` |

## 4. 配置

### 4.1 用户级配置

`model-config.json` 用 zod 严格校验（未知字段报错）：

```json
{
  "version": 1,
  "providers": [
    {
      "id": "deepseek-2",
      "name": "DeepSeek",
      "api": "openai-completions",
      "baseUrl": "https://api.deepseek.com",
      "zone": "public",
      "compat": { "maxTokensField": "max_tokens" },
      "concurrency": 4,
      "keys": [{ "ref": "deepseek-2#1", "label": "Key 1" }],
      "nextKeyNumber": 2,
      "models": [
        { "id": "deepseek-chat", "family": "deepseek", "contextWindow": 131072, "maxTokens": 8192,
          "reasoning": false, "input": ["text"] }
      ]
    }
  ],
  "groups": [{ "id": "cloud", "members": ["deepseek-2/deepseek-chat", "glm"] }],
  "normalDefault": "cloud",
  "allowedZones": ["local", "intranet"],
  "projectZones": { "d:/work/tool": ["public"] }
}
```

| 字段 | 规则 |
| --- | --- |
| `providers[].id` | `^[a-z0-9][a-z0-9-]{0,39}$`。与分组 id 共用一个名字空间，不能重复。保留 id：`mori`（会话的虚拟模型用，§11.1）和 pi 内置的提供商 id（启动时从 pi 读出，例如 `deepseek`、`openai`），避免 pi 把内置的认证和模型并进来。新建时由名称生成：小写，非字母数字换成 `-`，去掉首尾 `-`，截到 40 个字符（加后缀时缩短前面，使总长不超过 40），结果为空（例如名称全是汉字）时用 `provider`，与已有 id 或保留 id 重复时加 `-2`、`-3`。建好后不能改（会话记录和档案按它引用） |
| `providers[].name` | 非空，界面显示用 |
| `providers[].api` | `openai-completions`、`openai-responses`、`anthropic-messages`（v0 的 `API_TYPES`） |
| `providers[].baseUrl` | http 或 https URL |
| `providers[].zone` | `local`、`intranet`、`public`；只有迁移来、还没确认的提供商可以是 `null`（§4.5） |
| `providers[].compat` | 只能写 v0 的 `COMPAT_OPTIONS` 里的六个字段，值同 v0；只对 `openai-completions` 生效 |
| `providers[].concurrency` | 每个 key 的并发上限，整数 1–64，新建默认 4 |
| `providers[].keys` | 0–8 个，顺序就是使用顺序。`ref` 全局唯一，只含 `[A-Za-z0-9._#-]`；`label` 非空。没有 key 的提供商发请求时不带认证头（例如本机 Ollama，§8.4） |
| `providers[].nextKeyNumber` | 整数 ≥ 1，只增不减。新 key 的 `ref` 是 `<提供商 id>#<nextKeyNumber>`，之后加 1；删掉的编号不再用 |
| `providers[].models` | 至少 1 个，列出的顺序就是范围里的顺序。`id` 非空、不含空白，同一提供商内唯一，建好后不能改；`family` 可以为空字符串；`contextWindow` 正整数；`maxTokens` 正整数且小于 `contextWindow`；`reasoning` 布尔；`input` 为 `["text"]` 或 `["text","image"]` |
| `groups[]` | `id` 规则同提供商 id。`members` 是有序、不重复的成员，至少 1 个：已存在的提供商 id（它的全部模型），或已存在的 `<provider>/<model>`（只这一个模型）。同一个提供商或模型可以在多个分组里 |
| `normalDefault` | 一个选择范围（§4.2）或 `null`；指向的名字必须存在 |
| `allowedZones` | 所有项目默认允许的区域，只能是 `local`、`intranet` 的子集，默认两者都有。公网只能按项目授权（proposal §12 第 2 条） |
| `projectZones` | 本机按项目授权：键是项目文件夹的规范化路径（绝对路径、全部小写、`/` 分隔、无结尾 `/`），值是在 `allowedZones` 之外为这个项目额外允许的区域。路径比较不分大小写（Windows） |

**删除的连带改动**（确认框列出每一项）：

- 删除提供商：它和它的模型从所有分组里去掉，它的 key 一起删除；
- 删除模型：它从所有分组里去掉；它是提供商的最后一个模型时，提供商一起删除（同上一条），确认框写“This is the last model of <name>; the provider and its keys are deleted too.”；
- 因此变空的分组一起删除；
- `normalDefault` 指向被删的名字时改为 `null`；
- 删除分组：`normalDefault` 指向它时改为 `null`，确认框说明“Sessions using this group will need a new model range.”。

打开着的、范围指向被删名字的会话，静态校验按 `pick_missing` 拒绝启动（§4.6）。会话文件里的 `mori.pick` 和项目配置不改。

**改提供商地址**：`baseUrl` 的 origin（协议、主机、端口）变了时，保存会删除它的全部 key，确认框写“Changing the base URL removes this provider’s N saved keys. Add them again after saving.”（沿用 v0“改了服务地址就要重新填写 key”，key 不会发到新的地址）。

**启动时配置读不出**：`model-config.json` 存在但不是合法 JSON 或校验失败时，不迁移、不显示首次启动表单、不覆盖文件；所有会话按 `config_invalid` 拒绝启动，设置页 Models 只显示这条错误（“Couldn’t read model settings: <文件路径>: <校验原文>”）和“Retry”。

key：明文只经进程通道交给后台进程，放在模型池的内存里（§8.4），不进 pi、不进任何配置文件、不回到界面。从 v0 迁移来的 key 沿用原来的 `ref`（就是 v0 的提供商 id）。

### 4.2 名字与引用

- 选择范围是一个字符串：等于某个分组 id 就是分组；等于某个提供商 id 就是提供商；含 `/` 就是 `<提供商>/<模型>`。分组和提供商共用名字空间，所以不会有歧义。
- 引用的名字不存在时报错“<名字> is not in your model settings”，并说明谁引用了它（默认范围、本会话的范围、项目配置的哪一项）。

### 4.3 网络区域、项目授权与项目配置

一个项目（会话的工作文件夹）允许的区域：

1. 用户级 `allowedZones`；
2. 加上 `projectZones[项目路径]`（本机授权，只在设置页 Project access 里改，§9.1）；
3. 再与 `<project>/.mori/models.json` 的 `allowedZones`（若写了）取交集。

`<project>/.mori/models.json` 严格校验，只能写两项：

```json
{ "allowedZones": ["local"], "groups": { "cloud": ["glm/glm-4.6"] } }
```

- `allowedZones`：只会缩小（与前两步的结果取交集）。
- `groups`：把用户的某个分组在这个项目里缩小到它的一部分。列出的每一项必须是用户这个分组的成员，或者是某个提供商成员下的模型（把这个提供商缩小到这个模型）。
  展开顺序按用户分组里成员的顺序；同一提供商成员缩小成多个模型时，按提供商里列出的模型顺序。
- 分组不存在、列出的项不属于用户的这个分组、某个分组的列表为空、有别的字段、文件不是合法 JSON、文件读不出（不存在除外）：会话按 `project_config` 拒绝启动，显示原因或校验原文。
- 不能新增提供商、模型或 key。项目没有这个文件时只按前两步算。

区域只约束会话的模型请求（含它的压缩）。探针、测试连接、key 的 Test 是你在设置页发起的、只发合成内容，不按项目区域过滤；区域未确认的提供商也可以探测和测试。

### 4.4 编译到 pi

后台进程启动时、配置每次保存后、以及探针结束使某个模型的 `reasoning.replay` 变化时（只重新注册这个提供商，§7.4）：

1. pi 的运行时用 `ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })`：不读 `models.json`。
2. 每个提供商 `registerProvider(id, { name, baseUrl, api, apiKey: <占位>, models })`。每个模型带 `id`、`name`（= id）、`api`、`input`、`reasoning`、`contextWindow`、`maxTokens`、`cost`（全 0）和 `compat`（配置里的六个字段，加上档案给出的 `requiresReasoningContentOnAssistantMessages`，§7.6）。
   `apiKey` 是一个不保密的占位字符串（§12），只为让 pi 把提供商当作“已配置”；真正的 key 由模型池在发请求时写进认证头（§8.4）。
   （2026-10-24 补：档案 `reasoning.off_refused` 为真的模型另带 `thinkingLevelMap: { off: null }`，写在模型上、三种接口都写，不放进 `compat`；探针结束使某个模型的 `off_refused` 变化时同样只重新注册这个提供商，§7.7。）
3. 配置里删掉的提供商 `unregisterProvider`。
4. `await runtime.refresh({ allowNetwork: false })`：pi 的 `registerProvider` 自己发起的刷新不等待，会与别的刷新互相覆盖（§11.6 K9）。
5. 出错（pi 抛错）时：用旧配置把本次改动过的提供商重新注册（被删的重新注册、新增的 `unregisterProvider`），再刷新；保存失败，配置文件不改，错误原文显示在设置页。
6. 打开着的会话不需要重新创建；下一个请求起按新配置选择（§4.7）。

### 4.5 从 v0 迁移

后台进程启动时，`model-config.json` 不存在而 `<agentDir>/models.json` 存在，就迁移一次。读 `models.json` 用 v0 的读法（去 BOM、`//` 注释和多余的逗号）。

| v0 | 迁移成 |
| --- | --- |
| `models.json` 的每个 provider（不只 `mori-endpoint*`） | 一个提供商，`id` 不变；不符合 §4.1 规则、或是保留 id 的按 §4.1 改写（冲突加 `-2`、`-3`），在说明里列出 |
| provider 的 `name`、`baseUrl`、`api` | 原样；`name` 没有时用 id；`api` 不在三种之内的 provider 不迁移，在说明里列出 |
| `compat` | 六个字段只保留 v0 勾选时写的那个值（例如 `supportsStore: false`）；别的值和其余字段丢弃并在说明里列出 |
| `credentials.json` 里以 provider id 为 `ref` 的密文 | `keys: [{ ref: <provider id>, label: "Key 1" }]`，`nextKeyNumber: 1` |
| provider 的 `apiKey` 字段（手写在 `models.json` 里的明文） | 没有同 `ref` 的密文时交给主进程加密存为 `ref` = provider id 的 key；已有密文时以密文为准，在说明里注明；以 `$` 开头的环境变量写法不迁移，在说明里列出“需要重新填写 key” |
| 每个模型 | `id` 不变；`contextWindow`、`maxTokens` 取原值，没有时取 pi 的默认（128000、16384）；`maxTokens` 不小于窗口时取窗口的一半；`reasoning` 原值；`input` 原值或 `["text"]`；`family` 为空。不合格的模型丢弃并列出；一个合格模型都没有的 provider 不迁移 |
| 网络区域 | `zone: null`（未确认），设置页按 §12 的规则给出建议，由你确认 |
| pi 设置的 `defaultProvider` / `defaultModel` | `normalDefault` = `<provider>/<model>`（按改写后的 id；找不到时为 `null`） |
| pi 设置的 `modelThinkingLevels` | 原样保留；改写了 id 的，把旧键复制到新键（旧键不删） |
| 分组 | 不新建 |

- `providers` 为空或没有、或没有一个 provider 能迁移：不写配置，按首次启动处理；后一种情况把迁移说明作为 `migrationError` 显示在首次启动表单上方。
- 迁移成功：写 `model-config.json` 和 `model-migration.json`（说明：迁移了哪些提供商、改写了哪些 id、丢弃了什么、哪些要重新填 key）；对迁移来的全部模型在后台跑探针（§7.4）；这次启动直接打开 设置 → Models。
- 迁移说明在 Models 顶部一直显示，直到你点“Dismiss”（删除 `model-migration.json`）。
- 迁移失败（`models.json` 读不出、任何一个明文 key 加密失败）：不写 `model-config.json`，按首次启动处理，首次启动表单上方显示失败原文。

### 4.6 会话启动校验

会话新建、打开、改了范围、配置或档案变化、探针结束时，后台进程对会话做一次**静态校验**：按 §5.3 的第 1–3 步过滤（不看可用性），结果是 `ModelState.blocked`（§9.5）。

| 结果 | 条件 | 卡片文字（§9.3） | 可做的操作 |
| --- | --- | --- | --- |
| 可以发送 | 至少剩一个候选 | — | — |
| `verifying` | 没有候选通过，而且被排除的候选里至少一个是 `probing` | Verifying <模型>… | 无（探针结束自动重新校验） |
| `no_candidate` | 没有候选通过，没有在验证中的 | This session can’t start: no model fits. 加每个候选及原因 | Verify now（有 `unverified` 的候选时）；Allow <区域> for this project（有 `zone_blocked` 的候选、且项目配置没有排除这个区域时：打开 设置 → Project access，焦点在这个项目）；Confirm zone（有 `zone_unconfirmed` 的候选时：打开 设置 → Models 顶部区域未确认的几行）；Change model…；Open settings |
| `no_pick` | 会话没有范围（§5.1） | No default model range; pick one. | Change model…；Open settings |
| `pick_missing` | 范围指向的名字不存在 | <名字> is not in your model settings. | Change model…；Open settings |
| `project_config` | 项目配置无效（§4.3） | .mori/models.json: <原因或原文> | Open settings |
| `config_invalid` | 用户级配置读不出（§4.1） | Model settings can’t be read: <路径>: <原文> | Open settings |
| `agents_invalid` | `.mori/agents/*.md` 有错（平行 Agent 规格 §4.4，2026-10-21 加；优先于以上各项） | Fix the agent files 加每个问题 | Check again |

被拒绝启动的会话可以看历史、可以在输入框打字、可以改范围；发送不可用，后台进程收到这个会话的 `session.prompt` 时拒绝（`This session can’t start: no model fits`，经 `mori.prompt_error` 把文字放回输入框）。

### 4.7 回复进行中改配置

- `ReplyState.current` 存 `<provider>/<model>` 字符串，每次请求从运行时取模型对象。
- 正在用的模型或它的提供商被删除：保存照常进行；这段的下一个请求按 §5.6 换模型，原因 `missing`（“removed from your model settings”）。
- 配置或档案的其他变化不让段内的 `current` 失效：段内只有 §5.4 的失败分类会换模型，第 3 步（档案）只在选模型时判断。
- key 或并发上限的变化按 §8.2 处理。

## 5. 选择与切换

### 5.1 选择范围与候选

- 普通模式下每个会话有一个选择范围，记在会话文件里（自定义条目 `mori.pick`，`{ pick }`），以最后一条为准：
  - 新会话：创建时记下当时的 `normalDefault`；`normalDefault` 为 `null` 时不记，会话按 `no_pick` 拒绝启动；
  - 你在范围菜单里选了一个范围：再记一条（§5.10）；
  - 打开一个没有 `mori.pick` 的会话（v0 的旧会话）：最后一条助手消息的 `<provider>/<model>` 在配置里存在就以它为范围，否则用当时的 `normalDefault`；打开时记下这一条。
  - 设置里的默认范围后来改了，已有会话的范围不变。
- 展开：分组 → 成员按分组中的顺序（项目配置缩小过的按 §4.3），提供商成员展开成它列出的全部模型，模型成员就是它自己；提供商 → 它的模型按顺序；模型 → 它自己。
  同一个模型只保留第一次出现。
- 主 Agent 的能力要求固定为 `[tool_calling]`（proposal §5）；对话由用户定义的角色持有时再加上它的 `requires`（平行 Agent 规格 §12.1）。

### 5.2 一段工作（reply）

普通模式下一段工作是主 Agent 回答一条消息的过程：

- **开始**：
  - 你发消息：后台进程处理 `session.prompt` 时（§11.4），在调 pi 之前建立 `ReplyState`；
  - 排队的消息（followUp）在同一次 pi 运行里被处理：它被 pi 送进上下文时开始新的一段（§11.4）。
- **插话**（steer）不论在什么时候送达，都属于正在进行的那一段。
- **结束**：pi 发 `agent_settled`，或 pi 的 `prompt()` 结束（成功或抛错）时会话已不在运行，都清掉 `ReplyState`。
- `ReplyState`：`startedAt`（§11.4，晚于上一段的全部消息）、`anchor`（这段要回答的那条用户消息）、`current`（当前模型）、`tried`（本段里已失败、不再选的模型及原因）、`skipped`（段开始时排在 `current` 之前、被跳过的候选）。
- 段开始时从候选的第一个起选；段内一直用 `current`（粘性），只有它出故障才按 §5.6 换。下一段重新从第一个候选起选，所以首选恢复后下一段自然用回首选。

### 5.3 选择器

`select(input) → { model | null, excluded: [{ ref, reason, detail }] }`，纯函数。输入：候选列表、项目允许的区域、档案、可用性快照、`ReplyState`（可以没有）、当前时刻、时长表。

按顺序对每个候选判断，第一个不满足的条件就是它的排除原因：

| 步 | 条件 | 原因代码 | 界面文字 |
| --- | --- | --- | --- |
| 1 | 名字在配置里 | `missing` | not in your model settings / removed from your model settings（回复进行中被删时） |
| 2 | 提供商区域已确认 | `zone_unconfirmed` | network zone not confirmed |
| 2 | 区域在项目允许的区域里 | `zone_blocked` | zone <区域> is not allowed for this project |
| 3 | 档案的 `tool_calling` 为已验证（§7.4 重新验证期间按旧结果） | `probing` / `unverified` / `failed` | verifying… / tool calling not verified yet / tool calling failed verification |
| 3 | 角色会话：满足角色的 `requires`、不是要避开的模型族（平行 Agent 规格 §12.2、§12.9，2026-10-21 加） | `requires_unmet` / `same_family` | <不满足的那项> / same model family as the author (<族>) |
| 4 | 可用（§8.3） | `rate_limited` / `auth` / `quota` / `connection` / `not_found` / `timeout` / `held` | rate limited until hh:mm:ss / API key rejected / quota exhausted / can’t connect until hh:mm:ss / model not found on the server / no response; unavailable until hh:mm:ss / waiting to make sure it stopped, until hh:mm:ss |
| 5 | 不在 `tried` 里 | `tried` | failed earlier in this reply: <它的原因文字> |
| 5 | 段内选择时，排在 `current` 之后（不在 `skipped` 里，也不是排在它前面的） | `earlier` | skipped at the start of this reply |
| 6 | 能接手这段对话（§6.2，只在要换到它时判断） | `no_handover` | conversation too long for this model / couldn’t rebuild the conversation: <原文> |

- 第 1–3 步是静态校验（§4.6）；第 4–6 步只在选模型时判断。`queue_timeout` 不会出现在可用性里：它只让这一次请求换模型，记进 `tried`（文字“waited 60 s for a free slot”）。
- 没有 `ReplyState` 或段刚开始：选通过的第一个。段内：`current` 仍通过第 1–5 步就继续用它；否则只在排在 `current` 之后的候选里按顺序选。
- 展示原因时用“界面文字”列；`<它的原因文字>` 不带 until 部分。排除结果里的 `detail` 就是完整的界面文字（含 until）。界面文字只有一份，放在 `shared/models.ts`，后台进程（重做说明、没有可用模型的说明）和界面（卡片、菜单）共用。

### 5.4 失败分类

模型池在 HTTP 层看到每次尝试的结果（§8.4），按下表分类。“有输出”指这次请求已经收到正文、思考或工具调用的内容。

| 结果 | 分类 | 处理 |
| --- | --- | --- |
| HTTP 429 | `rate_limited` | 这个 key 冷却到 `Retry-After` 给的时刻（秒数、HTTP 日期，或 `retry-after-ms`；都没有时按 §12）；同一提供商还有可用的 key 就换 key 重发（§5.5）；没有就换模型（§5.6） |
| HTTP 401、403 | `auth` | 这个 key 标为被拒绝（§8.3）；换 key 或换模型同上 |
| HTTP 402，或状态 400/403/429 且响应体含 §12 的额度关键词（不区分大小写） | `quota` | 同 `auth`，原因为额度 |
| HTTP 404 | `not_found` | 这个模型标为不可用（§8.3）；换模型 |
| 发出前或收到响应头前的网络错误（连接被拒、DNS、TLS、连接重置），以及收到响应头之后、第一个有内容的事件之前连接中断（由包装判断，它知道有没有内容） | `connection` | 这个提供商不可用一段时间（§12）；换模型 |
| 排队等槽位超过 §12 的时长 | `queue_timeout` | 请求没有发出；换模型 |
| HTTP 500、502、503、504 | `server` | 原地重试（§5.5）；重试用完后这次回复以错误结束，不换模型（proposal：v1 原地重试） |
| 一次 HTTP 尝试真正发出（拿到槽位与 key 之后）起 §12 的时长内没有收到第一个有内容的事件（正文、思考、工具调用）；排队、换 key、原地重试的等待不计入，每次尝试重新计时 | `timeout` | §5.7 |
| 其他 4xx（例如 400 参数或模板错误） | `request` | 不换；这次回复以错误结束，显示原文 |
| 已经有输出后连接中断或出错 | `partial` | 不换；回复以错误结束，已显示的部分保留 |
| 上下文超长的错误 | — | 不换；由 pi 的溢出恢复（压缩后重试）处理，压缩走 §6.4 |
| 你按了停止 | — | 停止，不换 |

内容策略拦截在 pi 里表现为正常结束或 4xx，按上表不换。模型输出格式错误（例如工具参数不合格）在 pi 的循环里作为工具错误回给模型，不经过模型池，也不换。

### 5.5 换 key 与原地重试

都在模型池的 fetch 里完成，pi 只看到最后一次的响应：

- **换 key**：同一个请求体、同一个模型，换到同一提供商下一个可用的 key 重发；按 §8.2 重新排队。不算换模型，对话流不提示；等槽位时阶段行显示“Waiting for <提供商名>”。请求体不是字符串时（不能重发）按换模型处理。
- **原地重试**：`server` 分类按 §12 的次数和间隔重发（可以换 key）；每次等待前发 `mori.model_retry`，阶段行显示“Retrying (n/m) · HTTP 503”。
- pi 自己的 agent 级自动重试对 Mori 的会话关闭：每次调 pi 的 `prompt`、`steer`、`followUp`、`compact` 之前，都对会话的 `settingsManager` 执行 `applyOverrides({ retry: { enabled: false } })`（只在内存里、可以重复执行；pi 的 reload 和带 `persist` 的设置会清掉它，§11.6 K6）。
  provider 级重试由包装在每次请求的选项里写 `maxRetries: 0`。所以只有一层重试，就是模型池的。

### 5.6 换模型

换模型发生在 pi 的一次模型请求里，由 Mori 的流函数包装完成（§11.2）：

1. 当前模型这次请求失败，分类要求换模型，且这次请求还没有输出；或者发请求之前 `route()` 发现 `current` 已不在配置里、或已不可用（§11.1），这时不发出就换。
2. 失败的模型记进 `tried`；按 §5.3 在排在它之后的候选里选下一个，对每个候选做接手判断（§6.2）。
3. 选到了 B：
   - 写一条 `mori.model_switch` 条目（§6.1）；发 `mori.model_switch` 事件，对话流显示“Switched model: A → B · <原因>”，有被隐藏的过程时加“The new model redoes this response.”；
   - 用 §6 处理后的上下文，把同一个请求按 B 组装后发出——这就是 proposal 7.3 的“重做这次回复”（第一个请求就失败时没有要隐藏的过程，就是把这条消息原样交给 B）；
   - 之后段内都用 B（`ReplyState.current = B`）。
4. 选不到：按 §5.8 等待。

段内不会回到 `tried` 里的模型，也不会回到段开始时排在 `current` 前面的候选；首选恢复要等下一段。

### 5.7 结果未知（发出后超时）

一次尝试按 §5.4 的 `timeout` 超时：Mori 中止这次尝试（关闭连接）。

- 档案的 `cancel_verified` 为 `true`（探针证明断开后服务端会停止，§7.3）：这个模型不可用一段时间（`timeout`，§12），立即按 §5.6 换模型。
- `cancel_verified` 为 `false`（探针读得到服务端指标，但断开后请求没有停）：发每次尝试之前读一次服务端正在跑的请求数作基线（§7.3 第 9 步的指标）；超时后模型进入 `held`，
  每隔 §12 的间隔读一次，回到基线或更低即视为旧请求已停，立即按 §5.6 换模型；最长等 `held` 的时长。
- `cancel_verified` 为 `unknown`（没有指标可读）：模型进入 `held`，等满 §12 的时长后按 §5.6 换模型，换模型提示注明“Couldn’t confirm it stopped”。
- 等待时阶段行显示“Waiting to make sure <模型> stopped · until hh:mm:ss”（`mori.model_wait`，`kind: held`）；你可以按停止。同一个请求不会同时在两个模型上跑（proposal §8、§12 第 4 条）。

### 5.8 候选耗尽

选不到模型时先等：

- 阶段行显示“Waiting for a model · <最先恢复的那个候选的原因>”（`mori.model_wait`），在最早的恢复时刻、探针结束时、或每隔 §12 的间隔重新选，最长等 §12 的时长。
- 剩下的候选都是不会自己恢复的原因（`missing`、`zone_*`、`unverified`、`failed`、`auth`、`quota`、`not_found`、`tried`、`earlier`、`no_handover`）时不等。会恢复的是 `probing`、`rate_limited`、`connection`、`timeout`、`held`，但本段已在 `tried` 或 `earlier` 里的候选不算（它们恢复了本段也不会再选）。
- 等到了：继续（模型变了就按 §5.6 写换模型条目）。
- 没等到：发 `mori.model_unavailable`，对话流显示一张说明卡“No model available”：每个候选及原因，“Open settings”；这次请求以错误结束，pi 的错误卡不另外显示（§9.3）。
- 段开始时（§11.4）就选不到时同样先等；没等到时消息不发出：后台进程只发 `mori.model_unavailable`（`firstRequest: true`，`text` 为这条消息，`queued` 为准备中又发的消息），界面撤回这条用户消息、把文字放回输入框，显示同一张说明卡，不发 `mori.prompt_error`。
- 压缩时（没有段、或段内的压缩请求）选不到模型：不等待，`route()` 抛出“No model available for compaction: <每个候选及原因>”，由 pi 报告压缩失败。

### 5.9 不换的情况

proposal §8 中“不换”的各项按 §5.4 处理：输出格式错误、上下文太长（压缩或重建）、内容策略拦截、你按了停止、已经有输出、5xx（原地重试）。

### 5.10 选择范围菜单

- 菜单列出全部分组、提供商和模型；选一个就写一条 `mori.pick`，重新做静态校验，下一段起生效。
- 回复进行中（含 §11.4 的准备阶段）不能改，沿用 v0 的临时默认值“生成中不能换模型和思考强度”。
- 改了范围不改设置里的 `normalDefault`。

## 6. 跨模型上下文

### 6.1 重做：隐藏中断的过程

`mori.model_switch` 条目：`{ from, to, reason, detail, unconfirmed, replyStartedAt, anchorAt, hideUntil }`。

- `replyStartedAt` = `ReplyState.startedAt`；`anchorAt` = 这段 `anchor` 消息的时间戳（排队消息的时间戳是它排队的时刻，可能早于 `replyStartedAt`）。
- `hideUntil` = 换模型时上下文里助手消息和工具结果的最大时间戳；没有这类消息时等于 `replyStartedAt`（没有要隐藏的）。
  包装在 `Date.now()` 大于 `hideUntil` 之后才对 B 发请求，保证 B 的消息时间戳在区间之外。

发给模型的上下文（pi 的 `context` 钩子，以及换模型那一次由包装算出的上下文）按会话里的全部 `mori.model_switch` 条目处理：

- 时间戳在 `[replyStartedAt, hideUntil]` 之间的助手消息和工具结果不发给模型；用户消息（原消息、插话）都保留。上一段的消息都早于 `replyStartedAt`，不受影响。
- 同一段有多条条目时，隐藏区间取并集。
- 说明加在这段的 `anchor` 消息、或它之后时间戳 ≤ 最后一条条目的 `hideUntil` 的最后一条用户消息（插话）的内容末尾，不新增消息（以免连续两条用户消息）：
  `[Mori] The previous model (<from>) stopped partway through this reply (<reason>). Its partial work is hidden from you. Files in the workspace may already have been changed; check before you redo anything.`
  `<from>`、`<reason>` 取最后一条条目，`<reason>` 用 §5.3 的界面文字。没有被隐藏的消息时不加。这段文字已经在消息末尾时不再加（同一个函数处理多次结果不变）。
- 会话文件不改：被隐藏的消息仍在文件里，界面照常显示；重新打开会话后同样隐藏。
- 压缩也不能把被隐藏的过程带给新模型：Mori 的内联扩展处理 `session_before_compact`，按同样的规则就地从 `preparation.messagesToSummarize` 与 `turnPrefixMessages` 去掉被隐藏的助手消息与工具结果，并从 `preparation.fileOps` 的三个集合里去掉只在被隐藏的工具调用里出现过的路径，不返回结果，由 pi 照常压缩（§11.6 K12）。

### 6.2 接手判断

要用的模型 B 与上下文里最后一条有效助手消息（不是出错或中止的）的模型 A 不同（提供商、接口、模型 id 有一个不同）时，判断 B 能否直接接手（proposal §9 第三条路）。判断在 §6.1 与 §6.3 处理后的上下文上做：

| 条件 | 判断方法 | 不满足时 |
| --- | --- | --- |
| 推理字段 | B 的档案 `reasoning.replay` 为 `required`（§7.2），而上下文里有别的模型产生的、带工具调用的助手消息 | 重建（§6.3） |
| 工具调用格式 | Mori 的所有模型都用原生工具调用，pi-ai 按目标接口改写工具调用标识（`transformMessages`），所以总是满足 | — |
| 窗口 | 上下文的估算 token 数（pi 的 `estimateTokens`）加 B 的 `maxTokens` 超过 B 的有效窗口（§7.2） | 重建（§6.3）；段内不能压缩，见下 |

- **你发消息、段开始时**（§11.4）：按 §6.3 重建，重建后再判断一次窗口；仍放不下就排除 B（`no_handover`，“conversation too long for this model”），选下一个。
- **段内**（换模型，或排队消息开始的新段）：运行中不能压缩。推理字段不满足时只做 §6.3 第 2–3 步（不做摘要），B 照常接手；窗口不满足时排除 B（`no_handover`），下一段开始时再按上一条重建。

### 6.3 重建

重建 = 压缩摘要 + 最近几轮对话（proposal §9）：

1. 调 pi 的 `session.compact()`；压缩请求由 B 生成摘要（§6.4，`ReplyState.current` 此时已是 B）。这次压缩产生的 pi 事件（`compaction_start`、`compaction_end`）后台进程不转给界面：阶段行显示“Rebuilding the conversation for <B>…”（`mori.model_wait`），结果只经 `mori.model_rebuild` 或换模型提示显示，没有 v0 的压缩提示和错误卡。
   - pi 报“Nothing to compact”或“Already compacted”（对话太短、或刚压缩过）：跳过这一步，继续第 2 步；
   - 其他错误：排除 B（`no_handover`，“couldn’t rebuild the conversation: <原文>”），选下一个并重新做接手判断；全部候选都因此排除时按 §5.8。
2. 写一条 `mori.rebuild` 条目 `{ model: B, at, summary }`（`summary` 表示第 1 步做了压缩），`at` 为写条目的时刻；发 `mori.model_rebuild` 事件。重新打开会话时，pi 的压缩条目照 v0 显示“已压缩较早的对话”，其后是这条重建提示。
3. 之后发给模型的上下文里，时间戳早于 `at` 的消息：工具结果去掉；助手消息去掉思考和工具调用块，变空就去掉；其他角色（用户消息、压缩摘要、分支摘要、自定义消息、命令执行记录）原样保留。
   同一个函数既处理 pi 的 AgentMessage（`context` 钩子），也处理 pi-ai 的 Message（包装）。
4. 对话流显示一行“Rebuilt the conversation for <B>: summary + recent turns”（第 1 步跳过时为“Rebuilt the conversation for <B>: recent turns without tool calls”）。

### 6.4 压缩走 Mori

pi 的压缩（到阈值自动的、溢出恢复的、重建时的）不另加钩子：pi 先以 `direct` 原因调会话虚拟模型的 `route()` 取模型，Mori 返回 `ReplyState.current`（没有段时按 §5.3 选，选不到见 §5.8）；
再用会话的流函数发请求，也就是 Mori 的包装（§11.2），所以压缩同样经模型池、带 key。包装按请求里的 `sessionId` 与会话 id 不同认出压缩请求：压缩请求经模型池和 §5.5，不换模型、出错由 pi 报告压缩失败（v0 的错误卡）。
压缩请求属于 `conversation` 调度类别（§8.2）；每次尝试同样按 §5.4 的首个内容时限计时，超时记 `timeout`（§8.3），不换模型，pi 报告压缩失败（§6.3 第 1 步因此失败时按“其他错误”排除 B）。

## 7. 模型档案、探针与适配

### 7.1 档案键与指纹

- 档案键：`<baseUrl>|<api>|<模型 id>|<服务版本>`。服务版本取自探针第 0 步，取不到时为 `unknown`。
- 指纹：档案键加上配置里的 `contextWindow`、`maxTokens`、`reasoning`、`input`、`compat`。指纹变了，这个模型重新探测（proposal §10）。
- 读服务版本的时机：后台进程启动时；会话新建或打开时，对它范围内的模型（异步，不挡打开）。读失败（连接、非 2xx、没有版本字段）时档案不变；只有读到与档案不同的版本才算版本变化。配置保存时立即按新指纹判断。
  （2026-10-23 注：读版本每个提供商（`baseUrl` + `api`）读一次，结果对比它下面每个模型的档案：发列表请求，按那边 §3.3 全部判断种类，再发这个种类的版本请求，不发详情请求（那边 §4.2），不改 `reported`、`meta`；
  拿到了列表，且种类变了、或读到的版本与档案里的不同时这个模型重新探测；版本请求失败时只比种类（本节“读失败时档案不变”仍然成立），拿不到列表时档案不变。原来被认成 vLLM 的 LocalAI、TensorRT-LLM 因此各重新探测一次，版本改为 `unknown`。见 [model-discovery.md](model-discovery.md) §3.3、§7.3。）

### 7.2 档案字段

| 字段 | 取值 | 来源 |
| --- | --- | --- |
| `status` | `probing`、`ready`、`error`（附原文） | `error`：至少一步因连接或 HTTP 错误没有结果 |
| `server` | `{ kind, version }`，`kind` 为 `vllm`、`sglang`、`ollama`、`llamacpp`、`unknown`（2026-10-23 注：扩展为 model-discovery.md §3.3 的全部种类；`auto` 另记第 0 步读到的 `meta`（输出上限、思考、图片），见 [model-discovery.md](model-discovery.md) §7.2） | 第 0 步 |
| `tool_calling` | `verified`、`unverified`、`failed`，附第 3、4 步各自的结果 | 第 3、4 步 |
| `tier` | `A`、`B`、`C` 或 `null`，附每级的结果 | 第 5–7 步（§7.5） |
| `protocol_write` | 由 `tier` 派生：有等级为 `verified`；三级都判定为不通过为 `failed`；有一级因出错没有结果为 `unverified` | — |
| `structured_output` | `verified`、`failed`、`unverified` | 第 6 步；`anthropic-messages` 不跑第 6 步，为 `unverified` |
| `vision` | 配置声明了图像输入为 `unverified`，否则 `failed`（proposal 的探针表里没有图像探针） | 配置 |
| `reasoning` | `{ field, can_disable, replay }`。`field`：`openai-completions` 为 `reasoning_content`、`reasoning`、`reasoning_text` 或 `none`；另两种接口为 `native`。`can_disable`：`true`、`false`、`unknown`。`replay`：`required`、`not_required`、`unknown`；另两种接口为 `not_required`（pi-ai 自己回放同一模型的推理）（2026-10-24 补：加 `off_refused`：第 2 步关闭思考被服务以 400 或 422 拒绝、`medium` 有正文时为 `true`，这时 `can_disable` 为 `false`，见 §7.7） | 第 1、2、4 步 |
| `context` | `{ declared, reported, effective, truncation }`。`effective` = `declared` 与 `reported` 中较小的一个，长输入探针跑过后按第 8 步更新；`truncation`：`unknown`、`none`、`silent` | 第 0、8 步 |
| `cancel_verified` | `true`、`false`、`unknown` | 第 9 步 |
| `probedAt`、`suite` | 时间、探针套件版本 | — |

能力三态：已验证、未验证、验证失败（proposal §4）。本规格里关键能力 `tool_calling` 必须已验证才满足（§5.3 第 3 步）；
`protocol_write`、`structured_output`、`vision`、`context` 在设置页显示，供 §10 的 Agent 定义使用。（2026-10-26 注，负责人走查 M7：设置页的模型行不再列档案的各项，这几项只留在档案里，由选择器按 Agent 定义的 `requires` 检查；拒绝启动卡与说明卡照旧写出不满足的原因，例如“handoff tier C is below B”。）

### 7.3 探针

经模型池的 `background` 类别发出（§8.2），用这个提供商的 key，直接用实际模型调 `runtime.streamSimple`（§11.6 K10），选项带 Mori 的 fetch、`maxRetries: 0`、`timeoutMs: 2147483647`；
最大输出 §12；每一步 §12 的时长内没有第一个有内容的事件就中止，这一步按出错处理。第 1 步对 `reasoning: true` 的模型用思考 `medium`、否则 `off`；第 3、5、6、7、8、9 步思考关闭（`off`）；第 2、4 步见表。
（2026-10-24 补：本组第 2 步判出 `off_refused` 时第 3、4、6、7 步改用 `medium`、第 5 步不适用，第 8、9 步按档案里存的 `off_refused`；任何一步回复因输出上限停下、只有思考没有正文和工具调用时按出错处理；见 §7.7。）

| 步 | 请求 | 判定 |
| --- | --- | --- |
| 0 | GET `<baseUrl>/models`、`<origin>/version`、`<origin>/api/version`、`<origin>/props`（不计入短请求） | `server`：vLLM 的 `/version`、Ollama 的 `/api/version`、llama.cpp 的 `/props`、SGLang 的 `/models` 里 `owned_by: sglang`；`reported` 窗口：`/models` 里本模型的 `max_model_len`，或 `/props` 的 `n_ctx`（2026-10-23 注：改为调用读取器的单模型模式，种类先看列表的 `owned_by` 等再看版本接口，每个请求用发现的时限；key 用那边 §5.1 对已有提供商的选法；同一个提供商同时进行的第 0 步合并列表与种类判断；Ollama 只读到训练窗口时 `reported` 窗口为 null，见 [model-discovery.md](model-discovery.md) §7.1、§7.2） |
| 1 | “Reply with the single word: ready.” | 有正文即通过；`openai-completions` 记录推理字段名（pi-ai 记在思考块的 `thinkingSignature` 里；有 `reasoning_details` 时被覆盖成 JSON，这时按 `reasoning_content`） |
| 2 | 只对 `reasoning: true` 的模型：同一句，分别用思考 `off` 和 `medium` | `can_disable`：`off` 时没有思考内容为 `true`（2026-10-24 补：`off` 被 400 或 422 拒绝、`medium` 有正文时为 `false` 且 `off_refused: true`，这一步判定为不通过、不算出错；这一步总在没有“没有 Off”标记的模型副本上发，见 §7.7） |
| 3 | 工具 `get_weather({ city: string, days: integer })`，“Use the tool to get the weather for Paris for the next 3 days.” | 调用了 `get_weather`，`city` 是字符串，`days` 是整数（不是字符串） |
| 4 | 第 3 步的调用加工具结果“Paris: 21°C, sunny for 3 days.”，再问“What temperature did the tool report?” | 回答含 `21`。`openai-completions` 且 `reasoning: true` 的模型另做回传检查：思考 `medium` 再跑一次第 3 步，保留返回的助手消息；“带上” = 原样发出；“不带” = 去掉思考块、并在这个模型的副本上把 `requiresReasoningContentOnAssistantMessages` 设为 `false` 后发出。“不带”被拒（400 或 422）而“带上”通过：`replay: required`；都通过：`not_required` |
| 5 | 工具 `submit_outcome({ outcome: "ok" \| "fail" })`，指定调用它（`tool_choice`）并要求严格模式；“Call submit_outcome with outcome banana.” | 调用了它且 `outcome` 在枚举内：A 级通过 |
| 6 | 只对 `openai-completions`、`openai-responses`：严格的 JSON schema 输出，schema `{ outcome: "ok" \| "fail" }`；“Reply with JSON whose outcome is banana.” | 合法 JSON 且 `outcome` 在枚举内：B 级通过、`structured_output: verified` |
| 7 | 只在第 5 步判定为不通过（2026-10-24 补：或不适用，§7.7）、且第 6 步判定为不通过或不适用（`anthropic-messages`）时：“Answer in exactly this format: <summary>one sentence</summary><outcome>ok or fail</outcome>. Question: is 2 + 2 equal to 4?”，连发 §12 的次数 | 每次都能解析、取值都在列表内：C 级通过 |
| 8 | 需要你同意（§9.1）：“The passphrase is <随机词>.”，接着填充到有效窗口的 50%，最后问“What is the passphrase?”；再做一次 90% | 答对：窗口可用到这个长度。报错：`truncation` 保持 `none`、`effective` 不变。不报错但答不出暗号：`truncation: silent`，`effective` 降到通过的那个长度（50% 也没通过时为 0），设置页告警 |
| 9 | 需要你同意：只对 `server.kind` 为 `vllm`、`sglang`、`llamacpp` 的模型。先读一次服务端正在跑的请求数（vLLM、SGLang 的 `/metrics`，llama.cpp 的 `/slots`）作基线，再发“Count from 1 to 400, one number per line.”，收到第一段输出后断开 | 5 秒内请求数回到基线或更低：`true`；仍高于基线：`false`；指标接口不响应或没有这个计数：`unknown`；其他服务：`unknown` |

各接口的请求写法（经 `toolChoice` 选项和 `onPayload`）：

| 接口 | 第 5 步的指定调用 | 第 5 步的严格模式 | 第 6 步 |
| --- | --- | --- | --- |
| `openai-completions` | `tool_choice: { type: "function", function: { name } }` | `tools[i].function.strict = true` | `response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }` |
| `openai-responses` | `tool_choice: { type: "function", name }` | `tools[i].strict = true` | `text: { format: { type: "json_schema", name, schema, strict: true } }` |
| `anthropic-messages` | `tool_choice: { type: "tool", name }` | `tools[i].strict = true` | 不跑 |

`tool_calling` = 第 3、4 步都通过为 `verified`；有一步判定不成立为 `failed`；有一步出错（连接、HTTP 错误、超时）没有结果为 `unverified`，档案 `status: error` 并附原文。
第 5、6 步例外：服务端对指定调用或 JSON schema 回 400 或 422（拒绝这个功能，例如“Thinking mode does not support this tool_choice”“This response_format type is unavailable”）算判定为不通过，原文记在这一步的说明里；连接错误、其他 4xx（401、403、408、429 等认证或可用性问题）、5xx、超时仍是出错。第 4 步回传检查的“被拒”同样只认 400、422。

### 7.4 什么时候跑

- 自动（第 0–7 步）：后台进程启动时，对还没有档案的模型（上次探测没跑完 App 就关了）；添加或修改模型或提供商之后（加 key、删 key 也算修改提供商：这个提供商里档案不是已验证或验证失败的模型重新探测）；迁移之后；首次启动表单保存之后；指纹或服务版本变化之后。
- 你点“Verify”、或拒绝启动卡上的“Verify now”之后。（2026-10-26 注：模型行上常显的“Verify”删掉，只在 tool calling 没验证通过时，模型行的状态行带“Verify again”，发同样的 `models.verify`，见 §9.1。）
- 需要你同意（第 8、9 步）：只在设置页模型行上点“Long-input test…”或“Cancel test…”并确认之后；确认框写明大约多少 token（第 8 步按有效窗口的 50% + 90% 估算）。
  （2026-10-26 注，负责人走查 M7：这两个按钮与确认框从设置页删掉，界面上不再能发起第 8、9 步；后台进程里的这两步、`models.verify` 的 `tests: 'long_input' | 'cancel'` 和 §5.7 按 `cancel_verified` 分的三种处理由下一包（WP-04）删除。）
- 同一个模型同时只跑一组探针；新的一组开始时取消旧的。
- 从未验证过的模型（档案里 `tool_calling` 不是 `verified` 或 `failed`，包括上次因出错为 `unverified` 的）探测中为 `probing`；验证过的模型重新探测期间，选择仍按旧结果，设置页显示“Re-verifying…”，结果出来后替换。（2026-10-26 注：设置页不再写“Re-verifying…”，tool calling 验证过的模型重新探测时模型行没有状态行，§9.1。）
- 探针结束时重新做所有会话的静态校验，发 `mori.profiles`；档案的 `reasoning.replay` 变了时按 §4.4 重新编译这个提供商（不保存配置），下一个请求起生效。
  （2026-10-24 补：`reasoning.off_refused` 变了时同样重新编译这个提供商，§7.7。）
- 探针请求属于 `background` 类别：不受排队超时限制，一直等到有槽位（取消探针、删除模型时出队）；每一步的时限从真正发出时算起。

### 7.5 交接写入等级

`tier` = 第 5 步通过为 A，否则第 6 步通过为 B，否则第 7 步通过为 C，三级都判定为不通过为 `null`（`protocol_write: failed`）。
不适用的级别不参与判定：`anthropic-messages` 上 A、C 都判定为不通过即 `tier: null`、`protocol_write: failed`。本规格只判定和显示等级；按等级填交接单在平行 Agent 规格 §7.5。

### 7.6 适配层

普通模式用得到的适配在编译时（§4.4）按档案设到 pi 的模型上，由 pi-ai 执行：

| 档案 | 编译成 | 作用 |
| --- | --- | --- |
| `reasoning.replay: required` | `compat.requiresReasoningContentOnAssistantMessages: true` | 回传推理内容，避免这类部署拒绝请求（proposal §10“下一次请求要不要把它带回给模型”） |
| 推理字段 | 不需要设置：pi-ai 依次读 `reasoning_content`、`reasoning`、`reasoning_text` | 统一推理内容 |
| `reasoning.off_refused: true`（2026-10-24 补） | 这个模型的 `thinkingLevelMap: { off: null }` | 告诉 pi 这个模型没有 Off：pi 不再发“关闭思考”，Effort 菜单没有 Off，会话里的 Off 由 pi 提到 Minimal（§7.7） |

强制调用的改写（指定函数 → 结构化输出 → 文本标签）用在填交接单上，见平行 Agent 规格 §7.5、§12.7（三种写法移到 `kernel/forcedWrite.ts`）；本规格里只有探针第 5–7 步发这类请求，各自按 §7.3 直接组装。

### 7.7 思考关不掉的模型（2026-10-24 补丁）

依据 proposal §10“思考关不掉的模型”。Mori 关闭思考的做法是不传 `reasoning`；对勾了 Supports thinking 的模型，pi-ai 1.3.0 在 OpenRouter、DeepSeek、
z.ai、Together 的地址（按地址认出的 `thinkingFormat`）以及 `openai-responses`、`anthropic-messages` 上把它写成明确的“关闭思考”
（例如 OpenRouter 的 `reasoning: { effort: "none" }`、Anthropic 的 `thinking: { type: "disabled" }`）；必须思考的模型回 400，
OpenRouter 的原文是 `Reasoning is mandatory for this endpoint and cannot be disabled.`。其他 OpenAI 兼容服务（vLLM、SGLang、Ollama 等）关思考时什么也不发，不受影响。

**判定**（第 2 步，只对 `reasoning: true` 的模型）：

| `off` 的请求 | `medium` 的请求 | 判定 |
| --- | --- | --- |
| 正常回答，没有思考内容 | — | `can_disable: true`（同原来） |
| 正常回答，有思考内容 | — | `can_disable: false`，`off_refused: false`（同原来） |
| 400 或 422 | 有正文 | `can_disable: false`，`off_refused: true`；这一步判定为不通过（`fail`），说明为“Thinking can’t be turned off: <原文>”，不算出错，档案不因此为 `error` |
| 400 或 422 | 出错或没有正文 | 出错（同原来），`can_disable: unknown`；说明：`medium` 出错时用它的说明（含下面输出上限那一句），`medium` 没出错但没有正文时用 `off` 的原文 |
| 连接错误、其他 4xx、5xx、超时 | — | 出错（同原来） |

- 第 2 步的说明（含“Thinking can’t be turned off: <原文>”）只存在档案（`model-profiles.json`）第 2 步的结果里，`ProfileView` 不带，界面不显示；设置页看到的是档案摘要的“Thinking: Can’t be turned off”（同第 5、6 步的说明今天也只存不显示）。（2026-10-26 注：档案摘要删掉，改为模型行说明一行最后的“Thinking can’t be turned off”，§9.1。）
- 档案里存 `auto.offRefused: boolean`：在 `modelProfiles.ts` 的 `StoredProfileSchema` 的 `auto` 里加 `offRefused: z.boolean().optional()`（不加的话读回时会被丢掉）。可选字段，旧档案读作 `false`，不重新探测，`PROBE_SUITE` 不变；`ProfileView.reasoning` 加 `off_refused`。

**探针各步用的模型与强度**：

- 第 1–7 步（一组自动探针）都在一份**没有**“没有 Off”标记的模型副本上发（同第 4 步回传检查用副本的做法）：已经标记过的模型点 Verify 时第 2 步仍然重新测，这一次判出能关闭时第 3–7 步也确实关闭思考。
- 第 3–7 步用 `off` 还是 `medium`，按**这一组**第 2 步的判定：判出 `off_refused` 即第 3、4、6、7 步用 `medium`（同第 1 步和回传检查），第 5 步为 `not_applicable`；否则同原来。
  第 5 步（A 级：指定调用加严格模式，按平行 Agent 规格 §7.5 要关闭思考）不适用的理由：交接时 A 级只在 `can_disable` 为真时用（`handoffForm.ts` 的 `writeModeOf`，不改）。
- 第 8、9 步是单独的一组（需要你同意），用编译后的模型，按档案里存的 `off_refused` 选强度（这时编译后的模型与档案一致）：为真用 `medium`，否则同原来。
- 第 7 步的条件改为“第 5 步判定为不通过**或不适用**、且第 6 步判定为不通过或不适用”（这一条对所有模型都成立）。
- 回传检查不变（本来就是 `medium`）。

**输出上限**（对所有模型的第 1–9 步）：回复因输出上限停下（`stopReason` 为 `length`），而且没有正文也没有工具调用、只有思考时，这一步按出错处理，
说明为“Stopped at the probe output limit before answering”；不判为不通过，第 8 步也不因此记 `silent`。探针最大输出仍是 §12 的 256 token（实测见本节末尾）。

**编译**（§4.4、§7.6 的表）：`off_refused: true` 的模型编译成 `thinkingLevelMap: { off: null }`（pi 自己的“这一档不支持”的写法，`registerProvider` 按模型接受；写在模型上，三种接口都写，不放进 `compat`）。`off_refused` 变了时重新编译这个提供商（§7.4）。
它在 pi-ai 1.3.0 里起作用的是两处，与接口和地址无关：`getSupportedThinkingLevels` 不再列 `off`，`clampThinkingLevel` 把 `off` 提到最低一档 `minimal`。
加上本节其余各条，Mori 发给有标记的模型的每个请求都带一个强度，不会再出现“关闭思考”（点 Verify 时第 2 步在没有标记的副本上故意发的 `off` 除外：被拒正是判定的依据）：

| 请求 | 带的强度 |
| --- | --- |
| 会话经虚拟模型路由的请求（对话、TaskBoard 实例、增强会话、压缩与重建） | pi 路由时按实际模型收紧（`model-runtime.js` 的 `clampThinkingLevel`）：Off 变成 `minimal` |
| §11.2 换模型后重发的请求 | 按新模型收紧后的会话强度（见下面“其他改动”），Off 同样变成 `minimal` |
| 探针 | 第 1–7 步在没有标记的副本上、按本组第 2 步选强度；第 8、9 步按档案用 `medium`（见上面） |
| 测试连接 | `medium`（见下面“其他改动”） |
| TaskBoard 交接的 A 级（会关闭思考） | 不会用到：A 级只在 `can_disable` 为真时用 |

所以 pi 对 OpenAI 兼容接口下 z.ai、Together 地址的写法（`zai`、`together`，不认这个标记）也不受影响：它们只在不带强度时才写“关闭思考”。
标记本身让不带强度的请求在 OpenRouter、DeepSeek、`openai-responses`、`anthropic-messages` 上改为不发思考字段（实测第 2 项：OpenRouter 这样也能正常回答），只是一道保险。

**其他改动**：

- **换模型后重发**（§11.2 第 2.3 步）：思考强度用会话的强度按新模型收紧后的值（`clampThinkingLevel`，与路由一致）；收紧后是 `off` 才不传。
- **测试连接**：`reasoning: true` 的模型带 `medium`（同第 1 步），否则不带；这样第一次探测之前的测试连接也不发“关闭思考”。
- **界面**（§9.1、§9.2）：
  - 模型行的档案摘要在 `off_refused` 时加一项“Thinking: Can’t be turned off”（2026-10-26 注：改为模型行说明一行最后的“ · Thinking can’t be turned off”，§9.1）；
  - 输入框下面一行的 Effort 菜单（§9.2）按 `thinkingLevels` 列出，没有 Off；当前模型支持思考而 `thinkingLevels` 里没有 `off` 时，菜单底部加一句“This model can’t turn thinking off.”；
  - 模型表单（Edit）的 Default effort for new sessions：这个模型的档案 `off_refused` 时不列 Off；已经存成 Off 的照存，显示为 Minimal（pi 用的就是它）。
  - 增强设置的 Effort（记忆规格 §10.4）：`enhance.get` 的结果 `EnhanceInfo` 加 `noOffPicks: ModelPick[]`，是第一个候选（按记忆规格 §9.1 的取法，同 `effortPicks`）的档案 `reasoning.off_refused` 为真的那些范围（没有档案按假）；
    `effortPicks` 不变（录下的回放 fixture 照样有效）。所选范围在 `noOffPicks` 里时 Effort 不列 Off；已经存成 Off 的照存，显示为 Minimal。
    要改的：`shared/memory.ts`（`EnhanceInfo`）、`kernel/enhance.ts`（算 `noOffPicks`，用 `ModelLayer.profileOf`）、`renderer/.../MemoryEnhance.tsx`；记忆规格 §8 的 `enhance.get` 一行与 §10.4 加 2026-10-24 注。
- **已经验证失败的模型**：不自动重新探测（不加迁移）；模型行照旧显示“Couldn’t verify: <原文>”（这里是服务回的 400）和 Verify，点一次即按本节重新测。（2026-10-26 注：这类模型 tool calling 没验证，模型行的状态行照样写“Couldn’t verify: <原文>”，按钮是“Verify again”，§9.1。）

**不做**：不读服务列表里的标记（OpenRouter 的 `reasoning.mandatory`、Anthropic 的 `capabilities.thinking.types.disabled.supported`）；
不按模型名判断；被拒后不在同一次请求里换个强度重发（那是 fallback）；不改 TaskBoard 的写法选择。

**实现之前的三项实测**（2026-10-24，用 pi-ai 1.3.0 的 `streamSimple` 照探针的写法发出，最大输出 256 token；详见 [v1/models-checks.md](../v1/models-checks.md)“思考关不掉的模型：实测”）：

1. **`medium` 下能否通过第 3、4、6、7 步**：`recursive/flint-v1.0:free` 全部通过（第 7 步连发 3 次都通过）。`liquid/lfm-2.5-2.6b:free` 第 3、4、6 步通过；
   第 7 步 3 次都在 256 token 处停下、只有思考（约 900 字），按本节的输出上限规则为出错，不判为不通过。它第 6 步已通过（B 级），真实探测时第 7 步不会跑。
   结论：探针最大输出维持 256，输出上限规则必须有。
2. **不传 `reasoning` 字段**：两个模型都正常回答（HTTP 200，按默认思考），第 3、4 步也通过。结论：有标记的模型即使收到不带强度的请求（上面说的保险）也不会出错；按本节的规则 Mori 本来就不发这样的请求。
3. **强度不在 `supported_efforts` 里**：`openai/gpt-oss-20b`（列 `[high, medium, low]`）收 `minimal`、`z-ai/glm-5.3-flash`（列 `[max, high, low]`）收 `minimal` 和 `medium`，都是 HTTP 200、正常回答。
   结论：OpenRouter 不因强度不在列表里拒绝；会话里 Off 提到的 `minimal`、探针用的 `medium` 在 OpenRouter 上都能发。别的服务没有测。
4. 同时确认：两个模型在关闭思考（`reasoning: { effort: "none" }`）时都回 §14.1 合成端点 `-nooff` 用的那段 400 原文。

## 8. 模型池与多 key

### 8.1 槽位

- 每个 key 有 `concurrency` 个槽位；没有 key 的提供商算一个“无 key”，同样有 `concurrency` 个槽位。
- 一个 HTTP 请求从发出到响应体结束占一个槽位；工具执行期间不占。响应体结束 = 读到结尾、被读取方取消（OpenAI SDK 读到 `[DONE]` 后会取消）、出错，或请求被中止，以先到者为准。
- 4xx、5xx 的响应体由 fetch 先读完（§8.4），读完即释放。

### 8.2 排队与优先级

- 请求要用某个提供商时，按 key 的顺序取第一个可用（§8.3）且有空槽位的 key；有可用的 key 但槽位都满时排队。
- 这个模型此刻不可用（§8.3：提供商在 `connection`，模型在 `not_found`、`timeout`、`held`，或全部 key 都在 `rate_limited`、`auth`、`quota`）：不排队、不发出，fetch 立即以记录里最先恢复的原因失败，记给包装，按 §5.6 换模型。
- 队列按（类别，入队时刻）排序，同一个提供商的请求跨会话共用一个队列。类别：`conversation`（主 Agent 的请求、它的压缩、测试连接）先于 `background`（探针），严格优先（proposal §11：v1 只做简单的优先级）；平行 Agent 规格 §12.10 在两者之间加 `decision`、`task`。
- `conversation` 类别排队超过 §12 的时长：`queue_timeout`；`background` 类别没有排队超时（§7.4）。排队期间发 `mori.model_queue`，阶段行显示“Waiting for <提供商名>”。
- 你按了停止：只让这个会话的请求出队并中止。
- 换 key、原地重试、换模型后的请求按新的入队时刻排队。
- 并发上限调低：进行中的请求照常完成，新请求等到占用数低于新上限。删掉的 key 上进行中的请求照常完成，排队中等它的请求重新取 key。新加的 key 立即可用。

### 8.3 记住不可用

| 对象 | 状态 | 恢复 |
| --- | --- | --- |
| key | `rate_limited`（到某时刻）、`auth`、`quota` | `rate_limited` 到时刻；`auth`、`quota` 在这个 key 被删除重加、或提供商的地址、接口、兼容选项改变时清除 |
| 提供商 | `connection`（到某时刻） | 到时刻，或提供商的地址、接口、兼容选项改变 |
| 模型 | `not_found`；`timeout`（到某时刻）；`held`（到某时刻，§5.7） | `not_found` 在提供商或这个模型的配置改变时清除；其余到时刻 |

一个模型**可用** = 它的提供商不在 `connection`，它自己不在上述状态，并且提供商至少有一个 key 不在 `rate_limited`、`auth`、`quota`。
没有 key 的提供商把 §8.1 的“无 key”当作它唯一的 key：429、401/403、额度错误同样记在它上面，按上表恢复；`auth`、`quota` 在加了 key、或地址、接口、兼容选项改变时清除。
key 的“Test”（§9.1）和用它的“Test connection”不看这个 key 的记录，直接发出；成功时清除它的 `rate_limited`、`auth`、`quota` 并重新做静态校验。
（2026-10-26 补，负责人走查 WP-01 的观察：首次启动里一次 404 失败后什么都不改再点 Test connection，结果是“Connection failed: Connection error.”、请求没有发出——模型池按上表给这个模型记了 `not_found`，不带 key 的 Test connection 按“可用”判断，不可用就不发；401 之后同样被 key 的 `auth` 挡住。测试是你点的，要报告服务这一次的真实回答，失败也不能让下一次测试等或不发。）
测试连接与 key 的“Test”（`connection.test`）**不看任何不可用记录**：提供商的 `connection`、模型的 `not_found`、`timeout`、`held`、key 的记录都不挡它，总是发出（排队按 §8.2，同原来）。不带 key 时按顺序用第一个没有记录的 key，全部 key（或“无 key”）都有记录时用第一个；得到 401、429、额度错误时照原来换到下一个没有记录的 key（§5.5），没有就报告这一次的结果。失败照常写记录（会话照旧按记录挑模型）；成功时清除用到的 key 的 `rate_limited`、`auth`、`quota`，以及提供商的 `connection` 和这个模型的 `not_found`（测试刚证明它们不成立）；`timeout`、`held` 不清（§5.7 等的是旧请求停下，测试成功不能说明这一点）。会话、压缩与探针的请求不变。
槽位满不算不可用（排队）。记录只在内存里，后台进程重启后清空。只改提供商的名称、并发上限、区域或模型列表不清除记录。

### 8.4 发请求用的 fetch

模型池给每次请求一个 fetch（经 pi-ai 的 `fetch` 选项传入，§11.2），它：

1. 按 §8.2 取槽位和 key；
2. 改写认证头：`openai-completions`、`openai-responses` 写 `Authorization: Bearer <key>`，`anthropic-messages` 写 `x-api-key: <key>`；没有 key 的提供商删掉这两个头；
3. 发出（每一次真正发出，含换 key、原地重试，都回调包装的 `onSent`，§11.2）；看响应状态和响应头。4xx、5xx 先 `await res.text()`（最多 64 KB）用于分类，再用同样的状态、状态文字、响应头和这段文字构造一个新的响应交还；按 §5.4 分类，需要时换 key 或原地重试（§5.5）；
4. 2xx：把响应体包一层再交还 pi-ai，用来知道它何时结束（释放槽位）；
5. 把这次尝试的分类、状态码、`Retry-After`、有没有输出记给调用方（包装据此决定是否换模型）。

pi 传给 SDK 的超时（默认 300 秒）会把排队和重试也算进去，所以包装和探针在选项里写 `timeoutMs: 2147483647`（pi 表示“不限时”的值）；排队和重试的时限由模型池执行，首个内容的时限由包装执行（§11.2）。
fetch 收到的 signal 是包装给的 `AbortSignal.any([你按停止的 signal, 这次尝试的控制器])`：前者触发是你按了停止（出队、不再重试），后者触发是这次尝试超时（分类 `timeout`）。

## 9. 界面

每屏的状态表在 [v1/screens/](../v1/screens/)，实现前写好（AGENTS.md 第 1 条）；这里定主要行为。界面文字为英文，术语与写法按 [v0/ui-strings.md](../v0/ui-strings.md)（2026-10-21 与 english-ui 合并后统一，见 v1/models-checks.md）。

### 9.1 设置 → Models

取代 v0 的“Connections and models”分节（[v0/screens/settings.md](../v0/screens/settings.md)）。从上到下：

- **迁移说明**（§4.5，有时）与**区域未确认**的提供商（有时，每个一行“Confirm zone…”）。
- 设置页的每个修改（Defaults、Groups、Project access、Keys、上移下移）立即保存；表单（提供商、模型）按“Save”保存。
- **Defaults**：
  - Default model range for new sessions：下拉，按分组、提供商、模型分三节；可以为空（“None”）。
  - Allowed zones for all projects：Local、Intranet 两个勾选框；说明“Public providers can only be allowed per project, below.”。
- **Providers**：每个提供商一张卡：名称、地址、接口类型、区域、每个 key 的并发上限、兼容选项（2026-10-26 注，负责人走查 M1：只在接口为 `openai-completions` 时有这一行，同表单）；“Edit”、“Delete…”、“Test connection”（用第一个可用的 key 测第一个模型，结果文字同 v0）。
  - **Keys**：每行标签、“Saved”、当前记录（“Rate limited until hh:mm:ss” / “Rejected” / “Quota exhausted”，没有时不显示）、上移、下移、“Test”（用这个 key 测提供商的第一个模型，结果显示在这一行下面；成功时清除记录，§8.3）、“Remove”（只剩一个 key 时“Remove…”）。“Add key”：一行内联表单，Label（默认“Key <n>”）、Secret（密码框）、“Save”/“Cancel”，新 key 加在末尾。
    key 的明文不能查看也不能改：换 key = 加新的再删旧的。删最后一个 key 时确认“Requests to <name> will be sent without an API key.”。没有 key 时说明“Requests are sent without an API key.”。
  - **Models**：每行模型 id、窗口、最大输出、模型族、支持思考；档案摘要：Tool calling（Verified / Not verified / Failed / Verifying… / Re-verifying…）、Handoff tier（A / B / C / —）、Context（有效窗口；截断时告警“Silently truncates long input”）、Reasoning field、Cancel（Verified / Not verified / Unknown）；探针出错时“Couldn’t verify: <原文>”。
    （2026-10-24 补：`reasoning.off_refused` 时加一项“Thinking: Can’t be turned off”；Test connection 对勾了 Supports thinking 的模型带 `medium`；模型表单的 Default effort for new sessions 对这类模型不列 Off，见 §7.7。）
    操作：“Verify”、“Long-input test…”、“Cancel test…”（只对 vLLM、SGLang、llama.cpp）、上移、下移、“Edit”、“Delete…”、“Test”。
    （2026-10-26 注，负责人走查 M7、M8：模型行只留模型 id、说明一行（窗口、最大输出、模型族、支持思考，`off_refused` 时最后加“ · Thinking can’t be turned off”）、“Use”的提示和一行状态；档案摘要（Tool calling、Handoff tier、Context、Reasoning field、Cancel）、截断告警、“Verify”、“Long-input test…”、“Cancel test…”、“Test”都删掉，操作只剩上移、下移、“Edit”、“Delete…”。状态行只在模型不能用时有：从没完成过验证、正在验证时“Verifying…”；tool calling 判定为不通过时“Tool calling failed verification: <detail>”，没验证（第 3、4 步出错）时“Couldn’t verify: <原文>”，没有档案又不在探测（探针抛错、档案存不下、探针没能开始）时“Couldn’t verify”，这几种带“Verify again”（`models.verify`，`tests: 'auto'`）。tool calling 验证通过的模型（重新验证中、其他步出错的）没有状态行。测试连接留在提供商卡的“Test connection”和 Keys 的“Test”。服务没报告、值仍等于 Mori 默认值的窗口与最大输出标“(default)”，见 [model-discovery.md](model-discovery.md) §8。状态表见 docs/v1/screens/models-settings.md“Models 行”。）
    （2026-10-23 注：行上按档案的 `reported` 加“(not reported)”和“Server reports …”等提示与“Use”，见 [model-discovery.md](model-discovery.md) §8。）
  - 模型表单：Model ID（编辑时只读，沿用 v0）、Context window、Max output（新建默认 16384 与窗口一半中较小的）、Family（可空）、Supports thinking、Image input、Default effort for new sessions（只在支持思考时；写 pi 设置的 `modelThinkingLevels`，沿用 v0）。
    （2026-10-23 注：模型表单只剩 Edit（“Edit model · <provider name>”），卡上的“Add model”换成“Fetch models”，见 [model-discovery.md](model-discovery.md) §6.5。）
  - 提供商表单：Name、Base URL、API type（“OpenAI-compatible (Chat Completions)”、“OpenAI Responses”、“Anthropic Messages”）、Network zone（Local / Intranet / Public，按 §12 的规则预选建议值）、Concurrency per key、兼容选项；新建时还有第一个 key 和第一个模型。改地址的 origin 时按 §4.1 删除 key 并确认。
    新提供商保存失败时，删除本次新存的 key。兼容选项沿用 english-ui 的标签与说明，每个勾选框是标签加下面一行说明：“Endpoint doesn’t support the developer role”（“Sends the system prompt with the system role instead”）、“Endpoint doesn’t accept the store field”（“Leaves store out of requests”）、“Endpoint needs max_tokens instead of max_completion_tokens”（“Older endpoints don’t recognize max_completion_tokens”）、“Endpoint doesn’t report usage while streaming”（“Doesn’t send stream_options, so the context usage shown will be inaccurate”）、“Endpoint doesn’t support strict mode for tool parameters”（“Leaves strict out of tool definitions”）、“Tool results must include the tool name”（“Some endpoints require a name field on tool result messages”）；提供商卡上的“Compatibility options”只列标签。
    （2026-10-26 注，负责人走查 M1：兼容选项的图例下面加一行说明“Mori already adjusts requests for well-known services such as DeepSeek. Check an option only if this server rejects requests.”（pi 按地址认出 DeepSeek 等服务、自己调整请求；首次启动表单同）；“Endpoint doesn’t support strict mode for tool parameters”一项删掉：pi 1.3.0 默认就不发 strict，探针要 strict 时自己加（§7.3），勾不勾都一样。§4.1 的 `compat.supportsStrictMode` 照样能写在配置里、读得出，编译照旧交给 pi，界面不显示、保存时原样保留，不加迁移；从 v0 迁移时它不再算兼容选项，同其他不认识的字段一样丢弃并列在说明里（§4.5）。）
    （2026-10-23 注：新建时改为 Base URL、API key → Fetch models → 清单 → Add，Concurrency per key 与兼容选项收进 More settings，没有“第一个模型”；Edit provider 不变，见 [model-discovery.md](model-discovery.md) §6.1。）
  - 测试结果（Test connection、Test；2026-10-26 注：失败后再测照样发出，§8.3 的 2026-10-26 补）：“Connected · First token Nms · Total Nms”，有思考内容时加“ · Includes thinking”，有正文时加“ · Response: <前 200 字>”；失败时“Connection failed: <原文>”；“Cancel”取消。
  - 确认对话框“Confirm zone…”：提供商名称与地址，Local / Intranet / Public 单选（预选建议值），“Confirm”/“Cancel”。
- **Groups**：每个分组一行：id、有序的成员（“DeepSeek · all models” 或 “DeepSeek · deepseek-chat”），成员可以加入、去掉、上移、下移；“New group”、“Delete…”。
  - New group：输入 id（规则同提供商 id；错误“<id> is already used by a provider or group.”、“Use lowercase letters, digits, and hyphens.”）。
  - Add member：每个提供商一节，第一项“<name> · all models”，其后是它的各个模型；已在分组里的项打勾、不可再选。
  - 只剩一个成员时 Remove 不可用，说明“A group needs at least one member; delete the group instead.”。
- **Project access**：已知项目（侧栏里的项目）各一行，显示项目路径和这个项目允许的区域；每个不在 `allowedZones` 里的区域一个勾选框。勾上 `public` 先确认：
  “Allow public providers for this project?”，正文“Code and files from <项目路径> may be sent to: <公网提供商名，逗号分隔>.”，“Allow”/“Cancel”。项目配置排除了这个区域时勾选框不可用，说明“.mori/models.json in this project doesn’t allow <zone>.”。
- 删除、改地址、删最后一个 key 的确认框列出 §4.1 的连带改动。

**首次启动表单**（v0 的连接表单，改为英文）：Name、Base URL、API type、Network zone（必选，按 §12 预选建议值）、API key（可空）、Model ID、Context window（默认 128000）、Max output（默认 16384 与窗口一半中较小的）、Supports thinking、兼容选项。
（2026-10-23 注：改为 Base URL、API key → Fetch models → 清单，勾选的模型一次写入，再次保存时整体替换这个提供商和它的全部模型；Test connection 测第一个勾选的模型，见 [model-discovery.md](model-discovery.md) §6.6、§5.4。）

- “Test connection”：表单有改动时先保存（`models.firstRun`：一次写入提供商、模型、key 和 `normalDefault`；同一张表单再次保存时整体替换这个提供商和它唯一的模型，不新建第二个），再测；成功后显示“Open folder…”，同时在后台跑探针，表单下方显示探针状态：
  “Verifying tool calling…” / “Tool calling verified” / “Tool calling failed verification: <detail>. Mori needs tool calling for the main agent; pick another model or check the server’s tool-call settings.”（表单可以改，改了再测）/ “Couldn’t verify: <原文>” + “Verify again”。
  （2026-10-26 注，负责人走查 M2：测试成功就关掉首次启动表单、进入主窗口，“Connected · …”在主窗口的 Open a folder 提示里显示一次；表单下方不再有 Open folder… 与探针状态，上面这几句从首次启动删掉。探针照样在后台跑，进度显示在打开文件夹后会话的拒绝启动卡上（验证中“Verifying <模型>…”，判定失败或出错时 `no_candidate` 卡写出原因）；测试失败、已取消时表单同现在，可以改了再测。见 docs/v1/screens/first-run.md“测试成功之后：主窗口”。）
- 区域选 Public 时，区域下方说明“Public providers must be allowed per project. You’ll be asked when you open a folder.”；打开文件夹后，会话的拒绝启动卡显示“Allow public for this project”。
- 已经有配置时不显示首次启动表单（`config.get` 的 `firstRun`，§9.4）；配置存在但读不出时也不显示（§4.1）。
- 测试连接不用 v0 的 30 秒总时限：排队按 §8.2，每次尝试按 §5.4 的首个内容时限，不做原地重试（`server` 直接报告）。

### 9.2 选择范围按钮与思考强度（输入框下面一行）

- 协作模式下（`ModelState.pickLocked`，平行 Agent 规格 §12.11）模型按钮只显示正在用的模型，不能打开菜单。
- 模型按钮：范围是分组或提供商时显示“<范围名> · <当前模型 id>”（范围名：分组用 id，提供商用名称），是模型时显示模型 id；当前模型 = 本段正在用的模型，没有段时是静态校验后的第一个候选，没有候选时只显示范围名。悬停显示提供商名和区域。生成中或准备中按钮不可用，悬停“Can’t switch models until the response finishes”。
- 菜单分三节：Groups、Providers、Models（按提供商分组）。每项标出区域（分组标出它的成员涉及的全部区域，例如“Local · Public”）；展开后全部候选都被本会话静态校验排除的项变淡，悬停写原因，但仍可以选（选了以后由拒绝启动卡说明）；当前范围打勾；底部“Applies to this session only. New sessions use the default range from Settings.”与“Manage models”。
- 思考强度菜单沿用 v0，可选强度取当前模型（实际模型）的。当前模型不支持思考时的说明（它指向的设置页改了）：“This model isn’t marked “Supports thinking”, so Mori doesn’t send thinking parameters and the endpoint decides (DeepSeek thinks by default, but you can’t control it). To choose an effort level, edit this model in Settings → Models and check “Supports thinking”.”
  （2026-10-24 补：思考关不掉的模型的 `thinkingLevels` 没有 `off`，菜单里没有 Off，底部加一句“This model can’t turn thinking off.”；会话原来是 Off 的显示为 Minimal（pi 收紧后的强度），见 §7.7。）
- 位置、窄栏和悬停的行见 docs/v0/screens/models.md（2026-10-21 起在输入框下面一行）。

### 9.3 对话流与阶段行

| 项 | 来源 | 显示 |
| --- | --- | --- |
| 换模型 | `mori.model_switch` 事件，或会话里的同名条目 | 一行提示“Switched model: A → B · <原因>”；有被隐藏的过程时加“The new model redoes this response.” |
| 重建 | `mori.model_rebuild` 事件，或 `mori.rebuild` 条目 | 一行提示（§6.3） |
| 等模型、等它停下 | `mori.model_wait` | 阶段行“Waiting for a model · <原因>” / “Waiting to make sure <模型> stopped · until hh:mm:ss” |
| 排队 | `mori.model_queue` | 阶段行“Waiting for <提供商名>” |
| 原地重试 | `mori.model_retry` | 阶段行“Retrying (n/m) · <原因>” |
| 准备中 | §11.4 | 用户消息已显示在对话流里；会话按“发送中”显示，停止可用；阶段行显示等待或“Rebuilding the conversation for <B>…”；停止或等不到时撤回这条用户消息和准备中又发的消息，文字按发送顺序（空行分隔）放回输入框 |
| 没有可用模型 | `mori.model_unavailable` | 一张说明卡：每个候选及原因；“Open settings”（打开 设置 → Models，滚到第一个被排除候选的提供商卡；`auth`、`quota` 时焦点在它的 Keys） |
| 拒绝启动 | `ModelState.blocked`（§4.6） | 输入框上方一张卡，文字与操作见 §4.6；发送不可用 |
| `server` 重试用完、`request`、`partial` | 回复的错误 | v0 的错误卡（原文；“Put your last message back in the message box”） |

- 一次失败只显示一张卡：发了 `mori.model_unavailable` 的那次回复，pi 的错误不再显示成 v0 的错误卡。
- v0 错误卡的“Go to settings”和它的文字匹配（`SETTINGS_HINT`）删除：认证类错误由模型层处理（换 key、换模型或说明卡）。
- pi 的 `auto_retry_*` 不再出现（§5.5），阶段行的重试由 `mori.model_retry` 提供；它在下一个有内容的事件、下一次 `mori.model_retry` 或回复结束时清掉。
- 被拒绝启动的会话里，发送与需要模型的斜杠命令（例如 `/compact`）都不可用。
- 阶段行：模型层的等待（等模型、等它停下、排队、原地重试、重建）进行时，取代 v0 的“Waiting for the model…”，同样在后面显示已经等了多少秒。
- 拒绝启动卡：“Verifying <模型>…”写第一个正在验证的候选；“Confirm zone”和“Allow <区域> for this project”都打开 设置 → Models（前者落在区域未确认的那几行，后者落在 Project access 的这个项目）。

### 9.4 进程桥：保留、删除、改写

- 删除：`connection.save`、`endpoint.save`、`model.save`、`model.delete`、`model.setDefault`、`session.setModel`，以及后台进程的 `refreshSessionModels`、`afterModelsChange`。
- 保留：`connection.test`（改为 `{ providerId, modelId, keyRef? }`，经模型池）、`connection.testCancel`、`session.setThinking`。
- `config.get` 只返回 `{ agentDir, settingsError, defaultThinkingLevel, firstRun, migrationError, configError, migratedNow }`（`migratedNow`：这次启动刚做完迁移，界面据此直接打开 设置 → Models，§4.5）：`firstRun` 只在 `model-config.json` 不存在、且没有迁移成（`models.json` 不存在、`providers` 为空或迁移失败）时为真；
  `migrationError` 在迁移失败时给出原文；`model-config.json` 存在但读不出时 `firstRun` 为假、`configError` 给出路径与原文（§4.1）。`models.firstRun` 在 `model-config.json` 已存在、且要写的不是这张首次启动表单自己建的那个提供商时拒绝。
- 界面的操作记录（F8 报告的“Recent activity”，`state/actionLog.ts`）对 `models.*` 命令只记类型和 id（例如“Add key <providerId>”），从不包含 `secret`、`keySecret`。
  （2026-10-23 注：`models.discover`、`models.discoverCancel`、`models.addModels` 的记法见 [model-discovery.md](model-discovery.md) §5.5；`models.saveModel` 不再加模型，“Add model <provider>/<id>”一行删掉，见那边 §5.4。）

### 9.5 载荷

`ModelState`（在 `SessionInfo` 里——`session.create`、`session.open`、界面重新载入后接上会话——以及每个 `mori.model_state` 事件里；取代 v0 的 `model` 字段和 `SessionInfo.modelNotice`）：

```ts
{ pick: string | null; current: string | null /* <provider>/<model> */;
  blocked: null | { kind: 'verifying' | 'no_candidate' | 'no_pick' | 'pick_missing' | 'project_config' | 'config_invalid';
    detail: string; candidates: { ref: string; reason: string; detail: string }[];
    actions: ('verify' | 'allow_zone' | 'confirm_zone' | 'change_model' | 'open_settings')[];
    verifyRefs: string[]; zone: string | null; zoneProviders: string[] };
  thinkingLevel: ThinkingLevel; thinkingLevels: ThinkingLevel[]; reasoning: boolean }
```

事件（会话事件的信封不变；`mori.profiles`、`mori.key_status` 用全局信封 `{ kind: 'event', sessionId: null }`）：

| 事件 | 字段 |
| --- | --- |
| `mori.model_state` | `ModelState` |
| `mori.model_switch` | `{ from, to, reason, detail, hidden: boolean, unconfirmed: boolean, at }`（`unconfirmed`：§5.7 没能确认旧请求停下就换的；条目里同样记这个字段） |
| `mori.model_rebuild` | `{ model, summary: boolean, at }` |
| `mori.model_wait` | `{ active: boolean, kind: 'model' \| 'held' \| 'rebuild', model: string \| null, reason: string \| null, detail, until: number \| null }`；`active: false` 清掉阶段行 |
| `mori.model_queue` | `{ active: boolean, provider, providerName }` |
| `mori.model_retry` | `{ attempt, max, status, delayMs }` |
| `mori.model_unavailable` | `{ candidates: { ref, reason, detail }[], firstRequest: boolean, text: string \| null, queued: string[] }`（`text`、`queued` 是撤回的消息） |
| `mori.profiles` | `{ profiles: Record<ref, ProfileView>, running: { ref, step, of }[] }` |
| `mori.key_status` | `{ keyStatus: Record<ref, { state: 'rate_limited' \| 'auth' \| 'quota', until: number \| null }> }`（全局信封；key 的记录变化时发出） |

命令（结果都带 `error: string | null`）：

| 命令 | 参数 | 结果 |
| --- | --- | --- |
| `models.get` | — | `{ config /* key 只给 { ref, label } */, profiles, keyStatus, thinkingDefaults: Record<ref, ThinkingLevel \| null> /* pi 设置里按模型的新会话默认强度 */, zoneSuggestions: Record<providerId, zone>, migration: MigrationNotice \| null, projects: { path, zones /* 本机额外授权的区域 */, projectZones: Zone[] \| null /* .mori/models.json 的 allowedZones */, projectConfig: string \| null /* 这个文件的错误原文 */ }[], loadError: string \| null, reserved: string[] }` |
| `models.firstRun` | `{ providerId: string \| null, provider, model, keySecret: string \| null }`（`providerId` 非空时整体替换这个提供商与它唯一的模型，`keySecret` 为空时保留已存的 key；写配置失败时删除本次新存的 key）（2026-10-23 注：`model` 改为 `models`（1 个以上），整体替换这个提供商和它的全部模型，多个模型时默认范围为提供商 id，见 [model-discovery.md](model-discovery.md) §5.4） | `{ providerId }` |
| `models.saveProvider` | `{ id: string \| null, provider, keySecret?: string, model?, thinkingLevel?: ThinkingLevel }`（新建时带第一个 key（标签“Key 1”）和第一个模型及它的新会话默认强度）（2026-10-23 注：`model?`、`thinkingLevel?` 改为 `models?`：新建时 1 个以上，编辑时不带，见 [model-discovery.md](model-discovery.md) §5.4） | `{ providerId }` |
| `models.deleteProvider` | `{ id, dryRun: boolean }` | `{ consequences: string[] }`：确认框的各行（§4.1 的连带改动）；`dryRun` 为真时只算、不改 |
| `models.saveModel` | `{ providerId, model, adding: boolean, thinkingLevel?: ThinkingLevel }`（2026-10-23 注：去掉 `adding`，只改已有的模型：`{ providerId, model, thinkingLevel? }`，模型不存在时 `error`；加模型只有 `saveProvider`、`firstRun`、`addModels`，原来 `adding: true` 的分支删掉；Edit 里没设过强度的模型，Default effort for new sessions 显示 `config.get` 的 `defaultThinkingLevel`（没有时 Medium），只在你改了时带 `thinkingLevel`，见 [model-discovery.md](model-discovery.md) §5.4） | — |
| `models.deleteModel` | `{ providerId, modelId, dryRun: boolean }` | `{ consequences: string[] }`，同上 |
| `models.moveModel` | `{ providerId, modelId, delta: -1 \| 1 }` | — |
| `models.addKey` | `{ providerId, label, secret }` | `{ ref }` |
| `models.removeKey` | `{ providerId, ref }` | — |
| `models.moveKey` | `{ providerId, ref, delta: -1 \| 1 }` | — |
| `models.saveGroup` | `{ id, members, creating: boolean }` | — |
| `models.deleteGroup` | `{ id, dryRun: boolean }` | `{ consequences: string[] }`，同上 |
| `models.setDefaults` | `{ normalDefault: string \| null, allowedZones }` | — |
| `models.setProjectZones` | `{ path, zones }` | — |
| `models.confirmZone` | `{ providerId, zone }` | — |
| `models.dismissMigration` | — | — |
| `models.reload` | — | 同 `models.get` |
| `models.verify` | `{ refs, tests: 'auto' \| 'long_input' \| 'cancel' }` | — |
| `session.setPick` | `{ sessionId, pick }` | `ModelState` |
| `session.pickOptions` | `{ sessionId }`（只读） | `{ options: { pick, kind: 'group' \| 'provider' \| 'model', label, zones: Zone[], excluded: boolean, reason: string \| null }[] }`：范围菜单的每一项，按这个会话的项目对它做静态校验（§9.2 的变淡与原因） |

（2026-10-23 注：新命令 `models.discover`、`models.discoverCancel`、`models.addModels` 见 [model-discovery.md](model-discovery.md) §5；`ProfileView` 加 `reported`，见那边 §7.2。）

`models.*` 的写命令保存后：编译（§4.4）、对所有打开的会话重新做静态校验并发 `mori.model_state`、需要时发起探针（§7.4）。
段开始选定模型、段内换模型、段结束时，后台进程同样发 `mori.model_state`（`current`、`thinkingLevels`、`reasoning` 随之更新）。
`mori.prompt_error` 加字段 `queued: string[]`：准备中被撤回时一起撤回的、准备中又发的消息（§11.4）。

## 10. 由平行 Agent 与 TaskBoard 规格实现的部分

下面的规则属于 proposal，但只在有平行 Agent、TaskBoard 之后才有调用方，本规格不实现；2026-10-21 起由 [平行 Agent 与 TaskBoard 规格](parallel-agents-taskboard.md) 实现，每行注明落点：

| 规则 | 依据 | 落点 |
| --- | --- | --- |
| 子 Agent 按自己的 `models`、`requires` 选，只能落在用户为主 Agent 选的范围里（两者展开后的交集，顺序按子 Agent 的候选）；没有交集时这次提问失败并说明原因（子 Agent = 普通模式下对话 Agent 临时去问的只读实例） | proposal §5 | §12.1、§10.1 |
| 协作模式下用户不选，范围按钮只显示正在用的模型；按做这个 task 的角色的 `models`、`requires` 选，基座与没写 `models` 的角色用会话的选择范围 | proposal §5 | §12.1、§12.11 |
| `.mori/agents/*.md` 的 `models`（每项是一个选择范围）与 `requires`（`tool_calling`、`protocol_write`、`protocol_write>=B`、`structured_output`、`vision`、`context>=N`）。判定用 §7.2 的档案字段：`tool_calling`、`protocol_write`、`structured_output` 必须已验证；`vision` 为 `unverified`（配置声明了图像输入）即满足；`context>=N` 比较 `effective` | proposal §4、§6 | §4.1、§12.2 |
| Agent 定义引用的名字不存在时拒绝启动，说明缺哪一项、哪个 Agent 用到它 | proposal §6 | §4.4、§12.3 |
| 继续已有的对话、立项、结案会话，或交回同一角色的 task 会话时模型变了：按本规格 §6.2 判断能否转写，不能就按 §6.3 重建 | proposal §9 | §12.6 |
| task 会话中途换模型：结束本轮，切换记在实例自己的会话里，在新模型上从工作卡重建，需要前半段细节时读自己的会话；第一个请求就失败时把同一请求按新模型的档案重组后发出 | proposal §7.2、§9 | §12.4 |
| 执行中的 task 候选耗尽时交给结案 Agent | proposal §8 | §12.5、§7.4 |
| 填交接单按当前模型的写入等级：A 指定函数 + 严格模式，B JSON schema，C 文本标签；换了模型后，下一次按新模型的等级 | proposal §4、§11 | §7.5、§12.7 |
| 读别人的会话只拿整理过的文本（工具调用、输出、结论），不含推理原文，不并进自己的消息历史 | proposal §11 | §10.2、§12.8 |
| 评审 `differ_from: author` 排除改过这个 task 代码的模型族 | proposal §11 | §12.9 |
| 调度类别加上立项与结案的决策、执行 task，依次排在对话之后、后台之前；订阅与定时的请求归入 `background`，与探针同级（v1 没有定时） | proposal §11 | §12.10：`decision`、`task` 两类 |

## 11. 在 pi 上的落点

以 pi 1.3.0 为准；下面依赖的行为都在开工前用脚本对合成端点实测过（2026-10-21，§11.6，详见 [v1/models-checks.md](../v1/models-checks.md)）。
`@earendil-works/pi-ai` 1.3.0 改为直接依赖（精确版本；它已随 pi-coding-agent 安装，离线可用），只在 `app/src/kernel/` 里 import，用它的事件流（§11.2）。

### 11.1 每个会话一个虚拟模型

- pi 的 `route()` 不带会话身份，所以每个会话一个虚拟模型：会话新建或打开前，在共享的 `ModelRuntime` 上
  `registerVirtualModel({ provider: "mori", id: <pi 会话 id>, name, thinkingLevels: [全部七档], contextWindow, maxTokens, input, route })`，
  `contextWindow`、`maxTokens`、`input` 取静态校验后的第一个候选（没有时取 128000、16384、`["text"]`）；然后 `await runtime.refresh({ allowNetwork: false })`，再 `createAgentSession({ model: <这个虚拟模型> })`：
  新会话另传 `thinkingLevel`（下一条的取法）；打开已有会话时不传，pi 从会话记录恢复强度。会话关闭时 `unregisterVirtualModel`。重新打开时注册同一个 id，pi 恢复它。
- 新会话的思考强度：第一个候选的 `modelThinkingLevels["<provider>/<model>"]` → `defaultThinkingLevel` → `medium`（沿用 v0 按模型设的新会话默认）。pi 按每次请求的实际模型收紧。
- `ModelState.thinkingLevels`、`reasoning` 描述当前模型（实际模型），不用虚拟模型的。
- `route(request)`，不论原因（`user`、`continuation`、`direct`）：
  1. 有待开始的新段（§11.4）时先开始它；
  2. 有 `ReplyState` 时，对 `current` 做 §5.3 第 1、4 步：通过就返回它；不通过就在 `route()` 里按 §5.6 第 2–3 步换模型（原因取第一个不满足的条件，例如 `missing`、`rate_limited`），`hideUntil` 取 `request.messages` 里助手消息和工具结果的最大时间戳，写条目、发事件，在 `Date.now()` 大于 `hideUntil` 后返回新模型；选不到时按 §5.8 等待（听 `request.signal`），等不到就抛出 §5.8 的说明，界面只显示说明卡；pi 先调 `route()` 再调 `context` 钩子，所以这次请求的上下文已经按新条目处理；
  3. 没有 `ReplyState` 时按 §5.3 选。
  思考强度返回 `request.thinkingLevel`。

### 11.2 流函数包装

会话创建后、第一次运行前（pi 在每次运行开始时取一次流函数），把 `session.agent.streamFunction` 换成 Mori 的包装，原函数保留在包装里调用。包装总是在选项里加 Mori 的 fetch（§8.4）、`maxRetries: 0`、`timeoutMs: 2147483647`。

1. 请求里的 `sessionId` 与会话 id 不同：压缩请求（§6.4）。调原函数，执行首个内容的时限（同第 2.2 步），出错原样返回。
2. 其余请求：用 pi-ai 的 `createAssistantMessageEventStream()` 建一个事件流返回给 pi，然后在后台：
   1. 以 `ReplyState.current` 调原函数；
   2. 缓冲原函数的事件，直到第一个有内容的事件（正文、思考、工具调用的开始或增量）或完成。有内容就把缓冲的和之后的事件原样推进返回的事件流。
      时限：从模型池最近一次 `onSent` 回调起计 §12 的时长，每次 `onSent` 重新计时；超时用这次尝试自己的控制器中止（§8.4），分类 `timeout`，按 §5.7；
   3. 在有内容之前出错，且 fetch 记下的分类要求换模型：丢弃缓冲，按 §5.6 选下一个，用 §6 处理后的上下文对新模型调原函数，选项里的思考强度改为会话的强度（`off` 时不传），回到第 2 步（2026-10-24 补：会话的强度先按新模型 `clampThinkingLevel` 收紧，与路由一致；收紧后是 `off` 才不传，§7.7）；
   4. 你按了停止（选项里的 signal 在任何时候触发，包括包装自己在等待时）：不再调原函数，推一个 `{ type: 'error', reason: 'aborted' }` 事件，以 `stopReason: 'aborted'`、`errorMessage: 'Request was aborted'` 结束（直接用已中止的 signal 调原函数会得到 `error` 而不是 `aborted`，§11.6 K7）；
   5. 候选耗尽（含 §5.7 等完后选不到）：推一个错误事件，`errorMessage` 为 §5.8 的说明，以 `stopReason: 'error'` 结束；界面按 §9.3 只显示说明卡；
   6. 其他情况（`partial`、`server` 重试用完、`request`）：把原函数的事件原样推进去。
3. pi 的循环只用事件流的异步迭代和 `result()`；事件流结束时 `result()` 给出最终的助手消息。换了模型的那条消息上，pi 记的思考强度仍是路由时为原模型收紧的值（已知限制，记在检查记录里）。

### 11.3 上下文钩子

pi 扩展事件 `context`（`{ messages }` → `{ messages }`，不含 system 消息）：按 §6.1、§6.3 返回处理后的消息；只影响发出的请求，不改会话文件。换模型那一次请求，包装对传给原函数的上下文用同一个函数处理（函数对已处理过的上下文结果不变）。

### 11.4 段的开始与结束

- **你发消息**（后台进程处理 `session.prompt`，会话空闲）：
  1. 进入“准备中”：`entry.running` 为真；建立 `ReplyState`，`startedAt = Date.now()`（早于 pi 建的那条用户消息的时间戳）；
  2. 按 §5.3 选模型（§5.8 的等待在这里）；
  3. 做 §6.2 的接手判断，需要时 §6.3 重建；
  4. 调 pi 的 `prompt`。
  - `anchor`：`startedAt` 之后的第一条用户消息（就是这条消息）。
  - 准备中再收到的 `session.prompt` 由后台进程暂存，pi 的 `prompt` 开始后作为 `followUp` 交给 pi。
  - 准备中收到 `session.abort`、或 pi 的 `prompt()` 没有开始运行就结束：取消等待或压缩，发 `mori.prompt_error`（`message` 为 “Stopped before sending” 或 pi 的原文，`text` 为这条消息，`queued` 为暂存的消息，`running: false`），文字全部回到输入框，暂存区清空；等不到模型时按 §5.8 只发 `mori.model_unavailable`。
  - 准备中再发的消息显示在排队区（同 v0 的排队消息）；准备中不能插话（Ctrl+Enter 也按排队处理）。
  - 准备中不能改范围和思考强度。
- **排队消息开始新的一段**：后台进程记下自己经 `followUp` 交给 pi 的每条文字。Mori 的内联扩展处理运行中 role 为 user 的 `message_start`（pi 在送进这条消息之后、下一次调 `route()` 之前发它，并等待扩展处理，§11.6 K13）：
  文字与一条记下的 followUp 相同（匹配一次即消费）时，记下“待开始的新段”。下一次 `route()` 开始新段：`startedAt` = 此刻的 `Date.now()`，`anchor` = 这条消息，`tried`、`skipped` 清空，按 §5.3 从第一个候选起选，做 §6.2 的段内接手判断。
  由 `session.prompt` 开始的段的第一次 `route()`、溢出恢复后的继续、插话（不论在工具结果之后还是在最后一条回答之后送达）都不开始新段。
- **结束**：pi 发 `agent_settled`，或 pi 的 `prompt()` 结束时会话已不在运行，清掉 `ReplyState`。

### 11.5 开工前确认的做法

- 注册提供商和虚拟模型之后都 `await runtime.refresh({ allowNetwork: false })`（K9）。
- 包装在 `createAgentSession` 之后、第一次运行之前装上（K2）。
- `mori.pick`、`mori.model_switch`、`mori.rebuild` 用 `sessionManager.appendCustomEntry` 写；运行中写入与 pi 自己运行中写 `pi.virtual-model-state` 相同。

### 11.6 开工前实测的结果

| 项 | 结果 |
| --- | --- |
| K1 | 没有 key 的提供商 pi 不算“已配置”，`route()` 路由到它会报错；`registerProvider` 带一个占位 `apiKey` 就算已配置。`streamSimple` 和会话请求都采用 `fetch` 选项；自定义 fetch 看得到 429 的状态和 `Retry-After`（pi 的报错文字里没有它） |
| K2 | `session.agent.streamFunction` 可以替换；每次助手请求调用一次，参数里的模型是路由后的实际模型；选项里的 `apiKey`、`fetch` 被采用；包装里可以等待。pi 在运行开始时取流函数 |
| K3 | 每个会话一个虚拟模型可行；助手消息记的是实际模型；上下文用量按实际模型的窗口算；重新打开时注册同一个 id 就恢复。插话之后的请求原因是 `user`，工具循环是 `continuation`。虚拟模型不写 `thinkingLevels` 时只有 `off`，所以要写全部七档 |
| K4 | `context` 事件能去掉任意消息、加上用户消息，只影响发出的请求，会话文件不变 |
| K5 | 压缩请求先以 `direct` 调 `route()`，再用会话的流函数发出；每个压缩请求带一个不同于会话 id 的 `sessionId` |
| K6 | `applyOverrides({ retry: { enabled: false } })` 后 429 只发一次、没有 `auto_retry_start`；`resourceLoader.reload()`、`settingsManager.reload()` 和带 `persist` 的设置会清掉覆盖 |
| K7 | `session.abort()` 时 fetch 的 signal 同一刻触发，服务端几十毫秒内看到连接关闭；已收到的部分留在中止的消息里。用已中止的 signal 调原函数得到 `stopReason: error` |
| K8 | `streamSimple` 原样发出指定函数的 `toolChoice` 和经 `onPayload` 加的字段；工具的 `strict` 只在 `compat.supportsStrictMode` 为真时由 pi 发出，所以探针第 5 步经 `onPayload` 直接写 |
| K9 | `registerProvider`、`registerVirtualModel` 发起的刷新不等待，会与之后的刷新互相覆盖；注册后 `await runtime.refresh()` 就稳定 |
| K10 | 把虚拟模型交给 `streamSimple` 时 pi 丢掉调用方给的 key；探针和测试连接直接用实际模型 |
| K11 | pi 传给 SDK 的 `timeoutMs`（默认 300 秒）覆盖自定义 fetch 返回响应之前的全部时间，包括模型池里的排队和重试，超时报“Request timed out.”；包装在选项里写 `timeoutMs: 2147483647` 后不再超时 |
| K12 | `session_before_compact` 的处理器就地改 `preparation.messagesToSummarize`、`turnPrefixMessages` 后不返回结果，pi 用改过的内容压缩；`preparation.fileOps`（`read`、`written`、`edited` 三个集合）在钩子之前算好，要一起改，否则摘要末尾仍列出被隐藏的调用读过的文件。`compaction_start` 在钩子之前发出 |
| K13 | 运行中 pi 送进排队消息（followUp）和插话（steer）时都先发 role 为 user 的 `message_start`，等扩展的处理结束，再为下一次请求调 `route()`（原因 `user`）；消息的时间戳是排队的时刻。followUp 在本该结束的最后一轮之后送达，steer 在工具结果之后送达。`agent_settled` 每次运行结束发一次；`route()` 抛错时 `prompt()` 不抛、照样发 `agent_settled`；`prompt()` 在运行开始前抛错时不发任何事件 |

## 12. 临时默认值

都登记在 [v1/defaults.md](../v1/defaults.md)；时长集中在 `kernel/modelTimings.ts`。

| 项 | 值 |
| --- | --- |
| 每个 key 的并发上限（新提供商的默认） / 范围 | 4 / 1–64 |
| 每个提供商最多 key 数 | 8 |
| 提供商与分组 id | `^[a-z0-9][a-z0-9-]{0,39}$`；保留 `mori` 和 pi 内置的提供商 id |
| 排队超时 | 60 秒 |
| 429 没有 `Retry-After` 时 key 冷却 | 30 秒 |
| 连接失败后提供商不可用 | 30 秒 |
| 额度错误的关键词 | `insufficient_quota`、`quota`、`billing`、`balance` |
| HTTP 404 | 模型不可用，直到提供商或这个模型的配置改变 |
| 5xx 原地重试 | 3 次，间隔 2、4、8 秒 |
| 发出后等第一个有内容的事件 | 120 秒 |
| 超时后已验证取消的模型不可用（`timeout`） | 60 秒 |
| 超时后不能确认停止的模型等它停下（`held`） / 读指标确认的间隔 | 2 分钟 / 5 秒 |
| 候选耗尽时最长等 / 重新选的间隔 | 60 秒 / 5 秒 |
| 探针最大输出 / 每一步等第一个有内容的事件 | 256 token（第 9 步 2048）/ 120 秒 |
| C 级文本标签连发次数 | 3 |
| 长输入探针的两个长度 | 有效窗口的 50%、90% |
| 取消探针等请求数回落 | 5 秒 |
| 4xx、5xx 响应体最多读 | 64 KB |
| 区域建议 | 回环地址（127/8、`::1`、`localhost`）→ `local`；10/8、172.16/12、192.168/16、169.254/16、`fc00::/7`、`fe80::/10`、`.local` 与不含点的主机名 → `intranet`；IPv4 映射的 IPv6 地址按其中的 IPv4 判断；其余 → `public`。这个规则放在 `shared/models.ts`，后台进程和界面（表单的预选）共用 |
| 迁移时 `maxTokens` 缺失 / 不小于窗口 | pi 的默认 16384 / 窗口的一半 |
| 新模型表单的 Max output | 16384 与窗口一半中较小的 |
| pi 里的占位 `apiKey` | `mori-pool` |
| 重做说明文字、各提示文字 | §6.1、§9 |
| 思考关不掉的模型在探针里用的强度（2026-10-24 补） | `medium`（同第 1 步与回传检查；§7.7） |
| 测试连接的思考强度（2026-10-24 补） | 勾了 Supports thinking 的模型 `medium`，否则不带（§7.7） |
| 探针回复停在输出上限、只有思考（2026-10-24 补） | 这一步按出错处理，“Stopped at the probe output limit before answering”（§7.7） |

（2026-10-23 注：一键拉取模型的临时默认值见 [model-discovery.md](model-discovery.md) §11，登记在 v1/defaults.md 的“一键拉取模型”一节；新建模型的表单不再有，“新模型表单的 Max output”的规则用于清单里没报告的输出上限和手填的行，见那边 §4.1、§6.4。）

## 13. 要改的文件

| 文件 | 改什么 |
| --- | --- |
| `docs/proposals/model-providers.md` | 第四版（2026-10-21 的反馈） |
| `docs/specs/model-providers.md` | 本文 |
| `docs/app-v0.md` | 注明模型层按本规格改：§2 原则 5；§4 表“自动重试”“模型与端点”、“pi 没有、v0 也不补”；§5.2、§5.6、§5.8、§5.12；§6 第 6 件事、会话与数据的 API key、装配要点的“模型”；§9、§11 |
| `AGENTS.md` | 仓库结构加 `docs/specs/`、`docs/v1/`；第 4 条指向第 6 件事；第 6 条临时默认值也登记在 `docs/v1/defaults.md`；模型层的迁移与切换不算“fallback”；新写的界面用英文；常用命令 |
| `docs/proposals/model-reliability.md`、`docs/proposals/agent-lifecycle.md` | 开头注明：模型选择与切换以统一模型提供商 proposal 为准 |
| `docs/v0/screens/connection.md`、`settings.md`、`models.md`、`chat.md`，`docs/v0/defaults.md` | 被本规格取代的行注明“v1：见 docs/specs/model-providers.md” |
| `docs/v1/defaults.md`、`docs/v1/screens/*.md`、`docs/v1/models-checks.md` | 新建：临时默认值、状态表、检查记录 |
| `app/src/kernel/` | §2 表中的新文件；`pi.ts`（运行时、key）、`config.ts`（只留 pi 设置的读写与测试连接）、`sessions.ts`（虚拟模型、包装、段、准备中、`ModelState`）、`commands.ts`、`index.ts`、`credentials.ts` |
| `app/src/main/credentials.ts`、`kernel-process.ts` | key 按 `ref` 存取；迁移时加密 `models.json` 里的明文 key |
| `app/src/shared/models.ts`、`protocol.ts` | §9.4、§9.5 |
| `app/src/renderer/` | 设置页 Models 分节、首次启动表单、输入框下面一行的范围菜单、对话流提示与阶段行、拒绝启动卡、准备中；删除 v0 的连接与模型表单、`SETTINGS_HINT`、`modelNotice` 横幅 |
| `app/tests/` | §14 |
| 2026-10-24 补丁（§7.7）要改的 | 内核 `probes.ts`、`modelProfiles.ts`、`modelCompile.ts`、`modelLayer.ts`、`modelSession.ts`（§11.2 的收紧）、`config.ts`（测试连接）、`enhance.ts`；进程桥 `shared/models.ts`（`ProfileView.reasoning.off_refused`）、`shared/memory.ts`（`EnhanceInfo.noOffPicks`）；界面 `ThinkingMenu.tsx`、`settings/ModelRows.tsx`、`settings/fields.tsx`（Edit 的 Default effort）、`MemoryEnhance.tsx`；测试 `fake-endpoint/server.mjs`、`probes.mjs`、`v1-models-real.mjs`、`v1-real-helpers.mjs`、单元与 App；文档 [记忆规格](memory.md) §8、§10.4 的注，屏幕状态表 model-menu.md、models-settings.md、memory-enhance.md |
| `app/package.json` | `@earendil-works/pi-ai` 1.3.0 进 dependencies（§11）；`esbuild` 0.25.12 进 devDependencies（单元测试打包内核模块）；两者都已随现有依赖安装，离线可用。脚本 `test:unit`、`test:v1-models` |
| `app/README.md` | 真实走查的数据目录在 v1 里要先确认区域、给测试项目授权公网（§14.1） |

## 14. 验收

### 14.1 测试分层

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/unit/*.test.mjs`（`node --test`），经 esbuild 把内核模块打包到 `test-results/` 再导入 | 纯函数：配置校验与连带改动、名字解析、区域、迁移、选择器、失败分类、上下文规则、档案判定、模型池；时长与 `now()` 用假时钟，覆盖全部到期与恢复规则 |
| 合成端点 | `tests/fake-endpoint/server.mjs`（synthetic） | 见下面的“合成端点的行为” |
| App | `tests/ui/v1-models-*.mjs` | Electron + 合成端点，逐条验收 |
| 回放 | `tests/fixtures/v1/*.json` | 从真实会话录制：换模型、重做、拒绝启动、范围菜单的界面 |
| 真实模型 | `tests/ui/v1-models-real.mjs` | 你的数据目录，两个真实提供商 |

合成端点的行为（文件开头注释逐条列出；只用于测试）：

- 认出探针 1–9 的提示时一律按“能力全通过”回答（`get_weather` 返回 `{ city: "Paris", days: 3 }`，第 4 步回答含 21，第 5 步调 `submit_outcome` 且取值在枚举内，第 6 步回合法 JSON，第 7 步回合格的标签）；下面的模型 id 后缀只关掉对应的探针能力：
  `-notools`（第 3 步不调工具）、`-nochoice`（第 5 步忽略指定调用）、`-noschema`（第 6 步忽略 schema）、`-replay`（第 4 步“不带”推理内容时返回 400）、`-truncate`（第 8 步超过一半窗口时静默丢掉开头）。
- 只作用于不是探针的请求的后缀：`-404`（返回 404）、`-hang`（不回响应头）、`-stall`（回了响应头后不发内容）。`-nocancel` 作用于所有请求：断开后 `/metrics` 的进行中计数 10 秒内不回落（探针第 9 步因此得到 `false`）。
- （2026-10-24 补，§7.7）`-nooff` 作用于所有请求：请求里带明确的“关闭思考”（`reasoning.effort: "none"`、`reasoning.enabled: false`、`thinking.type: "disabled"`）时回 400，响应体照录下的 OpenRouter 原文
  `{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400,"metadata":{"provider_name":null}}}`（2026-10-24 实测的原文）；不带思考参数时照常回答并带思考内容。
  pi 只在地址含 `openrouter.ai` 时用 OpenRouter 的写法，所以合成端点同时在路径前缀 `/openrouter.ai/v1` 下提供同样的接口，测试的提供商地址写 `http://127.0.0.1:<端口>/openrouter.ai/v1`。
  对话请求的日志行加 `"effort"` = `reasoning_effort ?? reasoning.effort ?? null`（请求里的思考强度原值），用来看会话的 Off 实际发的是 `minimal`、测试连接发的是 `medium`。
  “开了思考”（`probes.mjs` 的 `thinkingOn` 与 “thinking check” 的回复）改为：请求带 `reasoning_effort` 或 `reasoning.effort`，且不是 `none`。
- （2026-10-24 补，§7.7）`-thinklong` 作用于探针：开了思考时先发一段超过 256 token 的思考、不给正文，以 `finish_reason: "length"` 结束（测输出上限的规则）。
- （2026-10-24 补，§7.7）真实层的 MP-40：在 `v1-models-real.mjs` 里多走一段，结果写进 `v1-models-real.json`。
  OpenRouter 提供商从复制出的数据目录里找（名称或地址含 openrouter，同 `md-real-helpers.mjs` 的找法）；找不到而运行它的进程设了 `MP_REAL_OPENROUTER_KEY`（由你或运行它的人从 `openrouter.env` 读出、不打印）时，
  经设置页的 Add provider 用这个 key 加入（同一键拉取模型的 MD-14）；两样都没有时 MP-40 停下来报告，同 MP-27。
  复制出的配置里已经有 `recursive/flint-v1.0:free` 或 `liquid/lfm-2.5-2.6b:free` 时先删掉，再经卡上的 Fetch models 加入。
  “原来是 Off 的会话”：先在一个有 Off 的模型（DeepSeek）上把会话设成 Off，再把范围换成 flint；免费模型每天有请求上限，与 `md-real.mjs` 同一天跑时注意。
- （2026-10-24 补，负责人定：选项 A，“用 env 里的 key 新建数据目录”）本机没有负责人的数据目录时，`v1-models-real.mjs` 另有 key 方式：
  不给 `--source`，环境变量 `MP_REAL_DEEPSEEK_KEY`、`MP_REAL_GLM_KEY`、`MP_REAL_OPENROUTER_KEY` 都有值（由运行它的进程从 `HoldThatThgt` 目录下的
  `deepseek.env`、`glm.env`、`openrouter.env` 读出、不打印）；脚本只经界面建一个新的数据目录：首次启动表单接 DeepSeek，再经 Add provider 接 GLM
  与 OpenRouter（建目录的代码从 `md-real.mjs` 的 key 方式移到共用的辅助模块，两边共用），之后照原样跑 MP-27 与 MP-40。key 不打印、不写进日志、
  结果文件与提交；`--source` 方式不变。OpenRouter 的 Add provider 就是 MP-40 上面那条“找不到时用 `MP_REAL_OPENROUTER_KEY` 经 Add provider 加入”：
  在这次建的数据目录里做、同时勾上 flint，lfm 再经卡上的 Fetch models 加入；建目录时不先加一个免费模型，免得同一天把免费模型多探测一遍（每天有请求上限）。
- 认证：`FAKE_KEYS` 是逗号分隔的可接受 key（没设时不检查）；`FAKE_LIMITED_KEYS` 里的 key 返回 429 带 `Retry-After`，`FAKE_LIMIT_MS` 之后恢复（没设时一直限流）；`FAKE_QUOTA_KEYS` 里的 key 返回 402 `insufficient_quota`。
- 关键词（在最后一条用户消息里）：`http-NNN`（每次都返回 NNN）、`http-NNN-once`（这个会话第一次返回 NNN，之后正常）、`overflow-once`（第一次返回 400 `This model's maximum context length is 1000 tokens`、`context_length_exceeded`，压缩后正常）、`drop-after-first`（发出第一段内容后断开）、`slow`，以及现有的全部关键词。
- `GET /version` 返回 `FAKE_SERVER_VERSION`（默认 vLLM 的形状）；`FAKE_NO_METRICS=1` 时 `/metrics` 返回 404；`/models` 带 `max_model_len`；`/metrics` 报告进行中的请求数。
- 多个提供商 = 多个端口。保留现有的 `METHOD url` 日志行和启动时的 `synthetic` 行，另每个请求一行 JSON（端口、模型、key 末 4 位、消息角色序列、状态、`probe: true|false`）。
- 合成端点只提供 `chat/completions`：`openai-responses`、`anthropic-messages` 的请求写法和认证头只在单元层用替身 fetch 截下请求检查（MP-10、MP-32）。

真实模型与录制：

- 两个真实提供商：DeepSeek 和 GLM（你在 Mori 的数据目录里保存它们的 key；脚本只复制加密的文件，不读 key）。没有第二个时 MP-27 停下来报告。
- `lib.mjs` 的 `scratchUserData` 也复制 `model-config.json`、`model-profiles.json`；真实与录制脚本在复制出的配置里给它们的临时项目写 `projectZones: ["public"]`，并建一个分组 `[deepseek 提供商, glm 提供商]` 作为默认范围（测试准备，代码里注明），之后的界面操作照常。
- 故障用真实方式触发、并且能恢复：脚本启动前把复制出的 `credentials.json` 里首选提供商的密文另存一份到一个备用 `ref`（只复制密文）；要制造故障时在界面里删掉首选的 key、加一个错的 key（`sk-invalid`），之后的请求得到真实的 401 → `auth` → 换模型；
  在回复开始前换掉就是段开始时换模型，在一个多工具调用的回复进行中换掉就是段内换模型。要恢复时退出 App，把配置里首选的 key 改指备用 `ref`，重新启动，下一段用回首选。脚本记录每一步，fixture 里注明。
- 你的数据目录要先用 v1 打开一次：确认迁移来的提供商区域为 Public（GLM 在 v0 里加好就会一起迁移）。

### 14.2 验收条目

每条测试的名字以条目编号开头。

| 编号 | 条目 | 通过条件 | 层 |
| --- | --- | --- | --- |
| MP-01 | 配置校验 | 未知字段、重复 id、分组与提供商重名、保留 id、`maxTokens` 不小于窗口、`allowedZones` 含 `public`、引用不存在的名字、`nextKeyNumber` 回退都报错并指出位置；配置读不出时会话按 `config_invalid` 拒绝启动，文件不被覆盖；由名称生成 id（大小写、非字母数字、截断、与保留 id 或已有 id 冲突加 `-2`）；删掉 key 后新 key 的编号不复用；配置读不出时不显示首次启动表单 | 单元、App |
| MP-02 | 编译到 pi | 保存后 pi 按提供商与模型找到模型；pi 里只有占位 key；删除的提供商从 pi 去掉；编译出错时回滚、文件不变 | 单元、App |
| MP-03 | 多个 key | 一个提供商两个 key、并发各 1：两个会话同时发送，分别用两个 key；第一个 key 被 429 后请求改用第二个 key，不提示换模型；用到的行为：`FAKE_KEYS` 两个 key、`FAKE_LIMITED_KEYS` 第一个 | App |
| MP-04 | key 全部不可用 | 两个 key 都 429：按候选换到下一个提供商，对话流一行换模型提示，没有错误卡 | App |
| MP-05 | 选择范围展开 | 分组成员顺序，提供商成员 → 它的模型顺序，模型成员 → 它自己；去重保留第一次；项目配置缩小分组（部分成员、或提供商缩小到模型）后按 §4.3 的顺序 | 单元 |
| MP-06 | 网络区域 | 公网提供商在没有授权的项目里被排除并给出原因；Project access 勾选 public 先确认，确认后可用、取消不写；项目配置缩小区域后被排除、对应勾选框不可用；项目配置不能放宽；项目路径大小写与分隔符不同仍按同一项目授权 | 单元、App |
| MP-07 | 项目配置 | 未知字段、坏 JSON、不存在的分组、不属于用户分组的项都让会话按 `project_config` 拒绝启动并显示原因 | 单元、App |
| MP-08 | 从 v0 迁移 | 全部 provider 迁入；key 沿用原 `ref`；手写明文 key 加密保存、密文优先；`$ENV`、不支持的接口、丢弃的兼容字段、不合格的模型、改写的 id（含冲突与保留 id）列在说明里；默认模型成为默认范围；`modelThinkingLevels` 复制到新键；区域建议按 §12；区域未确认的提供商在确认前被排除；迁移后改 `models.json` 不再生效；说明 Dismiss 后不再显示；迁移失败时不写配置；迁移后这次启动停在 设置 → Models | 单元、App |
| MP-09 | 会话启动校验 | §4.6 表中每种结果的卡片文字与操作；“Verify now”跑完探针后自动解除；全部在验证中时显示 verifying、没有 Verify now；被拒绝时发送不可用，后台进程也拒绝 | App、回放 |
| MP-10 | 档案与探针 | （2026-10-26 注：App 层读 `models.get` 的档案，模型行只看 `data-probe` 与状态行，§9.1；`fake-coder-notools` 的状态行带“Verify again”，点它重新跑第 0–7 步：行变为 `reverifying`、状态行“Verifying…”不带按钮，合成端点收到新的探针请求，结束后回到 `failed` 并再带“Verify again”；探针出错的状态行同样带“Verify again”）添加模型后自动跑第 0–7 步；合成端点上 `tool_calling`、A/B/C 等级（各后缀分别降级）、推理字段、`replay`、`can_disable`、`server` 判定正确；三种接口的请求写法按 §7.3 的表；探针走 `background` 类别；新的一组探针开始时旧的被取消；`anthropic-messages` 上 A、C 都不通过时 `tier: null`（§7.5）；`-replay` 模型探测完成后不保存配置，下一条消息里别的模型带工具调用的助手消息带有 `reasoning_content`（合成端点日志）；三种接口的请求写法在单元层用替身 fetch 检查 | 单元、App |
| MP-11 | 需要同意的探针 | （2026-10-26 注：设置页的两个按钮与确认框删掉，App 层经进程桥发 `models.verify`（`tests` 为 `long_input`、`cancel`）、读档案，不再查确认框与告警；整条由 WP-04 删除）长输入与取消探针只在确认后运行；静默截断被判出并告警；`/metrics` 回落时 `cancel_verified` 为真，不回落为假，没有指标为 `unknown`；`-nocancel` 为 `false`，`FAKE_NO_METRICS=1` 为 `unknown` | App |
| MP-12 | 指纹与版本 | 改窗口或服务版本变化后重新探测；重新探测期间旧结果继续用于选择、已打开的会话仍可发送；版本接口连不上时档案不变 | 单元、App |
| MP-13 | 粘性与回到首选 | 段内换到第二候选后一直用它；首选在段开始时不可用、段内恢复后第二候选又失败，换到第三个而不是首选；下一段首选可用时用回首选；第二条消息的第一次请求沿用段开始时（§11.4）选的模型；插话（含在最后一条回答之后送达的）不开始新段；溢出恢复后 `tried` 保留；回放层覆盖界面上的换模型提示与回到首选 | 单元、App、回放 |
| MP-14 | 第一个请求就失败 | 首选 401（错的 key）：同一个请求发给第二候选，对话流有换模型提示，没有错误卡 | App、回放 |
| MP-15 | 段内换模型（重做） | 第三个请求时首选不可用：新模型收到的上下文里没有之前的助手消息和工具结果，这段的用户消息末尾带说明；新模型自己的消息之后不被隐藏；两次换模型时区间取并集、只有一段说明；会话文件和界面保留被隐藏的过程；重新打开后仍然隐藏；排队消息那一段被重做时，上一段的回答仍发给新模型；排队消息在上一段还在调工具时排进来、它那一段被重做时，上一段的回答完整地发给新模型；换到窗口更小的模型后触发阈值压缩，摘要请求里没有被隐藏的过程 | 单元、App、回放 |
| MP-16 | 原地重试 | `http-503-once`：阶段行显示“Retrying (1/3)”，不换模型；`http-503`：重试用完后显示错误卡，不换模型 | App |
| MP-17 | 不换的情况与停止 | 400、有输出后中断都不换模型；你按停止不换；在排队中、等模型中、等它停下时按停止：对话流显示已停止而不是错误卡，合成端点没有收到新的请求；两个会话排同一个提供商，停止一个，另一个照常发出 | App |
| MP-18 | 结果未知 | `-hang` 与 `-stall`：`cancel_verified` 为 `true` 时立即换模型；为 `false`（`-nocancel`）时读指标确认停下后换模型；为 `unknown`（`FAKE_NO_METRICS=1`）时阶段行显示等它停下，等满后换模型继续这次回复，提示注明 Couldn’t confirm it stopped；期间合成端点没有收到同一请求的第二份；只有一个候选时等满后显示说明卡，没有错误卡 | 单元、App |
| MP-19 | 排队与优先级 | 并发 1 时第二个请求排队，阶段行显示等待；探针排在对话之后；排队超时后换模型；调低并发、删 key、加 key 时按 §8.2；会话 2 段内遇到会话 1 造成的全部 key 冷却：直接换模型，不排队；并发 1、对话占着槽位时添加模型：探针等对话结束后完成，档案为 verified | 单元、App |
| MP-20 | 候选耗尽 | 全部不可用时先等并显示原因，恢复后继续；只剩不会恢复的原因时不等；等不到时一张说明卡、没有错误卡；段开始时消息撤回、文字放回输入框；压缩时选不到模型报压缩失败；用到的行为：`FAKE_LIMIT_MS` 让限流在等待期间恢复 | 单元、App |
| MP-21 | 接手判断与重建 | 要求回传推理的模型接手带别的模型工具调用的对话：段开始时重建（对话太短时只去掉工具调用和思考），重建后的上下文保留压缩摘要；段内只去掉、不压缩；窗口不够时段开始重建、段内排除；重建的压缩失败时换下一个候选；重建时没有 v0 的压缩提示和错误卡；重建的压缩失败后换到下一个候选，对话流没有错误卡 | 单元、App |
| MP-22 | 压缩走 Mori | `overflow-once` 触发的溢出恢复与到阈值的自动压缩都经模型池、用当前模型和 key；压缩出错不换模型；压缩请求的首个内容时限生效 | App |
| MP-23 | 选择范围（输入框下面一行） | 可以选分组、提供商或模型；写进会话文件，重新打开后沿用；改了设置里的默认范围，已有会话（包括没切换过的）的范围不变；v0 旧会话打开后用它最后用过的模型；不改默认范围；生成中与准备中不能改；范围按钮的文字格式“<范围名> · <当前模型 id>”；被排除的项变淡并有原因；底部说明 | App、回放 |
| MP-24 | 设置页 | Providers、Keys、Models、Groups、Defaults、Project access 的增删改都写进配置并立即影响静态校验；删除与改地址的连带改动列在确认框里；改地址的 origin 后 key 被删，合成端点日志里新端口没有收到旧 key；分组编辑的错误与“至少一个成员”；key 的明文不回到界面 | App |
| MP-25 | 只有一层重试 | 429 时没有 pi 的 `auto_retry_start`；打开工具页、改思考强度等触发 pi reload 之后仍然没有；合成端点日志里每次尝试逐条对得上 | App |
| MP-26 | key 不落盘 | 配置文件、档案、迁移说明、会话文件、日志、测试结果里没有 key 明文；F8 报告（最近的操作与报告正文）里没有 key：Add key 后按 F8 保存报告检查 | App |
| MP-27 | 真实模型 | 两个真实提供商：正常对话；按 §14.1 的方法在段开始和段内各换一次模型（真实的 401）；恢复首选的 key 并重新启动后，下一段用回首选；探针结果合理 | 真实 |
| MP-28 | 失败分类 | §5.4 表的每一行，含三种 `Retry-After` 写法和额度关键词 | 单元 |
| MP-29 | 认证、额度、404、连接失败 | 各自按 §5.4 换 key 或换模型，§8.3 的记录与恢复；没有 key 的提供商 429 带 `Retry-After` 后下一段跳过它直到那个时刻；402 后 key 行显示 Quota exhausted，Test 成功后清除，下一段用回它 | 单元、App |
| MP-30 | 删除的连带改动 | §4.1 的每一项，含删最后一个模型删掉提供商、分组变空、`normalDefault` 置空、打开的会话按 `pick_missing` 拒绝 | 单元、App |
| MP-31 | 槽位不泄漏 | 正常结束、出错、停止、中止后占用数归零；4xx 读完响应体即释放 | 单元、App |
| MP-32 | 认证头 | 三种接口各写对认证头；没有 key 的提供商不带认证头；pi 的占位 key 不会发到服务端；三种接口在单元层检查，`openai-completions` 另在 App 层检查 | 单元、App |
| MP-33 | 首次启动 | 填表（含区域）→ 测试连接 → 进入主窗口（Open a folder 提示里一行“Connected · …”）→ 打开文件夹；区域为 Public 时会话的拒绝启动卡带“Allow public for this project”，授权（确认框）后可以发送；探针判定失败时会话的拒绝启动卡说明原因；测试失败后表单留着，改勾选的模型再测：配置里仍只有一个提供商（2026-10-26 按负责人走查 M2 改写） | App |
| MP-34 | 准备中 | 段开始的等待和重建期间用户消息已显示、停止可用；停止后消息撤回、文字回到输入框；准备中再发的消息作为排队消息在回复开始后交给 pi；准备中再发一条后按停止：两条文字都回到输入框，合成端点没有收到请求 | App |
| MP-35 | 思考强度 | 第一个候选是推理模型时新会话按它的按模型默认强度开始，请求带思考参数；换到不支持思考的模型时 pi 收紧；Effort 菜单的可选强度随当前模型；把强度改成 high 后关闭再打开会话，仍是 high；段内从非推理模型换到推理模型后 Effort 菜单的强度变为可选 | App |
| MP-36 | 回复进行中改配置 | 回复中删除它正在用的提供商：下一个请求换到下一个候选并提示；改它的兼容选项：本段继续用它；当前模型在段内被另一个会话造成冷却：下一个请求不发出就换模型 | App |
| MP-37 | 现有功能不退步 | §14.4 的全部现有测试通过（2026-10-22 注：m7 的 App 与回放由提示词分层与记忆规格 §14.4 删除，MP-37 为 smoke、m1–m6 的 App 与回放） | App、回放 |
| MP-38 | 思考关不掉的判定（2026-10-24 补，§7.7） | 单元：第 2 步表里每一行的判定与说明（400、422、`medium` 出错或没有正文、其他错误）；本组第 2 步判出 `off_refused` 时第 3、4、6、7 步用 `medium`、第 5 步不适用、第 7 步照跑；第 1–7 步用没有标记的副本，有标记的模型这一次判出能关闭时第 3–7 步发 `off`；第 8、9 步按档案选强度；回复停在输出上限、只有思考时为出错（`-thinklong`），第 8 步不记 `silent`；带 `auto.offRefused: true` 的档案写出、读回后仍为真并编译出标记；没有 `offRefused` 的旧档案照读、不重新探测；其他模型的判定不变：`fake-coder`，以及地址含 `deepseek.com` 的 `openai-completions` 模型（替身 fetch：`thinking.type: "disabled"` 时 200、没有思考）为 `can_disable: true`、`off_refused: false`、编译后没有标记。App：`fake-coder-nooff`（OpenRouter 前缀地址、勾 Supports thinking）加入后档案 `ready`、`tool_calling: verified`、`off_refused: true`，模型行有“Thinking: Can’t be turned off”，点 Verify 后仍是同样的结果；`fake-coder-thinklong`（普通地址、勾 Supports thinking）加入后模型行为“Couldn’t verify: Stopped at the probe output limit before answering”，Tool calling 仍为 Verified（2026-10-26 改，§9.1：模型行说明一行最后有“Thinking can’t be turned off”，经进程桥再发一次 `models.verify` 后仍是同样的结果；`fake-coder-thinklong` 的档案为 `error`、说明“Stopped at the probe output limit before answering”，tool calling 仍为 `verified`，模型能用，模型行没有状态行） | 单元、App |
| MP-39 | 没有 Off 的标记（2026-10-24 补，§7.7） | 单元：`off_refused` 编译成 `thinkingLevelMap: { off: null }`（三种接口都写在模型上）、变了时重新编译这个提供商；换模型后重发的强度按新模型收紧；`enhance.get` 的 `noOffPicks` 按第一个候选的档案给出。App（`fake-coder-nooff`）：输入框下面一行的 Effort 菜单没有 Off、有“This model can’t turn thinking off.”；会话原来是 Off 的显示 Minimal，发出的请求 `effort` 为 `minimal`、合成端点没有回 400；测试连接（2026-10-26 注：提供商卡的 Test connection，模型行没有 Test 了）发出的 `effort` 为 `medium` 且成功；模型表单（Edit）与增强设置的 Effort 不列 Off；没有标记的模型（`fake-coder`）菜单仍有 Off、Off 时不带思考参数 | 单元、App |
| MP-40 | 真实的思考关不掉的模型（2026-10-24 补，§7.7） | 你的 OpenRouter key：`recursive/flint-v1.0:free` 经设置页加入后档案 `ready`、`tool_calling: verified`、`off_refused: true`；`liquid/lfm-2.5-2.6b:free` 加入后 `tool_calling: verified`、`off_refused: true`，且等级 B 或第 6 步出错为“Stopped at the probe output limit before answering”（只能是出错，不能是不通过）（2026-10-24 负责人改，原来只写“等级 B”：lfm 在 `medium` 下第 6 步的思考长度不定，在 256 token 的探针上限上有时答完（B 级）、有时只有思考就停下（按本节的输出上限规则为出错，第 7 步不跑，等级为空）；这一条要验证的是必须思考的模型变得可用，探针上限不调，见 [v1/models-checks.md](../v1/models-checks.md)“思考关不掉的模型：实现与检查”）；会话里选不到 Off，原来是 Off 的会话正常回答；测试连接成功 | 真实 |
| MP-41 | 测试连接总是发出（2026-10-26 补，§8.3） | 单元：key 都在 `auth`（或 `rate_limited`、`quota`）、提供商在 `connection`、模型在 `not_found`、`timeout`、`held` 时，测试连接的请求（`connection.test` 用的 fetch）照样发出，会话的请求照旧不发；不带 key 时用第一个没有记录的 key，全部有记录时用第一个 key，401 后照样换到没有记录的 key；失败照常写记录；成功时清除用到的 key 的记录、提供商的 `connection` 与这个模型的 `not_found`，`timeout`、`held` 留着 | 单元 |

### 14.3 不留未完成项

`tests/spec-coverage.mjs` 读 §14.2 的编号和每条的“层”，再读 `test-results/` 里各测试的结果：每个编号在它列出的每一层都要有名字以这个编号开头、结果为通过的检查，任何一个缺少就失败。

- 层由结果文件决定：`v1-unit.json`（`node --test` 的结果转成 `createRecorder` 的格式）为单元；`v1-models-app*.json` 为 App；`v1-models-replay.json` 为回放；`v1-models-real.json` 为真实。
- `npm run test:v1-models` 依次跑单元、App、回放测试，再依次跑 §14.4 的现有套件，每个套件按退出码在 `v1-models-app-existing.json` 或 `v1-models-replay-existing.json` 记一条“MP-37 <脚本名>”，最后运行覆盖检查。
  （2026-10-22 注：m7 的 App 与回放由 [提示词分层与记忆规格](memory.md) §14.4 删除，现有套件为 smoke、m1–m6 的 App 与回放；这两个结果文件也由它的 MEM-35 一并写出。）
- 真实层（MP-27）由 `v1-models-real.mjs` 写结果，覆盖检查同样要求它通过。（2026-10-24 补：MP-40 同样由 `v1-models-real.mjs` 写进 `v1-models-real.json`，§14.1；MP-38、MP-39 新加的 App 脚本要加进 `package.json` 的 `test:v1-models`，否则覆盖检查找不到。）
- 只认开发构建的结果；打包构建另跑一遍时结果文件带 `-packaged`，覆盖检查对两者分别执行。

### 14.4 现有测试与回放

| 现有 | 改法 |
| --- | --- |
| `tests/fake-endpoint/server.mjs` | 加 §14.1 的行为；默认模型 `fake-coder` 能通过探针第 0–7 步，现有关键词的回答不变 |
| `tests/ui/page.mjs`、`m6-helpers.mjs` 的首次启动 | 填英文表单、区域选 Local；等 `mori.profiles` 里这个模型的探针都跑完（Models 行显示等级）再打开文件夹 |
| `m0-smoke.mjs` | 对 `pi/models.json` 的断言改为对 `model-config.json`；编辑连接与“改地址要重新填 key”的步骤改为 v1 的改地址（key 被删、确认框）；key 占位文字改为 Keys 行的“Saved”；中文的校验文字改为英文 |
| `m1-app.mjs` | 重试检查改为 `http-503-once` 与“Retrying (1/3)”；改错 key 再“Go to settings”的步骤改为：删 key、加一个错的 key → §9.3 的说明卡（“API key rejected”、“Open settings”，焦点在 Keys）→ 加回对的 key；首次启动的中文校验改为英文 |
| `m1-layout.mjs` | 设置页的测量改为 Models 分节（提供商卡与提供商表单） |
| `m2-app.mjs`、`m2-replay.mjs` | F8 检查前保存 key 的准备改为 Models → Add key（`models.addKey`，回放由桥应答）；“报告里没有 key”的检查不变 |
| `m6-app-settings.mjs` | 连接、模型、默认模型、删除的步骤删去，由 `v1-models-*.mjs` 覆盖；思考强度与 AGENTS.md 的步骤保留并改用新表单 |
| `m6-replay.mjs` | 设置页分节导航的检查改到 Models 分节；删除 `m6/model-switch.json`、`m6/thinking.json` 后，另录 `fixtures/v1/thinking.json`（输入框下面一行的思考强度）取代思考菜单的回放检查 |
| `m7-app.mjs`（2026-10-22 注：已删除，见提示词分层与记忆规格 §14.4） | “工作回顾不发模型请求”的检查只数 `probe: false` 的请求 |
| `m7-replay.mjs` 与其余回放脚本（2026-10-22 注：`m7-replay.mjs` 已删除，同上） | 各自的 `QUERIES` 加 `models.get` |
| 其余 `m1`–`m7` 的 App 测试（2026-10-22 注：m7 的已删除，同上） | 只换首次启动的写法，其余不变 |
| 回放：`tests/ui/harness/replay.js` | `models.get` 加进只读查询；录制里没有时用 fixture 的 `model` 合成（一个本机区域的提供商、一个模型、`normalDefault` 为它、档案已验证，代码里注明 synthetic）；`ModelState` 的新字段同样合成；`models.*` 的写命令照 `connection.save` 的方式应答；`harness/main.jsx` 加 `fixtures/v1` |
| 回放：`m6/model-switch.json`、`m6/thinking.json`、`m1/no-key.json` | 删除（v1 不再有这些命令和情形），对应检查从 `m6-replay.mjs`、`m1-replay.mjs` 去掉，由 MP-23 和 `fixtures/v1/thinking.json` 的回放取代；`m1/wrong-key.json` 的“去设置”检查改为说明卡 |
| `m0-real.mjs` | 断言改为 `model-config.json`、`credentials.json` |
| `m1-real.mjs`、`m1-record.mjs` | 首次启动的走查用一个空的复制数据目录；走查 6 改为“错的 key → 说明卡 → Open settings → Keys”，`$变量` 与没有 key 的情形删去（v1 里没有 key 就不带认证头）；压缩的准备改为在复制出的 `model-config.json` 里把窗口改小 |
| `m2-real.mjs` | F8 的准备改为 Add key |
| `m6-real.mjs`、`m6-record.mjs` | 走查 1 与 8 改为在 Models 里加模型、在范围菜单里选；读 `model-config.json`；重新录制范围与思考强度的 fixture |
| 全部 `*-real.mjs`、`*-record.mjs` | 提供商从 `model-config.json` 取，不再找 `pi/models.json` 的 `mori-endpoint`；按 §14.1 复制模型配置并给临时项目授权公网 |

`npm run smoke`、`test:app`、`test:m1-app`…`test:m7-app`、各回放测试都通过，MP-37 才算通过。
（2026-10-22 注：`test:m7-app`、`test:m7-replay` 由 [提示词分层与记忆规格](memory.md) §14.4 删除，MP-37 为 smoke、m1–m6 的 App 与回放。）
（2026-10-23 注：MP-01、MP-10、MP-24、MP-33 的条目文字不变，测试按一键拉取的流程写：首次启动、Add provider 和卡上加模型都走 Fetch models 与清单（或手填一行），见 [model-discovery.md](model-discovery.md) §13.4。）
（2026-10-26 注，负责人走查 M1、M6、M7、M8（WP-02）：模型行没有档案摘要、Verify、Test 与需要同意的探针，现有测试改读行的 `data-probe`（取代 `data-field="tool_calling"`）、状态行 `probe-status` 与 `models.get` 的档案；`m1-app.mjs` 设置页里取消测试改用提供商卡的 Test connection（先把 `fake-slow` 移到第一个）；`m0-smoke.mjs` 读表单结果时不再等 Playwright 的默认 30 秒（表单下方还没有结果时不等），并加一项“401 之后什么都不改再测，请求照样发出”（MP-41 的 App 侧，结果不计入覆盖检查）。逐条见 docs/v1/walkthrough-1026/WP-02.md。）
（2026-10-26 注：MP-33 的条目文字按“测试成功就进入主窗口”改写（负责人走查 M2，docs/v1/screens/first-run.md）：探针状态的检查从表单下方移到会话的拒绝启动卡与 `models.get` 的档案，改模型再测放在测试失败之后。）
