export interface CodexBinding { threadId: string; mode: 'copy' | 'prefill' }
export interface CodexSelection { file: string; line: number; lineEnd?: number | null; side?: 'old' | 'new'; text: string }
export interface CodexHandoffResult { message: string; snapshot: boolean; copiedOnly: boolean }

/** 绑定已存在的本地对话,不接受新建对话、任意 URL 或控制参数。 */
export function parseCodexThread(value: string): string {
  let id = value.trim();
  if (id.startsWith('codex://')) {
    const url = new URL(id);
    if (url.hostname !== 'threads' || url.username || url.password || url.port || url.search || url.hash) throw new Error('请粘贴不带参数的 Codex 对话链接');
    id = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('请输入 Codex 对话 UUID 或 codex://threads/… 链接');
  return id.toLowerCase();
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function codexFileReference(absolute: string, line: number, end: number, label: string) {
  const path = `${absolute}#L${line}${end > line ? `-L${end}` : ''}`;
  const encoded = absolute.split('/').map((part) => encodeURIComponent(part).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)).join('/');
  return {
    markdown: `[${label.replace(/[[\]\\]/g, '\\$&')}](${encoded}#L${line}${end > line ? `-L${end}` : ''})`,
    // 与本机 Codex atMention.parseDOM 使用相同属性;粘贴时恢复原生文件引用。
    html: `<span at-mention-label="${escapeHtml(label)}" at-mention-path="${escapeHtml(path)}" at-mention-fs-path="${escapeHtml(path)}">${escapeHtml(label)}</span>`,
  };
}
