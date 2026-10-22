// 只输出候选模块,不改安装版、不启动应用。目标版本变化后必须重新定位入口。
import asar from '@electron/asar';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const modules = {
  bootstrap: '.vite/build/bootstrap-CooIJpZm.js',
  main: '.vite/build/main-CqEoQDOU.js',
  composer: 'webview/assets/app-primary-6f60e9ac4103.js',
};
const here = path.dirname(fileURLToPath(import.meta.url));
export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Codex integration anchor changed: ' + before.slice(0, 80));
  return source.replace(before, after);
}
export function patchSources(sources) {
  const output = { ...sources };
  output.bootstrap = replaceOnce(output.bootstrap,
    'let c={browserUrl:s?.data,prompt:t??void 0};',
    'let c={browserUrl:s?.data,prompt:t??void 0};try{c.duetlensContext=require("./duetlens-bridge.cjs").fromUrl(e)}catch{return null}');
  output.main = replaceOnce(output.main,
    'let i=n;t.prompt!=null&&(i={...n,focusComposerNonce:Date.now(),prefillPrompt:t.prompt});',
    'let i=t.duetlensContext?{...n,duetlensContext:t.duetlensContext}:n;t.prompt!=null&&(i={...n,focusComposerNonce:Date.now(),prefillPrompt:t.prompt});');
  output.main = replaceOnce(output.main, '"add-context-file":async({hostId:e,path:t,origin:n})=>',
    '"duetlens-context-ack":async({requestId,threadId})=>require("./duetlens-bridge.cjs").acknowledge(requestId,threadId),"add-context-file":async({hostId:e,path:t,origin:n})=>');
  output.composer = 'import{appendSelection as duetlensAppendSelection}from"./duetlens-context-bridge.mjs";\n' + output.composer;
  output.composer = replaceOnce(output.composer,
    'HD(`add-context-file`,dn.view.dom,e=>{go(),io([e.file])});',
    'HD(`add-context-file`,dn.view.dom,e=>{go(),io([e.file])});const duetlensHandled=(0,ZX.useRef)(new Map);(0,ZX.useEffect)(()=>{duetlensAppendSelection({ticket:it?.duetlensContext,threadId:Ye,addFiles:io,handled:duetlensHandled.current,acknowledge:params=>to("duetlens-context-ack",{params})}).catch(error=>console.warn("Duetlens context append failed",error))},[it?.duetlensContext,Ye,io]);');
  return output;
}

export async function prepare(archive, directory) {
  const bytes = await fs.readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== '75e397e2280dde93b70a85aa926f4282c728eacc84dfeb15ba7fb6ddd84628af') throw Error('Unsupported Codex build; refusing to patch unknown code');
  const sources = Object.fromEntries(Object.entries(modules).map(([key, member]) => [key, asar.extractFile(archive, member).toString()]));
  const patched = patchSources(sources);
  await fs.mkdir(directory, { recursive: true });
  const files = {};
  for (const [key, member] of Object.entries(modules)) files[member] = patched[key];
  files['.vite/build/duetlens-bridge.cjs'] = await fs.readFile(path.join(here, 'receiver.cjs'), 'utf8');
  files['webview/assets/duetlens-context-bridge.mjs'] = await fs.readFile(path.join(here, 'append-selection.mjs'), 'utf8');
  for (const [member, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, member)), { recursive: true });
    await fs.writeFile(path.join(directory, member), contents);
  }
  const manifest = { sourceArchive: archive, sourceSha256: sha256, files: Object.keys(files), installed: false };
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await prepare(process.argv[2] || '/Applications/ChatGPT.app/Contents/Resources/app.asar', process.argv[3] || path.resolve('codex-bridge.local'));
  console.log(JSON.stringify(result, null, 2));
}
