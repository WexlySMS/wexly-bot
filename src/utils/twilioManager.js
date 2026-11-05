const twilio = require('twilio')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const WEBHOOK_URL = `${process.env.BOT_URL}/webhook/sms`
const STATUS_URL  = `${process.env.BOT_URL}/webhook/status`
const VOICE_URL   = `${process.env.BOT_URL}/webhook/voice`
const SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || null

// ── Warm number pool (v201, PROTECTED_DECISIONS Entry 70) ────────────────────
// Carriers take anywhere from minutes to many hours to recognise a number that
// was just added to a 10DLC campaign; until they do, every text from it bounces
// (30003). Observed Nov 4 2026: two fresh 310s and a fresh 424 bounced to the
// same handset for hours, the same numbers delivered the next morning, while an
// August number delivered instantly. So trials never get a fresh number: the
// bot keeps POOL_MIN registered numbers idle and hands out the oldest one.
const POOL_MIN         = parseInt(process.env.NUMBER_POOL_MIN || '5', 10)
const POOL_MAX         = parseInt(process.env.NUMBER_POOL_MAX || '12', 10)
const POOL_MIN_AGE_H   = parseFloat(process.env.NUMBER_POOL_MIN_AGE_HOURS || '12')
const QUARANTINE_DAYS  = parseInt(process.env.NUMBER_POOL_QUARANTINE_DAYS || '30', 10)
const digits = (n) => String(n || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
const SHARED_NUMBER    = digits(process.env.TWILIO_PHONE_NUMBER)
// Numbers the pool must never touch: the shared number, anything listed in
// NUMBER_POOL_EXCLUDE (comma separated), and toll-free (needs its own verification).
const EXCLUDED = new Set([SHARED_NUMBER, ...String(process.env.NUMBER_POOL_EXCLUDE || '').split(',').map(digits)].filter(Boolean))
const isTollFree = (n) => /^(800|833|844|855|866|877|888)/.test(digits(n))
const isExcluded = (n) => EXCLUDED.has(digits(n)) || isTollFree(n)

const hoursAgo = (iso) => iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : 0

// ── Twilio primitives ─────────────────────────────────────────────────────────
async function attachToService(sid, number) {
  if (!SERVICE_SID) return true
  for (let i = 0; i < 3; i++) {
    try {
      await client.messaging.v1.services(SERVICE_SID).phoneNumbers.create({ phoneNumberSid: sid })
      console.log(`[Twilio] Assigned ${number} to messaging service ${SERVICE_SID}`)
      return true
    } catch (err) {
      if (/already/i.test(err.message)) return true
      console.error(`[Twilio] Attach attempt ${i + 1} failed for ${number}:`, err.message)
      if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)))
    }
  }
  console.error(`[Twilio] ⚠️⚠️ ${number} is NOT in the messaging service after 3 tries. Texts from it will bounce until it is added in Twilio → Messaging → Services → Sender Pool.`)
  return false
}

async function isInService(sid) {
  if (!SERVICE_SID) return true
  try { await client.messaging.v1.services(SERVICE_SID).phoneNumbers(sid).fetch(); return true }
  catch { return false }
}

// Buy one local number. areaCode optional; falls back to any US local.
async function buyNumber(areaCode, friendlyName) {
  const search = { smsEnabled: true, limit: 5 }
  if (areaCode && /^\d{3}$/.test(String(areaCode))) search.areaCode = parseInt(areaCode, 10)
  let available = await client.availablePhoneNumbers('US').local.list(search)
  if (available.length === 0 && areaCode) available = await client.availablePhoneNumbers('US').local.list({ smsEnabled: true, limit: 5 })
  if (available.length === 0) throw new Error('No available phone numbers found')
  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    smsUrl: WEBHOOK_URL, smsMethod: 'POST',
    voiceUrl: VOICE_URL, voiceMethod: 'POST',
    statusCallback: STATUS_URL,
    friendlyName
  })
  console.log(`[Twilio] Purchased ${purchased.phoneNumber}`)
  const attached = await attachToService(purchased.sid, purchased.phoneNumber)
  return { number: purchased.phoneNumber, sid: purchased.sid, attached }
}

// ── Pool table helpers ────────────────────────────────────────────────────────
// number_pool(phone_number pk, twilio_sid, area_code, purchased_at, in_service,
//             assigned_business_id, assigned_at, released_at, note)
async function poolInsert(row) {
  const { error } = await supabase.from('number_pool').upsert(row, { onConflict: 'phone_number' })
  if (error) console.error('[Pool] insert failed:', error.message)
}

async function poolAvailable() {
  const { data, error } = await supabase.from('number_pool')
    .select('*').is('assigned_business_id', null).order('purchased_at', { ascending: true })
  if (error) { console.error('[Pool] read failed:', error.message); return [] }
  const cutoff = Date.now() - QUARANTINE_DAYS * 864e5
  return (data || []).filter(n => !n.released_at || new Date(n.released_at).getTime() < cutoff)
}

// Pick the best idle number: same area code if one is old enough, else the oldest.
function pickFromPool(list, areaCode) {
  list = list.filter(n => !isExcluded(n.phone_number))
  if (!list.length) return null
  const aged = list.filter(n => hoursAgo(n.purchased_at) >= POOL_MIN_AGE_H)
  const candidates = aged.length ? aged : list
  if (areaCode) {
    const local = candidates.find(n => n.area_code === String(areaCode))
    if (local) return local
  }
  return candidates[0]
}

// Top the pool up to POOL_MIN idle numbers, trim above POOL_MAX. Runs hourly.
async function maintainNumberPool() {
  try {
    const idle = await poolAvailable()
    const { data: all, error: readErr } = await supabase.from('number_pool').select('phone_number, twilio_sid, assigned_business_id, released_at, purchased_at')
    // Never buy numbers we can't record. If the table is missing (migration
    // not run yet) this logs once an hour and does nothing else.
    if (readErr) { console.error('[Pool] cannot read number_pool, skipping top-up:', readErr.message); return }
    const unassigned = (all || []).filter(n => !n.assigned_business_id)
    const need = POOL_MIN - unassigned.length
    if (need > 0) {
      console.log(`[Pool] ${unassigned.length} idle (${idle.length} out of quarantine), buying ${need}`)
      for (let i = 0; i < need; i++) {
        try {
          const b = await buyNumber(null, 'Wexly — pool')
          await poolInsert({ phone_number: b.number, twilio_sid: b.sid, area_code: b.number.slice(2, 5), purchased_at: new Date().toISOString(), in_service: b.attached })
        } catch (err) { console.error('[Pool] buy failed:', err.message); break }
      }
    } else if (unassigned.length > POOL_MAX) {
      // Release the youngest extras; aged numbers are the valuable ones.
      const extras = unassigned.sort((a, b) => new Date(b.purchased_at) - new Date(a.purchased_at)).slice(0, unassigned.length - POOL_MAX)
      for (const n of extras) {
        try { await client.incomingPhoneNumbers(n.twilio_sid).remove(); await supabase.from('number_pool').delete().eq('phone_number', n.phone_number); console.log(`[Pool] trimmed ${n.phone_number}`) }
        catch (err) { console.error('[Pool] trim failed:', err.message) }
      }
    }
    // Re-check service membership for idle numbers that failed to attach.
    for (const n of unassigned.filter(x => x.in_service === false)) {
      const ok = await attachToService(n.twilio_sid, n.phone_number)
      if (ok) await supabase.from('number_pool').update({ in_service: true }).eq('phone_number', n.phone_number)
    }
  } catch (err) { console.error('[Pool] maintain failed:', err.message) }
}

// One-time / on-demand: pull every Wexly-owned Twilio number that no live
// business is using into the pool, so numbers from cancelled accounts and
// earlier tests start ageing instead of sitting unused.
async function importOrphanedNumbers() {
  const out = { imported: [], skipped: [] }
  try {
    const numbers = await client.incomingPhoneNumbers.list({ limit: 200 })
    const { data: bizzes } = await supabase.from('businesses').select('id, sms_number, status')
    const live = new Set((bizzes || []).filter(b => b.sms_number && !['cancelled', 'pending_checkout', 'trial_expired'].includes(b.status)).map(b => b.sms_number))
    const { data: pooled, error: poolErr } = await supabase.from('number_pool').select('phone_number')
    if (poolErr) { console.error('[Pool] number_pool table not readable, skipping import (run the migration):', poolErr.message); out.error = poolErr.message; return out }
    const inPool = new Set((pooled || []).map(p => p.phone_number))
    for (const n of numbers) {
      if (isExcluded(n.phoneNumber)) { out.skipped.push(`${n.phoneNumber} (${isTollFree(n.phoneNumber) ? 'toll-free' : 'excluded'})`); continue }
      if (!n.capabilities?.sms) { out.skipped.push(`${n.phoneNumber} (no sms)`); continue }
      if (live.has(n.phoneNumber)) { out.skipped.push(`${n.phoneNumber} (in use)`); continue }
      if (inPool.has(n.phoneNumber)) { out.skipped.push(`${n.phoneNumber} (already pooled)`); continue }
      const inSvc = await isInService(n.sid)
      if (!inSvc) await attachToService(n.sid, n.phoneNumber)
      await client.incomingPhoneNumbers(n.sid).update({ smsUrl: WEBHOOK_URL, smsMethod: 'POST', voiceUrl: VOICE_URL, voiceMethod: 'POST', statusCallback: STATUS_URL, friendlyName: 'Wexly — pool' })
      await poolInsert({ phone_number: n.phoneNumber, twilio_sid: n.sid, area_code: n.phoneNumber.slice(2, 5), purchased_at: n.dateCreated ? new Date(n.dateCreated).toISOString() : new Date().toISOString(), in_service: true, note: 'imported' })
      // Detach from any dead business row that still references it.
      await supabase.from('businesses').update({ sms_number: null }).eq('sms_number', n.phoneNumber).in('status', ['cancelled', 'pending_checkout', 'trial_expired'])
      out.imported.push(n.phoneNumber)
    }
    console.log(`[Pool] imported ${out.imported.length}, skipped ${out.skipped.length}`)
  } catch (err) { console.error('[Pool] import failed:', err.message); out.error = err.message }
  return out
}

async function poolStatus() {
  const { data } = await supabase.from('number_pool').select('*').order('purchased_at', { ascending: true })
  const rows = (data || []).map(n => ({
    ...n,
    age_hours: Math.round(hoursAgo(n.purchased_at)),
    state: n.assigned_business_id ? 'assigned' : (n.released_at && hoursAgo(n.released_at) < QUARANTINE_DAYS * 24) ? 'quarantine' : (hoursAgo(n.purchased_at) >= POOL_MIN_AGE_H ? 'ready' : 'warming')
  }))
  return { min: POOL_MIN, max: POOL_MAX, min_age_hours: POOL_MIN_AGE_H, quarantine_days: QUARANTINE_DAYS, numbers: rows }
}

// ── Assign a number to a business: pool first, buy as last resort ────────────
async function assignNumberToBusiness(businessId, areaCode = null) {
  try {
    const idle = await poolAvailable()
    const pick = pickFromPool(idle, areaCode)
    let number, source
    if (pick) {
      number = pick.phone_number; source = `pool, ${Math.round(hoursAgo(pick.purchased_at))}h old`
      if (!pick.in_service) { const ok = await attachToService(pick.twilio_sid, number); if (ok) await supabase.from('number_pool').update({ in_service: true }).eq('phone_number', number) }
      await client.incomingPhoneNumbers(pick.twilio_sid).update({ friendlyName: `Wexly — Business ${businessId}`, smsUrl: WEBHOOK_URL, smsMethod: 'POST', voiceUrl: VOICE_URL, voiceMethod: 'POST', statusCallback: STATUS_URL })
      await supabase.from('number_pool').update({ assigned_business_id: businessId, assigned_at: new Date().toISOString(), released_at: null }).eq('phone_number', number)
      // A pool number younger than the propagation window still gets the hold.
      if (hoursAgo(pick.purchased_at) < 1) require('./sms').markNumberProvisioned(number)
    } else {
      console.warn(`[Pool] empty, buying a fresh number for ${businessId} (expect carrier delays)`)
      const b = await buyNumber(areaCode, `Wexly — Business ${businessId}`)
      number = b.number; source = 'fresh'
      require('./sms').markNumberProvisioned(number)
      await poolInsert({ phone_number: number, twilio_sid: b.sid, area_code: number.slice(2, 5), purchased_at: new Date().toISOString(), in_service: b.attached, assigned_business_id: businessId, assigned_at: new Date().toISOString() })
    }

    const { error } = await supabase.from('businesses').update({ sms_number: number, active: true }).eq('id', businessId)
    if (error) throw error
    console.log(`[Twilio] Number ${number} assigned to business ${businessId} (${source})`)
    // Keep the pool topped up without blocking signup.
    maintainNumberPool().catch(() => {})
    return number
  } catch (err) {
    console.error(`[Twilio] Failed to assign number to business ${businessId}:`, err.message)
    throw err
  }
}

// ── Release: back to the pool with a quarantine, not deleted ─────────────────
// An aged, registered number is the scarce thing; deleting it throws the ageing
// away. Quarantine keeps the old business's customers from reaching a stranger.
async function releaseNumberFromBusiness(businessId) {
  try {
    const { data: business } = await supabase.from('businesses').select('sms_number').eq('id', businessId).maybeSingle()
    if (!business?.sms_number) return
    const number = business.sms_number
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: number, limit: 1 })
    if (numbers.length > 0) {
      await client.incomingPhoneNumbers(numbers[0].sid).update({ friendlyName: 'Wexly — pool (quarantine)' })
      await poolInsert({ phone_number: number, twilio_sid: numbers[0].sid, area_code: number.slice(2, 5), purchased_at: numbers[0].dateCreated ? new Date(numbers[0].dateCreated).toISOString() : new Date().toISOString(), in_service: true, assigned_business_id: null, assigned_at: null, released_at: new Date().toISOString() })
      console.log(`[Twilio] Released ${number} from business ${businessId} → pool (quarantine ${QUARANTINE_DAYS}d)`)
    }
    await supabase.from('businesses').update({ sms_number: null }).eq('id', businessId)
  } catch (err) {
    console.error(`[Twilio] Failed to release number for business ${businessId}:`, err.message)
  }
}

// ── Update webhook URLs for all numbers (useful after redeployment) ───────────
async function syncAllWebhooks() {
  try {
    const numbers = await client.incomingPhoneNumbers.list({ limit: 100 })
    for (const num of numbers) {
      if (num.friendlyName?.startsWith('Wexly')) {
        await client.incomingPhoneNumbers(num.sid).update({ smsUrl: WEBHOOK_URL, smsMethod: 'POST', voiceUrl: VOICE_URL, voiceMethod: 'POST' })
        console.log(`[Twilio] Synced SMS + Voice webhook for ${num.phoneNumber}`)
      }
    }
    console.log(`[Twilio] Synced ${numbers.length} numbers`)
  } catch (err) {
    console.error('[Twilio] Sync failed:', err.message)
  }
}

module.exports = { assignNumberToBusiness, releaseNumberFromBusiness, syncAllWebhooks, maintainNumberPool, importOrphanedNumbers, poolStatus, buyNumber }
