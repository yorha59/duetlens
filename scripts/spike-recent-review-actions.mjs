/** 隔离组件回归:最近审核的备注和删除入口,不连接真实会话或调用模型。 */
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'duetlens-recent-review-test-'));
try {
  await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { RecentReviews } from './src/renderer/screens/entry/RecentReviews';
    import './src/renderer/index.css';
    import './src/renderer/screens/EntryScreen.css';
    const reviews = [1,2].map(n=>({id:String(n),source:'github-pr',sourceRef:'acme/repo#'+n,title:'Original '+n,status:'reviewing',currentRound:1,scopeCount:0,scanningScopeCount:0,findingCount:0,submittedCount:0,discussionCount:0}));
    window.calls = []; window.opened = []; window.fail = false;
    window.duetlens = {review:{
      setLocalTitle: async (id,title) => { window.calls.push('title'); if(window.fail)throw Error('save failed');return {...reviews.find(r=>r.id===id),localTitle:title.trim()||null}; },
      delete: async id => { window.calls.push('delete');if(window.fail)throw Error('delete failed'); },
    }};
    function Demo(){
      const [items,setItems]=useState(reviews);
      return <div className="entry-screen"><RecentReviews reviews={items} onOpen={id=>window.opened.push(id)} onChanged={r=>setItems(items=>items.map(item=>item.id===r.id?r:item))} onDeleted={id=>setItems(items=>items.filter(r=>r.id!==id))}/></div>;
    }
    createRoot(document.getElementById('root')).render(<Demo/>);
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
  await until('!!document.querySelector(".recent-actions button")');
  const click = async selector => {
    await js('document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"center"})');
    const at = await js('(() => {const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    win.webContents.sendInputEvent({type:'mouseDown',...at,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',...at,button:'left',clickCount:1});await wait(120);
  };
  const edit = '.recent-review-item:first-child .recent-actions button:first-child';
  const remove = '.recent-review-item:first-child .recent-actions button:last-child';
  const confirm = '.recent-confirm-delete';
  const cancel = '.recent-edit-panel button[type=button]';
  const input = '.recent-edit-panel input';
  const save = '.recent-edit-panel button[type=submit]';
  await click(edit);
  assert.deepEqual(await js('window.opened'),[],'edit must not open review');
  await click(input);win.webContents.insertText('草稿需求');await wait(40);
  await click(save);
  await until('document.querySelector(".recent-rev .t").textContent==="草稿需求"');
  assert.equal(await js('document.querySelector(".recent-original-title").textContent'),'Original 1');
  await click(edit);
  await js('window.fail=true');await click(save);
  assert.equal(await js('document.querySelector("[role=alert]").textContent'),'save failed');
  await js('window.fail=false');
  await click(input);
  await js('document.querySelector(".recent-edit-panel input").select()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'});await wait(60);
  await click(save);
  await until('document.querySelector(".recent-rev .t").textContent==="Original 1"');
  await click(remove);
  assert(!await js('window.calls.includes("delete")'),'first click only confirms');
  await click(cancel);
  assert.equal(await js('document.querySelectorAll(".recent-review-item").length'),2);
  await click(remove);await js('window.fail=true');await click(confirm);
  assert.equal(await js('document.querySelector("[role=alert]").textContent'),'delete failed');
  assert.equal(await js('document.querySelectorAll(".recent-review-item").length'),2);
  await js('window.fail=false');await click(confirm);
  await until('document.querySelectorAll(".recent-review-item").length===1');
  assert.equal(await js('document.querySelector(".recent-rev .t").textContent'),'Original 2');
  assert.deepEqual(await js('window.opened'),[]);
  console.log('recent review UI: title save/clear, original title, failures, delete confirmation/cancel and row removal passed');
  win.destroy();app.exit(0);
 } catch(error) {console.error(error);win.destroy();app.exit(1);}
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Recent review test exited ${code}`);
} finally { await rm(directory, { recursive: true, force: true }); }
