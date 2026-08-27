import type { RlBridge, RlPlayerApi } from '../../preload/index'

declare global {
  interface Window {
    /** The typed CORE surface. Feature modules do not extend it. */
    rlplayer: RlPlayerApi
    /** The generic, namespace-validated bridge every feature module uses. */
    rl: RlBridge
  }
}

export {}
