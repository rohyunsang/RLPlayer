import type { RlPlayerApi } from '../../preload/index'

declare global {
  interface Window {
    rlplayer: RlPlayerApi
  }
}

export {}
