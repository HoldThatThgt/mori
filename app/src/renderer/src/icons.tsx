// 线条图标，路径移植自 demo/icons.js。

const paths = {
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  panel: 'M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3ZM9 4v16',
  right: 'M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3ZM15 4v16',
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
  file: 'M14 3H5v18h14V8Zm0 0v5h5M8 13h8M8 17h5',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  stop: 'M7 7h10v10H7Z',
  settings: 'M4 7h16M4 17h16M12 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 14-3l1 7M4 12l1 7a8 8 0 0 0 14-3',
  back: 'm15 5-7 7 7 7',
  flag: 'M5 21V4h12l-2.5 4.5L17 13H5',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6',
  quote: 'M5 7h5v5H7a3 3 0 0 0 0 0v1a3 3 0 0 1-2 3M14 7h5v5h-3v1a3 3 0 0 1-2 3',
  copy: 'M9 9h10v11H9ZM5 15V4h10',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  feedback: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Zm7 4v4m0 3v.5',
  tools: 'M14.5 4.5a4 4 0 0 0-5 5L4 15v5h5l5.5-5.5a4 4 0 0 0 5-5L17 12l-3-3 2.5-2.5Z',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  // 记忆页（docs/specs/memory.md §10.1）：一本书，书脊在左，封面上一行标题。
  memory: 'M5 5.5A2.5 2.5 0 0 1 7.5 3H19v13H7.5A2.5 2.5 0 0 0 5 18.5ZM5 18.5A2.5 2.5 0 0 0 7.5 21H19v-5M9 7.5h6',
} as const;

export type IconName = keyof typeof paths;

/** @brief 装饰图标；文字说明由所在按钮提供。 */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

/** @brief Mori 标志（demo 的 M 形线条）。 */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path d="M4 23V8l11 11L26 8v15" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}
