// Web Audio chime — a short two-beep ping on timer zero.
// Also fires vibration if supported.

let ctx: AudioContext | null = null

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctx = new AC()
    } catch {
      ctx = null
    }
  }
  return ctx
}

function beep(c: AudioContext, at: number, frequency: number, duration = 0.12) {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  osc.connect(gain).connect(c.destination)
  osc.start(at)
  osc.stop(at + duration + 0.02)
}

export function playChime() {
  const c = ensureCtx()
  if (!c) return
  if (c.state === 'suspended') c.resume().catch(() => undefined)
  const t = c.currentTime
  beep(c, t, 660)
  beep(c, t + 0.18, 880)
}

export function vibrate(pattern: number | number[] = [120, 60, 120]) {
  if (typeof navigator === 'undefined') return
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // noop
  }
}

// Call once on any user gesture to unlock the AudioContext on iOS.
export function unlockAudio() {
  const c = ensureCtx()
  if (!c) return
  if (c.state === 'suspended') c.resume().catch(() => undefined)
}
