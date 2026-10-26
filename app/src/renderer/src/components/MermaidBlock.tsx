// mermaid 代码块画成图（docs/v0/screens/chat.md"图"，2026-10-26 走查 M16），经 Streamdown 的自定义渲染接口接上：
// 代码块还在写时显示代码，写完才画；画不出来时显示同样的代码块，照 Claude 桌面版不另给错误说明。
// mermaid 在第一次遇到图时才载入（单独的代码块，打包在程序里，不联网）。画好的 SVG 放进 shadow DOM：界面的全局样式
// （layout.css 的 svg { width: 18px }）管不到它，图里的字也不进选区。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CodeBlock, CodeBlockCopyButton, type CustomRendererProps } from 'streamdown';
import type { Mermaid, MermaidConfig } from 'mermaid';

/** 画过的图最多记几张（临时默认值，见 docs/v0/defaults.md） */
const CACHE_MAX = 50;
/**
 * 一张图最多多少字（临时默认值，同 Claude 桌面版）。超过时 mermaid 画一张"Maximum text size in diagram exceeded"的图，
 * 这里先拦下，显示代码（chat.md"画不出来"）
 */
const MAX_TEXT = 20000;
/** shadow DOM 里的样式：图居中；mermaid 给 SVG 写了 width="100%" 和 max-width，宽于这一栏时按比例缩小 */
const SHADOW_STYLE = ':host { display: flex; justify-content: center; } svg { display: block; height: auto; }';

/** 代码 → 画好的 SVG；画不出来的记为 null */
const drawn = new Map<string, string | null>();
let loading: Promise<Mermaid> | null = null;
let renders = 0;
let stage: HTMLDivElement | null = null;

/** @brief 一个 token 的具体颜色值（mermaid 读不了 CSS 变量和 color-mix）。 */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** @brief mermaid 的设置（临时默认值，见 docs/v0/defaults.md"mermaid 的设置"）。 */
function mermaidConfig(): MermaidConfig {
  return {
    startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true,
    maxTextSize: MAX_TEXT, maxEdges: 400, theme: 'base', fontFamily: getComputedStyle(document.body).fontFamily,
    themeVariables: {
      fontSize: '14px', primaryColor: token('--color-surface'), primaryBorderColor: token('--color-line-strong'),
      primaryTextColor: token('--color-text'), lineColor: token('--color-faint'),
      secondaryColor: token('--color-accent-soft'), tertiaryColor: token('--color-accent-tint'),
    },
  };
}

/** @brief 载入 mermaid（第一次用时；之后用同一个）并设好；载入失败时记错误日志，之后的图都显示代码。 */
function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(mermaidConfig());
    return mermaid;
  }, (error: unknown) => {
    console.error(`[renderer] cannot load mermaid: ${(error as Error).message}`);
    throw error;
  });
  return loading;
}

/** @brief mermaid 画图时用的容器：铺满窗口但看不见、不挡鼠标（量字的大小要在文档里排版）。 */
function renderStage(): HTMLDivElement {
  if (!stage?.isConnected) {
    stage = document.createElement('div');
    stage.className = 'mermaid-stage';
    stage.setAttribute('aria-hidden', 'true');
    document.body.append(stage);
  }
  return stage;
}

/** @brief 记下一张图的结果（超过 CACHE_MAX 时去掉最早的），原样返回。 */
function remember(code: string, svg: string | null): string | null {
  drawn.set(code, svg);
  const oldest = drawn.keys().next().value;
  if (drawn.size > CACHE_MAX && oldest !== undefined) drawn.delete(oldest);
  return svg;
}

/** @brief 画一张图，返回 SVG；画不出来（语法错误、超过上限、mermaid 载入失败）时记日志，返回 null。 */
async function draw(code: string): Promise<string | null> {
  if (code.length > MAX_TEXT) {
    console.warn(`[renderer] mermaid diagram not drawn: longer than ${MAX_TEXT} characters`);
    return remember(code, null);
  }
  try {
    const mermaid = await loadMermaid();
    renders += 1;
    const { svg } = await mermaid.render(`mori-mermaid-${renders}`, code, renderStage());
    return remember(code, svg);
  } catch (error) {
    console.warn(`[renderer] mermaid diagram not drawn: ${(error as Error).message}`);
    return remember(code, null);
  }
}

/** @brief 还在写或画不出来时：与其他语言相同的代码块（高亮、"Copy code"）。 */
function MermaidCode({ code, isIncomplete }: { code: string; isIncomplete: boolean }) {
  return <CodeBlock code={code} language="mermaid" isIncomplete={isIncomplete}><CodeBlockCopyButton /></CodeBlock>;
}

/** @brief 图的框；svg 为 null 时是画好之前的空框（aria-busy）。 */
function Diagram({ svg }: { svg: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || svg === null) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${SHADOW_STYLE}</style>${svg}`;
  }, [svg]);
  return <div ref={host} className="mermaid-diagram" role="img" aria-label="Mermaid diagram"
    aria-busy={svg === null ? true : undefined} data-no-quote data-testid="mermaid-diagram" />;
}

/**
 * @brief Streamdown 的 mermaid 渲染。
 * @param isIncomplete 代码块还没有结束的 ```（只在这段正文还在生成时为真）
 */
export function MermaidBlock({ code, isIncomplete }: CustomRendererProps) {
  const [result, setResult] = useState<{ code: string; svg: string | null } | null>(null);
  const known = drawn.has(code) ? drawn.get(code) ?? null : undefined;
  const svg = known !== undefined ? known : result?.code === code ? result.svg : undefined;
  useEffect(() => {
    if (isIncomplete || drawn.has(code)) return;
    let live = true;
    void draw(code).then((done) => live && setResult({ code, svg: done }));
    return () => {
      live = false;
    };
  }, [code, isIncomplete]);
  if (isIncomplete || svg === null) return <MermaidCode code={code} isIncomplete={isIncomplete} />;
  return <Diagram svg={svg ?? null} />;
}
