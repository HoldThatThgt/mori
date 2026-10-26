// 一条助手回复：正文按 Markdown 渲染（Markdown.tsx：代码块离线高亮、mermaid 画成图），思考流入时展开、正文开始后收起，
// 工具卡按调用顺序排列。2026-10-26 走查 M18：思考块与工具卡归进步骤组（state/turns.ts），组折起时它们收着，组的第一块
// 前面是一行"{n} steps"（docs/v0/screens/chat.md"步骤组"）。

import { Fragment, memo, useState, type ReactNode } from 'react';
import type { Block, Item, ToolCall } from '../state/model';
import type { ItemSteps, StepRow } from '../state/turns';
import { Markdown } from './Markdown';
import { Receipt } from './TeamStream';
import { ToolCard } from './ToolCard';

type Assistant = Extract<Item, { kind: 'assistant' }>;

/** @brief 思考块：流入时展开，正文开始后自动收起；你点过之后以你的选择为准。 */
function Thinking({ block }: { block: Extract<Block, { type: 'thinking' }> }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? block.streaming;
  return (
    <details className="thinking" open={open} data-testid="thinking">
      <summary data-no-quote onClick={(event) => { event.preventDefault(); setChosen(!open); }}>
        {block.streaming ? 'Thinking…' : 'Thought process'}
      </summary>
      <div className="thinking-text">{block.text}</div>
    </details>
  );
}

/** @brief 步骤组的摘要行：按钮，读屏名就是这行字（前面的 ▸ / ▾ 不读），展开与否在 aria-expanded。 */
function StepsRow({ row, onToggle }: { row: StepRow; onToggle: (id: string) => void }) {
  return (
    <button type="button" className="step-group" data-testid="step-group" data-group={row.id} data-no-quote
      aria-expanded={row.open} onClick={() => onToggle(row.id)}>{row.label}</button>
  );
}

/**
 * @brief 思考块、工具卡外面的一层：在步骤组里时带 data-step-group（给跳转找组），组收着时这一层 hidden。不在组里时
 *        也是同一个 div（不带属性）：思考块在它那一段出现第一张工具卡时进组，外层换了元素会让它重新挂载、丢掉你点过的展开。
 */
function Member({ steps, index, children }: { steps?: ItemSteps; index: number; children: ReactNode }) {
  const group = steps?.group[index];
  return <div data-step-group={group} hidden={Boolean(group && steps?.hidden.includes(index))}>{children}</div>;
}

/**
 * @brief 整条回复都收着：没有摘要行，有内容的块都在收着的组里，组里的工具卡也没有回执（回执照常显示）。
 * @param steps 这条回复的步骤组视图；没有时不收
 */
function allHidden(item: Assistant, tools: Record<string, ToolCall>, steps?: ItemSteps): boolean {
  if (!steps || Object.keys(steps.rows).length > 0) return false;
  return item.blocks.every((block, index) => {
    const hidden = steps.hidden.includes(index);
    if (block.type !== 'tool') return !block.text.trim() || hidden;
    const tool = tools[block.id];
    return !tool || (hidden && !tool.receipts?.length);
  });
}

/** @brief AssistantMessage 的参数。 */
interface MessageProps {
  /** 这条助手回复 */
  item: Assistant;
  /** 工具调用 */
  tools: Record<string, ToolCall>;
  /** 会话的工作目录 */
  cwd: string;
  /** 会话在界面里的标识 */
  tabKey: string;
  /** 这条回复的步骤组视图（turns.ts itemSteps）；没有组里的块时为 undefined */
  steps?: ItemSteps;
  /** 点摘要行：展开或折起那一组 */
  onSteps: (id: string) => void;
}

/** @brief 一块的内容：思考块、正文，或工具卡与它下面的回执。 */
function BlockView({ item, tools, cwd, tabKey, steps, index }: MessageProps & { index: number }) {
  const block = item.blocks[index]!;
  if (block.type === 'thinking') {
    return block.text.trim() ? <Member steps={steps} index={index}><Thinking block={block} /></Member> : null;
  }
  if (block.type === 'text') {
    // 还在生成的是这条回复的最后一块：告诉 Streamdown，它才分得出没写完的代码块（mermaid 等写完才画）。
    const streaming = item.streaming && index === item.blocks.length - 1;
    return block.text.trim() ? <Markdown text={block.text} streaming={streaming} /> : null;
  }
  const tool = tools[block.id];
  // 合并会话里立项调用写下的回执画在它的工具卡下面（docs/v1/screens/team-stream.md "回执"），卡收着时回执照常显示。
  return tool ? (
    <>
      <Member steps={steps} index={index}><ToolCard tool={tool} cwd={cwd} tabKey={tabKey} /></Member>
      {tool.receipts?.map((receipt, at) => <Receipt key={at} receipt={receipt} />)}
    </>
  ) : null;
}

/**
 * @brief 一条助手回复（pi 的一条助手消息）。整条是一个引用来源：选区起止都在这里时出"Attach as context / Feedback"浮层
 *        （docs/v0/screens/selection.md）。整条都收在折起的步骤组里时这一层 hidden（不留空白），标识照旧，跳转找得到它。
 */
export const AssistantMessage = memo(function AssistantMessage(props: MessageProps) {
  const { item, tools, steps, onSteps } = props;
  const visible = item.blocks.filter((block) => block.type === 'tool' || block.text.trim());
  if (visible.length === 0) return null;
  return (
    <div className="assistant-message" data-testid="assistant" data-quote-source="message" data-item-key={item.key}
      hidden={allHidden(item, tools, steps)}>
      {item.blocks.map((block, index) => (
        <Fragment key={block.type === 'tool' ? block.id : index}>
          {steps?.rows[index] && <StepsRow row={steps.rows[index]} onToggle={onSteps} />}
          <BlockView {...props} index={index} />
        </Fragment>
      ))}
    </div>
  );
});
