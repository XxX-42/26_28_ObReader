// PDF++-style data placeholders, deliberately without JavaScript evaluation.
const DEFAULT_COPY_TEMPLATE = '{{linkWithDisplay}}';
const DEFAULT_DISPLAY_TEMPLATE = '{{file.basename}} · p.{{page}}';
const COPY_PRESETS = Object.freeze([
  { id: 'link', name: '仅定位链接', template: '{{linkWithDisplay}}' },
  { id: 'compact', name: '短显示文字（p40）', template: '[[{{linktext}}|p{{pageLabel}}]]' },
  { id: 'plain-link', name: '裸链接地址（无括号）', template: '{{link}}' },
  { id: 'text', name: '仅选中文字', template: '{{text}}' },
  { id: 'quote', name: 'PDF++ 引用块＋链接', template: '> {{text}}\n\n{{linkWithDisplay}}' },
  { id: 'callout', name: 'PDF++ Callout＋链接', template: '> [!{{calloutType}}] {{linkWithDisplay}}\n> {{text}}' },
]);
function interpolate(template, variables) {
  if (typeof template !== 'string' || !template.trim() || template.length > 8192) {
    throw new Error('复制模板不能为空，且不能超过 8192 字符。');
  }
  const remainder = template.replace(/\{\{([^{}]+)\}\}/g, '');
  if (remainder.includes('{{') || remainder.includes('}}')) throw new Error('模板中的 {{ }} 未配对。');
  const output = template.replace(/\{\{([^{}]+)\}\}/g, (_, expression) => {
    const key = expression.trim();
    if (!Object.hasOwn(variables, key)) throw new Error(`不支持的模板参数：${key}（仅支持列出的数据参数，不执行 JavaScript）。`);
    return String(variables[key] ?? '');
  });
  if (output.length > 1_048_576) throw new Error('复制结果过长。');
  return output;
}
function formatSelectionCopy(context, settings = {}) {
  const path = context.path || 'Books/示例.pdf';
  const name = path.split('/').at(-1);
  const basename = context.basename || name.replace(/\.pdf$/i, '');
  const folderPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const folderName = folderPath.split('/').at(-1) || '';
  const page = context.page || 1;
  const safe = value => String(value).replaceAll('|', '\\|').replaceAll(']]', '\\]\\]');
  const linktext = context.linktext || `${path}#page=${page}`;
  const pageLinktext = `${path.replaceAll('#', '%23')}#page=${page}`;
  const variables = {
    'file.path': path, 'file.name': name, 'file.basename': basename, 'file.extension': 'pdf',
    'file.parent.path': folderPath, 'file.parent.name': folderName,
    'pdf.path': path, 'pdf.name': name, 'pdf.basename': basename, 'pdf.extension': 'pdf',
    'pdf.parent.path': folderPath, 'pdf.parent.name': folderName,
    'folder.path': folderPath, 'folder.name': folderName,
    page, pageLabel: context.pageLabel || String(page), pageCount: context.pageCount || 0,
    text: context.text || '', selection: context.text || '', comment: context.comment || '',
    color: context.color || '', colorName: context.color || '', calloutType: 'PDF',
    anchorId: context.anchorId || '', docKey: context.docKey || '', documentId: context.documentId || '',
  };
  const display = interpolate(settings.selectionDisplayTemplate ?? DEFAULT_DISPLAY_TEMPLATE, variables);
  Object.assign(variables, {
    display, linktext, link: linktext, linkWithDisplay: `[[${linktext}|${safe(display)}]]`,
    linkToPage: `[[${pageLinktext}]]`, linkToPageWithDisplay: `[[${pageLinktext}|${safe(display)}]]`,
  });
  return interpolate(settings.selectionCopyTemplate ?? DEFAULT_COPY_TEMPLATE, variables);
}
module.exports = { DEFAULT_COPY_TEMPLATE, DEFAULT_DISPLAY_TEMPLATE, COPY_PRESETS, formatSelectionCopy };
