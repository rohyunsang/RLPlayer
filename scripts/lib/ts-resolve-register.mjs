/**
 * `node --import ./scripts/lib/ts-resolve-register.mjs --test …` — installs the
 * bundler-shaped resolve hook in `ts-resolve.mjs`. See that file for why.
 */
import { register } from 'node:module'

register('./ts-resolve.mjs', import.meta.url)
