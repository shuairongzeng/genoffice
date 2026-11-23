export type SplitPaneSide = 'left' | 'right'

export interface SplitState {
  leftTabId: string
  rightTabId: string
  activePane: SplitPaneSide
  ratio: number
  syncScroll: boolean
  /** True when the user switches to Home so split views hide until a split tab resumes. */
  suspended: boolean
}

export const SPLIT_DIVIDER_WIDTH = 8
export const SPLIT_MIN_RATIO = 0.25
export const SPLIT_MAX_RATIO = 0.75
export const SPLIT_DEFAULT_RATIO = 0.5
export const SPLIT_MIN_PANE_WIDTH = 280

export const SPLIT_CHANNELS = {
  open: 'split:open',
  close: 'split:close',
  swap: 'split:swap',
  setRatio: 'split:set-ratio',
  setSyncScroll: 'split:set-sync-scroll',
  focusPane: 'split:focus-pane',
  getState: 'split:get-state',
} as const
