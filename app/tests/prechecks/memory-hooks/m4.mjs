// M4: tool_call handler blocks `write`. M5: getSessionStats() after the run.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSession, startServers, stopServers, requests, sessionLines, roles, show } from './lib.mjs';

const blockExt = { name: 'block-write', factory: (api) => {
  api.on('tool_call', (event) => {
    show('tool_call event', { toolName: event.toolName, input: event.input });
    if (event.toolName === 'write') return { block: true, reason: 'R' };
    return undefined;
  });
} };

await startServers('m4');
try {
  const { session, cwd } = await makeSession({ name: 'm4', extensions: [blockExt] });
  const before = requests.length;
  await session.prompt('call tool: write {"path":"x.txt","content":"y"}');
  show('requests in run', requests.slice(before).map(roles));
  const followUp = requests[before + 1];
  show('tool message sent to the model in the follow-up request', followUp?.messages.filter((m) => m.role === 'tool'));
  const { lines, file } = sessionLines(session);
  show('session file', file);
  for (const l of lines.filter((x) => x.type === 'message' && ['assistant', 'toolResult'].includes(x.message.role))) {
    show(`session line role=${l.message.role}`, l.message);
  }
  show('x.txt exists in cwd?', String(existsSync(join(cwd, 'x.txt'))));
  // M5
  show('M5 getSessionStats()', session.getSessionStats());
  show('M5 usage fields of the follow-up request', { stream_options: followUp?.stream_options });
  session.dispose();
} finally {
  await stopServers();
}
