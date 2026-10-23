// M2: custom sections every run (no patch when unchanged), then change taste + drop facts. M7: getCurrentSystemMessage.
import { makeSession, startServers, stopServers, requests, sessionLines, systemTexts, show, roles, pi, piAi }
  from './lib.mjs';

const state = { run: 0 };
const teamExt = { name: 'mori-team-probe', factory: (api) => {
  api.on('before_agent_start', (event) => { event.systemPromptOptions.sections.mori_team = '- team section'; });
} };
const promptExt = { name: 'mori-prompt-probe', factory: (api) => {
  api.on('before_agent_start', (event) => {
    const o = event.systemPromptOptions;
    o.customPrompt = 'IDENTITY-X';
    o.sections.taste = state.run >= 3 ? '- b' : '- a';
    o.sections.strategy = '- s';
    o.sections.review = '- r';
    if (state.run < 3) o.sections.facts = '- f';
    show(`run ${state.run}: section keys after hook`, Object.keys(o.sections));
  });
} };

async function scenario(label, compat) {
  state.run = 0;
  const { session } = await makeSession({ name: `m2-${label}`, extensions: [teamExt, promptExt], compat });
  for (let i = 1; i <= 3; i++) {
    state.run = i;
    const before = requests.length;
    await session.prompt(`plain run ${i}`);
    const body = requests[before];
    show(`${label} run ${i}: request roles`, roles(body));
    show(`${label} run ${i}: request system messages`, systemTexts(body).map((t, n) => `[#${n}]\n${t}`).join('\n'));
    const { lines } = sessionLines(session);
    const sys = lines.map((l, idx) => ({ idx, l })).filter(({ l }) => l.type === 'message' && l.message.role === 'system');
    show(`${label} after run ${i}: session file system messages (line index)`,
      sys.map(({ idx, l }) => ({ line: idx, sections: l.message.sections, content: l.message.content,
        toolsAdded: l.message.toolsAdded?.map((t) => t.name), toolsRemoved: l.message.toolsRemoved })));
  }
  show(`${label}: M7 getCurrentSystemMessage(session.messages).sections`,
    piAi.getCurrentSystemMessage(session.messages)?.sections);
  const file = session.sessionManager.getSessionFile();
  session.dispose();
  const reopened = pi.SessionManager.open(file);
  const fromFile = piAi.getCurrentSystemMessage(reopened.buildSessionContext().messages);
  show(`${label}: M7 getCurrentSystemMessage(SessionManager.open(file).buildSessionContext().messages)`,
    { sections: fromFile?.sections, content: fromFile?.content, tools: fromFile?.toolsAdded?.map((t) => t.name) });
  show(`${label}: M7 getCurrentSystemPrompt(from file)`,
    piAi.getCurrentSystemPrompt(reopened.buildSessionContext().messages));
}

await startServers('m2');
try {
  await scenario('default');
  await scenario('midconvo', { supportsMidConvoSystemMessages: true });
} finally {
  await stopServers();
}
