import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCodexThread } from '@shared/codex-handoff';
import type { CodexChatDraft, CodexChatSend, CodexChatState } from '@shared/codex-chat';
import { DesktopChat } from '../codex/desktop-chat';
import type { CodexBinding, CodexSelection } from '@shared/codex-handoff';
import { prepareCodexHandoff } from '../codex/selection-handoff';
import { app, clipboard, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  IpcChannels,
  IpcEvents,
  type AppInfo,
  type DiffStatInput,
  type DiscussionAnchor,
  type AddFindingInput,
  type FindingEditInput,
  type OpenExternalResult,
  type RerunInput,
  type ReviewEvent,
  type ReviewStartInput,
  type ReviewStartProgress,
  type StartScanInput,
  type SubmitReviewInput,
} from '@shared/ipc';
import type { AgentKind, ReviewUiState, Triage, UiSettings } from '@shared/domain';
import type { EnvCheckOptions } from '@shared/environment';
import type { PromptSaveInput } from '@shared/prompt';
import type { ReviewManager } from '../review/review-manager';
import type { SessionShareServer } from '../share/session-share-server';
import type { Updater } from '../update/updater';
import { resolvePrUrl } from '../source/source-discovery';
import { detectEditors, openEditorFile, resolveEditorFile } from '../editor/local-editors';

export interface IpcDeps {
  manager: ReviewManager;
  /** 把领域事件推给所有 renderer(main 提供,通常遍历 BrowserWindow) */
  broadcast: (channel: string, payload: unknown) => void;
  updater: Updater;
  shareServer: SessionShareServer;
}

/** 注册 main 侧全部 IPC handler,并把 ReviewManager 事件转发给 renderer。 */
export function registerIpcHandlers({ manager, broadcast, updater, shareServer }: IpcDeps): void {
  const chats = new Map<string, { chat: DesktopChat; count: number }>();
  const subscriptions = new Map<string, () => void>();
  const visibleDraft = (draft: CodexChatDraft): CodexChatDraft => ({ text: draft.text, selections: draft.selections.map(selection => ({ ...selection, context: '', text: selection.text.slice(0, 10000), previewTruncated: selection.text.length > 10000 })) });
  const boundThread = (id: string) => {
    const binding = manager.getCodexBinding(id);
    if (!binding) throw new Error('请先绑定 Codex 对话');
    return parseCodexThread(binding.threadId);
  };
  const publishDraft = (threadId: string) => {
    const draft = visibleDraft(manager.getCodexChatDraft(threadId));
    broadcast(IpcEvents.codexChatEvent, { kind: 'draft', threadId, draft }); return draft;
  };
  ipcMain.handle(IpcChannels.codexChatConnect, (event, id: string) => {
    const threadId = boundThread(id); const key = `${event.sender.id}:${id}`;
    subscriptions.get(key)?.();
    let entry = chats.get(threadId);
    if (!entry) { entry = { chat: new DesktopChat(threadId), count: 0 }; chats.set(threadId, entry); }
    entry.count++;
    const shared = entry;
    let previous: CodexChatState | undefined;
    const listener = (state: CodexChatState) => {
      if (event.sender.isDestroyed()) return;
      if (!previous) event.sender.send(IpcEvents.codexChatEvent, { kind: 'state', threadId, state });
      else {
        const old = new Map(previous.messages.map(message => [message.id, message]));
        const updates = state.messages.filter(message => { const before = old.get(message.id); return !before || before.text !== message.text || before.phase !== message.phase || before.role !== message.role; });
        const order = state.messages.map(message => message.id);
        const changed = order.length !== previous.messages.length || order.some((id, index) => id !== previous!.messages[index]?.id);
        const metadata: Omit<CodexChatState, 'messages'> = { threadId: state.threadId, connection: state.connection, title: state.title, busy: state.busy, activity: state.activity, error: state.error };
        event.sender.send(IpcEvents.codexChatEvent, { kind: 'update', threadId, state: metadata, messages: updates, order: changed ? order : undefined });
      }
      previous = state;
    };
    shared.chat.on('state', listener);
    const release = () => {
      if (subscriptions.get(key) !== release) return;
      subscriptions.delete(key); event.sender.off('destroyed', release); shared.chat.off('state', listener);
      if (--shared.count === 0) { shared.chat.stop(); chats.delete(threadId); }
    };
    subscriptions.set(key, release); event.sender.once('destroyed', release);
    if (entry.count === 1) entry.chat.start();
    return { state: entry.chat.state, draft: visibleDraft(manager.getCodexChatDraft(threadId)) };
  });
  ipcMain.handle(IpcChannels.codexChatDisconnect, (event, id: string) => subscriptions.get(`${event.sender.id}:${id}`)?.());
  ipcMain.handle(IpcChannels.codexChatOpen, (_event, id: string) => shell.openExternal(`codex://threads/${boundThread(id)}`));
  ipcMain.handle(IpcChannels.codexChatDraft, (_event, id: string, text: string, remove: string[] = []) => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 200000 || !Array.isArray(remove) || remove.length > 20 || remove.some(value => typeof value !== 'string')) throw new Error('草稿参数无效或过大');
    const threadId = boundThread(id); const draft = manager.getCodexChatDraft(threadId);
    draft.text = text; draft.selections = draft.selections.filter(selection => !remove.includes(selection.id));
    manager.saveCodexChatDraft(threadId, draft); return publishDraft(threadId);
  });
  ipcMain.handle(IpcChannels.codexChatSend, async (_event, id: string, input: CodexChatSend) => {
    const threadId = boundThread(id); const entry = chats.get(threadId); const chat = entry?.chat;
    if (!chat || !entry) throw new Error('请先打开 Codex 同步对话');
    if (typeof input?.text !== 'string' || Buffer.byteLength(input.text) > 200000 || !Array.isArray(input.selectionIds) || input.selectionIds.length > 20 || input.selectionIds.some(value => typeof value !== 'string')) throw new Error('发送参数无效或过大');
    parseCodexThread(input.requestId);
    const draft = manager.getCodexChatDraft(threadId);
    const chosen = draft.selections.filter(selection => input.selectionIds.includes(selection.id));
    if (new Set(input.selectionIds).size !== chosen.length) throw new Error('部分选区已移除,请重新检查待发送区');
    const text = [input.text.trim(), ...chosen.map(selection => selection.context)].filter(Boolean).join('\n\n');
    let reserved = false;
    // 等待发送回执时即使用户切到 Findings,也保留连接到本次请求结束。
    entry.count++;
    try {
      await chat.send(text, input.requestId, () => { manager.reserveCodexChatSend(threadId, input.requestId); reserved = true; });
      manager.finishCodexChatSend(input.requestId, 'accepted');
      const current = manager.getCodexChatDraft(threadId);
      if (current.text === input.text) current.text = '';
      current.selections = current.selections.filter(selection => !input.selectionIds.includes(selection.id));
      manager.saveCodexChatDraft(threadId, current); return publishDraft(threadId);
    } catch (error) {
      if (reserved) manager.finishCodexChatSend(input.requestId, 'unknown');
      throw error;
    } finally {
      if (--entry.count === 0) { entry.chat.stop(); chats.delete(threadId); }
    }
  });
  app.once('before-quit', () => { for (const release of [...subscriptions.values()]) release(); for (const entry of chats.values()) entry.chat.stop(); chats.clear(); });
  ipcMain.handle(IpcChannels.codexBindingGet, (_event, id: string) => manager.getCodexBinding(id));
  ipcMain.handle(IpcChannels.codexBindingSet, (_event, id: string, binding: CodexBinding | null) => manager.setCodexBinding(id, binding));
  ipcMain.handle(IpcChannels.codexAddSelection, async (_event, id: string, selection: CodexSelection) => {
    const review = await manager.getReview(id);
    const binding = manager.getCodexBinding(id);
    if (!review || !binding) throw new Error('请先绑定 Codex 对话');
    const session = await shareServer.share(id);
    const result = await prepareCodexHandoff(review, selection, manager.getDiff(id), path.join(app.getPath('userData'), 'codex-context'), binding, session.url);
    const draft = manager.getCodexChatDraft(binding.threadId);
    if (draft.selections.length >= 20) throw new Error('一次最多添加 20 个选区');
    if (!draft.selections.some(item => item.file === selection.file && item.line === selection.line && item.lineEnd === selection.lineEnd && item.side === selection.side && item.text === selection.text)) {
      if (Buffer.byteLength(draft.selections.map(item => item.context).join('') + result.text) > 1800000) throw new Error('选区内容过大,请先发送或移除部分选区');
      draft.selections.push({ ...selection, id: randomUUID(), context: result.text, snapshot: result.snapshot });
      manager.saveCodexChatDraft(binding.threadId, draft);
    }
    publishDraft(binding.threadId);
    return { snapshot: result.snapshot, copiedOnly: false, message: '已添加到同步对话的待发送区,点击发送后交给 Codex。' };
  });
  ipcMain.handle(IpcChannels.reviewRefreshLocal, (_event, id: string, forceMetadata?: boolean) => manager.refreshLocal(id, forceMetadata));
  ipcMain.handle(IpcChannels.reviewShare, async (_event, id: string) => {
    const result = await shareServer.share(id);
    clipboard.writeText(result.url);
    return result;
  });
  ipcMain.handle(IpcChannels.reviewRevokeShare, (_event, id: string) => shareServer.revoke(id));
  ipcMain.handle(IpcChannels.editorList, async () =>
    (await detectEditors()).map(({ id, name }) => ({ id, name })),
  );
  ipcMain.handle(IpcChannels.editorOpenFile, async (event, reviewId: string, file: string, choose = false, line?: number) => {
    try {
      const review = await manager.getReview(reviewId);
      if (!review?.repoPath) throw new Error('请先为审核关联本地仓库');
      if (!manager.getDiff(reviewId).some((entry) => entry.path === file)) throw new Error('文件不在本次审核改动中');
      const absolute = await resolveEditorFile(review.repoPath, file);
      const editors = await detectEditors();
      if (!editors.length) throw new Error('未检测到支持的代码编辑器,请先安装 Cursor 或 VS Code');
      let selected = editors[0];
      if (choose) {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new Error('审核窗口已关闭');
        const picked = await new Promise<string | null>((resolve) => {
          const menu = Menu.buildFromTemplate([
            { label: `在 ${selected.name} 中打开`, click: () => resolve(selected.id) },
            { label: '打开方式', submenu: editors.map((editor) => ({
              label: editor.name, click: () => resolve(editor.id),
            })) },
          ]);
          menu.popup({ window, callback: () => resolve(null) });
        });
        if (!picked) return { ok: true };
        const pickedEditor = editors.find((editor) => editor.id === picked);
        if (!pickedEditor) throw new Error('编辑器不可用');
        selected = pickedEditor;
      }
      await openEditorFile(selected, absolute, line);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
  ipcMain.handle(IpcChannels.appGetInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));

  ipcMain.handle(IpcChannels.appCheckEnvironment, (_e, opts?: EnvCheckOptions) =>
    manager.checkEnvironment(opts),
  );

  ipcMain.handle(IpcChannels.reviewList, () => manager.listReviews());
  ipcMain.handle(IpcChannels.reviewListRecent, () => manager.listRecentReviews());
  ipcMain.handle(IpcChannels.reviewWorkspaceState, (_e, id: string) => manager.workspaceState(id));
  ipcMain.handle(IpcChannels.reviewWorkspaceSwitch, (_e, id: string, mode: 'local' | 'remote', repoPath?: string) => manager.switchWorkspace(id, mode, repoPath));
  ipcMain.handle(IpcChannels.reviewSyncStatus, (_e, id: string) => manager.syncStatus(id));
  ipcMain.handle(IpcChannels.reviewApplyLocal, (_e, id: string) => manager.applyLocal(id));
  ipcMain.handle(IpcChannels.reviewAttachWorkspace, (_e, id: string, repoPath: string) => manager.attachWorkspace(id, repoPath));
  ipcMain.handle(IpcChannels.reviewSyncCode, (_e, id: string, direction: import('@shared/ipc').CodeSyncDirection) => manager.syncCode(id, direction));
  ipcMain.handle(IpcChannels.reviewGet, (_e, id: string) => manager.getReview(id));
  ipcMain.handle(IpcChannels.reviewFindings, (_e, reviewId: string) => manager.getFindings(reviewId));
  ipcMain.handle(IpcChannels.reviewDiff, (_e, reviewId: string) => manager.getDiff(reviewId));
  ipcMain.handle(IpcChannels.reviewLatestDiff, (_e, reviewId: string) => manager.getLatestDiff(reviewId));
  ipcMain.handle(IpcChannels.reviewFileContent, (_e, reviewId: string, path: string) =>
    manager.getFileContent(reviewId, path),
  );
  ipcMain.handle(IpcChannels.reviewDiscussions, (_e, reviewId: string) => manager.getDiscussions(reviewId));
  ipcMain.handle(IpcChannels.reviewMessages, (_e, discussionId: string) => manager.getMessages(discussionId));
  ipcMain.handle(IpcChannels.reviewStart, (_e, input: ReviewStartInput) => {
    const startId = input.startId;
    return manager.startReview(
      {
        source: input.source,
        ref: input.ref,
        repoPath: input.repoPath ?? '',
        baseRef: input.baseRef,
        headRef: input.headRef,
        agent: input.agent,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        intensity: input.intensity,
        context: input.context,
      },
      startId
        ? (stage) =>
            broadcast(IpcEvents.reviewStartProgress, { startId, stage } satisfies ReviewStartProgress)
        : undefined,
    );
  });
  ipcMain.handle(IpcChannels.reviewRerun, (_e, reviewId: string, input?: RerunInput) => {
    const { startId, ...rest } = input ?? {};
    return manager.rerunReview(
      reviewId,
      rest,
      startId
        ? (stage) =>
            broadcast(IpcEvents.reviewStartProgress, { startId, stage } satisfies ReviewStartProgress)
        : undefined,
    );
  });
  ipcMain.handle(IpcChannels.reviewRetryRound, (_e, reviewId: string) => manager.retryRound(reviewId));
  ipcMain.handle(IpcChannels.reviewStopScan, (_e, reviewId: string) => manager.stopScan(reviewId));
  ipcMain.handle(IpcChannels.reviewStopReply, (_e, reviewId: string, discussionId: string) =>
    manager.stopReply(reviewId, discussionId),
  );
  ipcMain.handle(IpcChannels.reviewRounds, (_e, reviewId: string) => manager.getRounds(reviewId));
  ipcMain.handle(IpcChannels.reviewListScopes, (_e, parentId: string) => manager.listScopes(parentId));
  ipcMain.handle(IpcChannels.reviewOpenScope, (_e, parentId: string, sha: string) =>
    manager.openScope(parentId, sha),
  );
  ipcMain.handle(IpcChannels.reviewStartScan, (_e, reviewId: string, input?: StartScanInput) => {
    const { startId, ...rest } = input ?? {};
    return manager.startScan(
      reviewId,
      rest,
      startId
        ? (stage) =>
            broadcast(IpcEvents.reviewStartProgress, { startId, stage } satisfies ReviewStartProgress)
        : undefined,
    );
  });
  ipcMain.handle(IpcChannels.reviewScopePending, (_e, reviewId: string) => manager.scopePending(reviewId));
  ipcMain.handle(IpcChannels.reviewResume, (_e, reviewId: string) => manager.resumeReview(reviewId));
  ipcMain.handle(IpcChannels.reviewCapacity, () => manager.getLiveCapacity());
  ipcMain.handle(IpcChannels.reviewRelease, (_e, reviewId: string) => manager.disposeReview(reviewId));
  ipcMain.handle(IpcChannels.reviewDelete, (_e, reviewId: string) => manager.deleteReview(reviewId));
  ipcMain.handle(IpcChannels.reviewAddDiscussion, (_e, reviewId: string, anchor?: DiscussionAnchor | null) =>
    manager.addUserDiscussion(reviewId, anchor),
  );
  ipcMain.handle(IpcChannels.reviewSendMessage, (_e, reviewId: string, discussionId: string, text: string, mode?: 'note' | 'agent') =>
    manager.sendMessage(reviewId, discussionId, text, mode),
  );
  ipcMain.handle(IpcChannels.reviewClearDiscussion, (_e, reviewId: string, discussionId: string) =>
    manager.clearDiscussion(reviewId, discussionId),
  );
  ipcMain.handle(IpcChannels.reviewProposals, (_e, reviewId: string) => manager.getProposals(reviewId));
  ipcMain.handle(IpcChannels.reviewApplyProposal, (_e, reviewId: string, proposalId: string) =>
    manager.applyProposal(reviewId, proposalId),
  );
  ipcMain.handle(IpcChannels.reviewSkipProposal, (_e, reviewId: string, proposalId: string) =>
    manager.skipProposal(reviewId, proposalId),
  );
  ipcMain.handle(IpcChannels.reviewUndoProposal, (_e, reviewId: string, proposalId: string) =>
    manager.undoProposal(reviewId, proposalId),
  );
  ipcMain.handle(
    IpcChannels.reviewSetTriage,
    (_e, reviewId: string, findingId: string, triage: Triage, reason?: string | null) =>
      manager.setTriage(reviewId, findingId, triage, reason),
  );
  ipcMain.handle(IpcChannels.reviewSetFindingAnchor, (_e, reviewId: string, findingId: string, line: number) =>
    manager.setFindingAnchor(reviewId, findingId, line),
  );
  ipcMain.handle(IpcChannels.reviewAddFinding, (_e, reviewId: string, input: AddFindingInput) =>
    manager.addManualFinding(reviewId, input),
  );
  ipcMain.handle(IpcChannels.reviewPromoteDiscussion, (_e, reviewId: string, discussionId: string) =>
    manager.promoteDiscussion(reviewId, discussionId),
  );
  ipcMain.handle(IpcChannels.reviewUpdateFinding, (_e, reviewId: string, input: FindingEditInput) =>
    manager.updateFinding(reviewId, input),
  );
  ipcMain.handle(IpcChannels.reviewSubmit, (_e, reviewId: string, input: SubmitReviewInput) =>
    manager.submitReview(reviewId, input),
  );
  // 外链只接受自己拼出的 github.com PR 地址,不透传任意 renderer 字符串给 openExternal。
  ipcMain.handle(IpcChannels.reviewOpenInBrowser, async (_e, reviewId: string): Promise<OpenExternalResult> => {
    const review = await manager.getReview(reviewId);
    if (!review) return { ok: false, message: '找不到该审核' };
    if (review.source !== 'github-pr') return { ok: false, message: '该来源没有可打开的网页' };
    try {
      const url = await resolvePrUrl(review.sourceRef, review.repoPath ?? undefined);
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });
  ipcMain.handle(IpcChannels.reviewGetUiState, (_e, reviewId: string) =>
    manager.getReviewUiState(reviewId),
  );
  ipcMain.handle(IpcChannels.reviewSaveUiState, (_e, reviewId: string, state: ReviewUiState) =>
    manager.saveReviewUiState(reviewId, state),
  );
  ipcMain.handle(IpcChannels.reviewGetActiveScope, (_e, reviewId: string) =>
    manager.getActiveScope(reviewId),
  );
  ipcMain.handle(IpcChannels.reviewSetActiveScope, (_e, reviewId: string, scope: string | null) =>
    manager.setActiveScope(reviewId, scope),
  );

  ipcMain.handle(IpcChannels.uiGetSettings, () => manager.getUiSettings());
  ipcMain.handle(IpcChannels.uiSaveSettings, (_e, settings: UiSettings) => manager.saveUiSettings(settings));

  ipcMain.handle(IpcChannels.updateGetStatus, () => updater.getStatus());
  ipcMain.handle(IpcChannels.updateCheck, () => updater.check());
  ipcMain.handle(IpcChannels.updateInstall, () => updater.install());

  ipcMain.handle(IpcChannels.agentListModels, (_e, agent: AgentKind) => manager.listModels(agent));

  ipcMain.handle(IpcChannels.sourceCheckGhAuth, () => manager.checkGhAuth());
  ipcMain.handle(IpcChannels.sourcePreviewPr, (_e, ref: string, repoPath?: string) =>
    manager.previewPr(ref, repoPath),
  );
  ipcMain.handle(IpcChannels.sourceListOpenPrs, (_e, opts: { nwo?: string; repoPath?: string }) =>
    manager.listOpenPrs(opts),
  );
  ipcMain.handle(IpcChannels.sourceGetRepoRemote, (_e, repoPath: string) =>
    manager.getRepoRemote(repoPath),
  );
  ipcMain.handle(IpcChannels.sourceInferLocalRepo, (_e, nwo: string) =>
    manager.inferLocalRepo(nwo),
  );
  ipcMain.handle(IpcChannels.sourceListLocalBranches, (_e, repoPath: string, baseRef?: string) =>
    manager.listLocalBranches(repoPath, baseRef),
  );
  ipcMain.handle(IpcChannels.sourceInspectRepo, (_e, repoPath: string) =>
    manager.inspectRepo(repoPath),
  );
  ipcMain.handle(IpcChannels.sourceListRepoPaths, () => manager.listRepoPaths());
  ipcMain.handle(IpcChannels.sourceDiffStat, (_e, input: DiffStatInput) => manager.diffStat(input));
  ipcMain.handle(IpcChannels.sourcePrBaseChain, (_e, ref: string, repoPath?: string) =>
    manager.prBaseChain(ref, repoPath),
  );
  ipcMain.handle(IpcChannels.sourceListPrCommits, (_e, ref: string, repoPath?: string) =>
    manager.listPrCommits(ref, repoPath),
  );

  ipcMain.handle(IpcChannels.promptGet, (_e, cwd?: string) => manager.getReviewPrompt(cwd));
  ipcMain.handle(IpcChannels.promptSave, (_e, input: PromptSaveInput) => manager.saveReviewPrompt(input));

  // ⌘W 落在没有 tab 可关的屏上时的回落:renderer 认不出「关窗」这件事,只能回来找 main
  ipcMain.handle(IpcChannels.windowClose, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  ipcMain.handle(IpcChannels.dialogPickDirectory, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { properties: ['openDirectory' as const] };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle(IpcChannels.dialogPickFile, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { properties: ['openFile' as const] };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle(IpcChannels.dialogSaveTextFile, async (_e, defaultName: string, content: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, content, 'utf8');
    return res.filePath;
  });

  manager.on('review-event', (e: ReviewEvent) => broadcast(IpcEvents.reviewEvent, e));
}
