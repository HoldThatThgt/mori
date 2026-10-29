# 卸载时问要不要删掉 Mori 的数据：检查记录（2026-10-28，U75）

依据：负责人 2026-10-28 报告：卸载旧版本（旧提交打的包）、在同一位置装上最新版本后，首次启动表单不出现，设置 → Models 停在
“Couldn’t read model settings: …\model-config.json: providers.0: Unrecognized key: "zone"; …”。负责人要求先修好本机的文件，
再让卸载时把旧的设置文件也去掉；问删到哪一步时选“Ask in the uninstaller”。状态表见 [screens/uninstall.md](screens/uninstall.md)。

## 诊断

- 这是规格写好的行为，不是缺陷：2026-10-26 负责人走查 M3 去掉网络区域时定了不写兼容代码，还写着 `zone`、`allowedZones`、
  `projectZones` 的旧文件按“启动时配置读不出”处理（[model-providers.md](../specs/model-providers.md) §4.1 的 2026-10-26 注）：
  不迁移、不显示首次启动表单、不覆盖文件，设置 → Models 只显示这条错误和 Retry。
- 首次启动表单不出现是因为 `model-config.json` 已经存在（[v1/screens/first-run.md](../v1/screens/first-run.md)“配置读不出”一行）；
  文件留下来是因为 electron-builder 的卸载程序本来不删 `%APPDATA%\Mori`（`deleteAppDataOnUninstall` 默认关）。

## 本机文件的修复

`C:\Users\blue\AppData\Roaming\Mori\model-config.json` 先备份成同目录的 `model-config.json.before-zone-removal`，再去掉两个提供商的
`zone` 和顶层的 `allowedZones`、`projectZones`（这三个就是校验原文指出的全部字段）。用现在的 `ModelConfigSchema` 校验过：去掉前报
这三处，去掉后通过；两个提供商、`default` 分组、`normalDefault` 不变，key 在 `credentials.json` 里没动。在 Mori 里点 Retry 由负责人做。

## 实现

- `app/installer/uninstall.nsh`（新，带 BOM 的 UTF-8）：`customUnWelcomePage` 在欢迎页之后加一页（nsDialogs），
  `customUnInstall` 在卸载那一节的开头、删程序之前，勾上时 `RMDir /r` 两个数据文件夹；路径按 `${APP_FILENAME}` 与当前用户取。
- `app/electron-builder.yml`：`nsis.include: installer/uninstall.nsh`。
- 没有改 `app/src/`：主进程、后台进程和界面都不变。

## 状态表各行的用例

| 屏 | 行 | 用例（套件、检查名） |
| --- | --- | --- |
| uninstall.md | Mori 的数据（欢迎页之后的一页） | `uninstall`：“卸载向导：欢迎页没有勾选框、按钮是“Next >””，“Mori 的数据（欢迎页之后的一页）：标题…；按钮“Uninstall”“< Back”“Cancel””，“那一页勾上后点“< Back”回到欢迎页、再点“Next >”回来：勾选照旧” |
| uninstall.md | 不勾，卸载 | `uninstall`：“不勾，卸载：删掉程序、桌面快捷方式和“设置 → 应用”里的这一项，两个数据文件夹原样留着；最后一页“Finish”” |
| uninstall.md | 勾上，卸载 | `uninstall`：“勾上，卸载：两个数据文件夹整个删掉，程序、快捷方式与卸载项也删掉；项目文件夹里的 .mori 不动；最后一页“Finish”” |
| uninstall.md | 装新版本到旧版本上 | `uninstall`：“装新版本到旧版本上（同一个安装包再静默装一次，旧版本的卸载程序带 /S --updated 运行）：两个数据文件夹都不删” |
| uninstall.md | 静默卸载 | `uninstall`：“静默卸载（Uninstall <产品名>.exe /S）：程序删掉，两个数据文件夹都不删” |
| uninstall.md | （测试的隔离） | `uninstall`：“真的 Mori 数据没被碰到：…” |

## 跑过的

- `npm run test:uninstall`（2026-10-28，第三次）：8/8 通过，结果在 `app/test-results/uninstall.json`。前两次的失败都在测试这一边，
  记在这里：
  - 第一次：UI Automation 把 NSIS 的每个控件都当成没有 Invoke、Toggle 的 Pane（注册 Win32 的客户端代理也一样），驱动点不动
    “Next >”，三个向导的用例失败；另外“不勾，卸载”那一轮的数据和程序被删了。手动重做（同一个安装包，用 Win32 消息点到那一页、
    不勾、点 Uninstall）数据留着、程序删掉，所以不是这一页的问题：测试只等程序文件没了就开始下一次安装，上一次的静默卸载还在
    `RMDir /r` 安装目录。驱动改成 Win32 消息（`WM_COMMAND`、`BM_SETCHECK` 加 `BN_CLICKED`；`BM_CLICK` 在对话框不是活动窗口时
    不起作用），每次卸载等安装目录和卸载项都没了再往下走。
  - 第二次：勾与不勾、Back、数据的删留都对，两个“最后一页 Finish”失败：驱动按标题找窗口，NSIS 在进度页起给标题后面加了一个空格
    （手动跟了一次：点 Uninstall 后约 4.6 秒按钮变成“Finish”）。改成按句柄查窗口还在不在。
- `npm run test:min`：退出码 0，2557 项通过、0 项失败，97 秒。
- 没有改 `app/src/`，按 AGENTS.md 测试分层第 1 条不跑 `test:quick`；没有改发给模型的东西，不录 fixture、不走真实模型。
- 推送前的打包程序（测试分层第 4 条，负责人 2026-10-28 选“Packaging check, push”）：`npm run dist:dir`（80 秒）后
  `m0-smoke --exe dist\win-unpacked\Mori.exe` 40 项通过、0 项失败、1 项 KNOWN（pi #9129，命令超时后留下 sleep 进程，上游的问题），
  49 秒；`m1-app --exe` 54 项通过、0 项失败，163 秒。

## 没有验证的

- 产品名是“Mori”的真实安装包没有走过这一页：测试走的是另打的“Mori Uninstall Test”（同一个 `uninstall.nsh`，路径都从
  `${APP_FILENAME}` 来）。在本机装着的 `D:\MORI` 上试会删掉负责人真的数据，所以没有试。
- 负责人现在装着的 `D:\MORI` 是旧提交打的，它的卸载程序没有这一页；要用这个版本打的安装包装过之后，卸载时才会问。
- 真的鼠标点击：驱动发的是按钮和勾选框被点时的通知，不是鼠标消息；Cancel 没有点（NSIS 自带的确认）。
- 为所有用户安装（`perMachine`、提权运行卸载程序）：这台电脑上没有这种安装，见 defaults.md“为所有用户安装时删谁的数据”。
- 推送前的完整回归（测试分层第 3 条）没有跑：负责人 2026-10-28 选了只跑打包程序那一层再推送（`app/src/` 与已推送的
  `origin/app-v0` 相同，这次只改了打包配置、测试与文档）。
- 本机文件修好之后在 Mori 里点 Retry：Mori 开着，由负责人点。
