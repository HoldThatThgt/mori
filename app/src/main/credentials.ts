// API key 的保存：用 Electron safeStorage 加密（Windows 上是 DPAPI，绑定当前用户）后写入 `<userData>/credentials.json`，
// 按 provider id 一项（M6 起每个连接一项）；连接删掉时删除它那一项。
// 不写明文，不放进环境变量；解密后的 key 只经进程通道交给后台进程，由 pi 放在内存里使用。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

/** @brief 加密文件：provider id → base64 密文。 */
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

/** @brief 解密全部已保存的 key；某一项解不开时记录错误并跳过。 */
export function loadKeys(): Record<string, string> {
  requireEncryption();
  const keys: Record<string, string> = {};
  for (const [providerId, cipher] of Object.entries(readEncrypted())) {
    try {
      keys[providerId] = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    } catch (error) {
      console.error(`[main] cannot decrypt the key for ${providerId}: ${(error as Error).message}`);
    }
  }
  return keys;
}

/** @brief 加密保存一个 key。 */
export function storeKey(providerId: string, key: string): void {
  requireEncryption();
  const keys = readEncrypted();
  keys[providerId] = safeStorage.encryptString(key).toString('base64');
  writeEncrypted(keys);
}

/** @brief 删除一个 provider 已保存的 key；没有时什么都不做。 */
export function deleteKey(providerId: string): void {
  const keys = readEncrypted();
  if (!(providerId in keys)) return;
  delete keys[providerId];
  writeEncrypted(keys);
}
