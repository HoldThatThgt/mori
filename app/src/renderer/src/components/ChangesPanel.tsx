// 右栏：本会话编辑或写入过的文件，按时间顺序显示每次编辑的 diff，写入显示新内容（方案 5.9；阅读器在 M4）。

import { PatchDiff } from '@pierre/diffs/react';
import type { ToolCall, Transcript } from '../state/model';
import { Icon } from '../icons';
import { displayPath } from './toolTitle';

/** @brief 一个文件的全部改动。 */
interface FileChanges {
  /** 显示用路径 */
  path: string;
  /** 按时间顺序的编辑与写入 */
  changes: ToolCall[];
}

/** @brief 从对话流里收集完成的编辑与写入，按文件分组（保持第一次出现的顺序）。 */
export function collectChanges(transcript: Transcript, cwd: string): FileChanges[] {
  const files = new Map<string, FileChanges>();
  for (const item of transcript.items) {
    if (item.kind !== 'assistant') continue;
    for (const block of item.blocks) {
      const tool = block.type === 'tool' ? transcript.tools[block.id] : undefined;
      if (!tool || tool.status !== 'done' || (tool.name !== 'edit' && tool.name !== 'write')) continue;
      const path = displayPath(String(tool.args?.path ?? ''), cwd);
      const entry = files.get(path) ?? { path, changes: [] };
      entry.changes.push(tool);
      files.set(path, entry);
    }
  }
  return [...files.values()];
}

/** @brief 一次改动：编辑显示 diff，写入显示新内容。 */
function Change({ tool }: { tool: ToolCall }) {
  if (tool.name === 'edit') {
    return tool.patch ? <div className="change-diff"><PatchDiff patch={tool.patch} disableWorkerPool /></div>
      : <p className="muted">pi 没有返回这次编辑的 diff</p>;
  }
  return (
    <div className="change-write">
      <div className="tool-section-label">写入的内容</div>
      <pre className="tool-pre">{String(tool.args?.content ?? '')}</pre>
    </div>
  );
}

/** @brief 右栏。 */
export function ChangesPanel({ transcript, cwd, onClose }: {
  transcript: Transcript; cwd: string; onClose: () => void;
}) {
  const files = collectChanges(transcript, cwd);
  return (
    <>
      <div className="panel-header">
        <Icon name="file" />本会话的改动
        <button className="icon-button" onClick={onClose} aria-label="关闭右栏"><Icon name="close" /></button>
      </div>
      <div className="panel-body" data-testid="changes">
        {files.length === 0 ? <p className="muted">本会话还没有改动</p> : (
          <>
            <p className="panel-note">只含编辑和写入，命令改动的文件不在此列。</p>
            {files.map((file) => (
              <details key={file.path} className="change-file">
                <summary><code>{file.path}</code><span className="muted">{file.changes.length} 次</span></summary>
                {file.changes.map((tool) => <Change key={tool.id} tool={tool} />)}
              </details>
            ))}
          </>
        )}
      </div>
    </>
  );
}
