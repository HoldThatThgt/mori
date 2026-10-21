// 工作回顾（方案 5.14，状态表见 docs/v0/screens/review.md）：读出对内容的反馈和界面问题报告、读报告的截图、
// 导出为 Markdown、在资源管理器里打开文件夹。方案第 4 节"选区反馈、F8 界面问题 · Mori · 记录、收件箱、导出"。
// 记录文件只读不改；不经过后台进程和 pi，后台进程退出后也能用。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { FeedbackSchema } from '../shared/feedback';
import {
  ExportRequestSchema, ISSUE_NAME, KIND_LABEL, REVIEW_KINDS, type BrokenRecord, type ExportRequest, type ExportResult,
  type FeedbackRecord, type IssueRecord, type ReviewKind, type ReviewRecords,
} from '../shared/review';
import { feedbackDir, issuesDir, localTime } from './feedback';

/** 存下的一份反馈：保存时刻（ISO，UTC）加界面交来的内容（main/feedback.ts saveFeedback） */
const StoredFeedbackSchema = FeedbackSchema.extend({ createdAt: z.iso.datetime() });

/** 报告里的各节，按报告里的顺序（main/feedback.ts issueMarkdown） */
const ISSUE_SECTIONS = ['哪里不对', '你期望什么', '截图', '当前界面', '最近的操作', '版本'] as const;
/** 报告里的一节 */
type IssueSection = (typeof ISSUE_SECTIONS)[number];

/** 记录文件名开头的保存时刻（本地时间 YYYY-MM-DD-HHmmss，main/feedback.ts fileStamp） */
const STAMP = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/;

/** 这次运行里导出过的文件；只有它们可以在资源管理器里选中 */
const exported = new Set<string>();

/** @brief 这一类记录的文件夹。 */
function kindDir(kind: ReviewKind): string {
  return kind === 'feedback' ? feedbackDir() : issuesDir();
}

/** @brief 文件名是不是这一类的记录：反馈是 .json；报告是报告时间格式的 .md（导出到这个文件夹里的 .md 不算）。 */
function isRecordName(kind: ReviewKind, name: string): boolean {
  if (basename(name) !== name) return false;
  if (kind === 'feedback') return name.endsWith('.json');
  return name.endsWith('.md') && ISSUE_NAME.test(name.slice(0, -3));
}

/**
 * @brief 按保存时刻比较两个记录的文件名：去掉扩展名后按数字比较，同一秒再存的 -2 排在不带序号的后面、-10 在 -9 后面
 *        （直接按字符比较时 "-" 小于 "."，同一秒的几份会倒过来）。
 */
function byStamp(left: string, right: string): number {
  const stem = (name: string) => name.slice(0, name.lastIndexOf('.'));
  return stem(left).localeCompare(stem(right), 'en', { numeric: true });
}

/** @brief 文件夹里这一类的记录，按文件名（保存时刻）从新到旧；文件夹不存在时为空。 */
function recordNames(kind: ReviewKind): string[] {
  const dir = kindDir(kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isRecordName(kind, entry.name))
    .map((entry) => entry.name).sort(byStamp).reverse();
}

/**
 * @brief 一份反馈的保存时刻（毫秒）：读出来的按 createdAt（改过系统时区、夏令时回拨时文件名的顺序不对）；
 *        读不出来的按文件名里的本地时间，不是这种文件名时排在最后。
 */
function feedbackMoment(record: FeedbackRecord | BrokenRecord): number {
  if (record.status === 'ok') return Date.parse(record.createdAt);
  const stamp = STAMP.exec(record.name);
  if (!stamp) return 0;
  const [year, month, day, hour, minute, second] = stamp.slice(1).map(Number);
  return new Date(year!, month! - 1, day!, hour!, minute!, second!).getTime();
}

/** @brief 读一个记录文件的文字；去掉开头的 BOM（在设成"UTF-8 带 BOM"的编辑器里另存过的）。 */
function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

/** @brief 读不出来的记录：记录错误日志，原文交给界面。 */
function broken(kind: ReviewKind, name: string, error: unknown): BrokenRecord {
  const message = error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message;
  console.error(`[main] cannot read the ${kind} record ${name}: ${message}`);
  return { status: 'broken', name, error: message };
}

/** @brief 读一份反馈。 */
function readFeedback(name: string): FeedbackRecord | BrokenRecord {
  try {
    const text = readText(join(feedbackDir(), name));
    const { createdAt, ...feedback } = StoredFeedbackSchema.parse(JSON.parse(text));
    return { status: 'ok', name, createdAt, time: localTime(new Date(createdAt)), feedback };
  } catch (error) {
    return broken('feedback', name, error);
  }
}

/**
 * @brief 一节在报告里的行号：第一节取第一次出现，之后的从后往前找。"截图"及之后的几节是 Mori 生成的，不会有标题行；
 *        你写的两节里像标题的行从 M7 起写报告时加了转义（main/feedback.ts written）。更早的报告里，"你期望什么"
 *        写了一行"## 你期望什么"时分不清哪一行是真的标题，那一行之前的字会被算进"哪里不对"。
 */
function sectionLines(lines: string[]): Record<IssueSection, number> {
  const found = {} as Record<IssueSection, number>;
  let end = lines.length;
  for (const section of [...ISSUE_SECTIONS].reverse()) {
    const heading = `## ${section}`;
    const index = section === ISSUE_SECTIONS[0] ? lines.indexOf(heading) : lines.lastIndexOf(heading, end - 1);
    if (index < 0 || index >= end) throw new Error(`The report has no "${heading}" section`);
    found[section] = index;
    end = index;
  }
  return found;
}

/** @brief 报告各节的原文（去掉首尾空行）。 */
function reportSections(text: string): { time: string; sections: Record<IssueSection, string> } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = /^# 界面问题 · (.+)$/.exec(lines[0] ?? '');
  if (!title) throw new Error('The report has no "# 界面问题 · <time>" title');
  const at = sectionLines(lines);
  const sections = {} as Record<IssueSection, string>;
  ISSUE_SECTIONS.forEach((section, index) => {
    const next = ISSUE_SECTIONS[index + 1];
    sections[section] = lines.slice(at[section] + 1, next ? at[next] : lines.length).join('\n').trim();
  });
  return { time: title[1]!.trim(), sections };
}

/**
 * @brief 报告里"截图"一节：截图的文件名，或没有截图时的原文。这里不看 PNG 还在不在：被删了的由详情读截图时显示
 *        "截图读不出来"，导出照样链接原来的 PNG。
 */
function reportShot(text: string): { shot: string | null; shotError: string | null } {
  const image = /^!\[截图\]\((.+)\)$/.exec(text);
  if (image) {
    const shot = image[1]!;
    if (isShotName(shot)) return { shot, shotError: null };
    return { shot: null, shotError: `Not a report screenshot: ${shot}` };
  }
  return { shot: null, shotError: text.replace(/^截图失败：/, '') || 'No screenshot section' };
}

/** @brief 读一份界面问题报告。 */
function readIssue(name: string): IssueRecord | BrokenRecord {
  try {
    const { time, sections } = reportSections(readText(join(issuesDir(), name)));
    return { status: 'ok', name, time, what: sections['哪里不对'], expect: sections['你期望什么'],
      ...reportShot(sections['截图']), view: sections['当前界面'], actions: sections['最近的操作'],
      versions: sections['版本'] };
  } catch (error) {
    return broken('issues', name, error);
  }
}

/** @brief 读出两类记录（反馈按保存时刻、报告按文件名，从新到旧）；读文件夹出错时报错（文件夹不存在算空）。 */
function listReview(): ReviewRecords {
  try {
    const feedback = recordNames('feedback').map(readFeedback)
      .sort((left, right) => feedbackMoment(right) - feedbackMoment(left));
    return { feedback, issues: recordNames('issues').map(readIssue) };
  } catch (error) {
    console.error(`[main] cannot list the review records: ${(error as Error).message}`);
    throw error;
  }
}

/** @brief 是不是报告的截图：报告时间格式的 .png 文件名。 */
function isShotName(name: string): boolean {
  return basename(name) === name && name.endsWith('.png') && ISSUE_NAME.test(name.slice(0, -4));
}

/** @brief 一份报告的截图（data URL）；只接受报告文件夹里报告时间格式的 .png。 */
function reviewShot(value: unknown): string {
  const name = typeof value === 'string' ? value : '';
  try {
    if (!isShotName(name)) throw new Error('Not a report screenshot');
    return `data:image/png;base64,${readFileSync(join(issuesDir(), name)).toString('base64')}`;
  } catch (error) {
    console.error(`[main] cannot read the screenshot ${String(value)}: ${(error as Error).message}`);
    throw error;
  }
}

/** @brief 引用块：每行前加"> "。 */
function quoted(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => `> ${line}`).join('\n');
}

/** @brief 反馈的范围：回复里的选区 / 整条回复 / 文件和行范围。 */
function feedbackScope(record: FeedbackRecord): string {
  const source = record.feedback.source;
  if (source.kind === 'file') {
    const lines = source.startLine === source.endLine ? `第 ${source.startLine} 行`
      : `第 ${source.startLine}–${source.endLine} 行`;
    return `文件 ${source.path} ${lines}`;
  }
  return source.scope === 'reply' ? '整条回复' : '回复里的选区';
}

/** @brief 导出文件里的一份反馈。 */
function feedbackSection(record: FeedbackRecord): string[] {
  const { feedback } = record;
  return [
    `- 会话：${feedback.session.title || '（没有名字）'}`,
    `- 范围：${feedbackScope(record)}`,
    `- 会话文件：${feedback.session.file ?? '（没有保存）'}`,
    `- 工作目录：${feedback.session.cwd || '（不知道）'}`,
    `- 记录文件：${join(feedbackDir(), record.name)}`, '',
    '### 你希望得到的结果', '', feedback.expected, '',
    '### 引用的原文', '', quoted(feedback.quote), '',
  ];
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
  const shot = record.shot ? `![截图](<${shotLink(target, record.shot)}>)` : `截图失败：${record.shotError ?? ''}`;
  const body: [string, string][] = [['哪里不对', record.what], ['你期望什么', record.expect], ['截图', shot],
    ['当前界面', record.view], ['最近的操作', record.actions], ['版本', record.versions]];
  return [`- 报告文件：${join(issuesDir(), record.name)}`, '',
    ...body.flatMap(([heading, text]) => [`### ${heading}`, '', text, ''])];
}

/** @brief 导出文件里的一条记录。 */
function exportSection(kind: ReviewKind, name: string, index: number, done: boolean, target: string): string[] {
  const state = done ? '已处理' : '未处理';
  const record = kind === 'feedback' ? readFeedback(name) : readIssue(name);
  if (record.status === 'broken') {
    return [`## ${index + 1}. ${name} · ${state}`, '', `- 记录文件：${join(kindDir(kind), name)}`, '',
      `读不出这份记录：${record.error}`, ''];
  }
  const body = 'feedback' in record ? feedbackSection(record) : issueSection(record, target);
  return [`## ${index + 1}. ${record.time} · ${state}`, '', ...body];
}

/** @brief 导出文件的全文。 */
function exportMarkdown(request: ExportRequest, target: string): string {
  const handled = new Set(request.handled);
  const done = request.names.filter((name) => handled.has(name)).length;
  const head = [`# ${KIND_LABEL[request.kind]}`, '',
    `导出于 ${localTime(new Date())} · 共 ${request.names.length} 条：未处理 ${request.names.length - done} 条，`
    + `已处理 ${done} 条`, ''];
  const sections = request.names.flatMap((name, index) =>
    exportSection(request.kind, name, index, handled.has(name), target));
  return [...head, ...sections].join('\n');
}

/** @brief 检查导出请求：记录名都要是这一类的文件名。 */
function checkExport(value: unknown): ExportRequest {
  const request = ExportRequestSchema.parse(value);
  const bad = request.names.find((name) => !isRecordName(request.kind, name));
  if (bad) throw new Error(`Not a ${request.kind} record: ${bad}`);
  return request;
}

/** @brief 导出：弹保存对话框，写导出文件；你取消时 file 为 null。 */
async function exportReview(event: IpcMainInvokeEvent, value: unknown): Promise<ExportResult> {
  try {
    const request = checkExport(value);
    const label = KIND_LABEL[request.kind];
    const day = localTime(new Date()).slice(0, 10);
    const options = { title: `导出${label}`, defaultPath: join(app.getPath('documents'), `${label}-${day}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }] };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { file: null };
    writeFileSync(result.filePath, exportMarkdown(request, result.filePath), 'utf8');
    exported.add(result.filePath);
    return { file: result.filePath };
  } catch (error) {
    console.error(`[main] cannot export the review records: ${(error as Error).message}`);
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

/** @brief 在资源管理器里选中一份记录（详情里的"打开所在文件夹"）；只接受这一类文件夹里已存在的记录文件。 */
function showRecord(kind: unknown, name: unknown): void {
  try {
    const parsed = z.enum(REVIEW_KINDS).parse(kind);
    if (typeof name !== 'string' || !isRecordName(parsed, name)) throw new Error('Not a review record');
    const file = join(kindDir(parsed), name);
    if (!existsSync(file)) throw new Error(`The record file is missing: ${name}`);
    shell.showItemInFolder(file);
  } catch (error) {
    console.error(`[main] refused to show the ${String(kind)} record ${String(name)}: ${(error as Error).message}`);
    throw error;
  }
}

/** @brief 在资源管理器里打开一类记录的文件夹（还没有时先建好）；打不开时返回原文。 */
async function openFolder(kind: unknown): Promise<{ error: string | null }> {
  try {
    const dir = kindDir(z.enum(REVIEW_KINDS).parse(kind));
    mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return { error: null };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[main] cannot open the ${String(kind)} folder: ${message}`);
    return { error: message };
  }
}

/**
 * @brief 注册工作回顾的通道；只有 Mori 自己的页面能调用。
 * @param isAppPage 判断地址是否是 Mori 自己的页面
 */
export function registerReviewHandlers(isAppPage: (url: string) => boolean): void {
  const check = (event: IpcMainInvokeEvent) => {
    if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  };
  ipcMain.handle('mori:review-list', (event: IpcMainInvokeEvent) => {
    check(event);
    return listReview();
  });
  ipcMain.handle('mori:review-shot', (event: IpcMainInvokeEvent, name: unknown) => {
    check(event);
    return reviewShot(name);
  });
  ipcMain.handle('mori:review-export', (event: IpcMainInvokeEvent, request: unknown) => {
    check(event);
    return exportReview(event, request);
  });
  ipcMain.handle('mori:review-show-export', (event: IpcMainInvokeEvent, file: unknown) => {
    check(event);
    showExport(file);
  });
  ipcMain.handle('mori:review-show-record', (event: IpcMainInvokeEvent, kind: unknown, name: unknown) => {
    check(event);
    showRecord(kind, name);
  });
  ipcMain.handle('mori:review-open-folder', (event: IpcMainInvokeEvent, kind: unknown) => {
    check(event);
    return openFolder(kind);
  });
}
