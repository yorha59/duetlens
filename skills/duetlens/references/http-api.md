# Duetlens 本机 HTTP 分享协议

本文描述仓库中 `src/backend/share/` 实现的只读协议。应用更新后应以实际响应和当前源码为准。

## 发现和生命周期

- macOS 端口文件：`~/Library/Application Support/Duetlens/share-server.json`，内容为 `{"port": number}`。开发版可显式提供其他数据目录，不自动混用。
- 服务仅监听 `127.0.0.1`。首次分享时启动；存在有效分享时应用重启会尝试恢复监听原端口。
- 应用运行且分享未撤销时链接可读；应用退出后不可读。原端口冲突会导致启动失败。
- `/`、`/health`、会话列表、创建分享及写接口均不是当前公开协议。端口文件不包含分享令牌。当前不能通过 HTTP 枚举未分享任务或创建分享。
- 不发送 `Origin`、伪造 Host 或通过网页跨域访问。Python/curl 直接请求即可。服务校验 Host，不开放 CORS。
- token 是 32 随机字节的 base64url 表示（43 个字符），本地和远端视图各有自己的分享 token。

## 三个 GET 端点

### `GET /sessions/{token}`

JSON 会话上下文：

- `kind: "duetlens.shared-review"`、`schemaVersion: 1`、`generatedAt`。
- `access: {localOnly: true, readOnly: true, liveComments: true}`。
- `repository: {path, source, sourceRef}`。path 是本机仓库根目录，可能为空。
- `review: {id,title,mode,round,head,reviewedHead,reviewedBase,baseRef,status,summary,...}`。
  `head` 是当前可读快照，`reviewedHead` 是上一轮审核版本；本地代码更新后两者可能不同。
- `findings[]`：`id/discussionId/file/line/side/title/body/triage/resolution/...`。处置及结论不可仅凭标题推断。
- `discussions[]`：`id/kind/origin/file/side/line/lineEnd/findingId/messages[]`。
  `messages[]` 含 `id/discussionId/role/kind/text/createdAt`。`role` 区分用户与 agent；`kind=note` 是批注，`chat` 是提问/回复，`legacy` 或旧响应中缺少 kind 的用户消息未分类。agent 消息属于对话。客户端保留完整讨论，并提供 `noteMessageIds`、`chatMessageIds`、`legacyUserMessageIds` 和 `userMessageKinds` 辅助识别；`userMessageIds` 包含所有用户留言，不能直接等同于待修改批注。
- `files[]: {path,status,url}`：文件范围是改动及可见讨论涉及的仓库相对路径。
- `diffUrl`：完整 diff 的版本绑定链接。

每次读取可能刷新本地工作区展示快照；不启动模型。本地刷新会归档已退出当前 diff 或对应改动已撤回的用户讨论；当前接口不返回这些归档讨论，也会隐藏已消失文件上的失效新侧锚点。不能把“没出现在新响应中”当作独立的修复证据。

### `GET /sessions/{token}/file?path=...&head=...&round=...&base=...`

必须使用上下文返回的 `files[].url`，不要自己省掉版本参数。

响应：`{path,head,round,kind,content,editablePath,contentSource}`。

- `contentSource` 为 `reviewed-snapshot` 或 `workspace-snapshot`，不是当前磁盘全文。
- `kind` 为 `file` 或 `symlink`。后者返回链接文字，不跟随链接，`editablePath=null`。
- `editablePath` 可为空；非空也应先核对真实路径和当前内容。
- 文件读取范围受限，不允许绝对路径、`..`、`.git` 或无关文件。
- 二进制文件不支持；删除文件的新侧可能 404。此时用 diff 的删除侧或本地经核实的 Git 版本取证，不能假设存在 old-file 参数。

### `GET /sessions/{token}/diff?head=...&round=...&base=...`

使用 `diffUrl`，响应为 `text/plain` unified diff。old/new 行号映射以此为准。

## 状态码与恢复

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| 403 | Host/Origin/浏览器访问限制 | 本机 HTTP 客户端直接访问 127.0.0.1，不经代理或浏览器 |
| 404 | 令牌失效、任务删除或文件不在范围/已删除 | 区分上下文和文件端点；不猜新 token，不把删除文件错误当成整个服务不可用 |
| 405 | 非 GET 请求 | 当前公开端口只读，不能 POST 回复/解决状态 |
| 409 | head、round 或 base 已变化/快照不可用 | 重新 GET 会话，再使用新的 file/diff URL；连续变化时报告阻塞 |
| 415 | 二进制文件 | 报告不可读能力及文件，使用适合该文件类型的已授权本地工具 |
| 429 | 并发读取超限 | 服务最多 4 个并发请求，按需串行读取并有界重试 |
| 500 | 应用无法刷新或读取会话 | 报告具体失败；不通过 GUI/DB 绕过接口 |

连接拒绝不等于任务不存在；先确认端口文件、应用是否运行和链接端口是否一致。不要自动重启应用，以免丢失用户草稿。

## 当前没有的能力

分享端口没有评论回写、回复、解决/处置状态更新、启动复审、Git 同步、视图切换、会话列表、创建/撤销分享的 HTTP API，也没有 SSE/WebSocket 评论订阅。所谓 liveComments 是每次 GET 读取当前数据，不是推送流。

「PR 评论」界面可展示 GitHub 评论,但分享 JSON 的 `discussions` 仍只包含 Duetlens 自己保存的批注,不能把它当成完整的 GitHub 评论集合。若任务要求读取 GitHub 评论,应明确这个端口缺口；可根据 `repository.sourceRef` 通过已授权的 GitHub API/gh CLI 读取 GitHub 数据,无需操作 Duetlens UI。

应用内部 `window.duetlens.review.*` 是 Electron preload IPC，不是外部 HTTP API。审核 agent 的临时 MCP 也不是分享端口；不能假定外部 Codex 具有相同工具及任务上下文。Codex 桌面会话镜像使用的 IPC 只负责 Codex 对话，不提供 Duetlens 评论处理状态的回写能力。

需要新增接口时，先明确缺口和作用，例如“按 discussionId 回写修复说明并标记处理状态”，由后续明确任务实现；不要在修改业务代码的任务里顺便改装 Duetlens 或伪造数据库状态。

## 源码定位（仅诊断协议时用）

以下路径相对于 Duetlens 源码仓库根目录：

- `src/backend/share/session-share-server.ts`：监听、路由、Host 校验、只读限制、生命周期。
- `src/backend/share/session-reader.ts`：上下文、讨论锚点、文件/版本闸门。
- `src/main.ts`：数据目录、启动恢复、刷新回调。

这些路径不是运行 skill 的前提。缺源码时根据实际响应核验，不依赖旧版 UI 或旧笔记推断能力。
