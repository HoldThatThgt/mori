// 工具页的"Skills"一节（docs/v0/screens/tools.md）：全部技能（含停用的、插件里的），开关启停，展开看 SKILL.md 正文和路径。

import { useState } from 'react';
import type { ResourceEntry } from '../../../shared/protocol';
import { toggleCommand, useChange } from '../state/tools';
import { Icon } from '../icons';
import { OpenInEditor, ResourceNotes, ToolSwitch, useSwitch } from './ToolsCommon';

/** @brief 技能的来源：用户级 / 本项目 / 插件里的。 */
function skillScope(skill: ResourceEntry): 'user' | 'project' | 'package' {
  return skill.origin === 'package' ? 'package' : skill.scope;
}

/** @brief 来源的文字："User" / "Project" / "Plugin <包>"。 */
function skillSource(skill: ResourceEntry): string {
  if (skill.origin === 'package') return `Plugin ${skill.packageSource ?? ''}`;
  return skill.scope === 'user' ? 'User' : 'Project';
}

/** @brief 一个技能：名字、来源、用途、开关；展开后是正文（去掉 frontmatter）和文件路径。 */
function SkillRow({ skill, cwd }: { skill: ResourceEntry; cwd: string }) {
  const [open, setOpen] = useState(false);
  const change = useChange();
  const power = useSwitch(change, skill.enabled, (next) => toggleCommand(skill.kind, skill.path, next));
  return (
    <li className={`tools-row${power.checked ? '' : ' off'}`} data-testid="skill-row" data-name={skill.name}
      data-scope={skillScope(skill)}>
      <div className="tools-row-head">
        <button type="button" className="tools-row-main" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevron" className="tools-chevron" />
          <span className="tools-row-name">{skill.name}</span>
          <span className="tools-tag">{skillSource(skill)}</span>
          {skill.description && (
            <span className="tools-row-desc" title={skill.description}>{skill.description}</span>)}
        </button>
        <ToolSwitch checked={power.checked} label={`Enable skill ${skill.name}`}
          disabled={change.busy || !!skill.readOnly} title={skill.readOnly ?? undefined} onChange={power.toggle} />
      </div>
      <ResourceNotes readOnly={skill.readOnly} error={change.error} />
      {open && (
        <div className="tools-detail">
          <p className="tools-path">
            <span className="tools-mono">{skill.path}</span>
            <OpenInEditor path={skill.path} cwd={cwd} />
          </p>
          {skill.body && <pre className="tools-body">{skill.body}</pre>}
        </div>
      )}
    </li>
  );
}

/** @brief "Skills"一节；diagnostics 是 pi 报告的问题原文，列在列表下方。 */
export function SkillsSection({ skills, diagnostics, cwd, agentDir }: {
  skills: ResourceEntry[]; diagnostics: string[]; cwd: string; agentDir: string;
}) {
  return (
    <>
      <h2>Skills</h2>
      {skills.length === 0 ? (
        <p className="tools-empty">
          No skills yet. Put a skill folder (with a SKILL.md) in {agentDir}\skills or in the project’s .pi\skills,
          or add a plugin.
        </p>
      ) : (
        <ul className="tools-list">{skills.map((skill) => <SkillRow key={skill.path} skill={skill} cwd={cwd} />)}</ul>
      )}
      {diagnostics.length > 0 && (
        <div className="tools-warn" role="status" data-testid="skill-diagnostics">
          {diagnostics.map((text, index) => <p key={index}>{text}</p>)}
        </div>
      )}
    </>
  );
}
