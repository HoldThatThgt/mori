# 随 Mori 一起打包的程序

pi 的 `grep` 工具要 ripgrep（`rg.exe`），`find` 工具要 fd（`fd.exe`）；Mori 让 pi 离线运行（`PI_OFFLINE`），pi 不下载它们。
这两个程序随安装包一起发（2026-10-28 负责人定，`docs/v1/walkthrough-1026-checks.md` 的 U76）：`electron-builder.yml` 的
`extraResources` 把 `bin/` 放到安装目录的 `resources\bin`、`licenses/` 放到 `resources\licenses`；主进程启动后台进程时把这个
`bin` 目录放在 PATH 最前面（`src/main/kernel-process.ts`），pi 和模型跑的命令都找得到。开发构建用这里的 `bin/`。

| 程序 | 版本 | 来源（GitHub release 的资源） | zip 的 SHA-256（与 GitHub 公布的 digest 相同） | exe 的 SHA-256 |
| --- | --- | --- | --- | --- |
| `bin/rg.exe` | ripgrep 15.2.0 | `https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip` | `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5` | `14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680` |
| `bin/fd.exe` | fd 10.5.0 | `https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-pc-windows-msvc.zip` | `a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7` | `d67d27a8e375ed7e9bca2b506a9dd5082bc24547aeba908b863f6f8b8ab0c3b9` |

许可：ripgrep 是 MIT 或 Unlicense（`licenses/ripgrep/`），fd 是 MIT 或 Apache-2.0（`licenses/fd/`），文件照 zip 里的原样。

换版本时：从上面同一个地址下载新的 zip，核对 GitHub release 页面公布的 digest，把 exe 和许可文件换进来，改这张表。
