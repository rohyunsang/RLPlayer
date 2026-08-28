import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * M29's DECLARATION, checked against its manifest row and against the guide's
 * hard rules.
 *
 * `index.ts` imports `electron`, so it cannot be loaded by `node --test` (§13:
 * "keep the logic you want to test free of Electron imports" -- and everything
 * that MATTERS in this module is in the other files, which is why they have real
 * behavioural tests). What is left to check here is the declaration itself, and
 * that is a text check on purpose: the alternative is no check at all, and the
 * things it catches -- a property written that the manifest does not record, a
 * command issued that belongs to somebody else -- are boot failures for the
 * whole app rather than for this module.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf8')

interface Row {
  id: string
  path: string
  dependsOn: string[]
  ownedProperties: string[]
  ownedCommands: string[]
  requestsProperties: string[]
  features: string[]
  ownedFiles: string[]
  mustNotTouch: string[]
}

const modules: Row[] = JSON.parse(
  fs.readFileSync(path.join(repo, 'docs', 'parity', 'modules.json'), 'utf8')
)
const row = modules.find((m) => m.path === 'src/main/features/mediainfo/')

/** `['a', 'b']` after a named field on the module object. */
function arrayField(name: string): string[] | null {
  const re = new RegExp(`\\n {2}${name}: \\[([^\\]]*)\\]`)
  const hit = re.exec(source)
  if (!hit) return null
  return [...(hit[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
}

// ---------------------------------------------------------------------------

test('the manifest row exists and this test is looking at the right one', () => {
  assert.ok(row, 'no modules.json row has path src/main/features/mediainfo/')
  assert.equal(row.id, 'M29')
})

test('the directory name equals the declared id', () => {
  // A mismatch is a boot error naming both, and the directory is what the
  // registry globs.
  assert.match(source, /\n {2}id: 'mediainfo',/)
})

test("dependsOn mirrors the manifest row VERBATIM, which is now the same namespace", () => {
  // §1: "Copy your modules.json row verbatim -- it is the same namespace now."
  // `manifest.test.ts` compares the feature half of these in both directions;
  // this asserts the whole list, core entries included, so a core id that is
  // spell-checked at boot is spelled right here.
  assert.ok(row)
  assert.deepEqual(arrayField('dependsOn'), row.dependsOn)
})

test('ownsCommands is exactly the manifest row, and every name is a real mpv command', () => {
  assert.ok(row)
  const declared = arrayField('ownsCommands')
  assert.deepEqual(declared, row.ownedCommands)
  // §2.1 gave these three to M29 because "the only loadable scripts are the
  // built-in stats and select overlays" -- U06 and L45.
  assert.deepEqual(declared, ['script-binding', 'script-message', 'script-message-to'])

  const dump: { commands: string[] } = JSON.parse(
    fs.readFileSync(path.join(repo, 'docs', 'parity', 'mpv-commands.json'), 'utf8')
  )
  for (const c of declared ?? []) {
    assert.ok(dump.commands.includes(c), `${c} is not in the pinned binary's --input-cmdlist`)
  }
})

test('requestsProperties is exactly the manifest row -- L28s three', () => {
  assert.ok(row)
  assert.deepEqual(arrayField('requestsProperties'), row.requestsProperties)
  assert.deepEqual(row.requestsProperties, [
    'audio-display',
    'cover-art-auto',
    'cover-art-whitelist'
  ])
})

test('M29 declares NO ownsProperties, because the manifest gives it none', () => {
  assert.ok(row)
  assert.deepEqual(row.ownedProperties, [])
  // Declaring one here without the manifest half is a `npm test` failure in
  // both directions; declaring one at all would make this an info panel that
  // changes what it measures.
  assert.equal(arrayField('ownsProperties'), null)
})

test('nothing in this module ever writes an mpv property', () => {
  // The strongest statement M29 can make about itself, and it is greppable.
  // `ctx.mpv.set` would throw an OwnershipError in dev and be dropped and
  // counted in a packaged build -- i.e. it would be a silent no-op in the hands
  // of users.
  assert.equal(/ctx\.mpv\.set\s*\(/.test(source), false, 'ctx.mpv.set() in a read-only module')
  assert.equal(/ctx\.vf\b|ctx\.af\b/.test(source), false)
  assert.equal(/usesVideoFilters|usesAudioFilters/.test(source), false)
  // …and the mediated path IS used, for the one property L28 needs.
  assert.match(source, /ctx\.mpv\.requestSet\(\s*\n?\s*'audio-display'/)
})

test('the refusal of that request is handled as a NORMAL outcome', () => {
  // §2: "refusal is a NORMAL outcome and your caller must handle it." Measured
  // today: M11 arbitrates `aid` only, and the mediator the manifest records for
  // these three (`audio-tracks.setTrackAutoSelection`) exists in modules.json
  // and nowhere in src/ -- so this request is refused in every build there is.
  const at = source.indexOf("'audio-display'")
  assert.notEqual(at, -1)
  const after = source.slice(at, at + 700)
  assert.match(after, /if \(!r\.ok\)/, 'the requestSet result is not checked')
  assert.match(after, /ctx\.log\.warn/, 'a refusal is not logged')
  assert.equal(/throw/.test(after), false, 'a refusal must not throw at the user')
})

test('the mediator the manifest promises for L28 does not exist in code', () => {
  /**
   * A CHECK THAT LIES, IN THE MANIFEST'S OWN TESTS.
   *
   * `manifest.test.ts`'s "every property another module requests has an arbiter
   * or a mediator" passes for M29 -- M11's row declares
   * `audio-tracks.setTrackAutoSelection` covering exactly these three
   * properties. It compares modules.json against modules.json, so it cannot see
   * that no module registers a command with that id:
   *
   *   $ grep -rn setTrackAutoSelection src/ docs/
   *   docs/parity/modules.json:1242
   *
   * That is a one-line PR against M11 plus a check in `manifest.test.ts` (a core
   * file, not this module's). Until then this assertion records the measurement
   * so the day the mediator lands, this test fails and tells M29 to use it
   * instead of a bare `requestSet` that can only be refused.
   */
  const mediator = 'audio-tracks.setTrackAutoSelection'
  const m11 = modules.find((m) => m.id === 'M11')
  assert.ok(m11, 'no M11 row')
  assert.ok(
    Object.keys((m11 as unknown as { mediates: Record<string, string[]> }).mediates).includes(
      mediator
    ),
    `M11's row no longer declares ${mediator}; update this test and M29's L28 path`
  )

  const featureDirs = path.join(repo, 'src', 'main', 'features')
  let registered = false
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        if (fs.readFileSync(full, 'utf8').includes(`id: '${mediator}'`)) registered = true
      }
    }
  }
  walk(featureDirs)
  assert.equal(
    registered,
    false,
    `${mediator} is registered now. M29's L28 path should call it through ` +
      `ctx.commands.invoke() instead of ctx.mpv.requestSet(), which the manifest ` +
      `says is not the sanctioned route for these three properties.`
  )
})

test('every IPC channel is namespaced, which the registry enforces at boot', () => {
  const channels = [
    ...source.matchAll(/ctx\.ipc\.(?:on|handle|send)<?[^>]*>?\(\s*'([^']+)'/g)
  ].map((m) => m[1] as string)
  assert.ok(channels.length >= 8, `found only ${channels.length} channels`)
  for (const c of channels) {
    assert.ok(c.startsWith('mediainfo:'), `channel '${c}' is outside this module's namespace`)
  }
  assert.equal(new Set(channels).size, channels.length, 'a channel is registered twice')
})

test('every command id and setting id is namespaced', () => {
  for (const [what, re] of [
    ['command', /\n {8}id: '([^']+)',\n {8}labelKey:/g],
    ['setting', /\n {8}id: '(mediainfo\.[^']+|[^']+)',\n {8}section:/g]
  ] as const) {
    const ids = [...source.matchAll(re)].map((m) => m[1] as string)
    assert.ok(ids.length >= 5, `found only ${ids.length} ${what} ids`)
    for (const id of ids) {
      assert.ok(id.startsWith('mediainfo.'), `${what} '${id}' is outside the namespace`)
    }
  }
})

test('every setting lands in one of the eight fixed sections', () => {
  const sections = [...source.matchAll(/\n {8}section: '([a-z]+)',/g)].map((m) => m[1] as string)
  const allowed = new Set([
    'general',
    'playback',
    'video',
    'audio',
    'subtitles',
    'keys',
    'filetypes',
    'advanced'
  ])
  assert.ok(sections.length >= 5)
  for (const s of sections) assert.ok(allowed.has(s), `'${s}' is not one of the eight sections`)
})

test('keybind defaults are PHYSICAL codes with modifiers in Ctrl+Alt+Shift order', () => {
  // P16: with the Korean IME composing, `e.key` is 'Process' for every letter,
  // so a `key`-based binding silently stops working the moment someone switches
  // to 한글.
  const accels = [...source.matchAll(/defaults: \{([^}]*)\}/g)].flatMap((m) =>
    [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string)
  )
  assert.ok(accels.length >= 8, `found only ${accels.length} accelerators`)
  const physical =
    /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Key[A-Z]|Digit\d|F\d{1,2}|Arrow(?:Up|Down|Left|Right)|Space|Tab|Enter|Escape|Backspace|Delete|Home|End|Page(?:Up|Down)|ScrollLock|Bracket(?:Left|Right)|Backslash|Comma|Period|Slash|Semicolon|Quote|Minus|Equal|Backquote|MBTN_[A-Z_]+|WHEEL_(?:UP|DOWN|LEFT|RIGHT))$/
  for (const a of accels) {
    assert.match(a, physical, `'${a}' is not a physical accelerator in Ctrl+Alt+Shift order`)
  }
})

test("`Tab` is bound in the potplayer preset only, and never in Default", () => {
  /**
   * U47 asks for `Tab` / `Shift+Tab` / `Scroll Lock`, which is PotPlayer's
   * scheme. In the overlay, `main.ts` runs `e.preventDefault()` on any bound
   * accelerator, and the overlay is a web page whose panels are full of
   * buttons: a globally bound `Tab` makes the whole app untabbable, this
   * module's own panel included. So the spec's key is honoured where a user
   * expects it and the Default preset keeps Tab for focus.
   */
  const full = /id: 'mediainfo\.showFull',[\s\S]{0,400}?defaults: \{([^}]*)\}/.exec(source)
  assert.ok(full, 'mediainfo.showFull has no defaults')
  const block = full[1] ?? ''
  assert.match(block, /potplayer: \['Tab'\]/)
  assert.equal(/default: \[[^\]]*'Tab'/.test(block), false, "Default must not bind bare Tab")

  const short = /id: 'mediainfo\.showShort',[\s\S]{0,400}?defaults: \{([^}]*)\}/.exec(source)
  assert.ok(short)
  assert.match(short[1] ?? '', /potplayer: \['Shift\+Tab'\]/)
  assert.equal(/default: \[[^\]]*'Shift\+Tab'/.test(short[1] ?? ''), false)
})

test('a second mpv comes from ctx.engine.spawn(), never from child_process + a path', () => {
  // "An untracked child is how 'no orphan mpv on quit' stops being true."
  assert.match(source, /ctx\.engine\.spawn\(/)
  assert.equal(/mpvBinary\(\)/.test(source), false)
  // L27's PowerShell child is the one `spawn` here, and it IS tracked.
  const spawns = [...source.matchAll(/(?<!engine\.)\bspawn\(/g)].length
  assert.equal(spawns, 1, `expected exactly one child_process spawn, found ${spawns}`)
  assert.match(source, /ctx\.lifecycle\.trackProcess\(/)
})

test('no forbidden import, and no core file reached by any spelling', () => {
  for (const banned of [
    /from '[^']*core\/mpv/,
    /from '[^']*core\/registry/,
    /from '[^']*window\/windows/,
    /from '[^']*\/ipc'/,
    /from '[^']*preload\/index/,
    /**
     * `createRequire` and `new BrowserWindow` are deliberately NOT in this list.
     *
     * `check:forbidden` already forbids both, repo-wide, and its rules run over
     * a view that keeps code — so writing either token as a regex literal here
     * made THIS FILE fail the real check:
     *
     *   src/main/features/mediainfo/module.test.ts:274  no feature module calls createRequire()
     *   src/main/features/mediainfo/module.test.ts:275  no feature module constructs a BrowserWindow
     *
     * Duplicating a repo-wide grep inside one module's test buys nothing and
     * costs the grep. The right place for "M29 does not do this" is the check
     * that says it for all 40 modules.
     */
    // Zero hosts at rest.
    /\bfetch\b|node:dns|node:tls/
  ]) {
    assert.equal(banned.test(source), false, `index.ts matches ${banned}`)
  }

  /**
   * §11: never Electron's `dialog` directly -- the service parents it to the
   * OVERLAY, and parenting to the video window puts it behind the video.
   *
   * Written as an import-list rule and not as `/\bdialog\b/`, and that is not
   * fussiness: the word rule failed on this very file, four times, all four in
   * PROSE about L27's modal message loop. That is the same defect
   * `check:partition` already had once and fixed -- "a 'use' was any substring
   * hit anywhere in any core file, COMMENTS INCLUDED, so one word of prose
   * whitelisted a real violation" -- with the sign flipped. A rule that fires on
   * comments is a rule people route around, and the way they route around it is
   * by rewording a comment.
   */
  const electronImport = /import \{([^}]*)\} from 'electron'/.exec(source)
  const imported = electronImport
    ? (electronImport[1] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : []
  assert.equal(imported.includes('dialog'), false, "imports Electron's dialog; use ctx.dialog")
  assert.deepEqual(imported, ['clipboard', 'shell'])
  assert.equal(
    /\bdialog\.(?:show|showMessageBox|showOpenDialog|showSaveDialog)/.test(source),
    false
  )

  // A feature module may not import another feature module.
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string)
  for (const spec of imports) {
    if (spec.includes('/features/')) {
      assert.ok(spec.includes('/features/mediainfo/'), `imports another module: ${spec}`)
    }
  }
})

test('dispose releases the timers, the subscriptions, the probe and the child', () => {
  const dispose = source.slice(source.indexOf('async dispose('))
  assert.ok(dispose.length > 100, 'no dispose()')
  assert.match(dispose, /clearInterval\(liveTimer\)/)
  assert.match(dispose, /clearTimeout\(cacheWriteTimer\)/)
  assert.match(dispose, /offs\.splice\(0\)/)
  assert.match(dispose, /shellChild\.kill\(\)/)
  assert.match(dispose, /await p\.dispose\(\)/)
})

test('the row still claims the two directories this module writes, and nothing else', () => {
  assert.ok(row)
  assert.deepEqual(row.ownedFiles, [
    'src/main/features/mediainfo/',
    'src/renderer/src/features/mediainfo/'
  ])
  // The reported gap, asserted so it cannot be quietly "fixed" one side only:
  // section 10's shared wire directory is not among them, which is why
  // `wire-parity.test.ts` exists.
  assert.equal(row.ownedFiles.includes('src/shared/features/mediainfo/'), false)
  assert.equal(fs.existsSync(path.join(repo, 'src', 'shared', 'features', 'mediainfo')), false)
})
