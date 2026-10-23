/** 隔离组件回归:点击真实 finding 卡验证追问导航,不连接真实会话或调用模型。 */
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'duetlens-remark-ui-test-'));
try {
  await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SettingsProvider } from './src/renderer/settings/SettingsProvider';
    import { ReviewScreen } from './src/renderer/screens/ReviewScreen';
    import { installPreviewApi } from './src/renderer/preview/fixtures';
    import './src/renderer/index.css';
    installPreviewApi();
    const api = window.duetlens.review;
    const listeners = new Set();
    api.onEvent = callback => { listeners.add(callback); return () => listeners.delete(callback); };
    const fire = event => { for (const listener of listeners) listener(event); };
    window.sends = [];
    let items = [
      {id:'note',role:'user',kind:'note',text:'saved annotation',createdAt:1},
      {id:'question',role:'user',kind:'chat',text:'agent question',createdAt:2},
      {id:'answer',role:'agent',kind:'chat',text:'agent answer',createdAt:3},
      {id:'legacy',role:'user',kind:'legacy',text:'unclassified old message',createdAt:4},
    ];
    let thread;
    api.messages = async id => { thread = id; return items.map(item=>({...item,discussionId:id})); };
    api.getUiState = async () => ({ viewedFiles: [], lastActiveTab: 'findings' });
    api.deleteMessage = async (_review,id,expected) => {
      const item=items.find(item=>item.id===id);
      if (!item || item.text!==expected) throw new Error('stale remark');
      items=items.filter(item=>item.id!==id);
      fire({reviewId:'demo',type:'message-deleted',discussionId:thread,messageId:id});
    };
    api.classifyMessage = async (_review,id,kind,expected) => {
      const item=items.find(item=>item.id===id);
      if (!item || item.text!==expected) throw new Error('stale remark');
      item.kind=kind;
      fire({reviewId:'demo',type:'message',payload:{...item,discussionId:thread}});
      return item;
    };
    api.sendMessage = async (_review,id,text,mode) => {
      window.sends.push(mode);
      const item={id:crypto.randomUUID(),discussionId:id,role:'user',kind:mode==='note'?'note':'chat',text,createdAt:Date.now()};
      items.push(item);fire({reviewId:'demo',type:'message',payload:item});return item;
    };
    api.clearDiscussion = async (_review,id,kind) => {
      items=items.filter(item=>item.kind!==kind);
      fire({reviewId:'demo',type:'messages-cleared',discussionId:id,kind});
    };
    createRoot(document.getElementById('root')).render(<SettingsProvider><ReviewScreen reviewId="demo" /></SettingsProvider>);
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'renderer.js'), jsx: 'automatic', platform: 'browser', loader: { '.svg': 'text' }, define: { __APP_VERSION__: '"test"' } });
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
  await writeFile(path.join(directory, 'main.cjs'), `
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
 const win = new BrowserWindow({width:1500,height:1000,show:false,webPreferences:{contextIsolation:true}});
 try {
  await win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});
  const js = code => win.webContents.executeJavaScript(code);
  const until = async code => { for(let i=0;i<100;i++){if(await js(code))return;await wait(30);}throw new Error('Timed out: '+code); };
  await until('!!document.querySelector(".f-ask")');
  const click = async selector => {
    await js('document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"center"})');
    const at = await js('(() => {const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    win.webContents.sendInputEvent({type:'mouseDown',...at,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',...at,button:'left',clickCount:1});await wait(120);
  };
  await click('.f-ask');
  await until('document.querySelector(".thread")?.textContent.includes("agent answer")');
  assert(!await js('document.querySelector(".thread").textContent.includes("saved annotation")'));
  assert.equal(await js('document.querySelectorAll(".remark-edit-trigger, .remark-delete-trigger").length'),0,'chat messages do not expose remark controls');
  win.webContents.insertText('chat draft');await wait(40);
  await click('[data-kind=note]');
  assert(await js('document.querySelector(".thread").textContent.includes("saved annotation")'));
  assert(!await js('document.querySelector(".thread").textContent.includes("agent question")'));
  await click('.remark-edit-trigger');
  assert(await js('!!document.querySelector(".remark-editor .remark-delete-trigger")'),'can delete while editing');
  await click('.remark-editor .remark-delete-trigger');
  assert(await js('document.querySelector(".thread").textContent.includes("saved annotation")'),'first click only confirms');
  await click('.remark-editor .remark-delete-trigger');
  await until('!document.querySelector(".thread").textContent.includes("saved annotation")');
  await click('.composer-input');win.webContents.insertText('new annotation');await wait(40);
  await click('[data-kind=chat]');
  assert.equal(await js('document.querySelector(".composer-input").value'),'chat draft','separate chat draft retained');
  await click('[data-kind=note]');
  assert.equal(await js('document.querySelector(".composer-input").value'),'new annotation','separate note draft retained');
  await click('.composer .send');
  await until('document.querySelector(".thread").textContent.includes("new annotation")');
  assert.deepEqual(await js('window.sends'),['note'],'note save never calls agent');
  await click('.thr-clear');await click('.thr-clear');
  await until('!document.querySelector(".thread").textContent.includes("new annotation")');
  await click('[data-kind=chat]');
  assert(await js('document.querySelector(".thread").textContent.includes("agent question")'),'clearing notes preserves chat');
  assert(await js('document.querySelector(".thread").textContent.includes("agent answer")'));
  await click('.composer .send');
  assert.deepEqual(await js('window.sends'),['note','agent'],'chat send uses agent route');
  await click('[data-kind=legacy]');
  assert(await js('document.querySelector(".thread").textContent.includes("unclassified old message")'));
  await click('.remark-classify button');
  await click('[data-kind=note]');
  assert(await js('document.querySelector(".thread").textContent.includes("unclassified old message")'),'legacy classification updates same message');
  assert.deepEqual(await js('window.sends'),['note','agent'],'classification never sends');
  console.log('remarks UI: separated note/chat/legacy, independent drafts and send routes, delete while editing, confirmation, scoped clearing and live classification passed');
  win.destroy();app.exit(0);
 } catch(error) {console.error(error);win.destroy();app.exit(1);}
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Remark test exited ${code}`);
} finally { await rm(directory, { recursive: true, force: true }); }
