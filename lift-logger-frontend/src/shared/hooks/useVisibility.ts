import { useEffect, useRef, useState } from 'react'

/** Returns true when the document is visible. */
export function useVisibility(): boolean {
  const [visible, setVisible] = useState<boolean>(
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  )
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/**
 * Fires a tick every `intervalMs` while `active` is true. Pauses when tab is
 * hidden. `onTick` is stored in a ref so callers can pass fresh inline
 * callbacks (capturing current state) without retriggering the interval —
 * without the ref, a new arrow function per render would put `onTick` in deps,
 * re-run the effect each render, and `onTick()` on line mount-body would
 * setState → rerender → loop.
 */
export function useTick(active: boolean, onTick: () => void, intervalMs = 250) {
  const visible = useVisibility()
  const onTickRef = useRef(onTick)
  useEffect(() => { onTickRef.current = onTick }, [onTick])
  useEffect(() => {
    if (!active || !visible) return
    const tick = () => onTickRef.current()
    const id = window.setInterval(tick, intervalMs)
    tick()
    return () => window.clearInterval(id)
  }, [active, visible, intervalMs])
}
