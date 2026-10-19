// F8 报告界面问题（方案 5.15，状态表见 docs/v0/screens/f8.md）：截下当前窗口、保存报告、在资源管理器里选中。
// 截图与保存都在主进程里完成，不经过后台进程和 pi，后台进程退出后也能报告。
// 报告只写界面交来的字段（IssueReport），界面从不交 API key。

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { app, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { IssueReport, SavedIssue, WindowCapture } from '../shared/issues';

/** 暂存的截图最多几张；只有最近打开的报告框会用到，更早的丢掉 */
const MAX_CAPTURES = 4;
/** 缩略图宽度（px），只用于报告框里的预览；文件里存原图 */
const THUMBNAIL_WIDTH = 640;

/** 截图 id → PNG 原图 */
const captures = new Map<string, Buffer>();

/** @brief 报告保存的文件夹（临时默认值，见 docs/v0/defaults.md）。 */
function issuesDir(): string {
  return join(app.getPath('userData'), 'ui-issues');
}

/** @brief 两位数字。 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** @brief 文件名用的本地时间 YYYY-MM-DD-HHmmss。 */
function fileStamp(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** @brief 标题用的本地时间 YYYY-MM-DD HH:mm:ss。 */
function localTime(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** @brief 截下发出请求的页面；失败时返回错误原文。 */
async function captureWindow(contents: WebContents): Promise<WindowCapture> {
  try {
    const image = await contents.capturePage();
    if (image.isEmpty()) throw new Error('The captured image is empty');
    const captureId = randomUUID();
    captures.set(captureId, image.toPNG());
    for (const id of captures.keys()) {
      if (captures.size <= MAX_CAPTURES) break;
      captures.delete(id);
    }
    const width = Math.min(THUMBNAIL_WIDTH, image.getSize().width);
    return { captureId, dataUrl: image.resize({ width, quality: 'good' }).toDataURL(), error: null };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[main] cannot capture the window: ${message}`);
    return { captureId: null, dataUrl: null, error: message };
  }
}

/** @brief 是否为字符串或 null。 */
function isTextOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** @brief 是否为对象数组，且每项的给定字段都是字符串。 */
function isTextRecords(value: unknown, keys: readonly string[]): boolean {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === 'object'
    && keys.every((key) => typeof (item as Record<string, unknown>)[key] === 'string'));
}

/** @brief 检查界面交来的报告；形状不对或两个输入框都空时报错。 */
function checkReport(value: unknown): IssueReport {
  const report = value as Record<string, unknown> | null;
  const valid = report !== null && typeof report === 'object'
    && typeof report.what === 'string' && typeof report.expect === 'string'
    && isTextOrNull(report.captureId) && isTextOrNull(report.captureError)
    && isTextRecords(report.view, ['label', 'value']) && isTextRecords(report.actions, ['time', 'text']);
  if (!valid) throw new Error('Invalid issue report');
  const checked = report as unknown as IssueReport;
  if (!checked.what.trim() && !checked.expect.trim()) throw new Error('The issue report is empty');
  return checked;
}

/** @brief 列表项里的文字：换行压成空格。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** @brief 你写的原文；没写时为"（没有填写）"。 */
function written(text: string): string {
  return text.trim() || '（没有填写）';
}

/** @brief 版本：Mori、Electron、Chromium、Node、Windows。 */
function versions(): string[] {
  return [
    `- Mori：${app.getVersion()}`,
    `- Electron：${process.versions.electron}`,
    `- Chromium：${process.versions.chrome}`,
    `- Node：${process.versions.node}`,
    `- Windows：${release()}`,
  ];
}

/** @brief 报告的 Markdown；标题用中文，M7 的收件箱按这些标题读取。shot 是"截图"一节的内容。 */
function issueMarkdown(report: IssueReport, when: Date, shot: string): string {
  return [
    `# 界面问题 · ${localTime(when)}`, '',
    '## 哪里不对', '', written(report.what), '',
    '## 你期望什么', '', written(report.expect), '',
    '## 截图', '', shot, '',
    '## 当前界面', '', ...report.view.map((field) => `- ${oneLine(field.label)}：${oneLine(field.value)}`), '',
    '## 最近的操作', '', ...report.actions.map((action) => `- ${oneLine(action.time)} ${oneLine(action.text)}`), '',
    '## 版本', '', ...versions(), '',
  ].join('\n');
}

/** @brief 报告附带的截图；没有截图时给出写进报告的原文。 */
function reportShot(report: IssueReport): { png: Buffer | null; error: string } {
  if (report.captureId) {
    const png = captures.get(report.captureId) ?? null;
    return { png, error: png ? '' : 'The screenshot is no longer available' };
  }
  return { png: null, error: report.captureError ?? 'No screenshot was taken' };
}

/** @brief 文件夹里还没用过的文件名：同一秒内再保存时加 -2、-3。 */
function freeName(dir: string, stamp: string): string {
  for (let index = 1; ; index += 1) {
    const name = index === 1 ? stamp : `${stamp}-${index}`;
    if (!existsSync(join(dir, `${name}.md`)) && !existsSync(join(dir, `${name}.png`))) return name;
  }
}

/** @brief 保存一份报告：先写截图，再写 Markdown；返回 Markdown 的完整路径。 */
function saveIssue(value: unknown): SavedIssue {
  try {
    const report = checkReport(value);
    const { png, error } = reportShot(report);
    const now = new Date();
    const dir = issuesDir();
    mkdirSync(dir, { recursive: true });
    // 全程同步读写，查找文件名与写入之间不会插进别的保存。
    const name = freeName(dir, fileStamp(now));
    if (png) writeFileSync(join(dir, `${name}.png`), png);
    const shot = png ? `![截图](${name}.png)` : `截图失败：${oneLine(error)}`;
    const file = join(dir, `${name}.md`);
    writeFileSync(file, issueMarkdown(report, now, shot), { encoding: 'utf8', flag: 'wx' });
    if (report.captureId) captures.delete(report.captureId);
    return { file };
  } catch (error) {
    console.error(`[main] cannot save the issue report: ${(error as Error).message}`);
    throw error;
  }
}

/** @brief 在资源管理器里选中一份报告；只接受报告文件夹里已存在的文件。 */
function showIssue(file: unknown): void {
  const dir = issuesDir();
  const target = typeof file === 'string' ? resolve(dir, file) : '';
  const inside = target ? relative(dir, target) : '';
  const allowed = inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
    && existsSync(target) && statSync(target).isFile();
  if (!allowed) {
    console.error(`[main] refused to show ${String(file)}: not a saved issue report`);
    throw new Error('Not a saved issue report');
  }
  shell.showItemInFolder(target);
}

/**
 * @brief 注册 F8 用的三个通道；只有 Mori 自己的页面能调用。
 * @param isAppPage 判断地址是否是 Mori 自己的页面
 */
export function registerFeedbackHandlers(isAppPage: (url: string) => boolean): void {
  const check = (event: IpcMainInvokeEvent) => {
    if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  };
  ipcMain.handle('mori:capture-window', (event: IpcMainInvokeEvent) => {
    check(event);
    return captureWindow(event.sender);
  });
  ipcMain.handle('mori:save-issue', (event: IpcMainInvokeEvent, report: unknown) => {
    check(event);
    return saveIssue(report);
  });
  ipcMain.handle('mori:show-issue', (event: IpcMainInvokeEvent, file: unknown) => {
    check(event);
    showIssue(file);
  });
}
