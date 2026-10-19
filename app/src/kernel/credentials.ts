// 请主进程加密保存 API key（只有主进程能用系统加密）。后台进程自己只把 key 放在 pi 的内存里。

type Waiting = { resolve: () => void; reject: (error: Error) => void };

let nextId = 1;
const waiting = new Map<number, Waiting>();

/** @brief 请主进程加密保存 key，等它回复结果。 */
export function requestStoreKey(providerId: string, key: string): Promise<void> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    process.parentPort.postMessage({ type: 'store-key', id, providerId, key });
  });
}

/** @brief 处理主进程的保存结果。 */
export function onStoreKeyResult(id: number, error: string | null): void {
  const entry = waiting.get(id);
  if (!entry) return;
  waiting.delete(id);
  if (error) entry.reject(new Error(error));
  else entry.resolve();
}
