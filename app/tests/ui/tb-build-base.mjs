// TB-03“关闭模式与 v0 一致”的对照构建：建出没有 TaskBoard 的那一版（BASE_REF），套件用同一份合成配置各跑一次，
// 比较发给模型的工具列表与 system prompt 的字节、工具页的行。
// 做法：在临时目录 git worktree add --detach BASE_REF，把它的 app/node_modules 联接到本工作树的依赖（两版依赖相同），
// electron-vite build 到本工作树的 app/.tb-runs/base/（out/ 与 package.json，同 tb-build.mjs），最后移除临时工作树。
// 用法（在 app/ 下）：node tests/ui/tb-build-base.mjs [--ref <提交>]

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRoot, arg } from './lib.mjs';

/** 对照的提交：app-v0 合并 v1 模型层之后的提交（英文界面与模型层都在、TaskBoard 之前） */
const BASE_REF = '6a57fd4';

/** @brief 运行一个命令；失败时打印并退出。 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    process.exit(1);
  }
}

const ref = arg('ref') ?? BASE_REF;
const repo = join(appRoot, '..');
const temp = mkdtempSync(join(tmpdir(), 'mori-tb-base-'));
const tree = join(temp, 'tree');
const outDir = join(appRoot, '.tb-runs', 'base');
run('git', ['worktree', 'add', '--detach', `"${tree}"`, ref], repo);
try {
  symlinkSync(realpathSync(join(appRoot, 'node_modules')), join(tree, 'app', 'node_modules'), 'junction');
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  run('npx', ['electron-vite', 'build', '--outDir', `"${join(outDir, 'out')}"`], join(tree, 'app'));
  const pkg = JSON.parse(readFileSync(join(tree, 'app', 'package.json'), 'utf8'));
  writeFileSync(join(outDir, 'package.json'),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, type: pkg.type }, null, 2)}\n`);
  console.log(`Built ${ref} into ${outDir}`);
} finally {
  // 先拆掉联接（只删联接本身），确认它不在了再移除工作树：否则移除工作树会删到依赖目录里的文件。
  const link = join(tree, 'app', 'node_modules');
  if (existsSync(link)) unlinkSync(link);
  if (existsSync(link)) {
    console.error(`Could not remove the junction ${link}; remove it by hand, then the worktree ${tree}`);
    process.exit(1);
  }
  run('git', ['worktree', 'remove', '--force', `"${tree}"`], repo);
  rmSync(temp, { recursive: true, force: true });
}
