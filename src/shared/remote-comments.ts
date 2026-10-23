export interface RemoteComment { id: string; author: string; body: string; url: string; createdAt: string }
export interface RemoteThread { id: string; path: string; line: number | null; side: 'old' | 'new'; resolved: boolean; outdated: boolean; comments: RemoteComment[] }
export interface RemotePrComments {
  threads: RemoteThread[];
  comments: RemoteComment[];
  reviews: (RemoteComment & { state: string })[];
  head: string;
  fetchedAt: number;
}

/** 点击时的完整讨论快照,避免后续刷新丢失回复语境。 */
export interface RemoteCommentContext { comment: RemoteComment; thread?: RemoteThread; head: string }
