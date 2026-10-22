// 把开发构建建到单独的目录 .tb-runs/<名字>/（out/ 与一份只有 name、version、main、type 的 package.json），
// 供 MORI_APP_DIR 指向它的套件启动（lib.mjs launch）。几组 TaskBoard 套件同时开发时各用自己的构建，不覆盖 out/；
// 依赖照常从 app/node_modules 解析（.tb-runs 在 app/ 下）。npm run test:taskboard 不用它，照常建 out/。
// 用法（在 app/ 下）：node tests/ui/tb-build.mjs <名字>

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from './lib.mjs';

const name = process.argv[2];
if (!name || !/^[\w-]+$/.test(name)) {
  console.error('Usage: node tests/ui/tb-build.mjs <name>');
  process.exit(2);
}
const dir = join(appRoot, '.tb-runs', name);
mkdirSync(dir, { recursive: true });
const result = spawnSync('npx', ['electron-vite', 'build', '--outDir', join(dir, 'out')],
  { cwd: appRoot, stdio: 'inherit', shell: true });
if (result.status !== 0) {
  console.error(`electron-vite build failed with exit code ${result.status}`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
writeFileSync(join(dir, 'package.json'),
  `${JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, type: pkg.type }, null, 2)}\n`);
console.log(`Built into ${dir}; run suites with MORI_APP_DIR=${dir}`);
