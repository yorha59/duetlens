import { renderToStaticMarkup } from 'react-dom/server';
import BetterSqlite3 from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { ReviewStore } from '../src/backend/db/review-store';
import { parseUnifiedDiff } from '../src/shared/diff';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require.extensions['.css'] = () => {};
async function main() {
const { DiffPane } = await import('../src/renderer/screens/review/DiffPane');
const db = new BetterSqlite3(process.argv[2], { readonly: true });
const store = new ReviewStore(db);
const review = store.listReviews().find((review) => review.localReview)!;
const files = parseUnifiedDiff(store.getRawDiff(review.id)!);
const previousError = console.error;
console.error = (message, ...rest) => { if (!String(message).includes('useLayoutEffect does nothing on the server')) previousError(message, ...rest); };
const start = performance.now();
const markup = renderToStaticMarkup(<DiffPane files={files} findings={store.listFindings(review.id)} discussions={store.listDiscussions(review.id)} activePath={files[0]?.path ?? null} focusFindingId={null} view="unified" viewed={new Set()} collapsed={new Set()} onToggleViewed={() => {}} onToggleCollapsed={() => {}} />);
console.error = previousError;
console.log(JSON.stringify({ files: files.length, allDiffLines: files.reduce((sum, file) => sum + file.hunks.reduce((s, hunk) => s + hunk.lines.length, 0), 0), mountedCodeRows: (markup.match(/class="row/g) ?? []).length, htmlBytes: markup.length, renderMs: Math.round(performance.now() - start) }));
db.close();
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
