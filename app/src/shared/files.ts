// 文件阅读器（方案 5.9，状态表见 docs/v0/screens/changes.md）：界面与主进程之间的数据形状。
// 文件由主进程只读地读出，不经过后台进程和 pi。

/** 超过这个大小的文件不预览（方案 5.9：超过 1MB 显示"无法预览"） */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

/** @brief 读一个文件的结果；path 都是主进程解析后的绝对路径。 */
export type FileRead =
  /** 文本文件：内容和内容的 SHA-256（十六进制，按原始字节算） */
  | { status: 'ok'; path: string; text: string; sha256: string; size: number }
  /** 文件已被删除或移动 */
  | { status: 'missing'; path: string }
  /** 前 8KB 里有 0 字节 */
  | { status: 'binary'; path: string; size: number }
  /** 超过 MAX_PREVIEW_BYTES */
  | { status: 'large'; path: string; size: number }
  /** 路径是文件夹 */
  | { status: 'directory'; path: string }
  /** 其他读取错误的原文 */
  | { status: 'error'; path: string; message: string };
