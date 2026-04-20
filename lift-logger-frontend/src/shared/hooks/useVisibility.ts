import { useEffect, useState } from 'react'

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

/** Fires a 250ms tick while `active` is true. Pauses when tab is hidden. */
export function useTick(active: boolean, onTick: () => void, intervalMs = 250) {
  const visible = useVisibility()
  useEffect(() => {
    if (!active || !visible) return
    const id = window.setInterval(onTick, intervalMs)
    onTick()
    return () => window.clearInterval(id)
  }, [active, visible, onTick, intervalMs])
}
