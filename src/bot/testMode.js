// v227 TEST mode: lets the owner be a client in their own text thread.
//
// The owner's verified cell is the boss number, so "any openings Friday?" from
// it is read as a command about Friday, never as a booking. That means a new
// signup can never experience the client side from their own phone, which is
// the one thing that makes the product click. TEST flips the thread for ten
// minutes: owner texts run through the client receptionist, the booking alert
// lands on the same phone, and everything the test created is deleted on DONE
// or on expiry. State lives in businesses.onboarding (test_started_at,
// test_until) so it survives restarts and the scheduler can expire it.
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { phoneVariants } = require('../utils/phone')
const { sendSMS } = require('../utils/sms')

const START_RE = /^\s*(test|test mode|try it|try it out|client mode|be a client|act as a client)\s*[.!?]*\s*$/i
const STOP_RE = /^\s*(done|exit|stop test|end test|stop|back)\s*[.!?]*\s*$/i
const TEST_MINUTES = 10

function state(business) {
  const ob = business.onboarding || {}
  const until = ob.test_until ? new Date(ob.test_until).getTime() : 0
  return { ob, started: ob.test_started_at || null, until, active: until > Date.now() }
}

async function setState(businessId, patch) {
  const { data } = await supabase.from('businesses').select('onboarding').eq('id', businessId).maybeSingle()
  const next = { ...(data?.onboarding || {}), ...patch }
  await supabase.from('businesses').update({ onboarding: next }).eq('id', businessId)
  return next
}

// Remove everything the test created: bookings, the customer record, the client
// thread. Scoped to the owner's phone and the test window so nothing real goes.
async function cleanup(business, ownerPhone, startedAt) {
  const variants = phoneVariants(ownerPhone)
  const since = startedAt || new Date(Date.now() - TEST_MINUTES * 2 * 60e3).toISOString()
  let removed = 0
  try {
    const { data: appts } = await supabase.from('appointments').select('id').eq('business_id', business.id).in('customer_phone', variants).gte('created_at', since)
    if (appts?.length) { await supabase.from('appointments').delete().in('id', appts.map(a => a.id)); removed += appts.length }
    await supabase.from('customers').delete().eq('business_id', business.id).in('phone', variants).gte('created_at', since)
    await supabase.from('conversation_sessions').delete().eq('business_id', business.id).in('customer_phone', variants)
  } catch (e) { console.error('[TestMode] cleanup failed:', e.message) }
  await setState(business.id, { test_until: null, test_started_at: null, test_last_ended_at: new Date().toISOString() })
  return removed
}

async function startReply(business) {
  const { data: svc } = await supabase.from('services').select('name').eq('business_id', business.id).order('created_at').limit(1).maybeSingle()
  const example = svc?.name ? `any openings Friday for a ${svc.name.toLowerCase()}?` : 'any openings Friday?'
  return `You're a client now for ${TEST_MINUTES} minutes. Text me like you're booking. Try: "${example}"\n\nWhen a booking goes through, watch for the alert I send you, that's what every real booking sends. Reply DONE to switch back.`
}

// Returns 'handled' (replied, stop), 'client' (route this text to the client
// receptionist), or 'owner' (carry on as a normal owner text).
async function handleTestMode(business, text, fromBusinessNumber, ownerPhone) {
  const s = state(business)
  if (START_RE.test(text)) {
    const startedAt = new Date().toISOString()
    await setState(business.id, { test_started_at: startedAt, test_until: new Date(Date.now() + TEST_MINUTES * 60e3).toISOString(), test_used_at: s.ob.test_used_at || startedAt })
    await sendSMS(fromBusinessNumber, ownerPhone, await startReply(business))
    return 'handled'
  }
  if (s.active && STOP_RE.test(text)) {
    const n = await cleanup(business, ownerPhone, s.started)
    await sendSMS(fromBusinessNumber, ownerPhone,
      `Back to owner mode.${n ? ` I cleared the ${n === 1 ? 'test booking' : n + ' test bookings'} so your calendar is clean.` : ''} That's exactly what your clients get, and the alert is what you get. Put the number in your Instagram bio and it's on.`)
    return 'handled'
  }
  if (s.active) return 'client'
  if (s.until && !s.active) { await cleanup(business, ownerPhone, s.started) }   // expired quietly; this text is an owner text
  return 'owner'
}

// Scheduler: expire and clean any test that ran out without a DONE.
async function expireTestModes() {
  const { data: rows } = await supabase.from('businesses').select('id, business_name, owner_phone, sms_number, onboarding')
    .not('onboarding->>test_until', 'is', null)
  for (const b of rows || []) {
    const s = state(b)
    if (s.active) continue
    const n = await cleanup(b, b.owner_phone, s.started)
    if (b.sms_number && b.owner_phone) await sendSMS(b.sms_number, b.owner_phone, `Test mode ended, you're the owner again.${n ? ' Test booking cleared.' : ''}`).catch(() => {})
    console.log(`[TestMode] expired for ${b.business_name}, removed ${n}`)
  }
}

module.exports = { handleTestMode, expireTestModes, cleanup, START_RE }
