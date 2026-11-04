import type { Discussion, Finding } from '@shared/domain';
import { isFixedResolved, isWontFixThisRound } from './rounds';

/** 与 Findings 的处置口径一致;自动修复跨轮保留,作者回应只在本轮有效。 */
export function handledDiscussionLabel(finding: Finding | undefined, round: number): string | null {
  if (!finding) return null;
  if (isFixedResolved(finding, round)) return '已修复';
  if (finding.triage === 'dismiss') return '已剔除';
  if (isWontFixThisRound(finding, round)) return '作者已回应';
  return null;
}

export function groupDiscussionList(discussions: Discussion[], findings: Finding[], round: number) {
  const byDiscussion = new Map(findings.map(finding => [finding.discussionId, finding]));
  const pending: Discussion[] = [];
  const handled: Discussion[] = [];
  for (const discussion of discussions) {
    (handledDiscussionLabel(byDiscussion.get(discussion.id), round) ? handled : pending).push(discussion);
  }
  return { pending, handled };
}
