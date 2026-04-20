import { create } from 'zustand'

type UiState = {
  savePromptOpen: boolean
  openSavePrompt: () => void
  closeSavePrompt: () => void
}

export const useUiStore = create<UiState>((set) => ({
  savePromptOpen: false,
  openSavePrompt: () => set({ savePromptOpen: true }),
  closeSavePrompt: () => set({ savePromptOpen: false }),
}))
