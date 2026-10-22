import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { prepareCodexHandoff } from '../src/backend/codex/selection-handoff';
import { parseUnifiedDiff } from '../src/shared/diff';
import { parseCodexThread } from '../src/shared/codex-handoff';
const thread = '01a13e53-eff9-7572-a453-3f3ed9420fe5';
async function main() {
 const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-codex-handoff-'));
 const db = openDatabase(path.join(root, 'test.db'));
 try {
  assert.equal(parseCodexThread(`codex://threads/${thread}`), thread);
  for (const input of ['codex://threads/new', `https://evil.test/${thread}`, `codex://threads/${thread}?prompt=send`, '../x']) assert.throws(() => parseCodexThread(input));
  const store = new ReviewStore(db);
  const remote = store.createReview({ source: 'github-pr', sourceRef: 'a/b#1', repoPath: root });
  const local = store.createWorkspaceLocal(remote.id, root, 'base', '', null);
  store.setCodexBinding(local.id, { threadId: thread, mode: 'copy' });
  assert.equal(store.getCodexBinding(remote.id)?.threadId, thread);
  store.setCodexBinding(remote.id, { threadId: thread, mode: 'prefill' });
  assert.equal(store.getCodexBinding(local.id)?.mode, 'prefill');
  const name = 'file with space.ts'; const code = 'const value = 1;\nconst next = 2;';
  await writeFile(path.join(root, name), `header\n${code}\n`);
  const diff = parseUnifiedDiff(`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,3 @@\n header\n-const value = 0;\n+const value = 1;\n+const next = 2;\n`);
  const selection = { file: name, line: 2, lineEnd: 3, text: code };
  const prepared = await prepareCodexHandoff(remote, selection, diff, path.join(root, 'snapshots'), { threadId: thread, mode: 'prefill' }, 'http://127.0.0.1/session');
  assert.equal(prepared.snapshot, false); assert.equal(prepared.copiedOnly, false);
  assert.equal(new URL(prepared.url).searchParams.get('prompt'), prepared.text);
  assert(prepared.text.includes('#L2-L3')); assert(prepared.html.includes('at-mention-fs-path='));
  assert(!new URL(prepared.url).searchParams.has('send'));
  const copy = await prepareCodexHandoff(remote, selection, diff, root, { threadId: thread, mode: 'copy' }, 'http://127.0.0.1/session');
  assert.equal(copy.copiedOnly, true); assert(!new URL(copy.url).search);
  const old = await prepareCodexHandoff(remote, { file: name, line: 2, side: 'old', text: 'const value = 0;' }, diff, path.join(root, 'snapshots'), { threadId: thread, mode: 'copy' }, 'http://127.0.0.1/session');
  assert(old.snapshot); assert(old.text.includes('删除前旧侧')); assert.equal(await readFile(path.join(root, name), 'utf8'), `header\n${code}\n`);
  const large = await prepareCodexHandoff(remote, { ...selection, text: 'x'.repeat(30_000) }, diff, path.join(root, 'snapshots'), { threadId: thread, mode: 'prefill' }, 'http://127.0.0.1/session');
  assert(large.copiedOnly); assert(large.snapshot);
  await assert.rejects(prepareCodexHandoff(remote, { ...selection, file: '../secret' }, diff, root, { threadId: thread, mode: 'copy' }, 'http://127.0.0.1/session'));
  // 只运行已安装 Codex 中两个无副作用的纯解析函数,不执行应用 bootstrap 或操作界面。
  const require = createRequire(import.meta.url);
  const asar = require('@electron/asar') as { extractFile(p: string, f: string): Buffer };
  const pkg = '/Applications/ChatGPT.app/Contents/Resources/app.asar';
  const source = asar.extractFile(pkg, 'webview/assets/app-shared-8bd9d0399038.js').toString();
  const parser = source.match(/function zZ\(e\)\{[\s\S]+?return\{path:t\}\}/)?.[0];
  assert(parser, 'installed Codex line locator parser changed; recheck native integration');
  const parse = vm.runInNewContext(`(${parser})`) as (path: string) => { path: string; line: number; endLine: number };
  const lineRef = prepared.html.match(/at-mention-fs-path="([^"]+)"/)![1];
  assert.deepEqual(JSON.parse(JSON.stringify(parse(lineRef))), { path: await realpath(path.join(root, name)), line: 2, endLine: 3 });
  const initial = asar.extractFile(pkg, 'webview/assets/app-initial-6350d04672d0.js').toString();
  assert(initial.includes('tag:`span[at-mention-label][at-mention-path][at-mention-fs-path]`'));
  assert(initial.includes('s&&p?S.push(p.create({label:M,path:N,fsPath:N}))'), 'Codex no longer restores path Markdown as native mentions');
  store.setCodexBinding(local.id, null); assert.equal(store.getCodexBinding(remote.id), null);
  console.log('Codex handoff: shared task binding/validation/native file HTML and installed line parser/prefill-vs-copy/no autosend/snapshot/version mismatch/long selection fallback/source preserved passed');
 } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
