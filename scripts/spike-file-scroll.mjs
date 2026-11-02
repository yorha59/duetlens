/** 隔离 Electron 回归:验证真实目录与虚拟 diff 的滚动联动,不接触安装版和审核数据。 */
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'duetlens-file-scroll-test-'));
try {
  await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { FileTree } from './src/renderer/screens/review/FileTree';
    import { DiffPane } from './src/renderer/screens/review/DiffPane';
    import './src/renderer/index.css';
    import './src/renderer/screens/ReviewScreen.css';
    const files=Array.from({length:30},(_,i)=>({path:'pkg/group'+String(i).padStart(2,'0')+'/file.ts',oldPath:null,status:'added',binary:false,additions:80,deletions:0,hunks:[{oldStart:0,oldCount:0,newStart:1,newCount:80,section:'',lines:Array.from({length:80},(_,j)=>({kind:'add',oldLine:null,newLine:j+1,text:'const value'+j+' = '+j+';'}))}]}));
    const empty=[];const none=new Set();
    function App(){
      const [active,setActive]=useState(files[0].path);const [nonce,setNonce]=useState(0);
      const [view,setView]=useState('tree');const [query,setQuery]=useState('');
      return <div className="test-layout">
        <FileTree files={files} findings={empty} activePath={active} onSelect={path=>{setActive(path);setNonce(n=>n+1)}} viewed={none} onToggleViewed={()=>{}} query={query} onQueryChange={setQuery} view={view} onViewChange={setView}/>
        <DiffPane files={files} findings={empty} discussions={empty} activePath={active} activePathNonce={nonce} focusFindingId={null} onSelectFile={setActive} viewed={none} collapsed={none} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} view="unified"/>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `, loader:'tsx',resolveDir:process.cwd()},bundle:true,outfile:path.join(directory,'renderer.js'),jsx:'automatic',platform:'browser'});
  await writeFile(path.join(directory,'index.html'), '<!doctype html><link rel="stylesheet" href="renderer.css"><style>.test-layout{height:760px;display:flex}.test-layout>.tree{width:300px;flex:none;overflow:auto}.test-layout>.diff-col{flex:1;min-width:0;display:flex;min-height:0}.diff.pane{overflow-y:auto}</style><div id="root"></div><script src="renderer.js"></script>');
  await writeFile(path.join(directory, 'main.cjs'), `
const {app, BrowserWindow} = require('electron');
const assert = require('node:assert/strict');
setTimeout(()=>app.exit(1),15000).unref();
app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
 const win = new BrowserWindow({width:1100,height:700,show:false,webPreferences:{contextIsolation:true}});
 try {
  await win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});
  const js = code => win.webContents.executeJavaScript(code);
  await wait(160);win.webContents.focus();
  const until=async predicate=>{for(let i=0;i<100;i++){if(await js(predicate))return;await wait(30)}throw new Error('Timed out: '+predicate)};
  const click=async selector=>{const at=await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.scrollIntoView({block:"nearest"});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');win.webContents.sendInputEvent({type:'mouseDown',...at,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...at,button:'left',clickCount:1});await wait(80)};
  const browse=async(index,offset=400)=>{
    await js('(()=>{const p=document.querySelector(".diff.pane");const file=p.querySelectorAll(".diff-file")['+index+'];p.scrollTop+=file.getBoundingClientRect().top-p.getBoundingClientRect().top+'+offset+';p.dispatchEvent(new Event("wheel"));})()');
    await until('document.querySelector(".tree .file.active")?.dataset.path === "pkg/group'+String(index).padStart(2,'0')+'/file.ts"');await wait(180);
  };
  await browse(14);
  const position=await js('document.querySelector(".diff.pane").scrollTop');await wait(300);
  assert(Math.abs((await js('document.querySelector(".diff.pane").scrollTop'))-position)<3,'scroll-spy must not snap the diff back to a header');
  assert(await js('(()=>{const p=document.querySelector(".tree").getBoundingClientRect();const r=document.querySelector(".tree .file.active").getBoundingClientRect();const h=document.querySelector(".tree-top").getBoundingClientRect();return r.top>=h.bottom-1&&r.bottom<=p.bottom+1})()'),'tree follows active row into view');
  await click('.tree button.dir[title="pkg/group15"]');
  assert.equal(await js('!![...document.querySelectorAll(".tree .file")].find(e=>e.dataset.path==="pkg/group15/file.ts")'),false);
  await browse(15);
  assert(await js('!![...document.querySelectorAll(".tree .file")].find(e=>e.dataset.path==="pkg/group15/file.ts")'),"scrolling expands a collapsed ancestor");
  await click('.tree .file[data-path="pkg/group14/file.ts"]');
  await until('(()=>{const p=document.querySelector(".diff.pane"),f=p.querySelectorAll(".diff-file")[14];return Math.abs(f.getBoundingClientRect().top-p.getBoundingClientRect().top-parseFloat(getComputedStyle(p).scrollPaddingTop))<4})()');
  await wait(100);
  await browse(3,600);
  await click('.tvsw button[title="平铺"]');
  await browse(25);
  assert.equal(await js('document.querySelectorAll(".tree .file.active").length'),1);
  await browse(0,300);
  console.log('file scroll: manual browsing in both directions, no snap-back, tree visibility, collapsed ancestor expansion, explicit click navigation, flat mode and virtualized bodies passed');
  win.destroy();app.exit(0);
 } catch(error) {console.error(error);win.destroy();app.exit(1);}
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`File scroll test exited ${code}`);
} finally { await rm(directory, { recursive: true, force: true }); }
