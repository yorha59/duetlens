interface NoteVersion {
  messageId: string;
  sha256: string;
}

export type ShareWriteback = { targetId: string; requestId: string } & (
  | { kind: 'reply'; text: string; note?: NoteVersion }
  | { kind: 'mark-fixed'; text: string }
  | { kind: 'delete-note'; sha256: string; replyRequestId: string }
);

export type ShareWritebackReceipt =
  | { kind: 'reply'; discussionId: string; messageId: string; note?: NoteVersion }
  | { kind: 'mark-fixed'; findingId: string; alreadyFixed: boolean }
  | { kind: 'delete-note'; discussionId: string; messageId: string };

export type ShareWritebackHandler = (
  reviewId: string,
  input: ShareWriteback,
  assertShare: () => void,
  assertVersion: () => void,
) => Promise<ShareWritebackReceipt & { replayed: boolean }>;
