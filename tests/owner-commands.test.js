const test = require('node:test')
const assert = require('node:assert/strict')
const { state, reset, ROOT, today, plusDays, BIZ } = require('./helpers')
const path = require('path')

const future = plusDays(5)
const rows = () => ({
  appointments: [
    { id: 'a1', business_id: 'biz-1', customer_name: 'Jess Lee', customer_phone: '+13105550101', appointment_date: '2025-01-10', appointment_time: '10:00:00', status: 'completed', service_name: 'Cut' },
    { id: 'a2', business_id: 'biz-1', customer_name: 'Jess Lee', customer_phone: '+13105550101', appointment_date: future, appointment_time: '14:00:00', status: 'confirmed', service_name: 'Balayage' },
    { id: 'a3', business_id: 'biz-1', customer_name: 'Maria Diaz', customer_phone: '+13105550102', appointment_date: today(), appointment_time: '23:30:00', status: 'deposit_pending', service_name: 'Color' },
    { id: 'a4', business_id: 'biz-1', customer_name: 'Ana Q', customer_phone: '+13105550103', appointment_date: future, appointment_time: '09:00:00', status: 'pending_approval', service_name: 'Cut', service_id: 's2' }
  ],
  blocked_dates: [], conversation_sessions: [], customers: [], businesses: [{ ...BIZ }], services: [{ id: 's2', business_id: 'biz-1', name: 'Cut', duration_mins: 45, active: true }]
})

const oc = require(path.join(ROOT, 'src/bot/ownerCommands.js'))

test('cancel <name> only touches a live, upcoming appointment', async () => {
  reset(rows())
  const out = await oc.executeOwnerTool('cancel_appointment', { customer_name: 'Jess' }, BIZ)
  assert.match(out, /Cancelled Jess Lee's Balayage/)
  const upd = state.writes.filter(w => w[1] === 'update')
  assert.equal(upd.length, 1)
  assert.equal(upd[0][2], 'a2', 'must not cancel the completed 2025 appointment')
  assert.equal(state.sms.length, 1)
  assert.match(state.sms[0].body, /Thursday|Friday|Saturday|Sunday|Monday|Tuesday|Wednesday/, 'client text uses a formatted date')
  assert.doesNotMatch(state.sms[0].body, /\d{4}-\d{2}-\d{2}/, 'no raw YYYY-MM-DD in client texts')
})

test('running late compares against the business timezone and notifies held statuses', async () => {
  reset(rows())
  const out = await oc.executeOwnerTool('running_late', { minutes: 15 }, BIZ)
  assert.match(out, /Notified 1 of 1/)
  assert.match(state.sms[0].body, /11:30 PM/)
})

test('block_dates reports bookings already on that day', async () => {
  reset(rows())
  const out = await oc.executeOwnerTool('block_dates', { start_date: future, end_date: future }, BIZ)
  assert.match(out, /Heads up: 2 bookings/)
  assert.match(out, /Ana Q/)
  assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}/)
})

test('get_schedule formats times and only lists upcoming approvals', async () => {
  reset(rows())
  const out = await oc.executeOwnerTool('get_schedule', { date: future }, BIZ)
  assert.match(out, /9:00 AM: Ana Q/)
  assert.match(out, /2:00 PM: Jess Lee/)
  assert.match(out, /1 pending approval/)
})

test('send_quote accepts a numeric price', async () => {
  reset(rows())
  const out = await oc.executeOwnerTool('send_quote', { customer_name: 'Ana', price: 240 }, BIZ)
  assert.match(out, /\$240 for Cut/)
  assert.match(state.sms[0].body, /\$240/)
})

test('approve texts a formatted confirmation and confirms the row', async () => {
  reset(rows())
  const out = await oc.executeOwnerTool('approve_booking_request', { customer_name: 'ana' }, BIZ)
  assert.match(out, /Approved/)
  assert.match(state.sms[0].body, /9:00 AM/)
  assert.doesNotMatch(state.sms[0].body, /\d{4}-\d{2}-\d{2}|\b09:00\b/)
  assert.equal(state.rows.appointments.find(a => a.id === 'a4').status, 'confirmed')
})

test('deny declines, texts the client with the reason, and cancels', async () => {
  reset(rows())
  const out = await oc.executeOwnerTool('deny_booking_request', { customer_name: 'Ana', reason: 'fully booked that week' }, BIZ)
  assert.match(out, /Declined Ana Q/)
  assert.match(state.sms[0].body, /\(fully booked that week\)/)
  assert.equal(state.rows.appointments.find(a => a.id === 'a4').status, 'cancelled')
})

test('reschedule_all blocks the day, cancels, and texts each client with a formatted date', async () => {
  reset(rows())
  const out = await oc.executeOwnerTool('reschedule_all', { date: today(), reason: 'illness' }, BIZ)
  assert.match(out, /Cancelled 1 appointment and texted 1 client/)
  assert.doesNotMatch(state.sms[0].body, /\d{4}-\d{2}-\d{2}/)
  assert.ok(state.writes.some(w => w[0] === 'blocked_dates'))
})

test('approve with a deposit service puts the booking on hold and sends the pay instructions', async () => {
  const r = rows(); r.services[0].deposit_amount = '50'; r.businesses[0].payment_link = 'Zelle: 310-555-0199'
  reset(r)
  const biz = { ...BIZ, payment_link: 'Zelle: 310-555-0199' }
  const out = await oc.executeOwnerTool('approve_booking_request', { customer_name: 'Ana' }, biz)
  assert.match(out, /deposit instructions/)
  assert.match(state.sms[0].body, /Zelle/)
  assert.equal(state.rows.appointments.find(a => a.id === 'a4').status, 'deposit_pending')
})
