import type { CodexSelection } from './codex-handoff';

export interface CodexChatMessage { id: string; role: 'user' | 'assistant'; text: string; phase?: string }
export interface CodexChatState {
  threadId: string;
  connection: 'connecting' | 'connected' | 'disconnected' | 'incompatible';
  title: string;
  busy: boolean;
  activity: string;
  messages: CodexChatMessage[];
  error?: string;
}
export interface CodexChatSelection extends CodexSelection { id: string; context: string; snapshot: boolean; previewTruncated?: boolean }
export interface CodexChatDraft { text: string; selections: CodexChatSelection[] }
export interface CodexChatSend { text: string; selectionIds: string[]; requestId: string }
export type CodexChatEvent = { kind: 'state'; threadId: string; state: CodexChatState }
  | { kind: 'update'; threadId: string; state: Omit<CodexChatState, 'messages'>; messages: CodexChatMessage[]; order?: string[] }
  | { kind: 'draft'; threadId: string; draft: CodexChatDraft };
