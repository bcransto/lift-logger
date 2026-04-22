import { create } from 'zustand'
import type { Cursor } from '../types/schema'

type OverlayKind = 'set' | 'workout' | 'setLogger' | 'blockComplete' | null

type UndoState = {
  message: string
  cursor: Cursor // cursor to restore
  expiresAt: number // Date.now() + 5000
} | null

type UiState = {
  savePromptOpen: boolean
  openSavePrompt: () => void
  closeSavePrompt: () => void

  overlay: OverlayKind
  openOverlay: (k: Exclude<OverlayKind, null>) => void
  closeOverlay: () => void

  undo: UndoState
  showUndo: (message: string, cursor: Cursor) => void
  clearUndo: () => void
}

export const useUiStore = create<UiState>((set) => ({
  savePromptOpen: false,
  openSavePrompt: () => set({ savePromptOpen: true }),
  closeSavePrompt: () => set({ savePromptOpen: false }),

  overlay: null,
  openOverlay: (k) => set({ overlay: k }),
  closeOverlay: () => set({ overlay: null }),

  undo: null,
  showUndo: (message, cursor) =>
    set({ undo: { message, cursor, expiresAt: Date.now() + 5000 } }),
  clearUndo: () => set({ undo: null }),
}))
