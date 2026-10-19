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
