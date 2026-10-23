// M6: setThinkingLevel('low') right after createAgentSession on a reasoning: true model.
import { makeSession, startServers, stopServers, requests, sessionLines, show } from './lib.mjs';

await startServers('m6');
try {
  for (const initial of [undefined, 'medium']) {
    const label = `initial=${initial ?? '(not passed)'}`;
    const { session } = await makeSession({ name: `m6-${initial ?? 'none'}`, reasoning: true, thinkingLevel: initial });
    show(`${label}: thinkingLevel after createAgentSession`, session.thinkingLevel);
    show(`${label}: session file before setThinkingLevel`, sessionLines(session));
    session.setThinkingLevel('low');
    show(`${label}: thinkingLevel after setThinkingLevel('low')`, session.thinkingLevel);
    show(`${label}: entries in memory (sessionManager.getEntries())`,
      session.sessionManager.getEntries().map((e) => ({ type: e.type, thinkingLevel: e.thinkingLevel })));
    const before = requests.length;
    await session.prompt('thinking check');
    const body = requests[before];
    show(`${label}: request thinking params`, { reasoning_effort: body.reasoning_effort, reasoning: body.reasoning,
      thinking: body.thinking, enable_thinking: body.enable_thinking });
    show(`${label}: thinkingLevel after the run`, session.thinkingLevel);
    show(`${label}: session file entries`, sessionLines(session).lines.map((l) => ({ type: l.type,
      thinkingLevel: l.thinkingLevel, role: l.message?.role,
      text: l.message?.role === 'assistant' ? l.message.content.map((c) => c.text ?? `[${c.type}]`).join('|')
        : undefined })));
    session.dispose();
  }
} finally {
  await stopServers();
}
