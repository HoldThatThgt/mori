# 卸载：问要不要删掉 Mori 的数据（2026-10-28，U75）

依据：负责人 2026-10-28：“when uninstall mori, those old setup file should goes away as well”；问过删到哪一步后选
“Ask in the uninstaller”（卸载向导里问，默认保留）。起因：负责人卸载旧版本、在同一位置装上新版本后，`%APPDATA%\Mori` 里
旧版本写的 `model-config.json` 还在（还写着 2026-10-26 删掉的网络区域字段），首次启动表单不出现，设置 → Models 停在
“Couldn’t read model settings”（[model-providers.md](../../specs/model-providers.md) §4.1，按规格就是这样）。
electron-builder 的卸载程序本来不删数据（`deleteAppDataOnUninstall` 默认关），Mori 在 NSIS 卸载向导里加一页
（`app/installer/uninstall.nsh`，经 `electron-builder.yml` 的 `nsis.include` 载入）。检查记录见 [../uninstall-checks.md](../uninstall-checks.md)。

## 来源

NSIS 卸载程序怎样启动：从 Windows 的“设置 → 应用”或控制面板卸载、直接运行安装目录里的 `Uninstall Mori.exe`
（都不带 `/S`）；带 `/S` 静默运行；新版本的安装程序在装之前静默运行旧版本的卸载程序（`/S --updated`）。以及你在这一页的勾选。

“Mori 的数据”是两个文件夹：`%APPDATA%\Mori`（设置、`model-config.json`、加密的 key、会话、记忆、TaskBoard、界面问题、
pi 的配置）和 `%LOCALAPPDATA%\Mori`（文件快照，[file-system.md](../../specs/file-system.md) §4.1）。

## 状态

| 状态 | 来源 | 必须可见 | 可做的操作 |
| --- | --- | --- | --- |
| Mori 的数据（欢迎页之后的一页） | 不带 `/S` 运行卸载程序，欢迎页点“Next >” | 页头标题“Your Mori data”，副标题“Choose whether to delete it along with Mori.”；说明“Mori keeps your settings, saved API keys, sessions, memory and file snapshots in these folders:”，下面两行是这台电脑上展开后的两个文件夹路径（例如 `C:\Users\<你>\AppData\Roaming\Mori`、`C:\Users\<你>\AppData\Local\Mori`）；再一行“Uninstalling keeps them, so installing Mori again picks up where you left off.”；勾选框“Also delete my Mori data”，第一次进这一页时不勾；勾选框下“This can’t be undone. Files in your project folders aren’t changed.”；下一步的按钮写“Uninstall” | 勾上或取消勾选；Uninstall；< Back（回到欢迎页，再点“Next >”回来时勾选照旧）；Cancel（NSIS 自带） |
| 不勾，卸载 | 上一页不勾，点“Uninstall” | 同 electron-builder 原来的卸载：删掉程序、快捷方式和“设置 → 应用”里的这一项；两个数据文件夹原样留着；最后一页“Finish” | Finish |
| 勾上，卸载 | 上一页勾上，点“Uninstall” | 先删掉两个数据文件夹（整个文件夹），再同上删掉程序；项目文件夹里的东西（`.mori`、`AGENTS.md`、worktree）不动；最后一页“Finish” | Finish |
| 装新版本到旧版本上 | 新版本的安装程序静默运行旧版本的卸载程序（`/S --updated`） | 不出这一页，两个数据文件夹都不删 | — |
| 静默卸载 | `Uninstall Mori.exe /S` | 不出这一页，两个数据文件夹都不删 | — |

electron-builder 自己还认卸载程序的 `--delete-app-data` 参数（只删 `%APPDATA%\Mori`，不删快照）；它不是 Mori 加的，照原样，
这一页和测试都不用它。

## 反例

- 不勾就什么数据都不删；这一页从来不默认勾上。
- 装新版本、静默卸载都不删数据。
- 不删项目文件夹里的任何东西，也不删两个数据文件夹以外的东西。

## 界面测试怎样碰到卸载向导

`tests/ui/uninstall.mjs`（`npm run test:uninstall`）用 electron-builder 另打一个安装包：产品名“Mori Uninstall Test”、
appId `com.holdthatthgt.mori.uninstall-test`、包名 `mori-uninstall-test`，不压缩，放在 `test-results/uninstall-dist/`。
它装到临时目录，数据文件夹是 `%APPDATA%\Mori Uninstall Test` 与 `%LOCALAPPDATA%\Mori Uninstall Test`，卸载项按 appId 另记，
所以碰不到真的 `%APPDATA%\Mori` 和装在别处的 Mori（测试前后比对真的 `%APPDATA%\Mori`、`%LOCALAPPDATA%\Mori` 一项都没少——
Mori 开着时自己会建、删的锁文件与数据库日志除外——`model-config.json` 与 `credentials.json` 没变）。
卸载向导是原生窗口，Playwright 碰不到：`tests/ui/uninstall-ui.ps1` 用 Win32 消息按控件 ID 读页上的文字和勾选、勾选、点按钮
（UI Automation 在这台机器上把 NSIS 的控件都当成没有可点、可勾的 Pane，2026-10-28 实测）。每次卸载等安装目录和卸载项都没了
再往下走，否则下一次安装会和还在删目录的卸载撞在一起。
