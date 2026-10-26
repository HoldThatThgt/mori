// 一段 Markdown（docs/v0/screens/chat.md"正文开始"、"图"）：对话流的正文、记忆页的 Details 与修订的 Notes
// （docs/specs/memory.md §10.1、§10.5）、右栏阅读器的 Markdown 预览（docs/v0/screens/changes.md）共用这一个渲染。
// 代码块离线高亮；mermaid 代码块画成图（MermaidBlock）。链接不在 App 里打开（窗口禁止跳转），也不弹外链确认框。

import { memo } from 'react';
import { defaultRehypePlugins, Streamdown, type Components, type StreamdownProps } from 'streamdown';
import { code } from '@streamdown/code';
import { MermaidBlock } from './MermaidBlock';

const plugins = { code, renderers: [{ language: 'mermaid', component: MermaidBlock }] };
const controls = { code: { copy: true, download: false }, table: false, image: false };
const translations = { copyCode: 'Copy code', copied: 'Copied' };
const linkSafety = { enabled: false };

/** @brief hast 树里用到的部分：元素的源码位置和属性。 */
interface HastNode {
  /** 节点种类（element、text、root…） */
  type: string;
  /** 在源码里的起止位置（行从 1 起）；生成的节点没有 */
  position?: { start: { line: number }; end: { line: number } };
  /** 元素的属性 */
  properties?: Record<string, unknown>;
  /** 子节点 */
  children?: HastNode[];
}

/** @brief 给每个有源码位置的元素写上 data-line-start / data-line-end。 */
function markLines(node: HastNode): void {
  if (node.type === 'element' && node.position) {
    node.properties = { ...node.properties, dataLineStart: node.position.start.line,
      dataLineEnd: node.position.end.line };
  }
  for (const child of node.children ?? []) markLines(child);
}

/**
 * @brief rehype 插件（预览用，排在 Streamdown 的 raw、sanitize、harden 之后）：元素带上它在源码里的行，
 *        预览里的选区按它取源码行（selectionSource.ts previewPick）。
 */
function sourceLines() {
  return (tree: HastNode) => markLines(tree);
}

/** 预览的 rehype 插件：Streamdown 默认的几个加上 sourceLines */
const previewRehype: StreamdownProps['rehypePlugins'] = [...Object.values(defaultRehypePlugins), sourceLines];

/**
 * @brief 一段 Markdown。
 * @param components 覆盖某些元素的渲染（记忆页 Details 里的 [[slug]] 链接）
 * @param streaming 这段正文还在生成（Streamdown 据此报告还没写完的代码块，mermaid 图等它写完才画）
 * @param preview 阅读器的预览：整份一次渲染（static），元素带源码行
 */
export const Markdown = memo(function Markdown({ text, components, streaming = false, preview = false }: {
  text: string; components?: Components; streaming?: boolean; preview?: boolean;
}) {
  return (
    <Streamdown className="prose" plugins={plugins} controls={controls} translations={translations}
      linkSafety={linkSafety} components={components} isAnimating={streaming}
      mode={preview ? 'static' : 'streaming'} rehypePlugins={preview ? previewRehype : undefined}>
      {text}
    </Streamdown>
  );
});
