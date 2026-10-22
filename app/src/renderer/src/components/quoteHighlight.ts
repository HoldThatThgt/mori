// 回到原位置时在对话流里标出引用（docs/v0/screens/selection.md "Jump to source"）：选区高亮引用的文字，
// 整条回复或找不到对应文字时高亮整轮回复，约 4 秒后消失。高亮用 CSS Custom Highlight，不改对话流的 DOM。

/** 回到原位置的高亮名 */
const JUMP_HIGHLIGHT = 'mori-jump';
/** 高亮停留的毫秒数 */
const HIGHLIGHT_MS = 4000;

let clearTimer: ReturnType<typeof setTimeout> | undefined;

/** @brief 在元素的文字里找原文（不看空白：选区的文字和 DOM 文字在换行、缩进上可能不同）；找不到时为 null。 */
export function findText(root: Element, quote: string): Range | null {
  const target = quote.replace(/\s+/g, '');
  if (!target) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const positions: Array<[Text, number]> = [];
  let flat = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    for (let index = 0; index < text.data.length; index += 1) {
      if (/\s/.test(text.data[index]!)) continue;
      flat += text.data[index];
      positions.push([text, index]);
    }
  }
  const at = flat.indexOf(target);
  const start = positions[at];
  const end = positions[at + target.length - 1];
  if (at < 0 || !start || !end) return null;
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1] + 1);
  return range;
}

/** @brief 清掉上一次的高亮。 */
function clearJump(): void {
  clearTimeout(clearTimer);
  CSS.highlights.delete(JUMP_HIGHLIGHT);
  for (const element of document.querySelectorAll('.jump-flash')) element.classList.remove('jump-flash');
}

/** @brief 高亮一段文字（选区引用）。 */
export function flashRange(range: Range): void {
  clearJump();
  CSS.highlights.set(JUMP_HIGHLIGHT, new Highlight(range));
  clearTimer = setTimeout(clearJump, HIGHLIGHT_MS);
}

/** @brief 高亮几个元素（整轮回复）。 */
export function flashElements(elements: Element[]): void {
  clearJump();
  for (const element of elements) element.classList.add('jump-flash');
  clearTimer = setTimeout(clearJump, HIGHLIGHT_MS);
}
