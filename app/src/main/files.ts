// 文件阅读器与复制用到的系统操作（方案 5.9、5.4，状态表见 docs/v0/screens/changes.md、selection.md）：
// 只读地读一个文件、用系统默认程序打开它、把文字写进剪贴板。界面进程是沙箱，这几件事由主进程做；不监视文件。

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { MAX_PREVIEW_BYTES, type FileRead } from '../shared/files';

/** 判断二进制时看的开头字节数（与 git 相同的做法：开头有 0 字节就当二进制） */
const BINARY_PROBE_BYTES = 8000;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * @brief 按 pi 工具解析路径的规则找到文件（照搬 pi 1.3.0 utils/paths.js 的 normalizePath / resolvePath，
 *        即 edit、write、read 用的 resolveToCwd）：去掉开头的 @、展开 ~、Git Bash 的 /c/... 换成 C:\...、file:// 换成路径，
 *        再相对工作目录。
 */
export function resolveToolPath(input: string, cwd: string): string {
  let path = input.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
  if (drive && !path.startsWith('//') && !path.includes('\\')) {
    path = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll('/', '\\') ?? ''}`;
  }
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) path = join(homedir(), path.slice(2));
  if (path.startsWith('file://')) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** @brief 文件不存在的错误。 */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** @brief 读出不超过 MAX_PREVIEW_BYTES 的文件内容并判断是不是文本。 */
async function readSmall(path: string, size: number): Promise<FileRead> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { status: 'binary', path, size };
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { status: 'ok', path, text: bytes.toString('utf8'), sha256, size };
  } finally {
    await handle.close();
  }
}

/**
 * @brief 解析路径；网络路径（\\主机\共享）不读也不打开：路径来自模型的工具参数，访问它会让 Windows 向那台主机认证。
 *        解析出错或是网络路径时抛错。
 */
function localPath(input: string, cwd: string): string {
  const path = resolveToolPath(input, cwd);
  if (path.startsWith('\\\\')) throw new Error(`Network paths are not opened: ${path}`);
  return path;
}

/** @brief 读一个文件给阅读器；不抛错，失败时把原文放进结果。 */
async function readFile(input: string, cwd: string): Promise<FileRead> {
  let path = input;
  try {
    path = localPath(input, cwd);
    const info = await stat(path);
    if (info.isDirectory()) return { status: 'directory', path };
    if (info.size > MAX_PREVIEW_BYTES) return { status: 'large', path, size: info.size };
    return await readSmall(path, info.size);
  } catch (error) {
    if (isMissing(error)) return { status: 'missing', path };
    const message = (error as Error).message;
    console.error(`[main] cannot read ${path}: ${message}`);
    return { status: 'error', path, message };
  }
}

/** 直接"打开"会运行它的扩展名（Windows 按关联程序执行），在 PATHEXT 之外再加上常见的脚本、快捷方式和安装包 */
const RUNNABLE = ['.com', '.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msc', '.ps1',
  '.psm1', '.py', '.pyw', '.lnk', '.url', '.hta', '.msi', '.msp', '.scr', '.cpl', '.reg', '.jar', '.appref-ms',
  '.application', '.website', '.settingcontent-ms'];

/** @brief 这个文件直接打开时会不会被运行。 */
function runnable(path: string): boolean {
  const extensions = [...RUNNABLE, ...(process.env.PATHEXT ?? '').toLowerCase().split(';').filter(Boolean)];
  return extensions.includes(extname(path).toLowerCase());
}

/**
 * @brief 用系统默认程序打开文件（文件夹在资源管理器里打开）；失败时返回原文。会被运行的文件（脚本、程序、快捷方式）
 *        不打开，改为在资源管理器里选中它（revealed 为真），免得点"用系统编辑器打开"就执行了模型写的东西。
 */
async function openPath(input: string, cwd: string): Promise<{ error: string | null; revealed: boolean }> {
  try {
    const path = localPath(input, cwd);
    if (runnable(path)) {
      shell.showItemInFolder(path);
      return { error: null, revealed: true };
    }
    const error = await shell.openPath(path);
    if (error) console.error(`[main] cannot open ${path}: ${error}`);
    return { error: error || null, revealed: false };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[main] cannot open ${input}: ${message}`);
    return { error: message, revealed: false };
  }
}

/** @brief 参数必须是字符串。 */
function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${what}`);
  return value;
}

/**
 * @brief 注册阅读器与复制用的三个通道；只有 Mori 自己的页面能调用。
 * @param isAppPage 判断地址是否是 Mori 自己的页面
 */
export function registerFileHandlers(isAppPage: (url: string) => boolean): void {
  const check = (event: IpcMainInvokeEvent) => {
    if (!event.senderFrame || !isAppPage(event.senderFrame.url)) throw new Error('Not allowed');
  };
  ipcMain.handle('mori:read-file', (event: IpcMainInvokeEvent, path: unknown, cwd: unknown) => {
    check(event);
    return readFile(text(path, 'path'), text(cwd, 'cwd'));
  });
  ipcMain.handle('mori:open-path', (event: IpcMainInvokeEvent, path: unknown, cwd: unknown) => {
    check(event);
    return openPath(text(path, 'path'), text(cwd, 'cwd'));
  });
  ipcMain.handle('mori:copy-text', (event: IpcMainInvokeEvent, value: unknown) => {
    check(event);
    clipboard.writeText(text(value, 'text'));
  });
}
