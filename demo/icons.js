const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  right: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
  file: '<path d="M14 3H5v18h14V8Zm0 0v5h5M8 13h8M8 17h5"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14"/>',
  terminal: '<path d="m5 6 6 6-6 6m8 0h6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/>' +
    '<rect x="14" y="4" width="6" height="6" rx="1"/><path d="M4 14h6v6H4Zm10 0h6v6h-6Z"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/>' +
    '<circle cx="15" cy="17" r="3"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  feedback: '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"/>' +
    '<path d="M7 9h10M7 13h6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/>' +
    '<circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 6-12 4-12 9"/>',
  memory: '<path d="M12 4C4 0 1 10 5 12c-4 4 1 11 7 7 6 4 11-3 7-7 4-2 1-12-7-8Z"/>' +
    '<path d="M12 4v15M7 8l5 3m5-3-5 3"/>',
  link: '<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0"/>' +
    '<path d="m14 9 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(-1 -3)"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/>' +
    '<path d="M5 8a8 8 0 0 1 14-3l1 7M4 12l1 7a8 8 0 0 0 14-3"/>',
};

/** @brief 返回指定名称的装饰图标。 */
export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
