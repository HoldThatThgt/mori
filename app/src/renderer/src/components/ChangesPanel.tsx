// 右栏：本会话编辑或写入过的文件，按时间顺序显示每次编辑的 diff，写入显示新内容；文件阅读器（方案 5.9，
// docs/v0/screens/changes.md）。照 Claude 桌面版：按文件折叠的 diff 列表，文件行上有打开文件的按钮。
// 只列对话流里的编辑与写入；后台实例改过文件时列表上方写明它们不在这里（docs/v1/screens/team-blocked.md "右栏"）。

import type { ToolCall, Transcript } from '../state/model';
import { openFile } from '../state/quotes';
import type { Tab } from '../state/store';
import { Icon } from '../icons';
import { Diff } from './Diff';
import { FileViewer } from './FileViewer';
import { PanelExpand } from './PanelExpand';
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
  const label = `Change ${index + 1} · ${tool.name === 'edit' ? 'Edit' : 'Write'}`;
  return (
    <div className="change-entry" data-testid="change-entry">
      <div className="tool-section-label">{label}</div>
      {tool.name === 'write' && <>
        <div className="tool-section-label">File content</div>
        <pre className="tool-pre">{String(tool.args?.content ?? '')}</pre>
      </>}
      {tool.name === 'edit' && (tool.patch ? <div className="change-diff"><Diff patch={tool.patch} /></div>
        : <p className="muted">This edit didn’t return a diff.</p>)}
    </div>
  );
}

/** @brief 改动列表。 */
function ChangesList({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const files = collectChanges(tab.transcript, tab.cwd);
  // 后台实例改的文件不在列表里（平行 Agent 规格 §13.12）：有实例改过文件时写明，列表为空时只有这一句。
  const teamEdited = tab.board.teamEdited;
  return (
    <>
      <div className="panel-header">
        <Icon name="file" /><span className="panel-title">This session’s changes</span>
        <PanelExpand tab={tab} />
        <button className="icon-button" onClick={onClose} aria-label="Close panel"><Icon name="close" /></button>
      </div>
      <div className="panel-body" data-testid="changes">
        {teamEdited && <p className="panel-note" data-testid="team-changes-note">
          Changes made by team tasks aren’t listed here.</p>}
        {files.length === 0 ? !teamEdited && <p className="muted">No changes yet.</p> : (
          <>
            <p className="panel-note">Only edits and writes are listed. Files changed by commands aren’t included.</p>
            {files.map((file) => (
              <details key={file.path} className="change-file" data-testid="change-file">
                <summary>
                  <code className="change-path">{file.path}</code>
                  <span className="muted">
                    {file.changes.length === 1 ? '1 change' : `${file.changes.length} changes`}</span>
                  <button className="text-link change-open" aria-label={`Open ${file.path}`}
                    onClick={(event) => { event.preventDefault(); openFile(tab.key, file.rawPath); }}>Open</button>
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
