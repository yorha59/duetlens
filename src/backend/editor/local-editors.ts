import { execFile } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LocalEditor } from '@shared/ipc';

const exec = promisify(execFile);
const EDITORS = [
  { id: 'cursor', name: 'Cursor', app: 'Cursor.app' },
  { id: 'vscode', name: 'Visual Studio Code', app: 'Visual Studio Code.app' },
  { id: 'windsurf', name: 'Windsurf', app: 'Windsurf.app' },
  { id: 'zed', name: 'Zed', app: 'Zed.app' },
  { id: 'sublime', name: 'Sublime Text', app: 'Sublime Text.app' },
  { id: 'xcode', name: 'Xcode', app: 'Xcode.app' },
] as const;

/** 白名单内、本机实际安装的代码编辑器。应用路径只在 main 内使用。 */
export async function detectEditors(roots = ['/Applications', path.join(os.homedir(), 'Applications')]): Promise<(LocalEditor & { appPath: string })[]> {
  const found: (LocalEditor & { appPath: string })[] = [];
  for (const editor of EDITORS) {
    for (const root of roots) {
      const appPath = path.join(root, editor.app);
      try {
        await access(path.join(appPath, 'Contents', 'Info.plist'));
        found.push({ id: editor.id, name: editor.name, appPath });
        break;
      } catch { /* 未安装则不列出。 */ }
    }
  }
  return found;
}

/** 打开本地当前版本;禁止通过绝对路径、.. 或符号链接跨出关联仓库。 */
export async function resolveEditorFile(repoPath: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error('文件路径必须是仓库内的相对路径');
  }
  const root = await realpath(repoPath);
  const candidate = path.resolve(root, relativePath);
  const inside = (file: string) => {
    const rel = path.relative(root, file);
    return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (!inside(candidate)) throw new Error('文件不在关联仓库内');
  let file: string;
  try { file = await realpath(candidate); }
  catch { throw new Error('本地文件不存在,可能已删除或尚未 checkout 到当前工作区'); }
  if (!inside(file)) throw new Error('文件链接指向关联仓库以外');
  if (!(await stat(file)).isFile()) throw new Error('只能在编辑器中打开文件');
  return file;
}

export function editorLaunch(editor: LocalEditor & { appPath: string }, file: string, line?: number): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error('行号必须是正整数');
  if (line !== undefined) {
    const target = `${file}:${line}:1`;
    const cliNames: Record<string, string | undefined> = { cursor: 'cursor', vscode: 'code', windsurf: 'windsurf' };
    const cli = cliNames[editor.id];
    if (cli) return {
      command: path.join(editor.appPath, 'Contents/Resources/app/bin', cli),
      args: ['--goto', target],
      env: { ...process.env, VSCODE_IPC_HOOK_CLI: '' },
    };
    if (editor.id === 'xcode') return {
      command: '/usr/bin/xed', args: ['--line', String(line), file],
      env: { ...process.env, DEVELOPER_DIR: path.join(editor.appPath, 'Contents/Developer') },
    };
    if (editor.id === 'sublime') return { command: path.join(editor.appPath, 'Contents/SharedSupport/bin/subl'), args: [target] };
    if (editor.id === 'zed') return { command: path.join(editor.appPath, 'Contents/MacOS/cli'), args: [target] };
    throw new Error('该编辑器暂不支持行号定位');
  }
  return { command: '/usr/bin/open', args: ['-a', editor.appPath, '--', file] };
}

export async function openEditorFile(editor: LocalEditor & { appPath: string }, file: string, line?: number): Promise<void> {
  // 不经 shell 拼接,文件名中的空格、引号与选项前缀都按普通路径处理。
  const launch = editorLaunch(editor, file, line);
  await exec(launch.command, launch.args, { env: launch.env, timeout: 30_000 });
}
