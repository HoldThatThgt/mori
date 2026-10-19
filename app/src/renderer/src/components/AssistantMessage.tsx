// 一条助手回复：正文按 Markdown 渲染（代码块离线高亮），思考流入时展开、正文开始后收起，工具卡按调用顺序排列。

import { memo, useState } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import type { Block, Item, ToolCall } from '../state/model';
import { ToolCard } from './ToolCard';

const plugins = { code };
const controls = { code: { copy: true, download: false }, table: false, mermaid: false, image: false };
const translations = { copyCode: '复制代码', copied: '已复制' };
// 链接不在 App 里打开（窗口禁止跳转），也不弹外链确认框。
const linkSafety = { enabled: false };

/** @brief 思考块：流入时展开，正文开始后自动收起；你点过之后以你的选择为准。 */
function Thinking({ block }: { block: Extract<Block, { type: 'thinking' }> }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? block.streaming;
  return (
    <details className="thinking" open={open} data-testid="thinking">
      <summary onClick={(event) => { event.preventDefault(); setChosen(!open); }}>
        {block.streaming ? '思考中…' : '思考'}
      </summary>
      <div className="thinking-text">{block.text}</div>
    </details>
  );
}

/** @brief 一段 Markdown 正文。 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <Streamdown className="prose" plugins={plugins} controls={controls} translations={translations}
      linkSafety={linkSafety}>
      {text}
    </Streamdown>
  );
});

/** @brief 一条助手回复。 */
export const AssistantMessage = memo(function AssistantMessage(
  { item, tools, cwd }: { item: Extract<Item, { kind: 'assistant' }>; tools: Record<string, ToolCall>; cwd: string },
) {
  const visible = item.blocks.filter((block) => block.type === 'tool' || block.text.trim());
  if (visible.length === 0) return null;
  return (
    <div className="assistant-message" data-testid="assistant">
      {item.blocks.map((block, index) => {
        if (block.type === 'thinking') return block.text.trim() ? <Thinking key={index} block={block} /> : null;
        if (block.type === 'text') return block.text.trim() ? <Markdown key={index} text={block.text} /> : null;
        const tool = tools[block.id];
        return tool ? <ToolCard key={block.id} tool={tool} cwd={cwd} /> : null;
      })}
    </div>
  );
});
