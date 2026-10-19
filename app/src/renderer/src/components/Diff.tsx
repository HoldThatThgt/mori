// 编辑的 diff：上下合并显示、长行折行，窄栏里也看得清。离线渲染（@pierre/diffs，不用 worker）。

import { PatchDiff } from '@pierre/diffs/react';

const options = { diffStyle: 'unified', overflow: 'wrap' } as const;

/** @brief 一段 unified diff。 */
export function Diff({ patch }: { patch: string }) {
  return <PatchDiff patch={patch} options={options} disableWorkerPool />;
}
