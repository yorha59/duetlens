/** 隔离组件回归:点击真实 finding 卡验证追问导航,不连接真实会话或调用模型。 */
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'duetlens-followup-test-'));
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
    const discussions = api.discussions;
    let loads = 0;
    window.sent = 0;
    window.fail = new URLSearchParams(location.search).has('fail');
    window.missing = new URLSearchParams(location.search).has('missing');
    api.discussions = async id => {
      if (++loads === 1) return new Promise(resolve => setTimeout(() => resolve([]), 400));
      if (window.fail) throw new Error('fixture: thread fetch failed');
      return window.missing ? [] : discussions(id);
    };
    api.getUiState = async () => ({ viewedFiles: [], lastActiveTab: 'findings' });
    api.sendMessage = async () => { window.sent++; throw new Error('must not send'); };
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
  await until('!!document.querySelector(".disc-item.on")');
  await wait(450);
  assert(await js('!!document.querySelector(".disc-item.on")'),'late initial snapshot must not erase the recovered thread');
  assert.equal(await js('document.activeElement?.className'),'composer-input','followup focuses the question composer');
  assert.equal(await js('window.sent'),0,'opening a discussion must not invoke the agent');
  win.webContents.insertText('existing draft');await wait(50);
  await click('.f-ask');
  assert.equal(await js('document.activeElement?.className'),'composer-input','repeated followup focuses again');
  assert.equal(await js('document.querySelector(".composer-input").value'),'existing draft','repeat focus preserves typed text');
  for (const mode of ['fail','missing']) {
    await win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))},{query:{[mode]:'1'}});
    await until('!!document.querySelector(".f-ask")');
    await click('.f-ask');
    await until('!!document.querySelector(".finding-followup-error")');
    assert((await js('document.querySelector(".finding-followup-error").textContent')).includes(mode === 'fail' ? 'fixture: thread fetch failed' : '找不到'));
    assert.equal(await js('window.sent'),0);
    assert.equal(await js('document.querySelector(".f-ask").disabled'),false,'can retry after failure');
  }
  console.log('followup: real card click, missing discussion recovery, selected thread, repeat focus, draft retention, explicit failure/retry, no auto-send passed');
  win.destroy();app.exit(0);
 } catch(error) {console.error(error);win.destroy();app.exit(1);}
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Followup test exited ${code}`);
} finally { await rm(directory, { recursive: true, force: true }); }
