// 记忆页各部分共用的小件（docs/specs/memory.md §10.1、§10.5）：读取失败的一行、后台进程不可用时的悬停说明、
// 与对话流同样渲染的 Markdown（条目的 Details、修订的 Notes）。

import { memo } from 'react';
import { Streamdown, type Components } from 'streamdown';
import { code } from '@streamdown/code';

const plugins = { code };
const controls = { code: { copy: true, download: false }, table: false, mermaid: false, image: false };
const translations = { copyCode: 'Copy code', copied: 'Copied' };
// 链接不在 App 里打开（窗口禁止跳转），也不弹外链确认框（同对话流）。
const linkSafety = { enabled: false };

/** @brief 一段 Markdown（同对话流的渲染）；components 覆盖某些元素的渲染（Details 里的 [[slug]] 链接）。 */
export const MemoryMarkdown = memo(function MemoryMarkdown({ text, components }: {
  text: string; components?: Components;
}) {
  return (
    <Streamdown className="prose" plugins={plugins} controls={controls} translations={translations}
      linkSafety={linkSafety} components={components}>
      {text}
    </Streamdown>
  );
});

/** @brief 读取失败（memory.list、memory.get、memory.revisions 的 error 或命令出错）：`Couldn’t load memory: <原因>`。 */
export function LoadError({ text }: { text: string }) {
  return <p className="form-message error memory-load-error" role="alert">Couldn’t load memory: {text}</p>;
}

/** @brief 操作不可用时的悬停说明：后台进程退出时为原因；没有连上（空串）或可用（null）时不显示。 */
export function unavailableTitle(unavailable: string | null): string | undefined {
  return unavailable || undefined;
}
