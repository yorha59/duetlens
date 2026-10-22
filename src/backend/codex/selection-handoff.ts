import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Review } from '@shared/domain';
import type { DiffFile } from '@shared/diff';
import { codexFileReference, parseCodexThread, type CodexBinding, type CodexSelection } from '@shared/codex-handoff';

/** 只读真实仓库;审核内容与磁盘不一致时写 Duetlens 自己的数据目录,不改业务代码。 */
export async function prepareCodexHandoff(review: Review, selection: CodexSelection, diff: DiffFile[], directory: string, binding: CodexBinding, sessionUrl: string) {
  const threadId = parseCodexThread(binding.threadId);
  if (selection.side && selection.side !== 'old' && selection.side !== 'new') throw new Error('选区侧别无效');
  const end = selection.lineEnd ?? selection.line;
  if (!Number.isSafeInteger(selection.line) || !Number.isSafeInteger(end) || selection.line < 1 || end < selection.line || end > 200_000 || end - selection.line > 5000) throw new Error('选区行号无效或范围过大');
  if (!selection.text.trim() || Buffer.byteLength(selection.text) > 1024 * 1024) throw new Error('请选择不超过 1 MiB 的代码');
  const file = diff.find((entry) => entry.path === selection.file);
  if (!file || file.binary || selection.file.includes('\\') || path.isAbsolute(selection.file) || selection.file.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) throw new Error('文件不在当前审核改动中');
  let absolute = '';
  if (selection.side !== 'old' && review.repoPath) {
    try {
      const root = await realpath(review.repoPath);
      const candidate = await realpath(path.join(root, selection.file));
      if (candidate.startsWith(root + path.sep)) {
        const contents = await readFile(candidate, 'utf8');
        if (contents.split(/\r?\n/).slice(selection.line - 1, end).join('\n') === selection.text) absolute = candidate;
      }
    } catch { /* 已删除、远端版本或未同步内容使用选区快照。 */ }
  }
  const snapshot = !absolute;
  if (snapshot) {
    // 只复制当前选区,空行用于保留原始行号;明确标注选区快照,不冒充原文件全文。
    const hash = createHash('sha256').update(JSON.stringify([selection.file, selection.side, selection.line, end, selection.text])).digest('hex').slice(0, 24);
    absolute = path.join(directory, review.id, hash, path.basename(selection.file));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, '\n'.repeat(selection.line - 1) + selection.text + '\n', { mode: 0o600 });
  }
  const label = `${path.basename(selection.file)}:${selection.line}${end > selection.line ? `-${end}` : ''}${snapshot ? '（选区快照）' : ''}`;
  const reference = codexFileReference(absolute, selection.line, end, label);
  const source = `原仓库：${review.repoPath ?? '未关联本地仓库'}\nDuetlens ${selection.side === 'old' ? '删除前旧侧' : '新侧'}选区 · ${selection.file}:${selection.line}-${end}${snapshot ? '；文件引用为仅包含选区的审核快照,前方空行保留原行号；快照仅供参考,修改请定位原仓库文件。' : ''}`;
  const fence = '`'.repeat(Math.max(3, ...[...selection.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const text = `${reference.markdown}\n\n${source}\n\n${fence}\n${selection.text}\n${fence}\n\n审核会话：${sessionUrl}`;
  const html = `<p>${reference.html}</p><p>${source.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</p><pre>${selection.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))}</pre><p>${sessionUrl}</p>`;
  const url = new URL(`codex://threads/${threadId}`);
  const prefill = new URL(url); prefill.searchParams.set('prompt', text);
  const copiedOnly = binding.mode !== 'prefill' || prefill.href.length > 24_000;
  return { text, html, url: copiedOnly ? url.href : prefill.href, snapshot, copiedOnly };
}
