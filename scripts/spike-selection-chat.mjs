/** 隔离组件回归:真实 diff 选区追加到审核对话,不连接真实会话或调用模型。 */
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'duetlens-selection-chat-test-'));
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
    window.sends=[];window.created=0;
    const originalAdd=api.addDiscussion;
    api.addDiscussion=async (...args)=>{window.created++;return originalAdd(...args);};
    api.sendMessage=async (_review,id,text,mode)=>{window.sends.push({text,mode});return {id:'sent',discussionId:id,role:'user',kind:mode==='agent'?'chat':'note',text,createdAt:Date.now()};};
    api.getUiState=async()=>({viewedFiles:[],lastActiveTab:'findings'});
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
  await until('!!document.querySelector(".diff-file td.src")');
  const click = async selector => {
    await js('document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"center"})');
    const at = await js('(() => {const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    win.webContents.sendInputEvent({type:'mouseDown',...at,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',...at,button:'left',clickCount:1});await wait(120);
  };
  const selectCode = async (old=false) => {
    await js('(()=>{const row=[...document.querySelectorAll(".diff-file tr[data-'+(old?'old':'new')+'-line]")].find(r=>'+(old?'!r.dataset.newLine':'!!r.dataset.newLine')+');const cell=row.querySelector("td.src");cell.scrollIntoView({block:"center"});const range=document.createRange();range.selectNodeContents(cell);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.selectedContext={file:row.closest(".diff-file").dataset.path,line:row.dataset.'+(old?'oldLine':'newLine')+',text:cell.textContent};cell.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));})()');
    await until('!!document.querySelector(".sp-add-chat")');
    return js('window.selectedContext');
  };
  const selected=await selectCode();
  await click('.sp-add-chat');
  await until('!!document.querySelector(".composer-input") && document.querySelector(".composer-input").value.includes(window.selectedContext.text)');
  assert.equal(await js('document.querySelector("[data-kind=chat]").getAttribute("aria-selected")==="true"'),true);
  let draft=await js('document.querySelector(".composer-input").value');
  assert(draft.includes(selected.file+':'+selected.line));
  assert(draft.includes('当前代码'));
  assert.equal(await js('window.created'),0,'staging must not create a discussion');
  assert.deepEqual(await js('window.sends'),[],'staging must never call agent or save note');
  assert(await js('document.activeElement.classList.contains("composer-input")'),'composer focused');
  win.webContents.insertText('my question');await wait(40);
  await click('[data-kind=note]');
  assert.equal(await js('document.querySelector(".composer-input").value'),'','note draft stays separate');
  const deleted=await selectCode(true);
  await click('.sp-add-chat');
  await until('document.querySelector(".composer-input").value.includes("删除前代码")');
  draft=await js('document.querySelector(".composer-input").value');
  assert(draft.includes('my question'),'existing chat draft preserved');
  assert(draft.includes(deleted.file+':'+deleted.line));
  assert(draft.includes(deleted.text));
  await click('[data-kind=note]');await click('[data-kind=chat]');
  assert.equal(await js('document.querySelector(".composer-input").value'),draft,'switching pane does not append selection again');
  assert.deepEqual(await js('window.sends'),[]);
  await click('.composer .send');
  await until('window.sends.length===1');
  const sent=await js('window.sends[0]');
  assert.equal(sent.mode,'agent');assert.equal(sent.text,draft.trim());
  console.log('selection chat: real diff selection, file/line/side context, append without overwrite, separate notes, no auto-send, no replay and explicit agent send passed');
  win.destroy();app.exit(0);
 } catch(error) {console.error(error);win.destroy();app.exit(1);}
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Selection chat test exited ${code}`);
} finally { await rm(directory, { recursive: true, force: true }); }
