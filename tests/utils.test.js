const test = require('node:test')
const assert = require('node:assert/strict')
const { ROOT, BIZ, plusDays } = require('./helpers')
const path = require('path')
const { toE164, phoneVariants } = require(path.join(ROOT, 'src/utils/phone.js'))
const { parsePayInstruction, payInstruction, hasPayMethod } = require(path.join(ROOT, 'src/utils/payments.js'))
const { getAvailableSlots, formatDate, formatTime } = require(path.join(ROOT, 'src/utils/dateHelpers.js'))

test('phones normalize however they were typed', () => {
  for (const v of ['760-604-1791', '(760) 604 1791', '7606041791', '+17606041791', '1 760 604 1791']) assert.equal(toE164(v), '+17606041791')
  assert.equal(toE164('nophone-abcxxxx'), null)
  assert.ok(phoneVariants('+17606041791').includes('760-604-1791'))
})

test('payment instructions: links, Zelle, Venmo, Cash App', () => {
  assert.deepEqual(parsePayInstruction('venmo @cielle').method, 'Venmo')
  assert.equal(parsePayInstruction('$cielle').stored, 'Cash App: $cielle')
  assert.equal(parsePayInstruction('760-555-0142').method, 'Zelle')
  assert.equal(parsePayInstruction('https://square.link/u/abc').method, 'link')
  assert.match(payInstruction({ payment_link: 'Zelle: 760-555-0142', business_name: 'Glow' }).text, /with Zelle to 760-555-0142 \(Glow\)/)
  assert.equal(hasPayMethod({ payment_link: '' }), false)
})

test('a fully blocked day has no slots on any path', () => {
  const d = plusDays(3)
  const slots = getAvailableSlots(BIZ, d, [], 60, [{ blocked_date: d, start_time: null, end_time: null }], 1, null, null)
  assert.deepEqual(slots, [])
})

test('held statuses take the slot', () => {
  const d = plusDays(3)
  const taken = getAvailableSlots(BIZ, d, [{ appointment_date: d, appointment_time: '10:00:00', duration_mins: 60, status: 'deposit_pending' }], 60, [], 1, null, null)
  assert.ok(!taken.includes('10:00'), 'deposit_pending must hold 10:00')
})

test('formatDate / formatTime read like a person wrote them', () => {
  assert.match(formatDate('2026-11-19'), /Thursday, November 19/)
  assert.equal(formatTime('14:00:00'), '2:00 PM')
})
