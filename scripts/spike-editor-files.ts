/** 编辑器 IPC 的路径边界验证,不实际启动外部应用。 */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectEditors, editorLaunch, resolveEditorFile } from '../src/backend/editor/local-editors';

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'duetlens-editor-test-'));
  try {
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    const name = '中文 file; $(echo test).ts';
    await writeFile(path.join(repo, name), 'example');
    await writeFile(path.join(root, 'outside.txt'), 'private');
    assert.equal(await resolveEditorFile(repo, name), await realpath(path.join(repo, name)));
    await symlink(name, path.join(repo, 'inside-link'));
    assert.equal(await resolveEditorFile(repo, 'inside-link'), await realpath(path.join(repo, name)));
    await symlink('../outside.txt', path.join(repo, 'outside-link'));
    for (const file of ['../outside.txt', path.join(root, 'outside.txt'), 'outside-link', 'missing.ts', '.', '\0']) {
      await assert.rejects(resolveEditorFile(repo, file), file);
    }
    const cursor = { id: 'cursor', name: 'Cursor', appPath: '/Applications/Cursor.app' };
    const launch = editorLaunch(cursor, path.join(repo, name), 42);
    assert.deepEqual(launch.args, ['--goto', `${path.join(repo, name)}:42:1`]);
    assert.equal(launch.command, '/Applications/Cursor.app/Contents/Resources/app/bin/cursor');
    const xcode = editorLaunch({ id: 'xcode', name: 'Xcode', appPath: '/Applications/Xcode.app' }, path.join(repo, name), 7);
    assert.deepEqual(xcode.args, ['--line', '7', path.join(repo, name)]);
    for (const line of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => editorLaunch(cursor, 'file.ts', line));
    console.log('editor path and line targeting: passed');
    console.log('installed editors:', (await detectEditors()).map((editor) => editor.name).join(', ') || '(none)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
