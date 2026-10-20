// 右栏：本会话编辑或写入过的文件，按时间顺序显示每次编辑的 diff，写入显示新内容；文件阅读器（方案 5.9，
// docs/v0/screens/changes.md）。照 Claude 桌面版：按文件折叠的 diff 列表，文件行上有打开文件的按钮。

import type { ToolCall, Transcript } from '../state/model';
import { openFile } from '../state/quotes';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { Diff } from './Diff';
import { FileViewer } from './FileViewer';
import { displayPath, pathKey } from './toolTitle';

/** @brief 一个文件的全部改动。 */
interface FileChanges {
  /** 显示用路径 */
  path: string;
  /** 工具参数里的路径原文（打开阅读器用，由主进程相对工作目录解析） */
  rawPath: string;
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
      const rawPath = String(tool.args?.path ?? '');
      const key = pathKey(rawPath, cwd);
      const entry = files.get(key) ?? { path: displayPath(rawPath, cwd), rawPath, changes: [] };
      entry.changes.push(tool);
      files.set(key, entry);
    }
  }
  return [...files.values()];
}

/** @brief 本会话对这个文件完成的编辑和写入次数（阅读器据此在文件被改后重新读）。 */
function changeCount(transcript: Transcript, cwd: string, path: string): number {
  const key = pathKey(path, cwd);
  return collectChanges(transcript, cwd).find((file) => pathKey(file.rawPath, cwd) === key)?.changes.length ?? 0;
}

/** @brief 一次改动：编辑显示 diff，写入显示新内容。 */
function Change({ tool, index }: { tool: ToolCall; index: number }) {
  const label = `第 ${index + 1} 次 · ${tool.name === 'edit' ? '修改' : '写入'}`;
  return (
    <div className="change-entry" data-testid="change-entry">
      <div className="tool-section-label">{label}</div>
      {tool.name === 'write' && <>
        <div className="tool-section-label">写入的内容</div>
        <pre className="tool-pre">{String(tool.args?.content ?? '')}</pre>
      </>}
      {tool.name === 'edit' && (tool.patch ? <div className="change-diff"><Diff patch={tool.patch} /></div>
        : <p className="muted">这次编辑没有返回 diff</p>)}
    </div>
  );
}

/** @brief 改动列表。 */
function ChangesList({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const files = collectChanges(tab.transcript, tab.cwd);
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
              <details key={file.path} className="change-file" data-testid="change-file">
                <summary>
                  <code className="change-path">{file.path}</code>
                  <span className="muted">{file.changes.length} 次</span>
                  <button className="text-link change-open" aria-label={`打开 ${file.path}`}
                    onClick={(event) => { event.preventDefault(); openFile(tab.key, file.rawPath); }}>打开</button>
                </summary>
                {file.changes.map((tool, index) => <Change key={tool.id} tool={tool} index={index} />)}
              </details>
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** @brief 右栏：改动列表或文件阅读器（按会话记住显示哪一个）。 */
export function RightPanel({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const view = tab.rightView;
  if (view.kind === 'changes') return <ChangesList tab={tab} onClose={onClose} />;
  return <FileViewer key={tab.key} tab={tab} view={view} version={changeCount(tab.transcript, tab.cwd, view.path)}
    onClose={onClose} />;
}
