import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CodexBinding } from '@shared/codex-handoff';
import type { CodexChatDraft, CodexChatMessage, CodexChatState } from '@shared/codex-chat';
import { useIsActiveTab } from '../../review/TabVisibility';
import { renderMarkdown } from './markdown';
import './CodexChatPane.css';

const ChatMessage = memo(function ChatMessage({ message }: { message: CodexChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const long = message.text.length > 10000;
  return <article className={`codex-chat-message ${message.role}`}>
    <header>{message.role === 'user' ? '你' : message.phase === 'commentary' ? 'Codex · 进展' : 'Codex'}</header>
    <div className="c-prose">{renderMarkdown(long && !expanded ? message.text.slice(0, 10000) : message.text)}</div>
    {long && <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开完整消息'}</button>}
  </article>;
}, (a, b) => a.message.id === b.message.id && a.message.text === b.message.text && a.message.phase === b.message.phase && a.message.role === b.message.role);

export function CodexChatPane({ reviewId, binding, active, onBind }: { reviewId: string; binding: CodexBinding | null; active: boolean; onBind: () => void }) {
  const isActiveTab = useIsActiveTab();
  const visible = active && isActiveTab;
  const [state, setState] = useState<CodexChatState | null>(null);
  const [draft, setDraft] = useState<CodexChatDraft>({ text: '', selections: [] });
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [limit, setLimit] = useState(60);
  const [reconnect, setReconnect] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const text = useRef('');
  const dirty = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const sendLock = useRef(false);
  const mounted = useRef(true);
  const persist = useCallback(async () => {
    clearTimeout(timer.current);
    if (!binding || !dirty.current) return;
    const savedText = text.current;
    try {
      await window.duetlens.review.saveCodexChatDraft(reviewId, savedText);
      if (text.current === savedText) dirty.current = false;
    } catch (error) { if (mounted.current) setError(`草稿保存失败：${(error as Error).message}`); throw error; }
  }, [reviewId, binding]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void persist().catch(() => {}); }; }, [persist]);
  useEffect(() => {
    if (!binding) return;
    return window.duetlens.review.onCodexChat(event => {
      if (event.threadId !== binding.threadId) return;
      if (event.kind === 'state') setState(event.state);
      else if (event.kind === 'update') setState(current => {
        const messages = new Map((current?.messages || []).map(message => [message.id, message]));
        for (const message of event.messages) messages.set(message.id, message);
        return { ...event.state, messages: event.order ? event.order.map(id => messages.get(id)).filter((message): message is CodexChatMessage => !!message) : [...messages.values()] };
      });
      else {
        setDraft(current => ({ text: dirty.current ? current.text : event.draft.text, selections: event.draft.selections }));
        if (!dirty.current) text.current = event.draft.text;
        if (!sendLock.current) requestId.current = crypto.randomUUID();
      }
    });
  }, [binding]);
  useEffect(() => {
    if (!binding || !visible) return;
    let alive = true;
    void window.duetlens.review.connectCodexChat(reviewId).then(result => {
      if (!alive) return;
      setState(result.state); setLoaded(true);
      setDraft(current => ({ text: dirty.current ? current.text : result.draft.text, selections: result.draft.selections }));
      if (!dirty.current) text.current = result.draft.text;
    }).catch((error: Error) => { if (alive) setError(error.message); });
    return () => { alive = false; void window.duetlens.review.disconnectCodexChat(reviewId).catch(() => {}); };
  }, [binding, reviewId, visible, reconnect]);
  const last = state?.messages.at(-1);
  useEffect(() => { if (visible && follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [last?.id, last?.text, visible, draft.selections.length]);
  useEffect(() => { if (visible && loaded && draft.selections.length) input.current?.focus(); }, [visible, loaded, draft.selections.length]);

  const send = async () => {
    if (sendLock.current || !binding) return;
    sendLock.current = true; setSending(true); setError('');
    try {
      await persist();
      const result = await window.duetlens.review.sendCodexChat(reviewId, { text: text.current, selectionIds: draft.selections.map(s => s.id), requestId: requestId.current });
      text.current = result.text; dirty.current = false; setDraft(result); follow.current = true;
      requestId.current = crypto.randomUUID();
    } catch (error) { setError((error as Error).message); }
    finally { sendLock.current = false; setSending(false); }
  };
  if (!active) return null;
  if (!binding) return <div className="codex-chat-empty"><p>绑定已有 Codex 对话,同步消息和回复,并把选区添加到待发送区。</p><button type="button" onClick={onBind}>绑定 Codex 对话</button></div>;
  return <section className="codex-chat" aria-label="Codex 同步对话">
    <div className="codex-chat-toolbar">
      <span title={binding.threadId}>{state?.connection === 'connected' ? '● 已同步' : state?.connection === 'connecting' ? '连接中…' : '未连接'} · {state?.title || 'Codex'}</span>
      <button type="button" onClick={() => { setError(''); setReconnect(n => n + 1); }}>重连</button>
      <button type="button" onClick={() => void window.duetlens.review.openCodexChat(reviewId).catch((e: Error) => setError(e.message))}>在 Codex 打开</button>
    </div>
    <div ref={scroller} className="codex-chat-messages" onScroll={() => { const el = scroller.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>
      {(state?.messages.length || 0) > limit && <button type="button" onClick={() => { follow.current = false; setLimit(n => n + 60); }}>显示更早的消息</button>}
      {state?.messages.slice(-limit).map(message => <ChatMessage key={message.id} message={message} />)}
      {!state?.messages.length && <p className="codex-chat-hint">请在 Codex 中打开绑定的会话。这里同步已加载的消息,不会自动发起新一轮。</p>}
    </div>
    {state?.activity && <div className="codex-chat-activity" role="status">{state.activity}</div>}
    {(error || state?.error) && <div className="codex-chat-error" role="alert">{error || state?.error}</div>}
    <div className="codex-chat-compose">
      {draft.selections.length > 0 && <div className="codex-chat-selections" aria-label="待发送上下文">
        <div className="codex-chat-selections-label">{draft.selections.length} 项上下文 · 待发送</div>
        {draft.selections.map(selection => <div className="codex-chat-selection" key={selection.id}>
          <details><summary title={selection.file}>{selection.kind === 'comment' ? `GitHub 评论 · ${selection.label}` : <>{selection.file.split('/').at(-1)}:{selection.line}–{selection.lineEnd ?? selection.line}{selection.side === 'old' ? ' · 删除侧' : ''}{selection.snapshot ? ' · 审核快照' : ''}</>}</summary><pre>{selection.text}</pre>{selection.previewTruncated && <small>预览已截断,发送时包含完整上下文。</small>}</details>
          <button type="button" aria-label={`移除上下文 ${selection.label ?? selection.file}`} disabled={sending} onClick={() => {
            requestId.current = crypto.randomUUID();
            void window.duetlens.review.saveCodexChatDraft(reviewId, text.current, [selection.id]).then(result => setDraft(current => ({ ...current, selections: result.selections }))).catch((e: Error) => setError(e.message));
          }}>×</button>
        </div>)}
      </div>}
      <textarea ref={input} aria-label="发送给绑定 Codex 会话的消息" value={draft.text} maxLength={60000} disabled={sending || !loaded} placeholder="输入消息,或添加代码选区、GitHub 评论…" onChange={event => {
        text.current = event.target.value; dirty.current = true; requestId.current = crypto.randomUUID();
        setDraft(current => ({ ...current, text: event.target.value }));
        clearTimeout(timer.current); timer.current = setTimeout(() => void persist().catch(() => {}), 300);
      }} onBlur={() => void persist().catch(() => {})} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (state?.connection === 'connected' && !state.busy && (draft.text.trim() || draft.selections.length)) void send(); } }} />
      <div className="codex-chat-send"><span>草稿自动保存 · ⌘↵ 发送</span><button type="button" disabled={sending || !loaded || state?.connection !== 'connected' || state.busy || (!draft.text.trim() && !draft.selections.length)} onClick={() => void send()}>{sending ? '发送中…' : state?.busy ? '等待本轮结束' : '发送到 Codex'}</button></div>
    </div>
  </section>;
}
