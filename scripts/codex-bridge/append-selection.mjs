// 复用文件浏览器的 addFiles 回调;不调用文字替换或提交接口。
export async function appendSelection({ ticket, threadId, addFiles, acknowledge, handled }) {
  if (!ticket || ticket.threadId !== threadId) return false;
  const existing = handled.get(ticket.requestId);
  if (existing) return existing;
  // 先登记,防止 StrictMode、路由重渲染或并发回调把同一选区追加两次。
  const operation = Promise.resolve().then(async () => {
    await addFiles(ticket.files);
    await acknowledge({ requestId: ticket.requestId, threadId });
    return true;
  });
  handled.set(ticket.requestId, operation);
  return operation;
}
