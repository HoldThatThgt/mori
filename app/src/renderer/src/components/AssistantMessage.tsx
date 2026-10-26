// 一条助手回复：正文按 Markdown 渲染（Markdown.tsx：代码块离线高亮、mermaid 画成图），思考流入时展开、正文开始后收起，
// 工具卡按调用顺序排列。

import { Fragment, memo, useState } from 'react';
import type { Block, Item, ToolCall } from '../state/model';
import { Markdown } from './Markdown';
import { Receipt } from './TeamStream';
import { ToolCard } from './ToolCard';

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

/**
 * @brief 一条助手回复（pi 的一条助手消息）。整条是一个引用来源：选区起止都在这里时出"Attach as context / Feedback"浮层
 *        （docs/v0/screens/selection.md）。
 */
export const AssistantMessage = memo(function AssistantMessage({ item, tools, cwd, tabKey }: {
  item: Extract<Item, { kind: 'assistant' }>; tools: Record<string, ToolCall>; cwd: string; tabKey: string;
}) {
  const visible = item.blocks.filter((block) => block.type === 'tool' || block.text.trim());
  if (visible.length === 0) return null;
  return (
    <div className="assistant-message" data-testid="assistant" data-quote-source="message" data-item-key={item.key}>
      {item.blocks.map((block, index) => {
        if (block.type === 'thinking') return block.text.trim() ? <Thinking key={index} block={block} /> : null;
        if (block.type === 'text') {
          // 还在生成的是这条回复的最后一块：告诉 Streamdown，它才分得出没写完的代码块（mermaid 等写完才画）。
          const streaming = item.streaming && index === item.blocks.length - 1;
          return block.text.trim() ? <Markdown key={index} text={block.text} streaming={streaming} /> : null;
        }
        const tool = tools[block.id];
        // 合并会话里立项调用写下的回执画在它的工具卡下面（docs/v1/screens/team-stream.md "回执"）。
        return tool ? (
          <Fragment key={block.id}>
            <ToolCard tool={tool} cwd={cwd} tabKey={tabKey} />
            {tool.receipts?.map((receipt, at) => <Receipt key={at} receipt={receipt} />)}
          </Fragment>
        ) : null;
      })}
    </div>
  );
});
