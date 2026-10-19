// window.mori 的类型，与 preload 暴露的接口一致。

import type { Command, EventEnvelope } from '../../shared/protocol';

declare global {
  interface Window {
    mori: {
      request<T = unknown>(command: Command): Promise<T>;
      onEvent(listener: (envelope: EventEnvelope) => void): () => void;
      onKernelExit(listener: (code: number) => void): () => void;
      onKernelReady(listener: () => void): () => void;
      restartKernel(): Promise<void>;
      pickFolder(): Promise<string | null>;
    };
  }
}

export {};
