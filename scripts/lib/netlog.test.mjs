import test from 'node:test'
import assert from 'node:assert/strict'
import { isLocalUrl, sessionProof, violationsIn } from './netlog.mjs'

/**
 * The evidence gate, tested on the exact stdout shapes that were measured.
 *
 * `check-network.mjs` asserts on the ABSENCE of network events, and a netlog
 * with zero events is the PASSING shape. Every regression this file has ever had
 * was therefore a piece of evidence that did not mean what it was read to mean,
 * and none of them could be tested at all while the logic lived inside a script
 * whose only entry point launches a packaged app.
 */

/** A stdout from a launch where everything really happened. */
const GOOD =
  '[no-network] 6 switches, 4 layers\n' +
  '[ready] windows shown, 12/12 modules loaded, engine playing\n' +
  '[e2e] settings page rendered rows=12 sections=4 textFields=1 focused=input typed=10\n' +
  '[quit] clean exit in 388 ms\n'

const seenTypes = new Set(['PROXY_CONFIG_CHANGED', 'QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS'])
const proof = (stdout, over = {}) =>
  sessionProof({ stdout, eventCount: 11, seenTypes, ...over })

test('a launch where everything happened is a real session', () => {
  assert.deepEqual(proof(GOOD), [])
})

test('THE OLD MARKER IS NOT PROOF: it was printed before the page existed', () => {
  // This is the whole finding. `src/main/index.ts` used to do
  //
  //     openSettingsWindow()
  //     console.log('[e2e] settings window opened')
  //
  // and `src/main/ipc.ts` does `void settingsWindow.loadFile(...)` and returns
  // before the page loads. Measured: the packaged app with and without
  // RLPLAYER_E2E_OPEN_SETTINGS produced 11 netlog events and 53,435 bytes in
  // BOTH cases -- delta 0. The console line was the only evidence the surface
  // had been touched, and it could not have been.
  const stale =
    '[no-network] 6 switches, 4 layers\n' +
    '[ready] windows shown, 12/12 modules loaded, engine playing\n' +
    '[e2e] settings window opened\n' +
    '[quit] clean exit in 388 ms\n'

  // The gate the old check used, verbatim. It passes this stdout.
  assert.match(stale, /\[e2e\] settings window opened/)

  const reasons = proof(stale)
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /never reported what it rendered/)
  assert.match(reasons[0], /printed the OLD marker/)
})

test('a settings window that opened and failed to load is named, not accepted', () => {
  const failed = GOOD.replace(
    /\[e2e\].*\n/,
    '[e2e] settings page FAILED: did-finish-load never fired in 20 s\n'
  )
  const reasons = proof(failed)
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /did-finish-load never fired/)
})

test('a page that loaded but generated no form is not a rendered settings page', () => {
  // settings.html is deliberately empty: every control comes from a
  // ctx.settings.define() descriptor over IPC. A page whose wiring broke renders
  // zero rows and throws nothing, which is why the count is the assertion.
  const empty = GOOD.replace(/rows=12/, 'rows=0')
  assert.match(proof(empty)[0] ?? '', /rendered 0 rows \(floor 8\)/)
  const thin = GOOD.replace(/rows=12/, 'rows=7')
  assert.match(proof(thin)[0] ?? '', /rendered 7 rows/)
  assert.deepEqual(proof(GOOD.replace(/rows=12/, 'rows=8')), [])
})

test('a page with no text field, or with focus landing elsewhere, is reported', () => {
  // The gvt1.com fetch was measured NOT to need typing -- it happened on load --
  // but a spellcheck-on-focus regression would be invisible without this, and
  // this is the only harness that opens the page at all.
  assert.match(
    proof(GOOD.replace(/textFields=1/, 'textFields=0'))[0] ?? '',
    /no text field at all/
  )
  assert.match(
    proof(GOOD.replace(/focused=input/, 'focused=body'))[0] ?? '',
    /focus landed on 'body'/
  )
})

test('the older gates still fire: [ready], [quit], the event floor and the pair', () => {
  assert.match(proof(GOOD.replace(/\[ready\].*\n/, ''))[0] ?? '', /never printed \[ready\]/)
  assert.match(proof(GOOD.replace(/\[quit\].*\n/, ''))[0] ?? '', /never printed \[quit\]/)
  assert.match(proof(GOOD, { eventCount: 0 })[0] ?? '', /header-only file/)
  assert.match(
    proof(GOOD, { seenTypes: new Set(['PROXY_CONFIG_CHANGED']) })[0] ?? '',
    /QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS/
  )
})

test('a remote WebSocket is a network request', () => {
  // `ws:` was whitelisted by scheme in LOCAL_SCHEME, so `ws://remote/` was not
  // counted at all. A WebSocket to another host is as much a request as an
  // https: one; the only local one this repo opens is e2e-overlay talking to
  // 127.0.0.1 on the CDP port.
  assert.equal(isLocalUrl('ws://remote.example/socket'), false)
  assert.equal(isLocalUrl('wss://redirector.gvt1.com/'), false)
  assert.equal(isLocalUrl('ws://127.0.0.1:9333/devtools/page/AB'), true)
  assert.equal(isLocalUrl('ws://localhost:9333/devtools/page/AB'), true)
  assert.equal(isLocalUrl('ws://[::1]:9333/devtools/page/AB'), true)
  assert.equal(isLocalUrl('ws://user@remote.example/'), false)

  const types = { 1: 'URL_REQUEST_START_JOB' }
  const { out } = violationsIn(
    [
      { type: 1, params: { url: 'ws://remote.example/socket' } },
      { type: 1, params: { url: 'ws://127.0.0.1:9333/devtools/page/AB' } }
    ],
    types
  )
  assert.equal(out.length, 1)
  assert.match(out[0].detail, /remote\.example/)
})

test('the schemes that really are local stay local', () => {
  for (const u of [
    'file:///C:/app/index.html',
    'data:text/plain,x',
    'blob:file:///abc',
    'devtools://devtools/bundled/x.js',
    'chrome://version',
    'chrome-extension://abc/x.js',
    'about:blank'
  ]) {
    assert.equal(isLocalUrl(u), true, u)
  }
  assert.equal(isLocalUrl('https://redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic'), false)
})

test('a gvt1.com request is still what this whole file is for', () => {
  const types = { 1: 'URL_REQUEST_START_JOB', 2: 'HOST_RESOLVER_MANAGER_REQUEST' }
  const { out } = violationsIn(
    [
      { type: 1, params: { url: 'https://redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic' } },
      { type: 2, params: { host: 'redirector.gvt1.com:443' } },
      { type: 1, params: { url: 'file:///C:/app/index.html' } }
    ],
    types
  )
  assert.deepEqual(
    out.map((v) => v.kind),
    ['request', 'resolve']
  )
})
