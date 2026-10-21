// 项目信任接线（方案 5.3、第 6 节"项目信任"）：判断与存储都用 pi 的（hasTrustRequiringProjectResources、
// ProjectTrustStore 即 <agentDir>/trust.json），何时问你由界面负责：界面先用 trust.check 问要不要问，
// 你的回答随 session.create / session.open 带来。pi 的 reload 传了 resolveProjectTrust 就每次调用、不自己判断要不要问，
// 所以回调里照 pi 命令行（dist/main.js 579–630、core/project-trust.js）的顺序再判断一次：
// 文件夹没有要信任的内容 → 信任；trust.json 有本文件夹或上层文件夹的记录 → 用记录；否则用你的回答，勾了"Remember my choice"写回；
// 没有回答（问过之后文件夹里才出现要信任的内容）→ 不信任。pi 命令行还会看扩展的 project_trust 事件和
// defaultProjectTrust 设置，Mori 不做（见 docs/v0/defaults.md）。

import type { ProjectTrust, TrustAnswer, TrustCheck } from '../shared/protocol';
import { loadPi } from './pi';

/** @brief 一次信任判断的结果。 */
export interface TrustDecision {
  /** 交给 pi 的 resolveProjectTrust：是否加载项目自带的扩展与配置 */
  trusted: boolean;
  /** 界面上显示的信任状态 */
  projectTrust: ProjectTrust;
  /** 判断已经记在 trust.json 里（原有的记录，或这次勾了"Remember my choice"并写进去了） */
  remembered: boolean;
  /** 没能写进 trust.json 时的原文 */
  saveError: string | null;
}

/** @brief trust.json 里本文件夹或上层文件夹的记录，以及读不出来时的原文（这时按"没有记录"处理，会问你）。 */
async function savedDecision(cwd: string): Promise<{ saved: boolean | null; readError: string | null }> {
  const pi = await loadPi();
  try {
    return { saved: new pi.ProjectTrustStore(pi.getAgentDir()).get(cwd), readError: null };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[kernel] cannot read trust.json for ${cwd}: ${message}`);
    return { saved: null, readError: message };
  }
}

/** @brief 打开这个文件夹里的会话之前，要不要先问你是否信任它。 */
export async function checkTrust(cwd: string): Promise<TrustCheck> {
  const pi = await loadPi();
  if (!pi.hasTrustRequiringProjectResources(cwd)) return { ask: false, readError: null };
  const { saved, readError } = await savedDecision(cwd);
  return { ask: saved === null, readError };
}

/** @brief 把"Remember my choice"写进 trust.json；失败时返回原文，这次的选择照样生效。 */
async function remember(cwd: string, trusted: boolean): Promise<string | null> {
  const pi = await loadPi();
  try {
    new pi.ProjectTrustStore(pi.getAgentDir()).set(cwd, trusted);
    return null;
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[kernel] cannot save the trust decision for ${cwd}: ${message}`);
    return message;
  }
}

/**
 * @brief 在 pi 加载项目资源之前（resolveProjectTrust 回调里）作出判断。
 * @param answer 你在询问框里的回答；界面没问（trust.check 说不用问）时为 undefined
 */
export async function decideTrust(cwd: string, answer: TrustAnswer | undefined): Promise<TrustDecision> {
  const pi = await loadPi();
  const none = { remembered: false, saveError: null };
  if (!pi.hasTrustRequiringProjectResources(cwd)) return { ...none, trusted: true, projectTrust: 'none' };
  const { saved } = await savedDecision(cwd);
  if (saved !== null) {
    return { trusted: saved, projectTrust: saved ? 'trusted' : 'untrusted', remembered: true, saveError: null };
  }
  if (!answer) {
    console.error(`[kernel] ${cwd} needs a trust answer that was not given; project resources are not loaded`);
    return { ...none, trusted: false, projectTrust: 'unasked' };
  }
  const saveError = answer.remember ? await remember(cwd, answer.trusted) : null;
  return { trusted: answer.trusted, projectTrust: answer.trusted ? 'trusted' : 'untrusted',
    remembered: answer.remember && saveError === null, saveError };
}
