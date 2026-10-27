// 编辑的 diff：上下合并显示、长行折行，窄栏里也看得清。离线渲染（@pierre/diffs，不用 worker）。
// 只画恰好一个文件的 diff；原文解析不出恰好一个文件、或渲染时出错，都只在这一处显示一行
// Couldn’t load the diff: <原文>，不让错误冒到根上把整个窗口卸掉（file-system.md §5.3）。

import { Component, useMemo, type ErrorInfo, type ReactNode } from 'react';
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';

const options = { diffStyle: 'unified', overflow: 'wrap' } as const;

/**
 * @brief 从 git diff 原文里取出一个文件的 diff。原文只有一段时就是它；有几段时（路径作 pathspec 也按目录前缀匹配，
 *        同一轮里文件夹换成同名文件或反过来时 git 给出两段）只留下名字等于 path 的那一段。
 * @param patch git diff 原文
 * @param path 要的文件（仓库内的相对路径，正斜杠）；不给时原文必须恰好一段
 * @throws 取不出恰好一段时抛出英文的原因
 */
export function singleFileDiff(patch: string, path?: string): FileDiffMetadata {
  const files = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
  const picked = files.length > 1 && path !== undefined ? files.filter((file) => file.name === path) : files;
  if (picked.length !== 1) throw new Error(`Expected one file in the diff, found ${picked.length}.`);
  return picked[0];
}

/** Diff 的入参 */
interface DiffProps {
  /** git diff 原文（必须恰好一个文件），或已经用 singleFileDiff 取出的一个文件 */
  patch: string | FileDiffMetadata;
}

/** @brief 解析（原文时）并画出这一个文件；解析失败在渲染时抛出，由外面的 Diff 接住。 */
function DiffBody({ patch }: DiffProps) {
  const fileDiff = useMemo(() => (typeof patch === 'string' ? singleFileDiff(patch) : patch), [patch]);
  return <FileDiff fileDiff={fileDiff} options={options} disableWorkerPool />;
}

/**
 * @brief 一段 unified diff，自带错误边界：解析或渲染出错时只把这一块换成一行错误（并记录到控制台）。
 *        patch 换了时清掉错误重画；收起再展开会重新挂载，也就是重试。
 */
export class Diff extends Component<DiffProps, { error: string | null }> {
  state: { error: string | null } = { error: null };

  /** @brief 渲染出错时记下原文，换成一行错误。 */
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  /** @brief 异常分支记录错误日志。 */
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[renderer] diff render failed: ${message}${info.componentStack ?? ''}`);
  }

  /**
   * @brief 显示着错误时换了 diff，清掉错误重画。刚接住错误的那一次更新不清（那次 patch 也可能刚换过），
   *        否则会把刚出错的 diff 立刻再画一遍。
   */
  componentDidUpdate(previous: DiffProps, previousState: { error: string | null }): void {
    if (this.state.error === null || previousState.error === null) return;
    if (previous.patch !== this.props.patch) this.setState({ error: null });
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return <p className="diff-error" data-testid="diff-error">Couldn’t load the diff: {this.state.error}</p>;
    }
    return <DiffBody patch={this.props.patch} />;
  }
}
