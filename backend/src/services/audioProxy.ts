/**
 * Remote Desktop Audio Proxy
 * 
 * Spawns parec (PulseAudio record) to capture all audio from the virtual desktop
 * and streams raw PCM via WebSocket to the browser. The browser uses Web Audio API
 * to play it back in real-time.
 * 
 * Architecture:
 *   PulseAudio (null sink) → parec (PCM capture) → WebSocket → Browser Web Audio API
 * 
 * Audio format: 16-bit signed LE, 2 channels, 44100 Hz (CD quality)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';

const AUDIO_PORT = 4714;
const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const FORMAT = 's16le';
const PULSE_USER = 'bridgesrd';
const PULSE_SOCKET = 'unix:/tmp/bridges-rd-runtime/pulse/native';

// Buffer size: ~50ms of audio at 44100Hz, 2ch, 16-bit = 8820 bytes
const CHUNK_SIZE = 8820;

let wss: WebSocketServer | null = null;
let parecProcess: ChildProcess | null = null;
let clientCount = 0;

function startParec(): ChildProcess | null {
  if (parecProcess && !parecProcess.killed) {
    return parecProcess;
  }

  try {
    const proc = spawn('sudo', [
      '-u', PULSE_USER,
      'env',
      'XDG_RUNTIME_DIR=/tmp/bridges-rd-runtime',
      `PULSE_SERVER=${PULSE_SOCKET}`,
      'parec',
      '--raw',
      `--format=${FORMAT}`,
      `--rate=${SAMPLE_RATE}`,
      `--channels=${CHANNELS}`,
      '-d', 'auto_null.monitor',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      console.error('[AudioProxy] parec spawn error:', err.message);
      parecProcess = null;
    });

    proc.on('close', (code) => {
      console.log(`[AudioProxy] parec exited with code ${code}`);
      parecProcess = null;
      // Restart if clients are still connected
      if (clientCount > 0) {
        console.log('[AudioProxy] Restarting parec (clients still connected)...');
        setTimeout(() => startParec(), 1000);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.warn('[AudioProxy] parec stderr:', msg);
    });

    // Stream audio data to all connected WebSocket clients
    let buffer = Buffer.alloc(0);
    proc.stdout?.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      
      // Send in consistent chunks for smoother playback
      while (buffer.length >= CHUNK_SIZE) {
        const chunk = buffer.subarray(0, CHUNK_SIZE);
        buffer = buffer.subarray(CHUNK_SIZE);
        
        if (wss) {
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              try {
                client.send(chunk);
              } catch {
                // Client disconnected
              }
            }
          }
        }
      }
    });

    parecProcess = proc;
    console.log(`[AudioProxy] parec started (PID ${proc.pid})`);
    return proc;
  } catch (err: any) {
    console.error('[AudioProxy] Failed to start parec:', err.message);
    return null;
  }
}

function stopParec() {
  if (parecProcess && !parecProcess.killed) {
    parecProcess.kill('SIGTERM');
    parecProcess = null;
    console.log('[AudioProxy] parec stopped (no clients)');
  }
}

export function startAudioProxy(): WebSocketServer | null {
  if (wss) return wss;

  try {
    const server = http.createServer((_req, res) => {
      // Health check endpoint
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        clients: clientCount,
        parecRunning: parecProcess !== null && !parecProcess.killed,
        format: { sampleRate: SAMPLE_RATE, channels: CHANNELS, format: FORMAT },
      }));
    });

    wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      clientCount++;
      console.log(`[AudioProxy] Client connected (${clientCount} total)`);

      // Send audio config to client
      ws.send(JSON.stringify({
        type: 'config',
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        format: FORMAT,
        chunkSize: CHUNK_SIZE,
      }));

      // Start parec if not running
      if (!parecProcess || parecProcess.killed) {
        startParec();
      }

      ws.on('close', () => {
        clientCount--;
        console.log(`[AudioProxy] Client disconnected (${clientCount} remaining)`);
        // Stop parec if no clients (save CPU)
        if (clientCount <= 0) {
          clientCount = 0;
          setTimeout(() => {
            if (clientCount <= 0) stopParec();
          }, 5000); // Grace period
        }
      });

      ws.on('error', () => {
        // Handled by close event
      });
    });

    server.listen(AUDIO_PORT, '127.0.0.1', () => {
      console.log(`[AudioProxy] WebSocket server listening on 127.0.0.1:${AUDIO_PORT}`);
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[AudioProxy] Port ${AUDIO_PORT} in use, retrying in 3s...`);
        setTimeout(() => {
          server.close();
          startAudioProxy();
        }, 3000);
      } else {
        console.error('[AudioProxy] Server error:', err.message);
      }
    });

    return wss;
  } catch (err: any) {
    console.error('[AudioProxy] Failed to start:', err.message);
    return null;
  }
}

export function stopAudioProxy() {
  stopParec();
  if (wss) {
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
    wss = null;
    console.log('[AudioProxy] Stopped');
  }
}
