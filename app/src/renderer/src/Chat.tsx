// M0 的最简对话：流式 Markdown（含代码高亮）、工具卡（编辑显示 diff）、发送与停止。

import { useEffect, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { PatchDiff } from '@pierre/diffs/react';
import { VList, type VListHandle } from 'virtua';
import type { SessionInfo } from '../../shared/protocol';
import { useTranscripts } from './store';
import { emptyTranscript, type Item, type ToolItem } from './transcript';

const plugins = { code };
const statusText = { running: '执行中', done: '完成', error: '失败' } as const;

/** @brief 一条助手回复：正文按 Markdown 渲染，思考默认折叠。 */
function AssistantView({ item }: { item: Extract<Item, { kind: 'assistant' }> }) {
  return (
    <div className="assistant">
      {item.blocks.map((block, index) =>
        block.type === 'thinking' ? (
          <details key={index} className="thinking"><summary>思考</summary>{block.text}</details>
        ) : (
          <Streamdown key={index} plugins={plugins}>{block.text}</Streamdown>
        ),
      )}
    </div>
  );
}

/** @brief 工具卡：标题、状态，展开看参数、输出和 diff。 */
function ToolCard({ item }: { item: ToolItem }) {
  return (
    <details className={`tool ${item.status}`} data-testid="tool-card">
      <summary>
        <span className="tool-name">{item.name}</span>
        <span className="tool-status">{statusText[item.status]}</span>
      </summary>
      <pre>{JSON.stringify(item.args, null, 2)}</pre>
      {item.patch ? (
        <div data-testid="tool-diff"><PatchDiff patch={item.patch} disableWorkerPool /></div>
      ) : (
        // 最多显示 4000 字符是临时默认值，见 docs/v0/defaults.md
        item.output && <pre>{item.output.slice(0, 4000)}</pre>
      )}
    </details>
  );
}

/** @brief 一条对话项。 */
function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return <div className="user">{item.text}</div>;
    case 'assistant':
      return <AssistantView item={item} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'error':
      return <div className="error">{item.text}</div>;
  }
}

/** @brief 发送与停止；请求失败时记录错误并结束运行状态，避免界面卡住。 */
function useChatActions(sessionId: string) {
  const { addUser, fail } = useTranscripts.getState();
  async function send(text: string) {
    addUser(sessionId, text);
    try {
      await window.mori.request({ type: 'session.prompt', sessionId, text });
    } catch (error) {
      console.error(`[renderer] prompt request failed: ${(error as Error).message}`);
      fail(sessionId, `发送失败：${(error as Error).message}`);
    }
  }
  async function stop() {
    try {
      await window.mori.request({ type: 'session.abort', sessionId });
    } catch (error) {
      console.error(`[renderer] abort request failed: ${(error as Error).message}`);
      fail(sessionId, `停止失败：${(error as Error).message}`);
    }
  }
  return { send, stop };
}

/** @brief 一个会话的对话流与输入框。 */
export function Chat({ session }: { session: SessionInfo }) {
  const transcript = useTranscripts((state) => state.transcripts[session.sessionId] ?? emptyTranscript);
  const [draft, setDraft] = useState('');
  const { send, stop } = useChatActions(session.sessionId);
  const list = useRef<VListHandle>(null);

  // M0 简化：有新内容就滚到底部；M1 再做"不在底部时不跟随"。
  useEffect(() => {
    if (transcript.items.length > 0) list.current?.scrollToIndex(transcript.items.length - 1, { align: 'end' });
  }, [transcript]);

  function submit() {
    const text = draft.trim();
    if (!text || transcript.running) return;
    setDraft('');
    void send(text);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <section className="chat">
      <header className="chat-head">{session.cwd} · {session.model ?? '没有可用模型'}</header>
      {session.modelNotice && <p className="error">{session.modelNotice}</p>}
      <div className="transcript" data-testid="transcript">
        <VList ref={list} style={{ height: '100%' }}>
          {transcript.items.map((item) => <div className="item" key={item.id}><ItemView item={item} /></div>)}
        </VList>
      </div>
      <div className="status" data-testid="status">{transcript.status}</div>
      <div className="composer">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown}
          placeholder="Enter 发送 · Shift+Enter 换行" />
        {transcript.running
          ? <button onClick={() => void stop()}>停止</button>
          : <button onClick={submit}>发送</button>}
      </div>
    </section>
  );
}
