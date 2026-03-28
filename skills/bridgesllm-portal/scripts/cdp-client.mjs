#!/usr/bin/env node
// CDP client for shared desktop Chrome browser (port 18801)
// No external dependencies — uses Node.js built-in WebSocket (v22+) and http.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
// Node 22+ has globalThis.WebSocket; fall back to 'ws' package if available
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  WS = globalThis.WebSocket;
} else {
  try {
    const mod = await import('ws');
    WS = mod.default || mod.WebSocket;
  } catch {
    console.error('ERROR: No WebSocket implementation available. Need Node 22+ or ws package.');
    process.exit(1);
  }
}

const CDP_PORT = process.env.SHARED_BROWSER_CDP_PORT || '18801';
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getFirstPage() {
  let targets;
  try {
    targets = await httpGet(`${CDP_BASE}/json/list`);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error(`Cannot reach shared browser on port ${CDP_PORT}. Is Chrome running? Run 'shared-browser.sh launch' to start it.`);
    }
    throw err;
  }
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page tab found in shared browser.');
  return page;
}

// Normalize WebSocket event handling (Node built-in uses MessageEvent, ws uses raw data)
function wsOn(ws, event, fn) {
  ws.addEventListener(event, (evt) => {
    if (event === 'message') fn(evt.data !== undefined ? evt.data : evt);
    else fn(evt);
  });
}

function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    
    function onMsg(data) {
      const msg = JSON.parse(String(data));
      if (msg.id === id) {
        clearTimeout(timeout);
        if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      }
    }
    
    wsOn(ws, 'message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    const timeout = setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000);
    wsOn(ws, 'open', () => { clearTimeout(timeout); resolve(ws); });
    wsOn(ws, 'error', (err) => { clearTimeout(timeout); reject(new Error(`WebSocket error: ${err.message || err}`)); });
  });
}

// ─── Commands ───

async function navigate(url) {
  const page = await getFirstPage();
  const ws = await connectWs(page.webSocketDebuggerUrl);
  try {
    const result = await cdpSend(ws, 'Page.navigate', { url });
    // Wait for load
    await new Promise(r => setTimeout(r, 2000));
    // Get final URL/title
    const info = await cdpSend(ws, 'Runtime.evaluate', {
      expression: 'JSON.stringify({title: document.title, url: location.href})',
      returnByValue: true,
    });
    const parsed = JSON.parse(info.result.value);
    console.log(`Navigated to: ${parsed.title} — ${parsed.url}`);
  } finally {
    ws.close();
  }
}

async function screenshot(outputPath) {
  const page = await getFirstPage();
  const ws = await connectWs(page.webSocketDebuggerUrl);
  try {
    const result = await cdpSend(ws, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
    });
    const outDir = outputPath || process.env.OPENCLAW_WORKSPACE || process.cwd();
    const outFile = outputPath && !fs.statSync(outputPath, { throwIfNoEntry: false })?.isDirectory()
      ? outputPath
      : path.join(outDir, `shared-browser-screenshot-${Date.now()}.jpg`);
    fs.writeFileSync(outFile, Buffer.from(result.data, 'base64'));
    console.log(outFile);
  } finally {
    ws.close();
  }
}

async function captureConsole(durationMs) {
  const duration = durationMs !== undefined && durationMs !== '' ? parseInt(durationMs) : 3000;
  const page = await getFirstPage();
  const ws = await connectWs(page.webSocketDebuggerUrl);
  const messages = [];
  
  try {
    await cdpSend(ws, 'Runtime.enable');
    await cdpSend(ws, 'Log.enable');
    
    wsOn(ws, 'message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = (msg.params.args || []).map(a => a.value || a.description || '').join(' ');
        messages.push({ type: msg.params.type, text: args });
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const ex = msg.params.exceptionDetails;
        messages.push({ type: 'error', text: ex.text || JSON.stringify(ex) });
      }
      if (msg.method === 'Log.entryAdded') {
        const entry = msg.params.entry;
        messages.push({ type: entry.level, text: entry.text });
      }
    });
    
    // Also grab existing console errors via evaluate
    const existing = await cdpSend(ws, 'Runtime.evaluate', {
      expression: `
        (function() {
          try {
            const entries = performance.getEntriesByType('resource')
              .filter(e => e.responseStatus >= 400)
              .map(e => ({ type: 'network-error', text: e.responseStatus + ' ' + e.name }));
            return JSON.stringify(entries);
          } catch { return '[]'; }
        })()
      `,
      returnByValue: true,
    });
    try {
      const parsed = JSON.parse(existing.result.value);
      messages.push(...parsed);
    } catch {}
    
    await new Promise(r => setTimeout(r, duration));
    
    if (messages.length === 0) {
      console.log('No console messages captured in ' + duration + 'ms.');
    } else {
      messages.forEach(m => console.log(`[${m.type}] ${m.text}`));
    }
  } finally {
    ws.close();
  }
}

async function evaluate(expression) {
  const page = await getFirstPage();
  const ws = await connectWs(page.webSocketDebuggerUrl);
  try {
    const result = await cdpSend(ws, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      console.error('Error:', result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
      process.exit(1);
    }
    const val = result.result;
    if (val.type === 'undefined') console.log('undefined');
    else if (val.value !== undefined) console.log(typeof val.value === 'string' ? val.value : JSON.stringify(val.value, null, 2));
    else console.log(val.description || JSON.stringify(val));
  } finally {
    ws.close();
  }
}

// ─── Main ───

const [,, action, ...args] = process.argv;

try {
  switch (action) {
    case 'navigate':
      await navigate(args[0]);
      break;
    case 'screenshot':
      await screenshot(args[0]);
      break;
    case 'console':
      await captureConsole(args[0]);
      break;
    case 'evaluate':
      await evaluate(args.join(' '));
      break;
    default:
      console.error(`Unknown action: ${action}`);
      process.exit(1);
  }
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
