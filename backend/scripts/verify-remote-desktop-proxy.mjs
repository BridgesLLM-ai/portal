#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { WebSocket } from 'ws';

const base = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 4001}`;
const token = process.env.ACCESS_TOKEN || '';
if (!token) { console.error('Missing ACCESS_TOKEN env var.'); process.exit(2); }
const cookie = `accessToken=${encodeURIComponent(token)}`;
function fetchPath(pathname) { return new Promise((resolve, reject) => { const url = new URL(pathname, base); const lib = url.protocol === 'https:' ? https : http; const req = lib.request(url, { method: 'GET', headers: { Cookie: cookie } }, (res) => { let data = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode || 0, body: data })); }); req.on('error', reject); req.end(); }); }
async function checkHttp() { const res = await fetchPath('/novnc/vnc.html?path=novnc%2Fwebsockify'); if (res.status !== 200) throw new Error(`HTTP check failed: status=${res.status}`); if (!/noVNC|vnc/i.test(res.body)) throw new Error('HTTP check failed: response does not look like noVNC page'); console.log('✓ HTTP via portal /novnc/vnc.html is healthy'); }
async function checkWs() { const wsUrl = new URL('/novnc/websockify', base); wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'; await new Promise((resolve, reject) => { let openedAt = 0; let settled = false; const ws = new WebSocket(wsUrl.toString(), { headers: { Cookie: cookie } }); const finish = (err) => { if (settled) return; settled = true; try { ws.close(); } catch {} if (err) reject(err); else resolve(); }; ws.on('open', () => { openedAt = Date.now(); setTimeout(() => { if (ws.readyState === WebSocket.OPEN) { console.log('✓ WS upgrade via portal /novnc/websockify succeeded and stayed open >1s'); finish(); } }, 1100); }); ws.on('close', (code, reason) => { const livedMs = openedAt ? Date.now() - openedAt : 0; if (!openedAt) return finish(new Error(`WS closed before open (code=${code}, reason=${reason.toString()})`)); if (livedMs < 1000) return finish(new Error(`WS dropped too quickly (${livedMs}ms, code=${code}, reason=${reason.toString()})`)); finish(); }); ws.on('error', (err) => finish(err)); }); }
(async () => { await checkHttp(); await checkWs(); console.log('Remote Desktop portal proxy checks passed.'); })().catch((err) => { console.error(`FAILED: ${err?.message || err}`); process.exit(1); });
