# Codex 原生文件引用桥接原型

目标是把 Duetlens 的文件与行范围直接追加到绑定 Codex 对话的草稿。复用 Codex 文件浏览器的 `addFileDescriptorsAsMentions`,不经过剪贴板、按键模拟或模型消息提交。

## 边界

- `prepare.mjs` 只读取指定安装包,输出候选模块与 manifest。它不修改、签名、启动或重启 Codex。
- 原生 IPC 的 `add-context-file` 不等于应用内部同名入口;用 `probe-ipc.mjs` 获取本机接收端的实际应答。
- MCP App 的 `ui/message` + `send: false` 走 `updateLiteralText`,能追加文字,但不能等价替代原生文件引用。插件方案不作为本原型的传输层。
- 桥接需要 Codex 侧加载补丁。官方安装包的签名会因此改变,更新会覆盖补丁,钥匙串与应用组权限可能受影响。未经额外确认不替换安装版。
- 隔离测试执行安装包中的路由函数和候选 effect,以模拟回调检验追加行为;它不证明真实 Codex 界面已运行该补丁。

## 可复跑命令

从仓库根目录运行:

```sh
node scripts/codex-bridge/probe-ipc.mjs
node scripts/codex-bridge/test.mjs
node scripts/codex-bridge/prepare.mjs
node scripts/codex-bridge/stage.mjs
```

候选代码写入被 Git 忽略的 `codex-bridge.local/`,manifest 记录实际来源摘要。安装包摘要或定位锚点不匹配就退出,不能盲目应用到升级后的版本。

`stage.mjs` 离线重打包候选 ASAR,验证新增模块与原生 unpacked 布局,记录签名所需的 Electron header hash。它不替换应用,不改 Info.plist,不执行签名命令。

`send.mjs THREAD_UUID ABSOLUTE_FILE START_LINE END_LINE` 只生成票据。已加载桥接后,显式增加 `--open` 才打开对应会话并等待原生追加回执;超时不会回退到发送模型消息或覆盖草稿。

## 交接过程

1. Duetlens 校验选区与审核版本;不匹配磁盘的选区应复用已有快照机制。
2. 当前用户写入有效期两分钟、权限 `0600` 的票据。链接只携带随机 UUID。
3. Codex 读取票据、验证所有者与绑定的本地对话,通过路由状态传给该会话。
4. 输入框 effect 调用原生文件追加回调,不设置 `prefillPrompt`,不修改原草稿正文。
5. 原生回调完成后写入回执。发送端只有读到正确回执才报告成功。

原型尚需实机验证:签名及登录兼容性、真实文件行引用展示和点击、会话重新挂载时的幂等处理、宿主繁忙或编辑历史消息时的拒绝行为。在这些验证完成前不替换 Duetlens 的正式交接功能。
