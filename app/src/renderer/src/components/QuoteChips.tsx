// 引用芯片（docs/v0/screens/selection.md）：输入框上方的芯片（可移除），以及发出的消息上方的引用。
// 照 Claude 桌面版：引用显示来源和原文摘要，点它回到原位置；点过之后查出的问题（原文已变化等）一直标在芯片上。

import type { QuoteRef } from '../../../shared/protocol';
import { excerpt, jumpToQuote, refKey, refLabel, removeQuote, useQuoteStatus, type QuoteStatus } from '../state/quotes';
import type { Tab } from '../state/store';
import { Icon } from '../icons';

/** 芯片上的检查结果 */
const STATUS_TEXT: Record<QuoteStatus, string> = { changed: '原文已变化', missing: '文件已被删除或移动' };

/** @brief 芯片上的检查结果标签；没有问题时不显示。 */
function StatusBadge({ quote }: { quote: QuoteRef }) {
  const status = useQuoteStatus((state) => state[refKey(quote)]);
  if (!status) return null;
  return <span className="quote-status" data-testid="quote-status">{STATUS_TEXT[status]}</span>;
}

/** @brief 输入框上方的芯片：来源、原文第一行，点它回到原位置；× 移除。 */
function ComposerChip({ tab, quote }: { tab: Tab; quote: QuoteRef }) {
  const label = refLabel(quote, tab.cwd);
  return (
    <div className="quote-chip" data-testid="quote-chip">
      <button className="quote-chip-main" title={quote.quote} aria-label={`引用 · ${label}，回到原位置`}
        onClick={() => jumpToQuote(tab.key, quote)}>
        <Icon name={quote.source.kind === 'file' ? 'file' : 'quote'} />
        <span className="quote-chip-label">{label}</span>
        <span className="quote-chip-text">{excerpt(quote.quote)}</span>
        <StatusBadge quote={quote} />
      </button>
      <button className="icon-button" aria-label={`移除引用 · ${label}`} title="移除引用"
        onClick={() => removeQuote(tab.key, quote)}><Icon name="close" /></button>
    </div>
  );
}

/** @brief 输入框上方的全部芯片；没有时不占位置。 */
export function ComposerQuotes({ tab }: { tab: Tab }) {
  if (tab.draftRefs.length === 0) return null;
  return (
    <div className="quote-chips" data-testid="quote-chips">
      {tab.draftRefs.map((quote) => <ComposerChip key={refKey(quote)} tab={tab} quote={quote} />)}
    </div>
  );
}

/** @brief 发出的消息上方的引用：来源和原文（最多 3 行），点它回到原位置。 */
export function SentQuotes({ refs, tabKey, cwd }: { refs: QuoteRef[]; tabKey: string; cwd: string }) {
  return (
    <div className="sent-quotes">
      {refs.map((quote) => {
        const label = refLabel(quote, cwd);
        return (
          <button key={refKey(quote)} className="sent-quote" data-testid="sent-quote" title={quote.quote}
            aria-label={`引用 · ${label}，回到原位置`} onClick={() => jumpToQuote(tabKey, quote)}>
            <span className="sent-quote-head">
              <Icon name={quote.source.kind === 'file' ? 'file' : 'quote'} />
              <span className="quote-chip-label">{label}</span>
              <StatusBadge quote={quote} />
            </span>
            <span className="sent-quote-text">{quote.quote}</span>
          </button>
        );
      })}
    </div>
  );
}
