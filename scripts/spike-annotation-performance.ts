/** 批注不启动 agent,以及重复渲染高亮的计算量验证。 */
import { strict as assert } from 'node:assert';
import { performance } from 'node:perf_hooks';
import BetterSqlite3 from 'better-sqlite3';
import hljs from 'highlight.js/lib/core';
import { openDatabase } from '../src/backend/db/database';
import { ReviewStore } from '../src/backend/db/review-store';
import { ReviewManager } from '../src/backend/review/review-manager';
import { SharedSessionReader } from '../src/backend/share/session-reader';
import { createLineHighlighter, highlightLine, langOf } from '../src/renderer/screens/review/highlight';
import { parseUnifiedDiff } from '../src/shared/diff';

async function main() {
  const db = openDatabase(':memory:');
  try {
    const store = new ReviewStore(db);
    const review = store.createReview({ source: 'local-worktree', sourceRef: 'test', repoPath: '/must-not-run-git', status: 'scanning' });
    const finding = store.addFinding(review.id, { title: 'test', body: '', file: 'a.ts', line: 1, severity: 'low' });
    let agentCalls = 0; let events = 0;
    const manager = new ReviewManager(store, undefined, { agentFactory: () => { agentCalls++; throw new Error('must not run'); } });
    manager.on('review-event', (event) => { if (event.type === 'message') events++; });
    await manager.sendMessage(review.id, finding.discussionId, '只保存批注', 'note');
    assert.equal(agentCalls, 0); assert.equal(events, 1);
    assert.equal(store.getReview(review.id)!.status, 'scanning', 'notes must not alter active scan status');
    const context = new SharedSessionReader(store, '/unused').context(review.id, 'http://127.0.0.1/test');
    assert.equal(context.discussions[0].messages[0].text, '只保存批注', 'external reader sees saved note immediately');
    const other = store.createReview({ source: 'local-worktree', sourceRef: 'other', status: 'reviewing' });
    await assert.rejects(manager.sendMessage(other.id, finding.discussionId, 'wrong', 'note'), /不属于/);
    await assert.rejects(manager.sendMessage(review.id, finding.discussionId, ' ', 'note'), /不能为空/);
    assert.equal(store.listMessages(finding.discussionId).length, 1);
    let calls = 0;
    const cached = createLineHighlighter((text, lang) => { calls++; return `${lang}:${text}`; }, 2, 100);
    assert.equal(cached('x', 'typescript'), cached('x', 'typescript')); assert.equal(calls, 1);
    cached('x', 'javascript'); assert.equal(calls, 2, 'language is part of key');
    cached('y', null); cached('x', 'typescript'); assert.equal(calls, 4, 'eviction bounds memory');
    const before = calls; cached('<'.repeat(5000), 'typescript'); assert.equal(calls, before, 'long lines bypass expensive regex');
    assert.ok(highlightLine('<script>', null).includes('&lt;script&gt;'));

    // 可选只读读取实际 diff 测量高亮,不会修改应用库或启动任何 agent。
    let corpus = Array.from({ length: 3000 }, (_, i) => ({ text: `const value${i}: number = ${i};`, lang: 'typescript' as string | null }));
    if (process.argv[2]) {
      const existing = new BetterSqlite3(process.argv[2], { readonly: true });
      const patches = existing.prepare('SELECT raw FROM review_diffs').all() as { raw: string }[];
      corpus = patches.flatMap(({ raw }) => parseUnifiedDiff(raw).flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.map((line) => ({ text: line.text, lang: langOf(file.path) }))))).filter((line) => !!line.lang && line.text.length < 4096);
      existing.close();
    }
    const compute = (text: string, lang: string | null) => lang ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : text;
    const start = performance.now(); for (const line of corpus) compute(line.text, line.lang); const uncachedMs = performance.now() - start;
    let computations = 0;
    const warm = createLineHighlighter((text, lang) => { computations++; return compute(text, lang); });
    for (const line of corpus) warm(line.text, line.lang);
    const warmCalls = computations; const next = performance.now();
    for (const line of corpus) warm(line.text, line.lang);
    assert.equal(computations, warmCalls, 're-render must not recompute highlighter for this diff');
    console.log(JSON.stringify({ lines: corpus.length, uncachedHighlightMs: Math.round(uncachedMs), cachedHighlightMs: +(performance.now() - next).toFixed(2), repeatComputations: computations - warmCalls }));
    console.log('annotation: no-agent notes/scan coexistence/message event/external visibility/scope guard/bounded highlight cache passed');
  } finally { db.close(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
