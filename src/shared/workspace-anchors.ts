import type { DiffFile } from './diff';
import type { Review } from './domain';

/** 工作区已不存在的文件:仅保留当前 diff 中仍可定位的删除侧批注。 */
export function workspaceAnchorVisible(anchor: { file: string | null; line: number | null; side?: 'old' | 'new' }, review: Review | null, diff: DiffFile[]): boolean {
  if (!anchor.file || !review?.workspaceMissingFiles?.includes(anchor.file)) return true;
  return anchor.side === 'old' && diff.some((file) => file.path === anchor.file && file.hunks.some((hunk) => hunk.lines.some((line) => line.kind === 'del' && line.oldLine === anchor.line)));
}
