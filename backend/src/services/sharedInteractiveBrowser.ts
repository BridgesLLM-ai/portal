import { EventEmitter } from 'events';

export const SHARED_BROWSER_OWNER_DIR = '/var/lib/bridges-shared-browser';
export const SHARED_BROWSER_PROFILE = 'portal-shared';
export const SHARED_BROWSER_CDP = 'http://127.0.0.1:18901';
export const SHARED_BROWSER_SOCKET = '/run/bridges-shared-browser/broker.sock';
export const SHARED_BROWSER_VNC_SOCKET = '/run/bridges-shared-desktop/transport/vnc.sock';
export type BrowserCaller = { agentId: string; sessionKey: string; toolCallId?: string; runId?: string };
export type BrowserLease = {
  userId: string; sessionKey: string; agentId: string;
  mode: 'agent' | 'taking-control' | 'human' | 'revoked';
  revision: number; handoverRequested: boolean;
};
export class SharedBrowserError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Coordination, not containment: root exec can bypass browser hooks and CDP policy. */
export class SharedInteractiveBrowser extends EventEmitter {
  private lease: BrowserLease | null = null;
  private revision = 0;
  private activeCall: string | null = null;
  private persistCall: (key: string | null) => void = () => {};
  restoreCall(key: string | null, persist: (key: string | null) => void): void {
    if (this.lease || this.activeCall) throw new SharedBrowserError(409, 'Browser admission already initialized');
    this.activeCall = key; this.persistCall = persist;
  }

  snapshot(userId: string): BrowserLease | null {
    if (this.lease && this.lease.userId !== userId) throw new SharedBrowserError(404, 'Shared browser unavailable');
    return this.lease ? { ...this.lease } : null;
  }
  private changed(): void { this.revision++; if (this.lease) this.lease.revision = this.revision; this.emit('changed'); }
  select(userId: string, sessionKey: string, agentId: string): BrowserLease {
    if (this.activeCall) throw new SharedBrowserError(409, 'A previous browser call is still finishing; no takeover is granted');
    if (this.lease) throw new SharedBrowserError(409, 'Release the existing shared browser selection first');
    this.lease = { userId, sessionKey, agentId, mode: 'human', revision: this.revision, handoverRequested: false };
    this.changed();
    return { ...this.lease };
  }
  control(userId: string, revision: number, action: 'take' | 'return' | 'decline' | 'release'): BrowserLease | null {
    const lease = this.snapshot(userId);
    if (!lease) throw new SharedBrowserError(409, 'Select an owned Agent Chat session first');
    if (lease.revision !== revision) throw new SharedBrowserError(409, 'Shared browser changed; refresh before controlling it');
    if (action === 'release') {
      if (this.activeCall) throw new SharedBrowserError(409, 'A browser call is still finishing');
      this.lease = null;
    } else {
      if (lease.mode === 'revoked') throw new SharedBrowserError(409, 'Selection revoked; release and select again');
      if (action === 'take') this.lease!.mode = this.activeCall ? 'taking-control' : 'human';
      if (action === 'return') {
        if (this.activeCall) throw new SharedBrowserError(409, 'Wait for the current browser call to finish');
        this.lease!.mode = 'agent';
      }
      this.lease!.handoverRequested = false;
    }
    this.changed();
    return this.snapshot(userId);
  }
  ownsCaller(caller: BrowserCaller): BrowserLease {
    if (!this.lease || this.lease.mode === 'revoked' || caller.agentId !== this.lease.agentId || caller.sessionKey !== this.lease.sessionKey) {
      throw new SharedBrowserError(403, 'This agent/session has no shared browser selection');
    }
    return { ...this.lease };
  }
  private callKey(caller: BrowserCaller): string {
    if (typeof caller.runId !== 'string' || typeof caller.toolCallId !== 'string' || !caller.runId || !caller.toolCallId || caller.runId.length > 256 || caller.toolCallId.length > 256) {
      throw new SharedBrowserError(403, 'Browser call identity unavailable');
    }
    return JSON.stringify([caller.sessionKey, caller.runId, caller.toolCallId]);
  }
  begin(caller: BrowserCaller): void {
    const lease = this.ownsCaller(caller);
    if (lease.mode !== 'agent') throw new SharedBrowserError(409, 'Human control holds the shared browser; wait for Return to agent');
    if (this.activeCall) throw new SharedBrowserError(409, 'A shared browser call is already active');
    const key = this.callKey(caller);
    this.persistCall(key); this.activeCall = key;
  }
  finish(caller: BrowserCaller): void {
    if (this.activeCall !== this.callKey(caller)) throw new SharedBrowserError(403, 'Browser completion identity does not match');
    this.persistCall(null); this.activeCall = null;
    if (this.lease?.mode === 'taking-control') { this.lease.mode = 'human'; this.changed(); }
  }
  requestHandover(caller: BrowserCaller): BrowserLease {
    this.ownsCaller(caller); this.lease!.handoverRequested = true; this.changed(); return { ...this.lease! };
  }
  humanCanConnect(userId: string): boolean { return this.lease?.userId === userId && this.lease.mode === 'human'; }
  revoke(userId: string): void {
    if (this.lease?.userId === userId) { this.lease.mode = 'revoked'; this.changed(); }
  }
}
export const sharedInteractiveBrowser = new SharedInteractiveBrowser();
