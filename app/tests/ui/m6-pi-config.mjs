// 录制"pi config 怎样写启停"的对照 fixture（tests/fixtures/m6/pi-config-toggles.json），M6 的整机测试拿 Mori 的写入与它比较。
// 不是模拟：直接载入 pi 1.3.0 自己的 ConfigSelectorComponent（`pi config` 的界面组件，没有从包入口导出，按文件路径载入），
// 照 `pi config`（handleConfigCommand）的做法准备两份 resolve 结果，再调用它的 toggleResource——就是你在 pi config 里按空格时
// 调用的那个方法——然后读出 settings.json。不启动终端界面。
// 布局与 M6 整机测试相同（相对路径一致，写进设置的相对路径才可比）：
//   <根>/data/pi                       Mori 的 agentDir（MORI_USER_DATA=<根>/data）
//   <根>/data/pi/skills/user-skill     用户级技能
//   <根>/data/pi/prompts/user-prompt.md 用户级提示词模板
//   <根>/project/.pi/skills/proj-skill 项目技能（项目已信任）
//   <根>/pkg                           tests/pi-package 的副本，用 addSourceToSettings 加进用户级设置
// 用法（在 app/ 下）：node tests/ui/m6-pi-config.mjs [--check]
//   不带参数：重新录制并写入 fixture；--check：录制后与已有的 fixture 比较（pi 升级时用）。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot } from './lib.mjs';

const fixturePath = join(appRoot, 'tests/fixtures/m6/pi-config-toggles.json');
const piDist = join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist');

/** @brief 写一个技能文件夹。 */
function writeSkill(dir, name, description) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nsynthetic\n`);
}

/** @brief 准备布局（见文件开头），返回各路径。 */
export function prepareLayout(root) {
  const agentDir = join(root, 'data', 'pi');
  const project = join(root, 'project');
  const pkg = join(root, 'pkg');
  writeSkill(join(agentDir, 'skills', 'user-skill'), 'user-skill', 'Synthetic user-level test skill.');
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  writeFileSync(join(agentDir, 'prompts', 'user-prompt.md'), '---\ndescription: Synthetic user prompt\n---\nHello.\n');
  writeSkill(join(project, '.pi', 'skills', 'proj-skill'), 'proj-skill', 'Synthetic project test skill.');
  cpSync(join(appRoot, 'tests', 'pi-package'), pkg, { recursive: true });
  return { agentDir, project, pkg };
}

/** 录制的步骤：作用域（global 即 pi config，project 即 pi config -l）、资源种类、资源路径（相对根） */
export const STEPS = [
  { scope: 'global', kind: 'skills', path: 'data/pi/skills/user-skill/SKILL.md', what: '停用用户级技能' },
  { scope: 'global', kind: 'skills', path: 'pkg/skills/package-review/SKILL.md', what: '停用包里的技能' },
  { scope: 'global', kind: 'prompts', path: 'data/pi/prompts/user-prompt.md', what: '停用用户级提示词模板' },
  { scope: 'global', kind: 'skills', path: 'data/pi/skills/user-skill/SKILL.md', what: '重新启用用户级技能' },
  { scope: 'project', kind: 'skills', path: 'project/.pi/skills/proj-skill/SKILL.md', what: '停用项目技能' },
  { scope: 'project', kind: 'skills', path: 'project/.pi/skills/proj-skill/SKILL.md', what: '重新启用项目技能' },
];

/** @brief 读一个设置文件；不存在时为 null。 */
function readSettings(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** @brief 照 pi config 的做法 resolve 两次，建一个 ConfigSelectorComponent。 */
async function selector(pi, ConfigSelectorComponent, { agentDir, project }, scope) {
  const globalSettings = pi.SettingsManager.create(project, agentDir, { projectTrusted: false });
  const global = await new pi.DefaultPackageManager({ cwd: project, agentDir, settingsManager: globalSettings })
    .resolve(async () => 'skip');
  const settingsManager = pi.SettingsManager.create(project, agentDir, { projectTrusted: true });
  const projectPaths = await new pi.DefaultPackageManager({ cwd: project, agentDir, settingsManager })
    .resolve(async () => 'skip');
  const noop = () => {};
  const component = new ConfigSelectorComponent({ global, project: projectPaths }, settingsManager, project, agentDir,
    noop, noop, noop, 24, scope, true);
  return { list: component.getResourceList(), settingsManager };
}

/** @brief 按 pi config 的顺序做完 STEPS，每一步后记下用户级和项目的 settings.json。 */
async function record() {
  const root = mkdtempSync(join(tmpdir(), 'mori-m6-piconfig-'));
  process.env.PI_CODING_AGENT_DIR = join(root, 'data', 'pi');
  process.env.PI_OFFLINE = '1';
  const layout = prepareLayout(root);
  const pi = await import(pathToFileURL(join(piDist, 'index.js')).href);
  const { ConfigSelectorComponent } = await import(
    pathToFileURL(join(piDist, 'modes/interactive/components/config-selector.js')).href);
  const setup = pi.SettingsManager.create(layout.project, layout.agentDir, { projectTrusted: false });
  new pi.DefaultPackageManager({ cwd: layout.project, agentDir: layout.agentDir, settingsManager: setup })
    .addSourceToSettings(layout.pkg);
  await setup.flush();
  const snapshots = [{ what: '加入本地包之后', user: readSettings(join(layout.agentDir, 'settings.json')), project: null }];
  for (const step of STEPS) {
    const { list, settingsManager } = await selector(pi, ConfigSelectorComponent, layout, step.scope);
    const target = join(root, step.path);
    const entry = list.flatItems.find((item) => item.type === 'item' && item.item.path === target);
    if (!entry) throw new Error(`pi config did not list ${target}`);
    list.toggleResource(entry.item);
    await settingsManager.flush();
    snapshots.push({ what: step.what, user: readSettings(join(layout.agentDir, 'settings.json')),
      project: readSettings(join(layout.project, '.pi', 'settings.json')) });
  }
  return { pi: pi.VERSION, steps: STEPS, snapshots };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await record();
  if (process.argv.includes('--check')) {
    const old = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const same = JSON.stringify(old.snapshots) === JSON.stringify(result.snapshots);
    console.log(same ? 'PASS pi config writes match the fixture' : 'FAIL pi config writes differ from the fixture');
    process.exitCode = same ? 0 : 1;
  } else {
    mkdirSync(join(appRoot, 'tests/fixtures/m6'), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`recorded ${result.snapshots.length} snapshots from pi ${result.pi} into ${fixturePath}`);
  }
}
