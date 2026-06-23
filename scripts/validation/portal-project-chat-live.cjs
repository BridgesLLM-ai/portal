const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');

// Live Project Chat regression harness.
// Required env: PORTAL_BASE_URL, PORTAL_TEST_EMAIL, PORTAL_TEST_PASSWORD.
// Optional env: CHROME_BIN, RESULT_PATH.
// Runs Chrome locally against the configured Portal URL, then verifies live UI + gateway history.

const baseUrl = (process.env.PORTAL_BASE_URL || '').replace(/\/$/, '');
const email = process.env.PORTAL_TEST_EMAIL;
const password = process.env.PORTAL_TEST_PASSWORD;
const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const resultPath = process.env.RESULT_PATH || '';
const validationModel = process.env.PORTAL_VALIDATION_MODEL || 'codex/gpt-5.5';
const replyPolls = Number.parseInt(process.env.PORTAL_REPLY_POLLS || '420', 10);
const reloadPolls = Number.parseInt(process.env.PORTAL_RELOAD_POLLS || '90', 10);
const traceCookies = process.env.PORTAL_TRACE_COOKIES === '1';
if (!baseUrl) throw new Error('PORTAL_BASE_URL is required, e.g. https://your-test-portal.example');
if (!email || !password) throw new Error('PORTAL_TEST_EMAIL and PORTAL_TEST_PASSWORD are required');

const runId = `PROJECT-${Date.now()}`;
const projectName = `portal-project-chat-${Date.now()}`;
const userToken = `USER_${runId}`;
const replyToken = `ASSISTANT_${runId}`;
const replySuffix = runId;
const port = 15200 + Math.floor(Math.random()*500);
const profile = `/tmp/portal-project-chat-${Date.now()}`;
fs.rmSync(profile,{recursive:true,force:true});
fs.mkdirSync(profile,{recursive:true});

const chrome = spawn(chromeBin, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--window-size=1500,1100',
  `--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'
], { stdio:['ignore','ignore','ignore'], detached:true });

const wait = ms => new Promise(r => setTimeout(r, ms));
function cleanup(){
  try { process.kill(-chrome.pid, 'SIGTERM'); } catch {}
  try { execFileSync('bash', ['-lc', `pkill -TERM -f -- '--user-data-dir=${profile.replace(/'/g,"'\\''")}' || true`]); } catch {}
  try { fs.rmSync(profile, { recursive:true, force:true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
function get(path){return new Promise((res,rej)=>http.get({host:'127.0.0.1',port,path},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>res(b));}).on('error',rej));}
function containsArtifacts(text){ return /message_tool_only|sourceReplyDeliveryMode|delivery-mirror|delivery mirror|toolResult|sourceReply|THINKING\s+Thinking|Thinking…\s+via OpenClaw/i.test(text || ''); }
function summarizeCookieHeader(header){
  return String(header || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf('=');
      const name = idx >= 0 ? part.slice(0, idx) : part;
      const valueLen = idx >= 0 ? part.length - idx - 1 : 0;
      return { name, valueLen };
    });
}

(async()=>{let ws; try{
  let page;
  for(let i=0;i<120;i++){
    try { page = JSON.parse(await get('/json/list')).find(p => p.type === 'page' && p.webSocketDebuggerUrl); if(page) break; } catch {}
    await wait(100);
  }
  if(!page) throw Error('no chrome page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0;
  const pending=new Map();
  const frames=[];
  const networkEvents=[];
  const consoleEvents=[];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(String(ev.data));
    if(m.method==='Runtime.consoleAPICalled') consoleEvents.push(m.params.args?.map(a=>a.value||a.description).join(' '));
    if(m.method==='Runtime.exceptionThrown') consoleEvents.push(m.params.exceptionDetails?.text||'exception');
    if(m.method==='Network.webSocketFrameReceived'){
      const payload=m.params.response?.payloadData||'';
      if(payload.includes(runId) || payload.includes('turnEvent') || payload.includes('session.message') || payload.includes('chat.delta') || payload.includes('session_status')) frames.push({t:Date.now(),payload:payload.slice(0,4000)});
    }
    if(m.method==='Network.webSocketCreated'){
      networkEvents.push({t:Date.now(),type:'webSocketCreated',requestId:m.params.requestId,url:m.params.url});
    }
    if(m.method==='Network.webSocketFrameSent'){
      const payload=m.params.response?.payloadData||'';
      networkEvents.push({t:Date.now(),type:'webSocketFrameSent',requestId:m.params.requestId,payload:payload.slice(0,1200)});
    }
    if(m.method==='Network.webSocketFrameReceived'){
      const payload=m.params.response?.payloadData||'';
      networkEvents.push({t:Date.now(),type:'webSocketFrameReceived',requestId:m.params.requestId,payload:payload.slice(0,1200)});
    }
    if(m.method==='Network.webSocketClosed'){
      networkEvents.push({t:Date.now(),type:'webSocketClosed',requestId:m.params.requestId});
    }
    if(m.method==='Network.webSocketFrameError'){
      networkEvents.push({t:Date.now(),type:'webSocketFrameError',requestId:m.params.requestId,errorMessage:m.params.errorMessage});
    }
    if(m.method==='Network.requestWillBeSentExtraInfo'){
      const cookieHeader=m.params.headers?.Cookie || m.params.headers?.cookie || '';
      const cookies=summarizeCookieHeader(cookieHeader);
      if(traceCookies && cookies.some(c => c.name === 'accessToken')){
        networkEvents.push({t:Date.now(),type:'requestExtraInfo',requestId:m.params.requestId,cookies});
      }
    }
    if(m.method==='Network.loadingFailed' && String(m.params.type||'').toLowerCase()==='websocket'){
      networkEvents.push({t:Date.now(),type:'loadingFailed',requestId:m.params.requestId,errorText:m.params.errorText,canceled:m.params.canceled});
    }
    if(m.id && pending.has(m.id)){
      const p=pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true}); ws.addEventListener('error',rej,{once:true});});
  const cdp=(method,params={})=>{const cid=++id; ws.send(JSON.stringify({id:cid,method,params})); return new Promise((resolve,reject)=>pending.set(cid,{resolve,reject}));};
  const ev=async(expression,awaitPromise=false)=>(await cdp('Runtime.evaluate',{expression,awaitPromise,returnByValue:true})).result?.value;
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Log.enable');

  await cdp('Page.navigate',{url: `${baseUrl}/`}); await wait(1200);
  const setup=await ev(`(async()=>{
    const login=await fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({email:${JSON.stringify(email)},password:${JSON.stringify(password)}})}).then(r=>({ok:r.ok,status:r.status}));
    const create=await fetch('/api/projects',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({name:${JSON.stringify(projectName)},template:'static-html'})}).then(async r=>({ok:r.ok,status:r.status,json:await r.json().catch(e=>({error:String(e)}))}));
    localStorage.setItem('projects-last-selected',${JSON.stringify(projectName)});
    localStorage.setItem('agentChats.lastModel.OPENCLAW', ${JSON.stringify(validationModel)});
    localStorage.setItem(${JSON.stringify(`agent-model-${projectName}`)}, ${JSON.stringify(validationModel)});
    return {login,create};
  })()`, true);
  await cdp('Page.navigate',{url: `${baseUrl}/apps`});
  async function waitForBody(pattern, tries=120, ms=500){for(let i=0;i<tries;i++){const ok=await ev(`/${pattern}/i.test(document.body.innerText)`); if(ok)return true; await wait(ms);} return false;}
  const projectLoaded = await waitForBody(projectName.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&'));
  const projectSelected = await ev(`(()=>{
    const name=${JSON.stringify(projectName)};
    const candidates=[...document.querySelectorAll('button, [role="button"], a, div')]
      .filter(el => (el.textContent || '').replace(/\\s+/g, ' ').trim() === name);
    const target=candidates.at(-1);
    if(!target) return {ok:false, candidates:[...document.querySelectorAll('button, [role="button"], a')].map(el=>(el.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(-80)};
    target.click();
    return {ok:true, tag:target.tagName, text:(target.textContent||'').replace(/\\s+/g,' ').trim()};
  })()`);
  await wait(1200);
  const selectedProjectReady = await waitForBody(`Select a file|${projectName.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')}`, 60, 500);
  const chatOpened = await ev(`(()=>{
    const buttons=[...document.querySelectorAll('button')];
    const normalized = (b) => ((b.textContent || '').replace(/\\s+/g, ' ').trim());
    // Avoid the left-nav "Agent Chats" route. We want the selected project's own Agent panel.
    const btn = buttons.find(b => (b.title || '') === 'Chat with Agent')
      || buttons.find(b => normalized(b) === 'Agent')
      || buttons.find(b => normalized(b) === 'Agent AI')
      || buttons.filter(b => /\\bAgent\\b/i.test(normalized(b))).at(-1);
    if(!btn) return {ok:false, buttons:buttons.slice(-40).map(b=>({title:b.title,text:normalized(b).slice(0,80)}))};
    btn.click();
    return {ok:true,title:btn.title,text:normalized(btn)};
  })()`);
  async function waitForComposer(){for(let i=0;i<240;i++){const ok=await ev(`(()=>{ const ta=document.querySelector('textarea'); const submit=document.querySelector('form button[type="submit"]'); return Boolean(ta && !ta.disabled && submit && /${projectName.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')}/i.test(document.body.innerText)); })()`); if(ok)return true; await wait(500);} return false;}
  const composerReady = await waitForComposer();
  const userMessage = `${userToken}\nReply exactly by concatenating these three strings: ASSISTANT, _, and ${replySuffix}. Do not echo the instruction.`;
  const sent=await ev(`(async()=>{ const ta=document.querySelector('textarea'); if(!ta)return{ok:false,reason:'no textarea',body:document.body.innerText.slice(-1200)}; const msg=${JSON.stringify(userMessage)}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,msg); ta.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:msg})); ta.focus(); await new Promise(r=>setTimeout(r,100)); const form=ta.closest('form'); const btn=form?.querySelector('button[type="submit"]'); if(!btn)return{ok:false,reason:'no submit',body:document.body.innerText.slice(-1200)}; const beforeDisabled=btn.disabled; if (beforeDisabled) { ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true})); } else { btn.click(); } await new Promise(r=>setTimeout(r,250)); return{ok:true,beforeDisabled,afterText:document.body.innerText.includes(${JSON.stringify(userToken)}),hasReplyPrematurely:document.body.innerText.includes(${JSON.stringify(replyToken)}),buttonDisabledNow:btn.disabled}; })()`, true);
  async function sample(label=''){
    return ev(`(()=>{ const text=document.body.innerText; return { label:${JSON.stringify(label)}, t:Date.now(), hasUser:text.includes(${JSON.stringify(userToken)}), hasReply:text.includes(${JSON.stringify(replyToken)}), progressVisible:/Thinking|Preparing|Running|Using|tool|via OpenClaw/i.test(text), hasArtifacts:${containsArtifacts.toString()}(text), tail:text.slice(-4000)}; })()`);
  }
  const samples=[];
  let sawProgress=false, sawArtifacts=false, replySeen=null;
  for(let i=0;i<replyPolls;i++){
    await wait(500);
    const s=await sample('wait-reply'); samples.push(s);
    sawProgress = sawProgress || s.progressVisible;
    sawArtifacts = sawArtifacts || s.hasArtifacts;
    if(s.hasReply){ replySeen=s.t; break; }
  }
  await wait(1500);
  const finalSample=await sample('final');
  sawArtifacts = sawArtifacts || finalSample.hasArtifacts;
  await cdp('Page.reload', { ignoreCache: true });
  let reloadSample=null;
  for(let i=0;i<reloadPolls;i++){
    await wait(500);
    reloadSample=await sample('reload');
    if(reloadSample.hasUser && reloadSample.hasReply) break;
  }
  reloadSample = reloadSample || await sample('reload');
  await wait(5000);
  const stableReloadSample = await sample('reload-stable');

  const turnEvents=[];
  const sessionKeys=[];
  for (const frame of frames) {
    try {
      const parsed=JSON.parse(frame.payload);
      const collect=(obj)=>{
        if(!obj || typeof obj !== 'object') return;
        if(typeof obj.sessionKey === 'string') sessionKeys.push(obj.sessionKey);
        if(typeof obj.session === 'string') sessionKeys.push(obj.session);
        if(obj.turnEvent) {
          turnEvents.push(obj.turnEvent);
          if(typeof obj.turnEvent.sessionKey === 'string') sessionKeys.push(obj.turnEvent.sessionKey);
        }
        if(Array.isArray(obj.turnEvents)) {
          turnEvents.push(...obj.turnEvents);
          for(const evt of obj.turnEvents) if(typeof evt?.sessionKey === 'string') sessionKeys.push(evt.sessionKey);
        }
        if(obj.payload && typeof obj.payload === 'object') collect(obj.payload);
      };
      collect(parsed);
    } catch {}
  }
  const sessionKey=[...sessionKeys].reverse().find(k => /^agent:/.test(k)) || null;
  const history=sessionKey
    ? await ev(`(async()=>{ const r=await fetch('/api/gateway/history?provider=OPENCLAW&enhanced=1&limit=100&session=${encodeURIComponent(sessionKey)}',{credentials:'include'}); return {ok:r.ok,status:r.status,json:await r.json().catch(e=>({error:String(e)}))}; })()`, true)
    : { ok:false, status:0, json:{ error:'no sessionKey captured from websocket frames' } };
  const histText=JSON.stringify(history.json || {});
  const turnEventTypes=[...new Set(turnEvents.map(e=>e?.type).filter(Boolean))];
  const hasTurnSpine=turnEventTypes.includes('assistant_final') && (turnEventTypes.includes('assistant_delta') || turnEventTypes.includes('assistant_status'));
  const noArtifacts=!sawArtifacts && !reloadSample.hasArtifacts && !containsArtifacts(histText);
  const staleConnectionNotice = /Connection lost|still reconnecting|Retry now/i.test(stableReloadSample.tail || '');
  const ok=Boolean(setup.login.ok && setup.create.ok && projectLoaded && projectSelected.ok && selectedProjectReady && chatOpened.ok && composerReady && sent.ok && replySeen && finalSample.hasUser && finalSample.hasReply && reloadSample.hasUser && reloadSample.hasReply && stableReloadSample.hasUser && stableReloadSample.hasReply && !staleConnectionNotice && sawProgress && hasTurnSpine && noArtifacts && history.ok && histText.includes(userToken) && histText.includes(replyToken));
  const allCookies=await cdp('Network.getAllCookies').catch(()=>({cookies:[]}));
  const cookieSummary=(allCookies.cookies||[]).filter(c=>['accessToken','refreshToken'].includes(c.name)).map(c=>({name:c.name,domain:c.domain,path:c.path,expires:c.expires,httpOnly:c.httpOnly,secure:c.secure,sameSite:c.sameSite,valueLen:String(c.value||'').length}));
  const result={ok,baseUrl,runId,projectName,sessionKey,setup,projectLoaded,projectSelected,selectedProjectReady,chatOpened,composerReady,sent,timing:{replySeen},visibleSignals:{sawProgress,noArtifacts,staleConnectionNotice},turnEventTypes,turnEvents:turnEvents.slice(-30),finalSample,reloadSample,stableReloadSample,historyStatus:{ok:history.ok,status:history.status,hasUser:histText.includes(userToken),hasReply:histText.includes(replyToken),messageCount:Array.isArray(history.json?.messages)?history.json.messages.length:null},historyPreview:histText.slice(-4000),frames:frames.slice(-40),networkEvents:networkEvents.slice(-100),cookieSummary,consoleEvents:consoleEvents.slice(-50)};
  const output=JSON.stringify(result, null, 2);
  if (resultPath) fs.writeFileSync(resultPath, output + '\n');
  console.log(output);
  process.exit(ok?0:2);
} finally { try{ws?.close()}catch{}; cleanup(); }} )().catch(e=>{ console.error(e.stack||e.message); cleanup(); process.exit(1); });
