/** Portal-native adaptation of stable9.9's double-frame protocol. No document or actor data in this shell. */
export const WIDGET_CDNS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://esm.sh',
  'https://unpkg.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://fonts.bunny.net'];
export const WIDGET_SHELL_CSP = `default-src 'none'; script-src 'unsafe-inline' ${WIDGET_CDNS.join(' ')}; style-src 'unsafe-inline' ${WIDGET_CDNS.join(' ')}; font-src data: ${WIDGET_CDNS.join(' ')}; img-src data:; media-src data: blob:; connect-src 'none'; frame-src blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
const documentPolicy = `default-src 'none'; script-src 'unsafe-inline' ${WIDGET_CDNS.join(' ')}; style-src 'unsafe-inline' ${WIDGET_CDNS.join(' ')}; font-src data: ${WIDGET_CDNS.join(' ')}; img-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
export const WIDGET_SANDBOX_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style></head><body><script>
(()=>{'use strict';
const instance=location.hash.slice(1);if(!/^[A-Za-z0-9-]{16,80}$/.test(instance))return;
const channel='bridgesllm.widget.v1';const host=parent;const post=host.postMessage.bind(host);
const emit=(type,params={})=>post({channel,instance,type,...params},'*');
let inner=null,url='',rendered=false,lastReport=0,errors=0,loaded=false;
const themeKeys=['surface','card','elevated','text','text-strong','muted','border','border-strong','accent','accent-fill','accent-fg','ok','warn','danger','info','radius','font-body','font-mono'];
addEventListener('message',event=>{
const data=event.data;if(!data||typeof data!=='object')return;
if(event.source===host){
 if(data.channel!==channel||data.instance!==instance)return;
 if(data.type==='document'&&!loaded&&typeof data.html==='string'&&new TextEncoder().encode(data.html).length<=10485760){
  loaded=true;inner=document.createElement('iframe');inner.sandbox='allow-scripts';inner.referrerPolicy='no-referrer';
  inner.allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'";
  // The policy precedes ALL untrusted bytes. Policies in the canonical document can only tighten it.
  const prefix=${JSON.stringify(`<meta http-equiv="Content-Security-Policy" content="${documentPolicy}"><meta name="referrer" content="no-referrer">`)};
  url=URL.createObjectURL(new Blob([prefix,data.html],{type:'text/html'}));
  inner.addEventListener('load',()=>{if(rendered){inner.remove();emit('error',{message:'Widget navigation is disabled.'});return;}rendered=true;
   inner.contentWindow.postMessage({type:'openclaw:widget-chat-host'},'*');emit('rendered');});
  inner.src=url;document.body.append(inner);
 }else if(data.type==='theme'&&inner){
  // Matching frame color schemes keeps transparent widget canvases transparent.
  const mode=data.mode==='light'?'light':'dark';document.documentElement.style.colorScheme=mode;
  const tokens={};for(const key of themeKeys){const value=data.tokens?.[key];if(typeof value==='string'&&value.length<=256&&!/[;{}<>]|url\\s*\\(/i.test(value))tokens[key]=value;}
  inner.contentWindow.postMessage({type:'openclaw:widget-theme',tokens,mode},'*');
 }
 return;
}
if(!inner||event.source!==inner.contentWindow||event.origin!=='null')return;
// Prompt/data/action/cron/state/links/snapshots intentionally have no Portal bridge.
for(const port of event.ports)port.close();
if(data.type==='openclaw:widget-size'&&typeof data.height==='number'&&Number.isFinite(data.height)&&Date.now()-lastReport>=50){
 lastReport=Date.now();emit('size',{height:Math.max(120,Math.min(720,Math.ceil(data.height)))});
}else if(data.type==='openclaw:widget-runtime-error'&&errors<3){errors++;emit('error',{message:'Widget script reported an error.'});}
});
addEventListener('pagehide',()=>{if(url)URL.revokeObjectURL(url);});emit('ready');
})();</script></body></html>`;
