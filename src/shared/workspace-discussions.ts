import type { DiffFile, DiffLine } from './diff';
import type { Discussion } from './domain';

export interface WorkspaceDiscussionUpdate { id: string; stale: boolean; line?: number }

/** 刷新时比较改动本身,不把行号平移误当成批注失效。历史 finding 留给复审判定。 */
export function reconcileWorkspaceDiscussions(previous: DiffFile[], current: DiffFile[], discussions: Discussion[]): WorkspaceDiscussionUpdate[] {
  const updates: WorkspaceDiscussionUpdate[] = [];
  const before = new Map(previous.map(file => [file.path, file]));
  const after = new Map(current.map(file => [file.path, file]));
  for (const discussion of discussions) {
    if (discussion.workspaceStale || discussion.kind !== 'user' || !discussion.file) continue;
    const file = after.get(discussion.file);
    if (!file) { updates.push({ id: discussion.id, stale: true }); continue; }
    if (!discussion.line || file.binary) continue;
    const oldSide = discussion.side === 'old';
    const number = (line: DiffLine) => oldSide ? line.oldLine : line.newLine;
    const changeKind = oldSide ? 'del' : 'add';
    const end = discussion.lineEnd ?? discussion.line;
    const hunk = before.get(discussion.file)?.hunks.find(hunk => hunk.lines.some(line => {
      const value = number(line);
      return value != null && value >= discussion.line! && value <= end;
    }));
    // 展开的未改动上下文不一定在旧 diff 中;无法取证时只按文件范围清理。
    if (!hunk) continue;
    const changes = hunk.lines.filter(line => line.kind === changeKind);
    const selected = changes.filter(line => number(line)! >= discussion.line! && number(line)! <= end);
    const relevant = selected.length ? selected : changes;
    if (!relevant.length) continue;
    const candidates = file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === changeKind);
    if (!relevant.some(old => candidates.some(line => line.text === old.text))) {
      updates.push({ id: discussion.id, stale: true });
      continue;
    }
    // 单行改动唯一匹配时同步锚点;重复文本有歧义时不擅自换到另一处。
    const anchor = selected.find(line => number(line) === discussion.line);
    if (anchor && end === discussion.line) {
      const matches = candidates.filter(line => line.text === anchor.text);
      if (matches.length === 1 && number(matches[0]) !== discussion.line) updates.push({ id: discussion.id, stale: false, line: number(matches[0])! });
    }
  }
  return updates;
}
