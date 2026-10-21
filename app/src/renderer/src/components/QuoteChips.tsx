// 引用芯片（docs/v0/screens/selection.md）：输入框上方的芯片（可移除），以及发出的消息上方的引用。
// 照 Claude 桌面版：引用显示来源和原文摘要，点它回到原位置；点过之后查出的问题（"Source changed"等）一直标在芯片上。
// M5 的会话引用（session-refs.md）：芯片写"Context · 会话名 · turns 3–8 · ~3,200 characters"，会话名取原会话现在的名字；
// 输入框里的芯片点开是预览对话框，发出的引用点了回到原会话；正在读取、没能加入的引用另列一行。

import type { QuoteRef } from '../../../shared/protocol';
import { excerpt, jumpToQuote, refKey, refLabel, removeQuote, useQuoteStatus, type QuoteStatus } from '../state/quotes';
import { dropPending, openPreview, sessionGone, sourceName } from '../state/refActions';
import { useApp, type PendingRef, type Tab } from '../state/store';
import { Icon, type IconName } from '../icons';

/** 芯片上的检查结果 */
const STATUS_TEXT: Record<QuoteStatus, string> = { changed: 'Source changed', missing: 'File not found',
  gone: 'Session deleted' };

/** 各种来源的图标 */
const ICONS: Record<QuoteRef['source']['kind'], IconName> = { file: 'file', message: 'quote', session: 'chat' };

/** @brief 芯片上的检查结果：会话引用的原会话已删除按会话列表算；其余是点过之后查出来的。 */
function useStatus(quote: QuoteRef): QuoteStatus | undefined {
  const gone = useApp((state) => quote.source.kind === 'session' && sessionGone(state, quote.source.sessionFile));
  const checked = useQuoteStatus((state) => state[refKey(quote)]);
  return gone ? 'gone' : checked;
}

/** @brief 芯片上的检查结果标签；没有问题时不显示。 */
function StatusBadge({ quote }: { quote: QuoteRef }) {
  const status = useStatus(quote);
  if (!status) return null;
  return <span className="quote-status" data-testid="quote-status">{STATUS_TEXT[status]}</span>;
}

/** @brief 芯片上的来源文字；会话引用用原会话现在的名字。 */
function useLabel(quote: QuoteRef, cwd: string): string {
  const name = useApp((state) => (quote.source.kind === 'session' ? sourceName(state, quote.source) : undefined));
  return refLabel(quote, cwd, name);
}

/** @brief 输入框上方的芯片：来源、原文第一行，点它回到原位置（会话引用是打开预览）；× 移除。 */
function ComposerChip({ tab, quote }: { tab: Tab; quote: QuoteRef }) {
  const label = useLabel(quote, tab.cwd);
  const session = quote.source.kind === 'session';
  const open = () => (session ? openPreview({ tabKey: tab.key, ref: quote, mode: 'edit', reason: null })
    : jumpToQuote(tab.key, quote));
  return (
    <div className="quote-chip" data-testid="quote-chip" data-kind={quote.source.kind}>
      <button className="quote-chip-main" title={quote.quote}
        aria-label={session ? `${label}, open preview` : `Context: ${label}, jump to source`} onClick={open}>
        <Icon name={ICONS[quote.source.kind]} />
        <span className="quote-chip-label">{label}</span>
        {!session && <span className="quote-chip-text">{excerpt(quote.quote)}</span>}
        <StatusBadge quote={quote} />
      </button>
      <button className="icon-button" aria-label={`Remove context: ${label}`} title="Remove context"
        onClick={() => removeQuote(tab.key, quote)}><Icon name="close" /></button>
    </div>
  );
}

/** @brief 正在读取的会话引用（× 取消），或没能加入的说明（× 关掉）。 */
function PendingChip({ tabKey, item }: { tabKey: string; item: PendingRef }) {
  if (item.problem) {
    return (
      <div className="ref-problem" role="alert" data-testid="ref-problem">
        <span>{item.problem}</span>
        <button className="icon-button" aria-label="Dismiss warning" title="Dismiss"
          onClick={() => dropPending(tabKey, item.id)}><Icon name="close" /></button>
      </div>
    );
  }
  return (
    <div className="quote-chip" data-testid="quote-chip" data-kind="session" data-pending="true">
      <span className="quote-chip-main" role="status">
        <Icon name="chat" /><span className="quote-chip-label">Context · {item.title} · Loading…</span>
      </span>
      <button className="icon-button" aria-label={`Cancel attaching “${item.title}”`} title="Cancel"
        onClick={() => dropPending(tabKey, item.id)}><Icon name="close" /></button>
    </div>
  );
}

/** @brief 输入框上方的全部芯片；没有时不占位置。 */
export function ComposerQuotes({ tab }: { tab: Tab }) {
  if (tab.draftRefs.length === 0 && tab.refPending.length === 0) return null;
  return (
    <div className="quote-chips" data-testid="quote-chips">
      {tab.draftRefs.map((quote) => <ComposerChip key={refKey(quote)} tab={tab} quote={quote} />)}
      {tab.refPending.map((item) => <PendingChip key={item.id} tabKey={tab.key} item={item} />)}
    </div>
  );
}

/** @brief 发出的消息上方的一个引用：来源和原文（最多 3 行），点它回到原位置。 */
function SentQuote({ quote, tabKey, cwd }: { quote: QuoteRef; tabKey: string; cwd: string }) {
  const label = useLabel(quote, cwd);
  const session = quote.source.kind === 'session';
  return (
    <button className="sent-quote" data-testid="sent-quote" data-kind={quote.source.kind} title={quote.quote}
      aria-label={session ? `${label}, jump to session` : `Context: ${label}, jump to source`}
      onClick={() => jumpToQuote(tabKey, quote)}>
      <span className="sent-quote-head">
        <Icon name={ICONS[quote.source.kind]} />
        <span className="quote-chip-label">{label}</span>
        <StatusBadge quote={quote} />
      </span>
      <span className="sent-quote-text">{quote.quote}</span>
    </button>
  );
}

/** @brief 发出的消息上方的引用。 */
export function SentQuotes({ refs, tabKey, cwd }: { refs: QuoteRef[]; tabKey: string; cwd: string }) {
  return (
    <div className="sent-quotes">
      {refs.map((quote) => <SentQuote key={refKey(quote)} quote={quote} tabKey={tabKey} cwd={cwd} />)}
    </div>
  );
}
