// 界面状态：按会话保存对话流。所有事件都经 apply 归并，实时事件与以后的回放走同一条路。

import { create } from 'zustand';
import type { EventEnvelope } from '../../shared/protocol';
import { applyEvent, emptyTranscript, pushError, pushUser, type Transcript } from './transcript';

/** @brief 全部会话的对话流。 */
interface TranscriptStore {
  /** 按会话 id 保存的对话流 */
  transcripts: Record<string, Transcript>;
  /** 归并一个后台进程事件 */
  apply: (envelope: EventEnvelope) => void;
  /** 追加你发出的消息 */
  addUser: (sessionId: string, text: string) => void;
  /** 追加一条错误，并结束运行状态 */
  fail: (sessionId: string, text: string) => void;
}

/** @brief 用 fn 更新某个会话的对话流。 */
function update(state: TranscriptStore, sessionId: string, fn: (t: Transcript) => Transcript) {
  return { transcripts: { ...state.transcripts, [sessionId]: fn(state.transcripts[sessionId] ?? emptyTranscript) } };
}

export const useTranscripts = create<TranscriptStore>((set) => ({
  transcripts: {},
  apply: (envelope) => set((state) => update(state, envelope.sessionId, (t) => applyEvent(t, envelope.event))),
  addUser: (sessionId, text) => set((state) => update(state, sessionId, (t) => pushUser(t, text))),
  fail: (sessionId, text) => set((state) => update(state, sessionId, (t) => pushError(t, text, true))),
}));

window.mori.onEvent((envelope) => useTranscripts.getState().apply(envelope));
