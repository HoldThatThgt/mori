// Customize › Agents 的数据（docs/specs/customize-agents.md §4、§5；状态表 docs/v1/screens/customize-agents.md）：
// 跟随的会话所在项目的 agent（roles.get），每次进入这一节、每次保存或删除之后重新读；不监视文件。
// 保存与删除的结果里带着重新读到的内容。只有最后一次读取的结果生效。

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentDraft, RolesDeleteResult, RolesGetResult, RolesInfo, RolesSaveResult,
} from '../../../shared/roles';
import { describe, request } from './bridge';

/** @brief 这一节读到的内容与读取状态。 */
export interface RolesRead {
  /** 读到的内容；还没读到时为 null（界面显示 Loading…） */
  info: RolesInfo | null;
  /** 读取失败的原文；重新读取时清除 */
  error: string | null;
  /** 重新读取（Retry） */
  reload: () => Promise<void>;
  /** 保存、删除的结果带来的新内容 */
  replace: (info: RolesInfo) => void;
}

/**
 * @brief 读跟随的会话所在项目的 agent；会话还在打开中（sessionId 为 null）时不读，打开好后读。
 * @param sessionId 跟随的会话
 */
export function useRolesInfo(sessionId: string | null): RolesRead {
  const [info, setInfo] = useState<RolesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    if (sessionId === null) return;
    latest.current += 1;
    const current = latest.current;
    setError(null);
    try {
      const result = await request<RolesGetResult>({ type: 'roles.get', sessionId });
      if (current !== latest.current) return;
      setInfo(result.info);
      setError(result.error);
    } catch (failure) {
      const message = describe('roles.get', failure);
      if (current === latest.current) setError(message);
    }
  }, [sessionId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const replace = useCallback((next: RolesInfo) => {
    latest.current += 1;
    setInfo(next);
    setError(null);
  }, []);
  return { info, error, reload, replace };
}

/** @brief roles.save（§5.1）：新建（file 为 null）或编辑；命令本身出错时按不写文件、error 为原文。 */
export async function saveAgent(sessionId: string, file: string | null, agent: AgentDraft): Promise<RolesSaveResult> {
  try {
    return await request<RolesSaveResult>({ type: 'roles.save', sessionId, file, agent });
  } catch (failure) {
    return { info: null, file: null, error: describe('roles.save', failure) };
  }
}

/** @brief roles.delete（§5.4）；name 只用于操作记录。 */
export async function deleteAgent(sessionId: string, file: string, name: string): Promise<RolesDeleteResult> {
  try {
    return await request<RolesDeleteResult>({ type: 'roles.delete', sessionId, file, name });
  } catch (failure) {
    return { info: null, error: describe('roles.delete', failure) };
  }
}
