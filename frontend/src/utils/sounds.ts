// UI Sound System - Web Audio API synthesized sounds
// Sci-fi/dark mode aesthetic: subtle, satisfying, futuristic

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') {
      // Best effort only — browsers may reject resume() until they decide a
      // gesture is valid. Sound failures should be silent, not throw or spam.
      void audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

// Sound enabled state (persisted to localStorage)
let soundsEnabled: boolean = (() => {
  try {
    const stored = localStorage.getItem('soundsEnabled');
    return stored === null ? true : stored === 'true';
  } catch { return true; }
})();

// Master volume (0-1, persisted to localStorage)
let masterVolume: number = (() => {
  try {
    const stored = localStorage.getItem('soundsVolume');
    if (stored !== null) {
      const v = parseFloat(stored);
      if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
    }
    return 0.3;
  } catch { return 0.3; }
})();

function isSoundEnabled(): boolean {
  return soundsEnabled;
}

function gain(ctx: AudioContext, volume: number = masterVolume): GainNode {
  const g = ctx.createGain();
  g.gain.value = volume * masterVolume;
  g.connect(ctx.destination);
  return g;
}

export const sounds = {
  // Nav click - soft blip (two-tone rising)
  click: () => {
    if (!isSoundEnabled()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = gain(ctx, 0.15);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.08);
    osc.connect(g);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  },

  // Button hover - very subtle tick
  hover: () => {
    if (!isSoundEnabled()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = gain(ctx, 0.06);
    osc.type = 'sine';
    osc.frequency.value = 1200;
    osc.connect(g);
    osc.start();
    osc.stop(ctx.currentTime + 0.03);
  },

  // Success toast - bright ascending chime (3 notes)
  success: () => {
    if (!isSoundEnabled()) return;
    const ctx = getCtx();
    if (!ctx) return;
    [0, 0.1, 0.2].forEach((delay, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.2 * masterVolume, ctx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + delay + 0.3);
      g.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = [523, 659, 784][i]; // C5, E5, G5 major chord ascending
      osc.connect(g);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.3);
    });
  },

  // Error - low buzzy descending tone
  error: () => {
    if (!isSoundEnabled()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25 * masterVolume, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    g.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.4);
    osc.connect(g);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  },

  // Warning - two-tone alert
  warning: () => {
    if (!isSoundEnabled()) return;
    const ctx = getCtx();
    if (!ctx) return;
    [0, 0.15].forEach((delay) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.18 * masterVolume, ctx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + delay + 0.15);
      g.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.value = 440;
      osc.connect(g);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.15);
    });
  },

  // Notification - gentle ping (like a message received)
  notification: () => {
    if (!isSoundEnabled()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.2 * masterVolume, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    g.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);
    osc.connect(g);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  },

  // Toggle on - quick bright pip (always plays even when disabled, used for enable/disable feedback)
  toggleOn: () => {
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = gain(ctx, 0.15);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(500, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1000, ctx.currentTime + 0.06);
    osc.connect(g);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  },

  // Toggle off - quick descending pip (always plays even when disabled, used for enable/disable feedback)
  toggleOff: () => {
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = gain(ctx, 0.15);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.06);
    osc.connect(g);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  },

  // Delete - soft whoosh down
  delete: () => {
    if (!isSoundEnabled()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15 * masterVolume, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    g.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.25);
    osc.connect(g);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  },

  // Upload complete - satisfying ding
  upload: () => {
    if (!isSoundEnabled()) return;
    const ctx = getCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.2 * masterVolume, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
    g.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 523; // C5
    osc2.type = 'sine';
    osc2.frequency.value = 784; // G5
    osc.connect(g);
    osc2.connect(g);
    osc.start();
    osc2.start();
    osc.stop(ctx.currentTime + 0.6);
    osc2.stop(ctx.currentTime + 0.6);
  },

  // Set master volume (persisted)
  setVolume: (v: number) => {
    masterVolume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('soundsVolume', String(masterVolume)); } catch {}
  },
  getVolume: () => masterVolume,

  // Enable/disable sounds (persisted)
  setEnabled: (enabled: boolean) => {
    soundsEnabled = enabled;
    try { localStorage.setItem('soundsEnabled', String(enabled)); } catch {}
  },
  isEnabled: () => soundsEnabled,
};

export default sounds;
