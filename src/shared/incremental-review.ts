import type { DiffFile } from './diff';
import type { Finding } from './domain';

/** 旧 finding 的行号属于上轮快照,用增量的旧侧范围确定是否需要重新复核。 */
export function findingTouchesDelta(finding: Pick<Finding, 'file' | 'line' | 'side'>, delta: readonly DiffFile[]): boolean {
  const file = delta.find((entry) => entry.path === finding.file);
  if (!file) return false;
  if (finding.side === 'old') return true;
  if (file.status === 'deleted' || file.binary || finding.line <= 0) return true;
  return file.hunks.some((hunk) => finding.line >= hunk.oldStart && finding.line < hunk.oldStart + Math.max(hunk.oldCount, 1));
}

/** 未改动的行只修正因前方插入/删除造成的行号漂移,不伪造新的复核结论。 */
export function shiftedFindingLine(finding: Pick<Finding, 'file' | 'line' | 'side'>, delta: readonly DiffFile[]): number {
  if (finding.side === 'old' || finding.line <= 0) return finding.line;
  const file = delta.find((entry) => entry.path === finding.file);
  if (!file) return finding.line;
  let shift = 0;
  for (const hunk of file.hunks) {
    const exact = hunk.lines.find((line) => line.kind === 'context' && line.oldLine === finding.line);
    if (exact?.newLine != null) return exact.newLine;
    if (hunk.oldCount === 0 ? hunk.oldStart < finding.line : hunk.oldStart + hunk.oldCount <= finding.line) shift += hunk.newCount - hunk.oldCount;
  }
  return Math.max(1, finding.line + shift);
}
