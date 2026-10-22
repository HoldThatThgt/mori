// API key 的保存：用 Electron safeStorage 加密（Windows 上是 DPAPI，绑定当前用户）后写入 `<userData>/credentials.json`，
// 格式 `{ <ref>: <base64 密文> }`（M0 起不变）。v1 起按 key 的 ref 一项（docs/specs/model-providers.md §4.1）：
// 新 key 的 ref 是 <提供商 id>#<编号>，从 v0 迁移来的沿用 v0 的提供商 id。
// 不写明文，不放进环境变量；解密后的 key 只经进程通道交给后台进程，放在模型池的内存里使用。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

/** @brief 加密文件：key 的 ref → base64 密文。 */
type EncryptedKeys = Record<string, string>;

/** @brief 加密文件的位置。 */
function credentialsPath(): string {
  return join(app.getPath('userData'), 'credentials.json');
}

/** @brief 系统加密不可用时直接报错，不退回明文保存。 */
function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('System encryption (safeStorage) is not available');
}

/** @brief 读取加密文件；不存在时返回空对象。 */
function readEncrypted(): EncryptedKeys {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf8')) as EncryptedKeys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** @brief 写加密文件；先写临时文件再改名。 */
function writeEncrypted(keys: EncryptedKeys): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(keys, null, 2)}\n`, 'utf8');
  renameSync(`${path}.tmp`, path);
}

/**
 * @brief 解密全部已保存的 key；某一项解不开时记录错误并跳过。
 * @return ref → 明文
 */
export function loadKeys(): Record<string, string> {
  requireEncryption();
  const keys: Record<string, string> = {};
  for (const [ref, cipher] of Object.entries(readEncrypted())) {
    try {
      keys[ref] = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    } catch (error) {
      console.error(`[main] cannot decrypt the key ${ref}: ${(error as Error).message}`);
    }
  }
  return keys;
}

/**
 * @brief 加密保存一个 key（新加的 key，或迁移时 models.json 里手写的明文 key）。
 * @param ref key 的引用
 * @param secret 明文
 */
export function storeKey(ref: string, secret: string): void {
  requireEncryption();
  const keys = readEncrypted();
  keys[ref] = safeStorage.encryptString(secret).toString('base64');
  writeEncrypted(keys);
}

/**
 * @brief 删除一个 ref 已保存的密文；没有时什么都不做。
 * @param ref key 的引用
 */
export function deleteKey(ref: string): void {
  const keys = readEncrypted();
  if (!(ref in keys)) return;
  delete keys[ref];
  writeEncrypted(keys);
}
