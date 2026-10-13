export const projectTools = {
  mori: {
    plugin: { name: '项目助手', description: '把代码检查的 Skill 和项目文件的 MCP 放在一起管理。', skill: 'review' },
    skills: {
      review: { name: '代码检查', command: 'code-review', plugin: true,
        description: '检查改动是否满足任务要求，整理问题和验证依据。',
        trigger: '需要检查代码改动、核对完成条件或整理检查结果时。',
        steps: ['读取任务目标、约束和相关改动。', '核对行为与验证结果，保留问题对应的依据。',
          '先说明结论，再列出需要处理的问题；没有证据时不宣称通过。'] },
      recap: { name: '工作回顾', command: 'work-review', plugin: false,
        description: '回顾反馈与普通沟通，整理有来源、有限定范围的候选。',
        trigger: '执行工作回顾、整理纠正和沟通中的理解偏差时。',
        steps: ['查看用户原话、任务上下文和后续实际结果。', '区分用户明确要求与模型推断，保留冲突和反证。',
          '形成待判断的候选；不因一次纠正直接发布长期偏好。'] },
    },
    mcp: { name: '项目文件', description: '让 Mori 读取、搜索和修改当前项目的文件。', scope: 'D:\\code\\mori', tools: [
      { id: 'read', name: '读取文件', description: '查看项目中的代码和文档', icon: 'file', access: '只读' },
      { id: 'search', name: '搜索内容', description: '在项目文件中查找实现和引用', icon: 'search', access: '只读' },
      { id: 'write', name: '写入文件', description: '按当前任务的允许范围修改文件', icon: 'code', access: '需任务检查' },
    ] },
  },
  research: {
    plugin: { name: '研究助手', description: '一起管理来源核对 Skill 和研究资料 MCP。', skill: 'sources' },
    skills: {
      sources: { name: '来源核对', command: 'source-check', plugin: true,
        description: '核对引用出处、发布日期，以及原文是否支持结论。',
        trigger: '需要查证资料来源，或检查研究结论的依据时。',
        steps: ['找到结论引用的原始资料。', '核对作者、日期、上下文和适用范围。', '保留原文链接，标出尚未证实的推断。'] },
      compare: { name: '方案对比', command: 'compare-options', plugin: false,
        description: '按同一组问题比较方案，说明适用范围与不确定项。',
        trigger: '整理研究资料并比较不同方案时。',
        steps: ['明确比较问题和使用场景。', '按相同维度整理证据和差异。', '说明结论、适用边界与待核对事项。'] },
    },
    mcp: { name: '研究资料', description: '只读检索资料研究项目的文档和参考来源。', scope: '资料研究项目的文档与参考来源', tools: [
      { id: 'lookup', name: '检索资料', description: '按主题搜索项目内的研究资料', icon: 'search', access: '只读' },
      { id: 'source', name: '读取来源', description: '查看原文及保留的出处信息', icon: 'link', access: '只读' },
    ] },
  },
};
