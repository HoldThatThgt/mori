// Mori 随程序带的 rg.exe、fd.exe 与许可（app/vendor，docs/v1/walkthrough-1026-checks.md 的 U76），几个测试共用：
//   打包程序与安装包里的 resources 带着它们（m0-smoke --exe、uninstall.mjs）；
//   单独建的开发构建（tb-build.mjs 的 .tb-runs/<名字>、mem-app-prompt 与 tb-app-roles 的故障拷贝）也带上 vendor\bin：
//   用 MORI_APP_DIR 启动时 app.getAppPath() 是那个目录，主进程在它下面找 vendor\bin（main/kernel-process.ts bundledBinDir）。
// 只 import node 的模块，uninstall.mjs 不必载入 lib.mjs。

import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '../..');
const vendor = join(appRoot, 'vendor');

/** 带的文件，相对 app\vendor 与安装目录的 resources */
export const VENDOR_FILES = ['bin/rg.exe', 'bin/fd.exe', 'licenses/ripgrep/COPYING', 'licenses/ripgrep/LICENSE-MIT',
  'licenses/ripgrep/UNLICENSE', 'licenses/fd/LICENSE-APACHE', 'licenses/fd/LICENSE-MIT'];

/**
 * @brief resources 目录下缺少或与 app\vendor 里不逐字节相同的文件。
 * @param resources 安装目录（或免安装目录）的 resources
 * @return 相对路径，按 VENDOR_FILES 的顺序；都对时为空
 */
export function vendorProblems(resources) {
  return VENDOR_FILES.filter((file) => !existsSync(join(resources, file))
    || !readFileSync(join(resources, file)).equals(readFileSync(join(vendor, file))));
}

/**
 * @brief 把 app\vendor\bin 拷到单独建的开发构建目录下的 vendor\bin（拷贝，不用目录联接：故障拷贝会整个删掉重建）。
 * @param buildDir 构建目录（有 out\ 与 package.json，MORI_APP_DIR 指向它）
 */
export function copyVendorBin(buildDir) {
  cpSync(join(vendor, 'bin'), join(buildDir, 'vendor', 'bin'), { recursive: true });
}
