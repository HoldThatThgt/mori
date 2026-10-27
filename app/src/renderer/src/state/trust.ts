// 项目信任询问（docs/v0/screens/sessions.md "项目信任"）：新建或打开会话之前问后台进程要不要问你，
// 要问时显示询问框并等你回答。本次运行里回答过的文件夹不再问（勾了"Remember my choice"的由 pi 的 trust.json 记住，跨重启）。
// 同一个文件夹同时要问两次时只问一次；不同文件夹的询问排队，一次显示一个。
// 本次的回答与正在问的按主文件夹记（docs/specs/file-system.md §11.7 projectFolder）：在主文件夹回答过，同一次运行里
// 它的 worktree 不再问；trust.check 与询问框仍用会话的工作路径。

import type { TrustAnswer, TrustCheck } from '../../../shared/protocol';
import { projectFolder } from '../../../shared/workspace';
import { recordAction } from './actionLog';
import { request } from './bridge';
import { useApp } from './store';

/**
 * 本次运行里你对每个项目（主文件夹）的回答；只记"Trust workspace" / "Don’t trust"，"没有要信任的内容"不记（之后可能出现）
 */
const answers = new Map<string, boolean>();
/** 正在问的项目（主文件夹）：询问框写的工作路径与等着的回答 */
const pending = new Map<string, { cwd: string; answer: Promise<TrustAnswer> }>();
/** 询问 id → 交回回答 */
const resolvers = new Map<number, (answer: TrustAnswer) => void>();
let promptCounter = 0;

/**
 * @brief 显示询问框（排在已有询问之后），等你回答；同一个项目正在问时等那一次的回答。询问框写的是别的工作路径时
 *        （worktree 与它的主文件夹同时在问）只沿用信任与否，不记住：Remember my choice 只记询问框写的那个文件夹（§11.7）。
 */
function ask(cwd: string, readError: string | null): Promise<TrustAnswer> {
  const project = projectFolder(cwd);
  const existing = pending.get(project);
  if (existing) {
    return existing.cwd === cwd ? existing.answer
      : existing.answer.then((answer) => ({ trusted: answer.trusted, remember: false }));
  }
  promptCounter += 1;
  const id = promptCounter;
  const answer = new Promise<TrustAnswer>((resolve) => resolvers.set(id, resolve));
  pending.set(project, { cwd, answer });
  useApp.setState((state) => ({ trustPrompts: [...state.trustPrompts, { id, cwd, readError }] }));
  return answer.finally(() => pending.delete(project));
}

/** @brief 你在询问框里的回答；操作记录写"Trust prompt: Trust workspace (remembered) <文件夹>"或"Trust prompt: Don’t trust <文件夹>"。 */
export function answerTrust(id: number, answer: TrustAnswer): void {
  const prompt = useApp.getState().trustPrompts.find((item) => item.id === id);
  if (!prompt) return;
  const choice = answer.trusted ? 'Trust workspace' : 'Don’t trust';
  recordAction(`Trust prompt: ${choice}${answer.remember ? ' (remembered)' : ''} ${prompt.cwd}`);
  useApp.setState((state) => ({ trustPrompts: state.trustPrompts.filter((item) => item.id !== id) }));
  resolvers.get(id)?.(answer);
  resolvers.delete(id);
}

/**
 * @brief 新建或打开 cwd 里的会话之前调用：返回要交给后台进程的回答；不用问时为 undefined。
 *        本次运行里对这个项目（projectFolder(cwd)）回答过的直接沿用（不再问，也不再记住一次）。
 */
export async function trustFor(cwd: string): Promise<TrustAnswer | undefined> {
  const project = projectFolder(cwd);
  const known = answers.get(project);
  if (known !== undefined) return { trusted: known, remember: false };
  const check = await request<TrustCheck>({ type: 'trust.check', cwd });
  if (!check.ask) return undefined;
  const answer = await ask(cwd, check.readError);
  answers.set(project, answer.trusted);
  return answer;
}
