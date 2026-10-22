import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 只存内容寻址对象,不复制工作区。旧 tree 得以在临时快照释放或应用重启后继续比较。 */
export async function archiveSnapshotObjects(gitDirectory: string, archive: string, originalObjects: string): Promise<void> {
  const objects = path.join(archive, 'objects');
  await mkdir(path.join(objects, 'info'), { recursive: true });
  for (const entry of await readdir(path.join(gitDirectory, 'objects'), { withFileTypes: true })) {
    if (entry.isDirectory() && (/^[a-f0-9]{2}$/.test(entry.name) || entry.name === 'pack')) {
      await cp(path.join(gitDirectory, 'objects', entry.name), path.join(objects, entry.name), { recursive: true, force: false });
    }
  }
  await writeFile(path.join(objects, 'info/alternates'), `${originalObjects}\n`);
}
