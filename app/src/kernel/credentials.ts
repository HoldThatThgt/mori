// 请主进程加密保存或删除 API key（只有主进程能用系统加密，docs/specs/model-providers.md §4.1）。
// key 按 ref 存取：新 key 的 ref 是 <提供商 id>#<编号>，从 v0 迁移来的沿用 v0 的提供商 id。
// 后台进程自己只把明文放在模型池的内存里（modelPool.ts），不写进任何文件、不交给 pi。

type Waiting = { resolve: () => void; reject: (error: Error) => void };

let nextId = 1;
const waiting = new Map<number, Waiting>();

/**
 * @brief 请主进程加密保存一个 key，等它回复结果。
 * @param ref key 的引用
 * @param secret 要保存的明文；为 null 时删除这个 ref 已保存的密文（删 key、删提供商、改地址，或保存失败后撤回新 key）
 */
export function requestStoreKey(ref: string, secret: string | null): Promise<void> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    process.parentPort.postMessage({ type: 'store-key', id, ref, key: secret });
  });
}

/**
 * @brief 处理主进程的保存结果。
 * @param id 请求序号
 * @param error 失败时的原文；成功为 null
 */
export function onStoreKeyResult(id: number, error: string | null): void {
  const entry = waiting.get(id);
  if (!entry) return;
  waiting.delete(id);
  if (error) entry.reject(new Error(error));
  else entry.resolve();
}
