import test from 'node:test'
import assert from 'node:assert/strict'
import {
  accelFromEvent,
  accelFromMouse,
  accelFromWheel,
  isModifierCode,
  labelForAccel,
  normalizeAccel
} from './accel.ts'

/**
 * test:accel (§6.2): "a table of synthetic KeyboardEvents INCLUDING
 * key:'Process', keyCode:229 and key:'ㄴ', code:'KeyS' all resolve to the same
 * accelerator."
 *
 * This is the whole point of P16. With the Korean IME composing, `e.key` is
 * 'Process' for every letter; with 한글 selected but not composing it is the
 * jamo. `e.code` is 'KeyS' in all three cases.
 */

const base = { ctrlKey: false, altKey: false, shiftKey: false }

test('the same physical key resolves identically with the IME off, composing, or in 한글', () => {
  const latin = accelFromEvent({ ...base, code: 'KeyS', key: 's' })
  const composing = accelFromEvent({ ...base, code: 'KeyS', key: 'Process' })
  const hangul = accelFromEvent({ ...base, code: 'KeyS', key: 'ㄴ' })
  assert.equal(latin, 'KeyS')
  assert.equal(composing, 'KeyS')
  assert.equal(hangul, 'KeyS')
})

test('modifier order is fixed at Ctrl+Alt+Shift so string comparison is safe', () => {
  assert.equal(
    accelFromEvent({ code: 'KeyS', ctrlKey: true, altKey: true, shiftKey: true }),
    'Ctrl+Alt+Shift+KeyS'
  )
  assert.equal(normalizeAccel('Shift+Ctrl+KeyS'), 'Ctrl+Shift+KeyS')
  assert.equal(normalizeAccel('alt+control+KeyS'), 'Ctrl+Alt+KeyS')
})

test('punctuation and digits keep their physical names', () => {
  assert.equal(accelFromEvent({ ...base, code: 'Comma', key: ',' }), 'Comma')
  assert.equal(accelFromEvent({ ...base, code: 'BracketLeft', key: '[' }), 'BracketLeft')
  assert.equal(accelFromEvent({ ...base, code: 'Digit1', key: '1' }), 'Digit1')
  assert.equal(
    accelFromEvent({ code: 'Digit3', key: '#', ctrlKey: false, altKey: false, shiftKey: true }),
    'Shift+Digit3',
    "mpv's '#' is Shift+3 on a US layout, and the binding must survive a layout change"
  )
})

test('a bare modifier press is not an accelerator', () => {
  assert.equal(accelFromEvent({ ...base, code: 'ShiftLeft', key: 'Shift' }), '')
  assert.equal(isModifierCode('ControlRight'), true)
  assert.equal(isModifierCode('KeyA'), false)
})

test('mouse and wheel share the accelerator namespace using mpv names', () => {
  assert.equal(accelFromMouse({ ...base, button: 0 }), 'MBTN_LEFT')
  assert.equal(accelFromMouse({ ...base, button: 0, detail: 2 }), 'MBTN_LEFT_DBL')
  assert.equal(accelFromMouse({ ...base, button: 2 }), 'MBTN_RIGHT')
  assert.equal(accelFromWheel({ ...base, deltaY: -120, deltaX: 0 }), 'WHEEL_UP')
  assert.equal(accelFromWheel({ ...base, deltaY: 120, deltaX: 0 }), 'WHEEL_DOWN')
  assert.equal(
    accelFromWheel({ code: '', deltaY: 120, deltaX: 0, ctrlKey: true, altKey: false, shiftKey: false } as never),
    'Ctrl+WHEEL_DOWN'
  )
})

test('display labels turn physical codes back into what is printed on the key', () => {
  assert.equal(labelForAccel('Ctrl+KeyS'), 'Ctrl+S')
  assert.equal(labelForAccel('Comma'), ',')
  assert.equal(labelForAccel('Shift+ArrowRight'), 'Shift+→')
  assert.equal(labelForAccel('Digit9'), '9')
  assert.equal(labelForAccel('F11'), 'F11')
})

test('a layout map, where the browser offers one, wins over the static table', () => {
  const layout = new Map([['KeyA', 'q']])
  assert.equal(labelForAccel('KeyA', layout), 'Q', 'AZERTY must not read as A')
})
