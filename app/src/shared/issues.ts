// F8 报告界面问题：界面与主进程之间的数据形状（方案 5.15，状态表见 docs/v0/screens/f8.md）。
// 截图与保存都在主进程里完成，不经过后台进程和 pi，后台进程退出后也能报告。

/** @brief 截图结果。 */
export interface WindowCapture {
  /** 主进程暂存这张截图的 id，保存时带上；截图失败时为 null */
  captureId: string | null;
  /** 缩略图用的 data URL（PNG）；截图失败时为 null */
  dataUrl: string | null;
  /** 截图失败时的错误原文 */
  error: string | null;
}

/** @brief "Current view"里的一项：名称和取值，例如 { label: 'Page', value: 'Session' }。 */
export interface IssueField {
  /** 这一项的名称 */
  label: string;
  /** 这一项当前的取值 */
  value: string;
}

/** @brief 一条最近的操作。 */
export interface IssueAction {
  /** 本地时间，HH:mm:ss */
  time: string;
  /** 操作的说明，不含 key 等机密 */
  text: string;
}

/** @brief 界面交给主进程保存的一份报告。 */
export interface IssueReport {
  /** 截图 id；截图失败时为 null */
  captureId: string | null;
  /** 截图失败时的原文，写进报告 */
  captureError: string | null;
  /** 哪里不对 */
  what: string;
  /** 你期望什么 */
  expect: string;
  /** 当前界面 */
  view: IssueField[];
  /** 最近的操作，从早到晚 */
  actions: IssueAction[];
}

/** @brief 保存结果。 */
export interface SavedIssue {
  /** Markdown 文件的完整路径 */
  file: string;
}
