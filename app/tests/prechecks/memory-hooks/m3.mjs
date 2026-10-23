// M3: an inline-extension tool `memory` with plain JSON Schema parameters vs the createAgentSession tools whitelist.
import { makeSession, startServers, stopServers, requests, sessionLines, toolNames, show } from './lib.mjs';

const schema = { type: 'object', properties: { note: { type: 'string', description: 'What to remember' } },
  required: ['note'], additionalProperties: false };

function memoryExt(defaultActive) {
  return { name: 'memory-probe', factory: (api) => {
    api.registerTool({ name: 'memory', label: 'Memory', description: 'Remember a note.', parameters: schema,
      defaultActive,
      execute: async (_id, params) => ({ content: [{ type: 'text', text: `remembered: ${params.note}` }],
        details: {} }) });
  } };
}

async function run(label, { tools, defaultActive = true, call = false }) {
  const { session } = await makeSession({ name: `m3-${label}`, extensions: [memoryExt(defaultActive)], tools });
  show(`${label}: getActiveToolNames()`, session.getActiveToolNames());
  const before = requests.length;
  await session.prompt('plain');
  show(`${label}: request tools array`, toolNames(requests[before]));
  if (call) {
    const n = requests.length;
    await session.prompt('call tool: memory {"note":"hi"}');
    const { lines } = sessionLines(session);
    const result = lines.filter((l) => l.type === 'message' && l.message.role === 'toolResult').at(-1);
    show(`${label}: memory call result in session file`, result?.message);
    show(`${label}: requests made for the call`, requests.length - n);
  }
  session.dispose();
}

await startServers('m3');
try {
  await run('a-nowhitelist', { tools: undefined });
  await run('b-read-memory', { tools: ['read', 'memory'], call: true });
  await run('c-read-only', { tools: ['read'] });
  await run('d-inactive-nowhitelist', { tools: undefined, defaultActive: false });
  await run('e-inactive-read-memory', { tools: ['read', 'memory'], defaultActive: false });
} finally {
  await stopServers();
}
