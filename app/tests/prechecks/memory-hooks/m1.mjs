// M1: customPrompt from before_agent_start; option fields; SYSTEM.md interplay; systemPromptOverride.
import { makeSession, startServers, stopServers, requests, sessionLines, systemTexts, show } from './lib.mjs';

/** Render IDENTITY-X + tools + rules from the options, like a Mori prompt would. */
function render(o) {
  const declared = o.selectedTools.filter((n) => !o.hiddenTools.includes(n));
  const tools = declared.map((n) => `- ${n}: ${o.toolSnippets[n] ?? '(no snippet)'}`).join('\n');
  const rules = [...declared.flatMap((n) => o.toolGuidelines[n] ?? []), ...o.promptGuidelines].map((r) => `- ${r}`);
  return `IDENTITY-X\n\nTools:\n${tools}\n\nRules:\n${rules.join('\n')}`;
}

function identityExt(label, { setPrompt = true } = {}) {
  return { name: `identity-${label}`, factory: (api) => {
    api.on('before_agent_start', (event) => {
      const o = event.systemPromptOptions;
      show(`${label}: options seen by hook`, { customPrompt: o.customPrompt, selectedTools: o.selectedTools,
        hiddenTools: o.hiddenTools, toolSnippets: o.toolSnippets, toolGuidelines: o.toolGuidelines,
        promptGuidelines: o.promptGuidelines, appendSystemPrompt: o.appendSystemPrompt, sections: o.sections,
        contextFiles: o.contextFiles.map((f) => f.path), skills: o.skills.length });
      if (setPrompt) o.customPrompt = render(o);
    });
  } };
}

const toolExt = { name: 'probe-tool', factory: (api) => {
  api.registerTool({ name: 'probe_tool', label: 'Probe', description: 'A probe tool.',
    promptSnippet: 'Probe snippet line', promptGuidelines: ['Use probe_tool only for probing'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }) });
} };

async function run(label, opts) {
  const before = requests.length;
  const { session } = await makeSession({ name: `m1-${label}`, ...opts });
  await session.prompt('plain');
  const body = requests[before];
  show(`${label}: request system messages (${systemTexts(body).length})`, systemTexts(body).join('\n-----\n'));
  const sys = sessionLines(session).lines.filter((l) => l.type === 'message' && l.message.role === 'system');
  show(`${label}: session file system messages`, sys.map((l) => ({ sections: l.message.sections,
    content: l.message.content, toolsAdded: (l.message.toolsAdded ?? []).map((t) => t.name) })));
  session.dispose();
}

await startServers('m1');
try {
  await run('default', { extensions: [identityExt('default')] });
  await run('exttool', { extensions: [toolExt, identityExt('exttool')] });
  const md = { '.pi/SYSTEM.md': 'SYSTEM-MD-TEXT from project' };
  await run('sysmd-baseline', { extensions: [identityExt('sysmd-baseline', { setPrompt: false })],
    trusted: true, projectFiles: md });
  await run('sysmd-hook', { extensions: [identityExt('sysmd-hook')], trusted: true, projectFiles: md });
  await run('sysmd-override', { extensions: [identityExt('sysmd-override', { setPrompt: false })], trusted: true,
    projectFiles: md, loaderExtra: { systemPromptOverride: () => undefined } });
} finally {
  await stopServers();
}
