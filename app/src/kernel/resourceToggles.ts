// 资源启停的写法，照搬 pi 1.3.0 的 `pi config`（MIT 许可）：
// modes/interactive/components/config-selector.ts 的 toggleTopLevelResource、togglePackageResource，
// 以及它们用到的 getResourcePattern、getPackageResourcePattern、getTopLevelBaseDir。
// pi 没有导出这个组件，这里改成普通函数：组件里的 this.settingsManager / this.cwd / this.agentDir 由参数带进来，
// 写出的条目与 pi config 逐字节相同（路径用 path.relative，Windows 上是反斜杠；包的过滤数组为空时还原成字符串）。

import { dirname, join, relative } from 'node:path';
import type { PackageSource, PathMetadata, SettingsManager } from '@earendil-works/pi-coding-agent';
import { RESOURCE_KINDS, type ResourceKind } from '../shared/protocol';

/** @brief 要启停的一项（pi config 的 ResourceItem 中写入用到的部分）。 */
export interface ResourceItem {
  /** resolve 给出的文件路径 */
  path: string;
  /** resolve 给出的来源 */
  metadata: PathMetadata;
  /** 种类 */
  resourceType: ResourceKind;
}

/** @brief 写入时的环境（pi config 组件的成员）。 */
export interface ToggleContext {
  /** 写哪份设置：用户级写 <agentDir>/settings.json，项目写 <cwd>/.pi/settings.json */
  settings: SettingsManager;
  /** 跟随的会话的工作目录（没有会话时为 agentDir） */
  cwd: string;
  /** pi 的配置目录 */
  agentDir: string;
  /** 项目配置目录名（pi 的 CONFIG_DIR_NAME，即 .pi） */
  configDirName: string;
}

/** @brief 顶层资源的路径相对的目录：项目的 .pi 或 agentDir（pi getTopLevelBaseDir）。 */
function getTopLevelBaseDir(scope: 'user' | 'project', context: ToggleContext): string {
  return scope === 'project' ? join(context.cwd, context.configDirName) : context.agentDir;
}

/** @brief 顶层资源写进设置的路径（pi getResourcePattern）。 */
function getResourcePattern(item: ResourceItem, context: ToggleContext): string {
  if (item.metadata.source === 'builtin') return item.path;
  const scope = item.metadata.scope as 'user' | 'project';
  const baseDir = item.metadata.baseDir ?? getTopLevelBaseDir(scope, context);
  return relative(baseDir, item.path);
}

/** @brief 包里的资源写进过滤数组的路径，相对包的根目录（pi getPackageResourcePattern）。 */
function getPackageResourcePattern(item: ResourceItem): string {
  const baseDir = item.metadata.baseDir ?? dirname(item.path);
  return relative(baseDir, item.path);
}

/** @brief 去掉同一路径原有的 +、-、! 条目，再加上 +路径 或 -路径（两个 pi 函数里相同的一段）。 */
function withPattern(current: string[], pattern: string, enabled: boolean): string[] {
  const updated = current.filter((p) => {
    const stripped = p.startsWith('!') || p.startsWith('+') || p.startsWith('-') ? p.slice(1) : p;
    return stripped !== pattern;
  });
  updated.push(enabled ? `+${pattern}` : `-${pattern}`);
  return updated;
}

/** @brief 写一份设置的某类顶层资源数组（pi 按种类调用的 set*Paths）。 */
function setTopLevelPaths(settings: SettingsManager, scope: 'user' | 'project', kind: ResourceKind,
  paths: string[]): void {
  if (scope === 'project') {
    if (kind === 'extensions') settings.setProjectExtensionPaths(paths);
    else if (kind === 'skills') settings.setProjectSkillPaths(paths);
    else if (kind === 'prompts') settings.setProjectPromptTemplatePaths(paths);
    else settings.setProjectThemePaths(paths);
    return;
  }
  if (kind === 'extensions') settings.setExtensionPaths(paths);
  else if (kind === 'skills') settings.setSkillPaths(paths);
  else if (kind === 'prompts') settings.setPromptTemplatePaths(paths);
  else settings.setThemePaths(paths);
}

/**
 * @brief 启停一个顶层资源（pi toggleTopLevelResource）：用户级的改 <agentDir>/settings.json，
 *        项目的改 <cwd>/.pi/settings.json 里这一类的数组。写入在 settings 的队列里，调用方 flush。
 */
export function toggleTopLevelResource(item: ResourceItem, enabled: boolean, context: ToggleContext): void {
  const scope = item.metadata.scope as 'user' | 'project';
  const settings = scope === 'project' ? context.settings.getProjectSettings() : context.settings.getGlobalSettings();
  const current = (settings[item.resourceType] ?? []) as string[];
  const updated = withPattern(current, getResourcePattern(item, context), enabled);
  setTopLevelPaths(context.settings, scope, item.resourceType, updated);
}

/**
 * @brief 启停包里的一个资源（pi togglePackageResource）：改 packages 里这个包的过滤数组，相对包的根目录；
 *        四类都没有过滤时还原成字符串。设置里找不到这个包时什么也不写（同 pi）并返回 false。
 */
export function togglePackageResource(item: ResourceItem, enabled: boolean, context: ToggleContext): boolean {
  const scope = item.metadata.scope as 'user' | 'project';
  const settings = scope === 'project' ? context.settings.getProjectSettings() : context.settings.getGlobalSettings();
  const packages = [...(settings.packages ?? [])] as PackageSource[];
  const pkgIndex = packages.findIndex((pkg) => (typeof pkg === 'string' ? pkg : pkg.source) === item.metadata.source);
  if (pkgIndex === -1) return false;
  let pkg = packages[pkgIndex];
  if (typeof pkg === 'string') {
    pkg = { source: pkg };
    packages[pkgIndex] = pkg;
  }
  const current = (pkg[item.resourceType] ?? []) as string[];
  const updated = withPattern(current, getPackageResourcePattern(item), enabled);
  pkg[item.resourceType] = updated.length > 0 ? updated : undefined;
  const filtered = pkg;
  if (!RESOURCE_KINDS.some((kind) => filtered[kind] !== undefined)) packages[pkgIndex] = filtered.source;
  if (scope === 'project') context.settings.setProjectPackages(packages);
  else context.settings.setPackages(packages);
  return true;
}
