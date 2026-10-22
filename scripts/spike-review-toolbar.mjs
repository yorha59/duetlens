/** 在隔离 Electron 窗口中用 Chromium 鼠标输入验证整项拖动,不接触已安装应用和真实审核。 */
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'duetlens-toolbar-test-'));
try {
  await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReviewToolbar } from './src/renderer/screens/review/ReviewToolbar';
    window.clicks = 0;
    const actions = ['codex', 'refresh', 'share'].map(id => ({id, label:id, content:<button onClick={() => window.clicks++}>{id}</button>}));
    createRoot(document.getElementById('root')).render(<header className="rev-topbar"><div className="source">Review title</div><ReviewToolbar actions={actions} middle={<button className="source-mode">Remote / Local</button>} /></header>);
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'renderer.js'), jsx: 'automatic', platform: 'browser' });
  await writeFile(path.join(directory, 'index.html'), `<!doctype html><link rel="stylesheet" href="renderer.css"><style>
  :root { --agent-2:#5af; --surface-2:#18202b; --surface-3:#283041; --border:#456; --text:#fff; --text-faint:#aab; }
  body {margin:0;background:#111;color:white;font:14px sans-serif;} .rev-topbar {height:60px;display:flex;align-items:center;gap:12px;padding:0 20px;-webkit-app-region:drag;} button {padding:10px 18px;color:white;background:#223;border:1px solid #567;border-radius:6px;-webkit-app-region:no-drag;}
  </style><div id="root"></div><script src="renderer.js"></script>`);
  await writeFile(path.join(directory, 'main.cjs'), `
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
 const win = new BrowserWindow({width:1100,height:700,show:false,webPreferences:{contextIsolation:true}});
 try {
  await win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});
  const js = code => win.webContents.executeJavaScript(code);
  await wait(100); win.webContents.focus();
  const rect = selector => js('(() => { const r = document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),left:r.x,right:r.right}; })()');
  const input = (type, at, extra={}) => win.webContents.sendInputEvent({type,x:at.x,y:at.y,...extra});
  const click = async selector => { const at=await rect(selector);input('mouseMove',at);input('mouseDown',at,{button:'left',clickCount:1});input('mouseUp',at,{button:'left',clickCount:1});await wait(50); };
  const drag = async (selector, destination) => {
    const from=await rect(selector);input('mouseMove',from);input('mouseDown',from,{button:'left',clickCount:1});
    for(let i=1;i<=8;i++){input('mouseMove',{x:Math.round(from.x+(destination.x-from.x)*i/8),y:Math.round(from.y+(destination.y-from.y)*i/8)},{button:'left',buttons:['left']});await wait(20);}
    input('mouseUp',destination,{button:'left',clickCount:1});await wait(80);
  };
  const pinned = () => js('JSON.parse(localStorage.getItem("duetlens.review-toolbar.pinned") || "[]")');
  await click('.review-toolbar-trigger');
  await click('.review-toolbar-menu [data-action-id="codex"] button');
  assert.equal(await js('window.clicks'),1,'normal click must still execute');
  await click('.review-toolbar-trigger');
  await drag('.review-toolbar-menu [data-action-id="codex"] button',{x:350,y:30});
  assert.deepEqual(await pinned(),['codex'],'drag button body onto empty header');
  assert.equal(await js('window.clicks'),1,'drag must not execute action');
  const fixed=await rect('.review-toolbar-pinned [data-action-id="codex"]');const mode=await rect('.source-mode');
  assert(fixed.right <= mode.left,'pinned action must be to the left of source switch');
  await wait(360);await click('.review-toolbar-trigger');
  await drag('.review-toolbar-menu [data-action-id="refresh"] button',{x:350,y:30});
  assert.deepEqual(await pinned(),['codex','refresh']);
  const first=await rect('.review-toolbar-pinned [data-action-id="codex"]');
  await drag('.review-toolbar-pinned [data-action-id="refresh"] button',{x:Math.round(first.left+2),y:first.y});
  assert.deepEqual(await pinned(),['refresh','codex'],'reorder pinned buttons');
  await drag('.review-toolbar-pinned [data-action-id="codex"] button',{x:950,y:135});
  assert.deepEqual(await pinned(),['refresh'],'drag fixed button back into menu');
  assert.equal(await js('window.clicks'),1,'all drags must avoid clicks');
  await wait(360);await click('.review-toolbar-trigger');
  assert.equal(await js('document.querySelectorAll(".review-toolbar-grip, .review-toolbar-pin").length'),0);
  assert.equal(await js('document.body.innerText.includes("全部收起")'),false);
  const before=await pinned();
  await drag('.review-toolbar-menu [data-action-id="share"] button',{x:300,y:600});
  assert.deepEqual(await pinned(),before,'drop outside toolbar cancels');
  await new Promise(resolve => { win.webContents.once('did-finish-load',resolve); win.reload(); });await wait(80);
  assert.deepEqual(await pinned(),before,'layout must survive reload');
  console.log('toolbar: normal click, header pin, pinned order, reorder, unpin, cancel, no extra controls passed');
  win.destroy();app.exit(0);
 } catch(error) {console.error(error);win.destroy();app.exit(1);}
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Toolbar test exited ${code}`);
} finally { await rm(directory, { recursive: true, force: true }); }
