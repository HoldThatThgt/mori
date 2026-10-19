// M0 的临时界面：连接、选文件夹、最简对话。M1 会用正式界面替换它。

import { useEffect, useState } from 'react';
import type { ConfigInfo, Connection, SessionInfo, TestResult } from '../../shared/protocol';
import { Chat } from './Chat';

// 上下文长度的默认值是临时默认值，见 docs/v0/defaults.md
const emptyForm: Connection = { name: '', baseUrl: '', apiKey: '', modelId: '', contextWindow: 128000 };
const ENV_REFERENCE = /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;

/** @brief 把异常转成一行文字，并记录到控制台。 */
function describe(what: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[renderer] ${what} failed: ${message}`);
  return message;
}

/** @brief 连接表单的状态与操作。 */
function useConnectionForm(onSaved: (saved: boolean) => void) {
  const [form, setForm] = useState<Connection>(emptyForm);
  const [keySaved, setKeySaved] = useState(false);
  const [message, setMessage] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.mori.request<ConfigInfo>({ type: 'config.get' }).then(
      (info) => {
        if (!info.saved) return;
        setForm(info.saved.connection);
        setKeySaved(info.saved.apiKeyKind === 'literal');
        onSaved(true);
      },
      (error: unknown) => setMessage(`读取配置失败：${describe('config.get', error)}`),
    );
  }, [onSaved]);

  async function run(what: string, action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setMessage(`${what}失败：${describe(what, error)}`);
    } finally {
      setBusy(false);
    }
  }

  const save = () => run('保存', async () => {
    setTest(null);
    const result = await window.mori.request<{ error: string | null }>({ type: 'connection.save', connection: form });
    setMessage(result.error ? `已保存，但配置有错误：${result.error}` : '已保存');
    setKeySaved(form.apiKey ? !ENV_REFERENCE.test(form.apiKey) : keySaved);
    onSaved(true);
  });
  const runTest = () => run('测试', async () => {
    setMessage('测试中…');
    setTest(await window.mori.request<TestResult>({ type: 'connection.test' }));
    setMessage('');
  });
  return { form, setForm, keySaved, message, test, busy, save, runTest };
}

/** @brief 测试连接的结果。 */
function TestView({ result }: { result: TestResult }) {
  if (!result.ok) return <p className="error">连接失败：{result.error ?? '没有收到回复'}</p>;
  const thinking = result.thinking ? ' · 有思考内容' : '';
  return (
    <p className="ok">
      连接成功 · 首字 {result.firstTokenMs} ms · 共 {result.totalMs} ms{thinking} · 回复：{result.text}
    </p>
  );
}

/** @brief 连接表单：保存到 pi 的 models.json，并测试一次真实请求。 */
function ConnectionPanel({ onSaved }: { onSaved: (saved: boolean) => void }) {
  const { form, setForm, keySaved, message, test, busy, save, runTest } = useConnectionForm(onSaved);
  const field = (key: keyof Connection) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: key === 'contextWindow' ? Number(event.target.value) : event.target.value });
  const keyHint = keySaved ? '已保存（不显示）；改了服务地址就要重新填写' : 'key 本身，或 $环境变量名';
  return (
    <section className="panel">
      <h2>连接</h2>
      <label>名称<input value={form.name} onChange={field('name')} placeholder="内网模型" /></label>
      <label>服务地址<input value={form.baseUrl} onChange={field('baseUrl')} placeholder="http://host:8000/v1" /></label>
      <label>API key<input value={form.apiKey} onChange={field('apiKey')} placeholder={keyHint} /></label>
      <label>模型 ID<input value={form.modelId} onChange={field('modelId')} placeholder="qwen3-coder" /></label>
      <label>上下文长度<input type="number" value={form.contextWindow} onChange={field('contextWindow')} /></label>
      <div className="row">
        <button onClick={save} disabled={busy}>保存</button>
        <button onClick={runTest} disabled={busy}>测试连接</button>
        <span className="hint">{message}</span>
      </div>
      {test && <TestView result={test} />}
    </section>
  );
}

/** @brief 选文件夹并新建会话；新会话替换当前对话。 */
function FolderPanel({ onSession }: { onSession: (session: SessionInfo) => void }) {
  const [error, setError] = useState('');
  async function open() {
    try {
      const cwd = await window.mori.pickFolder();
      if (!cwd) return;
      onSession(await window.mori.request<SessionInfo>({ type: 'session.create', cwd }));
      setError('');
    } catch (err) {
      setError(`打开失败：${describe('session.create', err)}`);
    }
  }
  return (
    <section className="panel">
      <button onClick={open}>打开文件夹…</button>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** @brief 根组件。 */
export function App() {
  const [hasConnection, setHasConnection] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => window.mori.onKernelExit(setExitCode), []);

  return (
    <main className="app">
      {exitCode !== null && <p className="error">Mori 的后台进程意外退出（{exitCode}）· 请重新启动 Mori</p>}
      <ConnectionPanel onSaved={setHasConnection} />
      {hasConnection && <FolderPanel onSession={setSession} />}
      {session && <Chat key={session.sessionId} session={session} />}
    </main>
  );
}
