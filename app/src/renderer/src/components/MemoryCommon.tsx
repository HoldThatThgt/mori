// 记忆页各部分共用的小件（docs/specs/memory.md §10.1、§10.5）：读取失败的一行、后台进程不可用时的悬停说明。
// 条目的 Details、修订的 Notes 与对话流同样渲染，用 Markdown.tsx。

/** @brief 读取失败（memory.list、memory.get、memory.revisions 的 error 或命令出错）：`Couldn’t load memory: <原因>`。 */
export function LoadError({ text }: { text: string }) {
  return <p className="form-message error memory-load-error" role="alert">Couldn’t load memory: {text}</p>;
}

/** @brief 操作不可用时的悬停说明：后台进程退出时为原因；没有连上（空串）或可用（null）时不显示。 */
export function unavailableTitle(unavailable: string | null): string | undefined {
  return unavailable || undefined;
}
