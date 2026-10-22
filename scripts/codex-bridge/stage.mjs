// 离线构建候选 ASAR,保留原生模块的 unpacked 布局。不修改安装版或代码签名。
import asar from '@electron/asar';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { prepare } from './prepare.mjs';

const archive = '/Applications/ChatGPT.app/Contents/Resources/app.asar';
const output = path.resolve(process.argv[2] || 'codex-bridge.local');
const staged = path.join(output, 'app.asar');
try { await fs.stat(staged); throw Error('Candidate archive already exists; choose a new output directory'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const manifest = await prepare(archive, output);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'duetlens-asar-build-'));
function unpackedFiles(header) {
  const result = [];
  function walk(files, prefix = '') {
    for (const [name, file] of Object.entries(files)) {
      const member = prefix ? prefix + '/' + name : name;
      if (file.files) walk(file.files, member); else if (file.unpacked) result.push(member);
    }
  }
  walk(header.files); return result.sort();
}
try {
  const unpacked = unpackedFiles(asar.getRawHeader(archive).header);
  asar.extractAll(archive, temporary);
  for (const member of manifest.files) {
    const destination = path.join(temporary, member);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(output, member), destination);
  }
  await asar.createPackageWithOptions(temporary, staged, { unpack: '{' + unpacked.map(member => '**/' + member).join(',') + '}' });
  if (JSON.stringify(unpackedFiles(asar.getRawHeader(staged).header)) !== JSON.stringify(unpacked)) throw Error('Unpacked native module layout changed');
  for (const member of manifest.files) {
    const expected = await fs.readFile(path.join(output, member));
    if (!expected.equals(asar.extractFile(staged, member))) throw Error('Archive content mismatch: ' + member);
  }
  const candidate = {
    ...manifest,
    candidateArchive: staged,
    candidateSha256: createHash('sha256').update(await fs.readFile(staged)).digest('hex'),
    electronAsarIntegrity: createHash('sha256').update(asar.getRawHeader(staged).headerString).digest('hex'),
    unpackedNativeFiles: unpacked.length,
  };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(candidate, null, 2));
  console.log(JSON.stringify(candidate, null, 2));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
