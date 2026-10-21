// 工具页各节共用的小部件：开关、"Open in default app"、资源的启停行（技能和插件里的资源，docs/v0/screens/tools.md）。

import { useState } from 'react';
import type { Command } from '../../../shared/protocol';
import { describe } from '../state/bridge';
import type { Change } from '../state/tools';

/** @brief 开关（role="switch"）；不可用时 title 说明原因。 */
export function ToolSwitch({ checked, label, disabled, title, onChange }: {
  checked: boolean; label: string; disabled: boolean; title?: string; onChange: (next: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={title}
      className="tools-switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="tools-switch-knob" aria-hidden="true" />
    </button>
  );
}

/** @brief "Open in default app"：失败时在按钮后面显示原文。cwd 只用于解析相对路径。 */
export function OpenInEditor({ path, cwd }: { path: string; cwd: string }) {
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setError(null);
    try {
      setError((await window.mori.openPath(path, cwd)).error);
    } catch (failure) {
      setError(describe('openPath', failure));
    }
  }
  return (
    <>
      <button type="button" className="text-link" onClick={() => void open()}>Open in default app</button>
      {error && (
        <span className="form-message error" role="alert">Couldn’t open this file with the default app: {error}</span>)}
    </>
  );
}

/** @brief 一个开关的状态。 */
export interface SwitchState {
  /** 开关显示的状态 */
  checked: boolean;
  /** 按下开关 */
  toggle: (next: boolean) => void;
}

/**
 * @brief 开关按下后立刻显示新的状态；命令和之后的重新读取结束时改以读到的为准（失败时回到原来的样子）。
 * @param change 这一行的改动状态（失败的原文显示在这一行下面）
 * @param enabled 读到的状态
 * @param command 新状态对应的命令
 */
export function useSwitch(change: Change, enabled: boolean, command: (next: boolean) => Command): SwitchState {
  const [target, setTarget] = useState<boolean | null>(null);
  async function flip(next: boolean) {
    setTarget(next);
    await change.run(command(next));
    setTarget(null);
  }
  return { checked: target ?? enabled, toggle: (next) => void flip(next) };
}

/** @brief 资源行下面的说明：不能在这里改的原因、"Couldn’t save: "加原文。 */
export function ResourceNotes({ readOnly, error }: { readOnly: string | null; error: string | null }) {
  return (
    <>
      {readOnly && <p className="tools-row-note">{readOnly}</p>}
      {error && <p className="form-message error" role="alert">Couldn’t save: {error}</p>}
    </>
  );
}
