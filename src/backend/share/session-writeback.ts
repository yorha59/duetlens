export interface ShareWriteback {
  kind: 'reply' | 'mark-fixed';
  targetId: string;
  text: string;
  requestId: string;
}

export type ShareWritebackReceipt =
  | { kind: 'reply'; discussionId: string; messageId: string }
  | { kind: 'mark-fixed'; findingId: string; alreadyFixed: boolean };

export type ShareWritebackHandler = (
  reviewId: string,
  input: ShareWriteback,
  assertShare: () => void,
  assertVersion: () => void,
) => Promise<ShareWritebackReceipt & { replayed: boolean }>;
