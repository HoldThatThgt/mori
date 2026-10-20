// 工具页的"插件"一节（docs/v0/screens/tools.md）：pi 设置里的包（用户级和信任后的本项目），每个包一张卡，
// 包里的资源按扩展、技能、提示词、主题分组，每个资源一个开关；添加本地包、停用 / 启用整个包、移除（不删文件夹）。
// 不是本地文件夹的包（npm / git）只读，卡上说明内网不会安装它，只能移除。

import { useState } from 'react';
import { RESOURCE_KINDS, type PackageEntry, type ResourceEntry, type ResourceKind } from '../../../shared/protocol';
import { toggleCommand, useChange } from '../state/tools';
import { ConfirmDialog } from './ConfirmDialog';
import { ResourceNotes, ToolSwitch, useSwitch } from './ToolsCommon';

/** 资源种类的界面文字 */
const KIND_TEXT: Record<ResourceKind, string> = { extensions: '扩展', skills: '技能', prompts: '提示词', themes: '主题' };

/** 包里没有找到资源时的说明 */
const NO_RESOURCES = '这个文件夹里没有找到扩展、技能、提示词或主题（pi 包的 package.json 的 pi 字段，'
  + '或 extensions / skills / prompts / themes 文件夹）';

/**
 * @brief 包里的一个资源：名字、用途、开关；主题标"Mori 不使用"。
 * @param shared 卡片上已经说明的不能改的原因（本项目的包）；与它相同时这一行不再重复
 */
function PackageResource({ resource, shared }: { resource: ResourceEntry; shared: string | null }) {
  const change = useChange();
  const power = useSwitch(change, resource.enabled, (next) => toggleCommand(resource.kind, resource.path, next));
  return (
    <li className={`tools-row${power.checked ? '' : ' off'}`} data-testid="package-resource"
      data-kind={resource.kind} data-path={resource.path}>
      <div className="tools-row-head">
        <div className="tools-row-main" title={resource.path}>
          <span className="tools-row-name">{resource.name}</span>
          {resource.kind === 'themes' && <span className="tools-tag">Mori 不使用</span>}
          {resource.description && (
            <span className="tools-row-desc" title={resource.description}>{resource.description}</span>)}
        </div>
        <ToolSwitch checked={power.checked} label={`启用${KIND_TEXT[resource.kind]} ${resource.name}`}
          disabled={change.busy || !!resource.readOnly} title={resource.readOnly ?? undefined}
          onChange={power.toggle} />
      </div>
      <ResourceNotes readOnly={resource.readOnly === shared ? null : resource.readOnly} error={change.error} />
    </li>
  );
}

/** @brief 包里的资源，按扩展、技能、提示词、主题分组；shared 是卡片上已经说明的不能改的原因。 */
function ResourceGroups({ resources, shared }: { resources: ResourceEntry[]; shared: string | null }) {
  return (
    <>
      {RESOURCE_KINDS.map((kind) => {
        const items = resources.filter((resource) => resource.kind === kind);
        if (items.length === 0) return null;
        return (
          <section key={kind} className="tools-group" aria-label={KIND_TEXT[kind]}>
            <h3>{KIND_TEXT[kind]}</h3>
            <ul className="tools-list">
              {items.map((resource) => <PackageResource key={resource.path} resource={resource} shared={shared} />)}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** @brief 移除确认框：只从用户级设置里去掉这个包，文件夹不删。 */
function RemovePackage({ source, onClose }: { source: string; onClose: () => void }) {
  const change = useChange();
  async function confirm() {
    if (await change.run({ type: 'package.remove', source })) onClose();
  }
  return (
    <ConfirmDialog title={`移除插件 ${source}？`} text="只从设置里去掉它，文件夹不删。已经打开的会话不受影响。"
      confirmLabel="移除" tone="danger" testId="remove-dialog" busyText={change.busy ? '正在移除…' : null}
      error={change.error} onConfirm={() => void confirm()} onCancel={onClose} />
  );
}

/**
 * @brief 一个包：来源、解析后的文件夹、用户级 / 本项目；资源分组；停用或启用整个包、移除。
 *        卡只读（readOnly）时不能整包启停；用户级的包（含内网不会安装的 npm / git 包）总能移除，本项目的不能。
 */
function PackageCard({ pkg }: { pkg: PackageEntry }) {
  const change = useChange();
  const [removing, setRemoving] = useState(false);
  const allOff = pkg.resources.length > 0 && pkg.resources.every((resource) => !resource.enabled);
  return (
    <article className="tools-card" data-testid="package-card" data-source={pkg.source}>
      <header className="tools-card-head">
        <span className="tools-row-name">{pkg.source}</span>
        <span className="tools-tag">{pkg.scope === 'user' ? '用户级' : '本项目'}</span>
        <div className="tools-row-actions">
          {pkg.resources.length > 0 && (
            <button type="button" className="text-link" disabled={change.busy || pkg.readOnly !== null}
              onClick={() => void change.run({ type: 'package.setAll', source: pkg.source, enabled: allOff })}>
              {allOff ? '启用整个包' : '停用整个包'}</button>
          )}
          <button type="button" className="text-link danger" disabled={change.busy || pkg.scope === 'project'}
            onClick={() => setRemoving(true)}>移除</button>
        </div>
      </header>
      <p className="tools-mono">{pkg.root ?? '找不到这个文件夹'}</p>
      <ResourceNotes readOnly={pkg.readOnly} error={change.error} />
      {pkg.resources.length === 0 && pkg.root && <p className="tools-empty">{NO_RESOURCES}</p>}
      <ResourceGroups resources={pkg.resources} shared={pkg.readOnly} />
      {removing && <RemovePackage source={pkg.source} onClose={() => setRemoving(false)} />}
    </article>
  );
}

/** @brief "添加本地包…"：先在系统对话框里选文件夹，取消时什么都不做。 */
function AddPackage() {
  const change = useChange();
  async function add() {
    const path = await window.mori.pickFolder();
    if (path) await change.run({ type: 'package.add', path });
  }
  return (
    <div className="tools-add">
      <button type="button" className="button" disabled={change.busy} onClick={() => void add()}>
        {change.busy ? '正在添加…' : '添加本地包…'}</button>
      <span className="tools-row-note">内网只支持本地文件夹的包，包要自带依赖</span>
      {change.error && <p className="form-message error" role="alert">没能添加：{change.error}</p>}
    </div>
  );
}

/** @brief "插件"一节。 */
export function PluginsSection({ packages }: { packages: PackageEntry[] }) {
  return (
    <>
      <h2>插件</h2>
      <AddPackage />
      {packages.length === 0 && <p className="tools-empty">还没有插件</p>}
      {packages.map((pkg) => <PackageCard key={`${pkg.scope}:${pkg.source}`} pkg={pkg} />)}
    </>
  );
}
