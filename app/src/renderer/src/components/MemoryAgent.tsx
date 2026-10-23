// 记忆页的 AGENT 节（docs/specs/memory.md §10.3）：这个项目加载的 AGENTS.md，用户级在前，然后按 pi 的顺序，
// 每个文件一行：路径与 token 数；用户级的一行有 Edit in Settings（打开设置页的 AGENTS.md 节），项目的文件有
// Open in default app。下面一行合计 `<total> / 500 tokens`，超出时警告色并加说明（不截断仓库里的文件）。
// User 层时只列用户级。数据是 agents.get（Project 时带跟随的会话）；读取失败时同设置页 AGENTS.md 节的那一句。

import { useShallow } from 'zustand/react/shallow';
import { MEMORY_LIMIT } from '../../../shared/memory';
import type { AgentsInfo } from '../../../shared/protocol';
import { guardLeave } from '../state/leaveGuard';
import { shownScope, useMemory, useUnavailable } from '../state/memory';
import { showSettingsSection } from '../state/settings';
import { AGENTS_OVER_TEXT, OpenInEditor, tokenCount } from './AgentsSection';
import { unavailableTitle } from './MemoryCommon';

/**
 * @brief 用户级的一行：agentDir 里生效的那个文件与它的 token 数，没有时 `No user-level AGENTS.md`；
 *        都有 Edit in Settings（有未保存的编辑时先问）。
 */
function UserFile({ info }: { info: AgentsInfo }) {
  const unavailable = useUnavailable();
  return (
    <li className="memory-agent-file" data-testid="memory-agent-file">
      {info.effectivePath ? (
        <>
          <span className="memory-agent-path">{info.effectivePath}</span>
          <span className="memory-agent-tokens">{tokenCount(info.userTokens)}</span>
        </>
      ) : <span className="memory-agent-none">No user-level AGENTS.md</span>}
      <button type="button" className="text-link" disabled={unavailable !== null} title={unavailableTitle(unavailable)}
        onClick={() => guardLeave(() => showSettingsSection('agents'))}>Edit in Settings</button>
    </li>
  );
}

/** @brief AGENT 节：读取失败、读取中、文件列表与合计。 */
export function MemoryAgent() {
  const { info, loadError, project, cwd } = useMemory(useShallow((state) => ({ info: state.agents,
    loadError: state.loadError, project: shownScope(state) === 'project', cwd: state.cwd })));
  const unavailable = useUnavailable();
  if (loadError) {
    return <p className="form-message error memory-load-error" role="alert">Couldn’t load AGENTS.md: {loadError}</p>;
  }
  if (!info) return <p className="memory-state" role="status">Loading…</p>;
  const files = project ? info.loaded ?? [] : [];
  const total = project ? info.total : info.userTokens;
  const over = total > MEMORY_LIMIT;
  return (
    <div className="memory-agent">
      <ul className="memory-agent-files">
        <UserFile info={info} />
        {files.map((file) => (
          <li key={file.path} className="memory-agent-file" data-testid="memory-agent-file">
            <span className="memory-agent-path">{file.path}</span>
            <span className="memory-agent-tokens">{tokenCount(file.tokens)}</span>
            <OpenInEditor path={file.path} cwd={cwd ?? file.path} disabled={unavailable !== null}
              title={unavailableTitle(unavailable)} />
          </li>
        ))}
      </ul>
      <p className={`memory-agent-total${over ? ' memory-over' : ''}`} data-testid="memory-agent-total">
        {`${total} / ${MEMORY_LIMIT} tokens`}
        {over && <span className="memory-agent-over">{` · ${AGENTS_OVER_TEXT}`}</span>}
      </p>
    </div>
  );
}
