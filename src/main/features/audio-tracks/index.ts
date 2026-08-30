import { describeIdentity, identityOf, planReselection } from '@shared/mpv/tracks'
import type { TrackLike } from '@shared/mpv/tracks'
import type { Track } from '@shared/types'
import type { FeatureContext, FeatureModule, MenuNode } from '@shared/feature-api'

/**
 * M11 audio-tracks — audio and video track selection.
 *
 * WAVE 0 SEED: the new owner of `cycleAudio`, and — this is the part that
 * matters — the SOLE owner of `aid` and `vid` (§3.7.1).
 *
 * `aid` had three writers on paper: M11's own per-file restore, M15's
 * passthrough round-trip and M13's AC-3 DRC reinit. An M15 round-trip racing
 * M11's restore picks the wrong dub on a dual-audio release: silent,
 * intermittent, and exactly the failure ownership exists to prevent. So the
 * round-trip lives here, serialised against the restore, and everyone else
 * calls the mediator.
 */

let ctx: FeatureContext
/** The track M11 INTENDS to be selected. The round-trip restores to this, not
 *  to whatever happened to be current when a caller asked. */
let intended: number | false = false
let restoring: Promise<void> = Promise.resolve()
/** True while the per-file restore is in flight; the arbiter refuses then. */
let busyRestoring = false

const tracks = (): Track[] => ctx.mpv.peek<Track[]>('track-list') ?? []
const audioTracks = (): Track[] => tracks().filter((t) => t.type === 'audio')

function label(t: Track): string {
  const bits = [String(t.id)]
  if (t.lang) bits.push(t.lang)
  if (t.channels) bits.push(t.channels)
  if (t.title) bits.push(t.title)
  if (t.external) bits.push('(외부)')
  return bits.join(' · ')
}

/**
 * `aid` HAS THE SAME EXPOSURE AS `sid`, and it is written from four places.
 *
 * mpv accepts `set_property aid <gone>` with `{"error":"success"}` and then
 * holds `false` — the shape that lost every Korean subtitle through `sid` one
 * round ago. `audio-add`, `audio-remove`, `audio-reload` and
 * `rescan-external-files` all renumber the audio list, so a captured `aid` is
 * exactly as perishable as a captured `sid`. `selectTrack` returns what mpv
 * RESOLVED to rather than whether it accepted the write.
 */
async function select(id: number | false): Promise<void> {
  intended = id
  const got = await ctx.mpv.selectTrack('aid', id === false ? 'no' : id)
  if (id !== false && got !== id) {
    ctx.log.error(
      `aid=${id} was accepted by mpv and resolved to ${JSON.stringify(got)}; the audio tracks ` +
        `mpv has are ${audioTracks().map((t) => t.id).join(', ') || '(none)'}. A captured track ` +
        `index does not survive audio-reload / audio-add / rescan-external-files.`
    )
  }
  const t = audioTracks().find((x) => x.id === id)
  ctx.osd.show({ kind: 'track', text: id === false ? '오디오 없음' : `오디오 ${label(t ?? { id, type: 'audio', selected: true })}` })
}

const mod: FeatureModule = {
  id: 'audio-tracks',
  // §3.6: M11 "owns `aid` and `vid` outright", so it owns the commands that
  // rewrite the track lists those two index into.
  ownsCommands: [
    'audio-add',
    'audio-remove',
    'audio-reload',
    'video-add',
    'video-remove',
    'video-reload'
  ],
  ownsProperties: [
    'aid',
    'vid',
    'alang',
    'audio-display',
    'audio-file-auto',
    'cover-art-auto',
    'cover-art-whitelist',
    'track-auto-selection',
    'subs-with-matching-audio'
  ],

  setup(c): void {
    ctx = c

    ctx.mpv.contributeArgs(10, () => ['--audio-file-auto=fuzzy'])

    /**
     * The arbiter for `aid` (§3.7). Until this existed, every `requestSet` in
     * the app returned `{ok: false, reason: 'no-arbiter'}` -- no module
     * registered one anywhere in src/ -- while the OwnershipError told the
     * developer to use exactly that call. The mediated path was a dead end that
     * the error message advertised.
     *
     * It is not a rubber stamp. M15's passthrough round-trip and M13's AC-3
     * reinit both want `aid` at moments M11's own per-file restore may be in
     * flight, and that race picks the wrong dub on a dual-audio release:
     * silent, intermittent, and precisely what ownership exists to stop. So a
     * request during a restore is REFUSED, with a reason the caller can log,
     * rather than queued behind it -- by the time the restore finishes the
     * caller's reason is usually stale.
     */
    ctx.mpv.arbitrate('aid', async (value, req) => {
      if (busyRestoring) {
        return {
          ok: false,
          reason: `audio-tracks is restoring the per-file track; '${req.reason}' would race it`
        }
      }
      const id = value === false || value === 'no' ? false : Number(value)
      if (id !== false && !Number.isFinite(id)) {
        return { ok: false, reason: `'${String(value)}' is not a track id` }
      }
      if (id !== false && !audioTracks().some((t) => t.id === id)) {
        return { ok: false, reason: `no audio track ${id} in this file` }
      }
      await select(id)
      ctx.log.info(`aid -> ${String(id)} at the request of ${req.from}: ${req.reason}`)
      return { ok: true }
    })

    ctx.mpv.observe<number | false>('aid', (v) => {
      // Keep `intended` honest when mpv picks a track on its own at file load.
      if (typeof v === 'number') intended = v
    })

    ctx.perFile.slice({
      key: 'audio-tracks',
      capture: () => {
        const list = ctx.mpv.peek<TrackLike[]>('track-list') ?? []
        const aid = ctx.mpv.peek<number | false>('aid') ?? false
        const t = list.find((x) => x.type === 'audio' && x.id === aid)
        // The identity beside the index, for the same reason M17 stores one: a
        // remembered `aid` is a position in a PREVIOUS session's track list, and
        // an external audio file added since shifts every id after it.
        return { aid, identity: t ? identityOf(list, t) : null }
      },
      apply: async (v) => {
        const identity = v.identity as ReturnType<typeof identityOf> | null | undefined
        if (identity && typeof identity.type === 'string') {
          const list = ctx.mpv.peek<TrackLike[]>('track-list') ?? []
          const plan = planReselection(list, identity, ctx.mpv.peek<number | false>('aid') ?? false)
          if (plan.kind === 'lost') {
            ctx.log.warn(
              `the remembered audio track ${describeIdentity(identity)} is not in this file; ` +
                `leaving mpv's own choice alone.`
            )
            return
          }
          if (plan.kind === 'already') {
            intended = plan.id
            return
          }
          busyRestoring = true
          restoring = select(plan.id).then(
            () => undefined,
            () => undefined
          )
          await restoring
          busyRestoring = false
          return
        }
        if (typeof v.aid === 'number') {
          // The window the arbiter refuses inside: a foreign write landing
          // here picks the wrong dub on a dual-audio release.
          busyRestoring = true
          restoring = select(v.aid).then(
            () => undefined,
            () => undefined
          )
          await restoring
          busyRestoring = false
        }
      },
      rememberDefaults: { aid: true }
    })

    ctx.commands.register([
      {
        id: 'audio-tracks.cycle',
        labelKey: 'audio-tracks.cycle',
        category: 'audio',
        defaults: { default: ['KeyA'], mpv: ['Shift+Digit3'] },
        enabledWhen: () => audioTracks().length > 1,
        run: async () => {
          await ctx.mpv.command(['cycle', 'aid']).catch(() => {})
          const now = ctx.mpv.peek<number | false>('aid')
          intended = now ?? false
          const t = audioTracks().find((x) => x.id === now)
          ctx.osd.show({ kind: 'track', text: t ? `오디오 ${label(t)}` : '오디오 없음' })
        }
      },
      {
        id: 'audio-tracks.select',
        labelKey: 'audio-tracks.select',
        category: 'audio',
        internal: true,
        run: (arg) => select(arg === false || arg === 'no' ? false : Number(arg))
      },
      {
        id: 'audio-tracks.selectVideo',
        labelKey: 'audio-tracks.selectVideo',
        category: 'video',
        internal: true,
        run: async (arg) => {
          const id = arg === false || arg === 'no' ? 'no' : Number(arg)
          const got = await ctx.mpv.selectTrack('vid', id)
          if (id !== 'no' && got !== id) {
            ctx.log.warn(`vid=${id} was accepted by mpv and resolved to ${JSON.stringify(got)}`)
          }
        }
      },
      {
        /**
         * The sanctioned cross-module path (§3.7.3). M15 (A20 passthrough) and
         * M13 (A36 AC-3 DRC) both need a decoder reinit, which mpv only offers
         * as an `aid` round-trip. Neither of them may write `aid`.
         */
        id: 'audio-tracks.reinitDecoder',
        labelKey: 'audio-tracks.reinitDecoder',
        category: 'audio',
        internal: true,
        run: async () => {
          await restoring
          const target = intended
          if (target === false) return
          await ctx.mpv.selectTrack('aid', 'no')
          const got = await ctx.mpv.selectTrack('aid', target)
          if (got !== target) {
            ctx.log.error(
              `the decoder reinit round-trip left aid=${JSON.stringify(got)} rather than ` +
                `${target}; mpv accepted the write and resolved it to nothing.`
            )
          }
        }
      },
      {
        /** M36 (R08): `vid` and `aid` are one decision on an EDL-backed source,
         *  so they are applied together by the module that owns both. */
        id: 'audio-tracks.selectStreamFormat',
        labelKey: 'audio-tracks.selectStreamFormat',
        category: 'audio',
        internal: true,
        run: async (arg) => {
          const a = (arg ?? {}) as { vid?: number | false; aid?: number | false }
          if (a.vid !== undefined) await ctx.mpv.selectTrack('vid', a.vid === false ? 'no' : a.vid)
          if (a.aid !== undefined) await select(a.aid)
        }
      }
    ])

    ctx.menu.contribute({
      id: 'audio-tracks.menu',
      labelKey: 'audio-tracks.menuTitle',
      order: 40,
      items: [
        {
          labelKey: 'audio-tracks.menuTitle',
          submenu: [
            {
              dynamic(): readonly MenuNode[] {
                const list = audioTracks()
                if (list.length === 0) return [{ labelKey: 'audio-tracks.none', enabled: false }]
                const current = ctx.mpv.peek<number | false>('aid')
                return list.map((t) => ({
                  label: label(t),
                  commandId: 'audio-tracks.select',
                  arg: t.id,
                  radio: true,
                  checked: current === t.id
                }))
              }
            }
          ]
        }
      ]
    })

    ctx.i18n.register('ko', {
      'audio-tracks.cycle': '오디오 트랙 전환',
      'audio-tracks.select': '오디오 트랙 선택',
      'audio-tracks.selectVideo': '비디오 트랙 선택',
      'audio-tracks.reinitDecoder': '오디오 디코더 재초기화',
      'audio-tracks.selectStreamFormat': '스트림 포맷 선택',
      'audio-tracks.menuTitle': '오디오 트랙',
      'audio-tracks.none': '(트랙 없음)'
    })
    ctx.i18n.register('en', {
      'audio-tracks.cycle': 'Cycle audio track',
      'audio-tracks.select': 'Select audio track',
      'audio-tracks.selectVideo': 'Select video track',
      'audio-tracks.reinitDecoder': 'Reinitialise audio decoder',
      'audio-tracks.selectStreamFormat': 'Select stream format',
      'audio-tracks.menuTitle': 'Audio track',
      'audio-tracks.none': '(no tracks)'
    })
  }
}

export default mod
