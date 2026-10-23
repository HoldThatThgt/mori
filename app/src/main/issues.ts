// 设置页的 UI issues（docs/specs/memory.md §10.8，原 M7 工作回顾的界面问题部分，docs/v0/screens/review.md）：
// 读出 F8 的界面问题报告、读报告的截图、导出为 Markdown、在资源管理器里选中、打开文件夹。
// 方案第 4 节"选区反馈、F8 界面问题 · Mori · 记录、收件箱、导出"。
// 报告文件只读不改；不经过后台进程和 pi，后台进程退出后也能用。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  ExportRequestSchema, ISSUE_NAME, type BrokenRecord, type ExportRequest, type ExportResult, type IssueItem,
  type IssueRecord,
} from '../shared/issueRecords';
import { issuesDir, localTime } from './feedback';

/** 报告里的各节，按报告里的顺序（main/feedback.ts issueMarkdown） */
const ISSUE_SECTIONS = [
  'What went wrong', 'What you expected', 'Screenshot', 'Current view', 'Recent activity', 'Versions',
] as const;
/** 报告里的一节 */
type IssueSection = (typeof ISSUE_SECTIONS)[number];

/** 文件开头的 BOM（U+FEFF），按码位写 */
const BOM = String.fromCodePoint(0xfeff);

/** 这次运行里导出过的文件；只有它们可以在资源管理器里选中 */
const exported = new Set<string>();

/** @brief 文件名是不是一份报告：报告时间格式的 .md（导出到这个文件夹里的 .md 不算）。 */
function isRecordName(name: string): boolean {
  return basename(name) === name && name.endsWith('.md') && ISSUE_NAME.test(name.slice(0, -3));
}

/**
 * @brief 按保存时刻比较两份报告的文件名：去掉扩展名后按数字比较，同一秒再存的 -2 排在不带序号的后面、-10 在 -9 后面
 *        （直接按字符比较时 "-" 小于 "."，同一秒的几份会倒过来）。
 */
function byStamp(left: string, right: string): number {
  const stem = (name: string) => name.slice(0, name.lastIndexOf('.'));
  return stem(left).localeCompare(stem(right), 'en', { numeric: true });
}

/** @brief 文件夹里的报告，按文件名（保存时刻）从新到旧；文件夹不存在时为空。 */
function recordNames(): string[] {
  const dir = issuesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isRecordName(entry.name))
    .map((entry) => entry.name).sort(byStamp).reverse();
}

/** @brief 读一份报告的文字；去掉开头的 BOM（在设成"UTF-8 带 BOM"的编辑器里另存过的）。 */
function readText(path: string): string {
  const text = readFileSync(path, 'utf8');
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** @brief 读不出来的报告：记录错误日志，原文交给界面。 */
function broken(name: string, error: unknown): BrokenRecord {
  const message = (error as Error).message;
  console.error(`[main] cannot read the UI issue ${name}: ${message}`);
  return { status: 'broken', name, error: message };
}

/**
 * @brief 一节在报告里的行号：第一节取第一次出现，之后的从后往前找。"Screenshot"及之后的几节是 Mori 生成的，
 *        不会有标题行；你写的两节里像标题的行写报告时加了转义（main/feedback.ts written）。
 */
function sectionLines(lines: string[]): Record<IssueSection, number> {
  const found = {} as Record<IssueSection, number>;
  let end = lines.length;
  for (const section of [...ISSUE_SECTIONS].reverse()) {
    const heading = `## ${section}`;
    const index = section === ISSUE_SECTIONS[0] ? lines.indexOf(heading) : lines.lastIndexOf(heading, end - 1);
    if (index < 0 || index >= end) throw new Error(`The report has no “${heading}” section`);
    found[section] = index;
    end = index;
  }
  return found;
}

/** @brief 报告各节的原文（去掉首尾空行）。 */
function reportSections(text: string): { time: string; sections: Record<IssueSection, string> } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = /^# UI issue · (.+)$/.exec(lines[0] ?? '');
  if (!title) throw new Error('The report has no “# UI issue · <time>” title');
  const at = sectionLines(lines);
  const sections = {} as Record<IssueSection, string>;
  ISSUE_SECTIONS.forEach((section, index) => {
    const next = ISSUE_SECTIONS[index + 1];
    sections[section] = lines.slice(at[section] + 1, next ? at[next] : lines.length).join('\n').trim();
  });
  return { time: title[1]!.trim(), sections };
}

/** @brief 是不是报告的截图：报告时间格式的 .png 文件名。 */
function isShotName(name: string): boolean {
  return basename(name) === name && name.endsWith('.png') && ISSUE_NAME.test(name.slice(0, -4));
}

/**
 * @brief 报告里"Screenshot"一节：截图的文件名，或没有截图时的原文（去掉"Couldn’t capture a screenshot:"前缀；
 *        各节读出时去掉了首尾空白，原文为空时冒号后没有空格）。这里不看 PNG 还在不在：
 *        被删了的由详情读截图时显示"Couldn’t load the screenshot"，导出照样链接原来的 PNG。
 */
function reportShot(text: string): { shot: string | null; shotError: string | null } {
  const image = /^!\[Screenshot\]\((.+)\)$/.exec(text);
  if (image) {
    const shot = image[1]!;
    if (isShotName(shot)) return { shot, shotError: null };
    return { shot: null, shotError: `Not a report screenshot: ${shot}` };
  }
  const error = text.replace(/^Couldn’t capture a screenshot:\s*/, '');
  return { shot: null, shotError: error || 'No screenshot section' };
}

/** @brief 读一份界面问题报告。 */
function readIssue(name: string): IssueItem {
  try {
    const { time, sections } = reportSections(readText(join(issuesDir(), name)));
    return { status: 'ok', name, time, what: sections['What went wrong'], expect: sections['What you expected'],
      ...reportShot(sections['Screenshot']), view: sections['Current view'], actions: sections['Recent activity'],
      versions: sections['Versions'] };
  } catch (error) {
    return broken(name, error);
  }
}

/** @brief 读出全部报告（按文件名从新到旧）；读文件夹出错时报错（文件夹不存在算空）。 */
function listIssues(): IssueItem[] {
  try {
    return recordNames().map(readIssue);
  } catch (error) {
    console.error(`[main] cannot list the UI issues: ${(error as Error).message}`);
    throw error;
  }
}

/** @brief 一份报告的截图（data URL）；只接受报告文件夹里报告时间格式的 .png。 */
function issueShot(value: unknown): string {
  const name = typeof value === 'string' ? value : '';
  try {
    if (!isShotName(name)) throw new Error('Not a report screenshot');
    return `data:image/png;base64,${readFileSync(join(issuesDir(), name)).toString('base64')}`;
  } catch (error) {
    console.error(`[main] cannot read the screenshot ${String(value)}: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * @brief 截图链接：从导出文件所在的文件夹到原来那张 PNG 的相对路径，每一段按网址编码（文件夹名里的 "#"、"%" 不会被
 *        当成网址的一部分）；不在同一个盘上时写完整的 file 地址。
 */
function shotLink(target: string, shot: string): string {
  const png = join(issuesDir(), shot);
  const path = relative(dirname(target), png);
  return isAbsolute(path) ? pathToFileURL(png).href : path.split(/[\\/]/).map(encodeURIComponent).join('/');
}

/** @brief 导出文件里的一份报告：报告原来的各节，标题降一级，截图链接改成相对导出文件的路径。 */
function issueSection(record: IssueRecord, target: string): string[] {
  const shot = record.shot ? `![Screenshot](<${shotLink(target, record.shot)}>)`
    : `Couldn’t capture a screenshot: ${record.shotError ?? ''}`;
  const body: [IssueSection, string][] = [['What went wrong', record.what], ['What you expected', record.expect],
    ['Screenshot', shot], ['Current view', record.view], ['Recent activity', record.actions],
    ['Versions', record.versions]];
  return [`- Report file: ${join(issuesDir(), record.name)}`, '',
    ...body.flatMap(([heading, text]) => [`### ${heading}`, '', text, ''])];
}

/** @brief 导出文件里的一份报告；读不出来的写文件名和原文。 */
function exportSection(name: string, index: number, done: boolean, target: string): string[] {
  const state = done ? 'Resolved' : 'Unresolved';
  const record = readIssue(name);
  if (record.status === 'broken') {
    return [`## ${index + 1}. ${name} · ${state}`, '', `- Record file: ${join(issuesDir(), name)}`, '',
      `Couldn’t read this record: ${record.error}`, ''];
  }
  return [`## ${index + 1}. ${record.time} · ${state}`, '', ...issueSection(record, target)];
}

/** @brief 导出文件的全文。 */
function exportMarkdown(request: ExportRequest, target: string): string {
  const handled = new Set(request.handled);
  const done = request.names.filter((name) => handled.has(name)).length;
  const total = request.names.length;
  const head = ['# UI issues', '',
    `Exported ${localTime(new Date())} · ${total} ${total === 1 ? 'record' : 'records'}: ${total - done} unresolved, `
    + `${done} resolved`, ''];
  const sections = request.names.flatMap((name, index) => exportSection(name, index, handled.has(name), target));
  return [...head, ...sections].join('\n');
}

/** @brief 检查导出请求：文件名都要是报告的文件名。 */
function checkExport(value: unknown): ExportRequest {
  const request = ExportRequestSchema.parse(value);
  const bad = request.names.find((name) => !isRecordName(name));
  if (bad) throw new Error(`Not a UI issue report: ${bad}`);
  return request;
}

/** @brief 导出：弹保存对话框，写导出文件；你取消时 file 为 null。 */
async function exportIssues(event: IpcMainInvokeEvent, value: unknown): Promise<ExportResult> {
  try {
    const request = checkExport(value);
    const day = localTime(new Date()).slice(0, 10);
    // 默认文件名与报告文件夹同名：ui-issues-2026-10-21.md。
    const file = `${basename(issuesDir())}-${day}.md`;
    const options = { title: 'Export as Markdown', defaultPath: join(app.getPath('documents'), file),
      filters: [{ name: 'Markdown', extensions: ['md'] }] };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { file: null };
    writeFileSync(result.filePath, exportMarkdown(request, result.filePath), 'utf8');
    exported.add(result.filePath);
    return { file: result.filePath };
  } catch (error) {
    console.error(`[main] cannot export the UI issues: ${(error as Error).message}`);
    throw error;
  }
}

/** @brief 在资源管理器里选中这次运行导出过的文件。 */
function showExport(file: unknown): void {
  if (typeof file !== 'string' || !exported.has(file)) {
    console.error(`[main] refused to show ${String(file)}: not an exported file`);
    throw new Error('Not an exported file');
  }
  shell.showItemInFolder(file);
}

/** @brief 在资源管理器里选中一份报告（详情里的"Show in Explorer"）；只接受报告文件夹里已存在的报告文件。 */
function showRecord(name: unknown): void {
  try {
    if (typeof name !== 'string' || !isRecordName(name)) throw new Error('Not a UI issue report');
    const file = join(issuesDir(), name);
    if (!existsSync(file)) throw new Error(`The record file is missing: ${name}`);
    shell.showItemInFolder(file);
  } catch (error) {
    console.error(`[main] refused to show the UI issue ${String(name)}: ${(error as Error).message}`);
    throw error;
  }
}

/** @brief 在资源管理器里打开报告文件夹（还没有时先建好）；打不开时返回原文。 */
async function openFolder(): Promise<{ error: string | null }> {
  try {
    const dir = issuesDir();
    mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return { error: null };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[main] cannot open the UI issues folder: ${message}`);
    return { error: message };
  }
}

/**
 * @brief 注册 UI issues 的通道；只有 Mori 自己的页面能调用。
 * @param isAppPage 判断地址是否是 Mori 自己的页面
 */
export function registerIssuesHandlers(isAppPage: (url: string) => boolean): void {
  const check = (event: IpcMainInvokeEvent) => {
    if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  };
  ipcMain.handle('mori:issues-list', (event: IpcMainInvokeEvent) => {
    check(event);
    return listIssues();
  });
  ipcMain.handle('mori:issues-shot', (event: IpcMainInvokeEvent, name: unknown) => {
    check(event);
    return issueShot(name);
  });
  ipcMain.handle('mori:issues-export', (event: IpcMainInvokeEvent, request: unknown) => {
    check(event);
    return exportIssues(event, request);
  });
  ipcMain.handle('mori:issues-show-export', (event: IpcMainInvokeEvent, file: unknown) => {
    check(event);
    showExport(file);
  });
  ipcMain.handle('mori:issues-show-record', (event: IpcMainInvokeEvent, name: unknown) => {
    check(event);
    showRecord(name);
  });
  ipcMain.handle('mori:issues-open-folder', (event: IpcMainInvokeEvent) => {
    check(event);
    return openFolder();
  });
}
