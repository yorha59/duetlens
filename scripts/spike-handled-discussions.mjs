/** 隔离组件回归:已处理讨论折叠与跨轮状态,不连接真实会话或调用模型。 */
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'duetlens-handled-discussion-test-'));
try {
  await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DiscussionTab } from './src/renderer/screens/review/DiscussionTab';
    import './src/renderer/index.css';
    import './src/renderer/screens/ReviewScreen.css';
    const findings=[
      {id:'fixed',discussionId:'fixed',title:'Fixed issue',triage:'dismiss',autoClosed:true,resolution:'fixed',lastSeenRound:1},
      {id:'response',discussionId:'response',title:'Author responded',triage:'open',autoClosed:false,resolution:'wont_fix',lastSeenRound:2},
      {id:'dismiss',discussionId:'dismiss',title:'Dismissed issue',triage:'dismiss',autoClosed:false,resolution:null,lastSeenRound:2},
      {id:'open',discussionId:'open',title:'Pending issue',triage:'open',autoClosed:false,resolution:'still_present',lastSeenRound:2},
    ].map(f=>({...f,severity:'medium',file:'a.ts',line:1}));
    const discussions=[...findings.map(f=>({id:f.id,reviewId:'demo',kind:'finding',origin:'agent',file:f.file,line:f.line,createdAt:1})),{id:'user',reviewId:'demo',kind:'user',origin:'manual',file:null,line:null,createdAt:2}];
    const messages={fixed:[{id:'note',discussionId:'fixed',role:'user',kind:'note',text:'Retained note',createdAt:1}]};
    function Demo(){
      const [items,setItems]=useState(findings),[round,setRound]=useState(2),[active,setActive]=useState(null),[focus,setFocus]=useState(null);
      window.updateFinding=(id,patch)=>setItems(items=>items.map(f=>f.id===id?{...f,...patch}:f));
      window.advanceRound=()=>setRound(3);
      window.focusHandled=()=>{setActive('fixed');setFocus({id:'fixed',nonce:Date.now(),mode:'note'});};
      return <div style={{height:800,width:650}}><DiscussionTab currentRound={round} discussions={discussions} findings={items} messages={messages} activeId={active} composerFocus={focus} onSelect={setActive} awaitingReply={new Set()} streams={{}} onStopReply={async()=>{}} replyFailure={{}} unsent={[]} onRestoreUnsent={()=>{}} scanning={false} onSend={()=>{throw Error('must never send')}} onStartGlobal={async()=>{}} onJumpToCode={()=>{}} ensureMessages={()=>{}} onPromote={()=>{}} onClearMessages={()=>{}} proposals={[]} onApplyProposal={async()=>{}} onSkipProposal={async()=>{}} onUndoProposal={async()=>{}}/></div>;
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
  await until('!!document.querySelector(".disc-handled")');
  const click = async selector => {
    await js('document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"center"})');
    const at = await js('(() => {const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    win.webContents.sendInputEvent({type:'mouseDown',...at,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',...at,button:'left',clickCount:1});await wait(120);
  };
  const pendingIds=()=>js('[...document.querySelectorAll(".disc-list > .disc-item")].map(e=>e.dataset.discussionId)');
  assert.deepEqual(await pendingIds(),['open','user']);
  assert.equal(await js('document.querySelector(".disc-handled").open'),false);
  assert.equal(await js('document.querySelectorAll(".disc-handled .disc-item").length'),3);
  await click('.disc-handled summary');
  await click('[data-discussion-id=fixed]');
  assert(await js('document.querySelector(".thread").textContent.includes("Retained note")'),'archived discussions retain notes');
  await click('.disc-handled summary');
  await js('window.updateFinding("open",{triage:"dismiss",autoClosed:true,resolution:"fixed"})');
  await until('document.querySelectorAll(".disc-list > .disc-item").length===1');
  assert.equal(await js('document.querySelector(".disc-handled").open'),false,'new handled event does not reopen history');
  await js('window.updateFinding("fixed",{triage:"open",autoClosed:false})');
  await until('document.querySelectorAll(".disc-list > .disc-item").length===2');
  assert.deepEqual(await pendingIds(),['fixed','user'],'restored finding returns to main list');
  await js('window.updateFinding("fixed",{triage:"dismiss",autoClosed:true});window.advanceRound()');
  await until('document.querySelector(".disc-list > .disc-item").dataset.discussionId==="response"');
  assert.deepEqual(await pendingIds(),['response','user'],'prior wont-fix is not mistaken for current-round response');
  await js('window.focusHandled()');
  await until('document.querySelector(".disc-handled").open');
  assert(await js('document.querySelector(".thread").textContent.includes("Retained note")'));
  console.log('handled discussions: default collapse, pending/user preservation, history access, live resolution/restoration, cross-round semantics and explicit focus passed');
  win.destroy();app.exit(0);
 } catch(error) {console.error(error);win.destroy();app.exit(1);}
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(directory, 'main.cjs')], { env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`Handled discussion test exited ${code}`);
} finally { await rm(directory, { recursive: true, force: true }); }
