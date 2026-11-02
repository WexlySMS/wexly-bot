// ── Instant trial onboarding (v190) ───────────────────────────────────────────
// Signup → verified owner cell → number bought on the spot → the bot introduces
// itself from the owner's NEW business number. Everything after that (DEMO,
// nudges, card ask, expiry) rides on the same owner thread.
//
// Status lifecycle for an instant-trial account:
//   trial (no card)  → day 7/13 nudges → trial_expired (bot off for clients)
//   trial + card (stripe_subscription_id set) → Stripe owns billing from there
//
// Everything here is gated on `owner_phone_verified_at` (set only by the instant flow) so legacy accounts
// (card-first signups) are never touched by the drip.

const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')
const { sendSMS } = require('../utils/sms')
const { assignNumberToBusiness, releaseNumberFromBusiness } = require('../utils/twilioManager')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const SITE_URL = (process.env.SITE_URL || 'https://getwexly.com').replace(/\/$/, '')
const BOT_URL  = (process.env.BOT_URL || 'https://wexly-bot.onrender.com').replace(/\/$/, '')
const CODE_TTL_MIN = 10
const CODE_MAX_ATTEMPTS = 5
const CODES_PER_10_MIN = 3
const VERIFIED_WINDOW_MIN = 30
const TRIAL_DAYS = 14
const EXPIRED_NUMBER_GRACE_DAYS = 14
const PLAN_PRICE = { solo: '$79', standard: '$149', pro: '$199' }

// ── Phone helpers ─────────────────────────────────────────────────────────────
function normalizeUSPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
  if (d.length !== 10) return null
  if (/^[01]/.test(d) || /^[01]/.test(d.slice(3, 4))) return null // NANP: area code / exchange can't start with 0 or 1
  return '+1' + d
}

function formatPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '').replace(/^1/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164
}

function phoneVariants(e164) {
  const d = e164.replace(/\D/g, '').replace(/^1/, '')
  return [e164, d, '1' + d, formatPhone(e164), `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`]
}

function firstName(biz) {
  return (biz.owner_name || '').split(' ')[0] || 'there'
}

function hashCode(code, phone) {
  const secret = process.env.ADMIN_SECRET || process.env.TWILIO_AUTH_TOKEN || 'wexly'
  return crypto.createHash('sha256').update(`${code}|${phone}|${secret}`).digest('hex')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Verification codes ────────────────────────────────────────────────────────
// Codes go out from the shared Wexly number (TWILIO_PHONE_NUMBER) because the
// business number does not exist yet at this point.
async function sendVerificationCode(rawPhone, ip) {
  const phone = normalizeUSPhone(rawPhone)
  if (!phone) return { ok: false, error: 'invalid_phone', message: 'Enter a valid US cell number.' }
  if (!process.env.TWILIO_PHONE_NUMBER) return { ok: false, error: 'not_configured', message: 'Texting is not configured.' }

  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { count } = await supabase.from('phone_verifications')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone).gt('created_at', tenMinAgo)
  if ((count || 0) >= CODES_PER_10_MIN) {
    return { ok: false, error: 'too_many', message: 'Too many codes sent. Wait a few minutes and try again.' }
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const { error } = await supabase.from('phone_verifications').insert({
    phone,
    code_hash: hashCode(code, phone),
    expires_at: new Date(Date.now() + CODE_TTL_MIN * 60 * 1000).toISOString(),
    ip: ip || null
  })
  if (error) throw error

  const sent = await sendSMS(process.env.TWILIO_PHONE_NUMBER, phone,
    `Your Wexly code is ${code}. It expires in ${CODE_TTL_MIN} minutes.`)
  if (!sent.success) return { ok: false, error: 'send_failed', message: 'We could not text that number. Check it and try again.' }

  console.log(`[Verify] Code sent to ${phone}`)
  return { ok: true, phone, masked: formatPhone(phone) }
}

async function verifyCode(rawPhone, code) {
  const phone = normalizeUSPhone(rawPhone)
  const clean = String(code || '').replace(/\D/g, '')
  if (!phone || clean.length !== 6) return { ok: false, error: 'invalid', message: 'Enter the 6-digit code we texted you.' }

  const { data: row } = await supabase.from('phone_verifications')
    .select('id, code_hash, attempts, expires_at')
    .eq('phone', phone).is('verified_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()

  if (!row || new Date(row.expires_at) < new Date()) {
    return { ok: false, error: 'expired', message: 'That code expired. Tap "Text me a new code".' }
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    return { ok: false, error: 'too_many_attempts', message: 'Too many tries. Tap "Text me a new code".' }
  }
  if (row.code_hash !== hashCode(clean, phone)) {
    await supabase.from('phone_verifications').update({ attempts: row.attempts + 1 }).eq('id', row.id)
    return { ok: false, error: 'wrong', message: 'That code does not match. Try again.' }
  }

  await supabase.from('phone_verifications').update({ verified_at: new Date().toISOString() }).eq('id', row.id)
  console.log(`[Verify] ${phone} verified`)
  return { ok: true, phone }
}

// create-business trusts a phone only if it was verified in the last 30 minutes.
async function isRecentlyVerified(rawPhone) {
  const phone = normalizeUSPhone(rawPhone)
  if (!phone) return false
  const since = new Date(Date.now() - VERIFIED_WINDOW_MIN * 60 * 1000).toISOString()
  const { data } = await supabase.from('phone_verifications')
    .select('id').eq('phone', phone).gt('verified_at', since).limit(1)
  return !!(data && data.length)
}

// One free trial per cell. A different user_id already holding a trial, expired
// trial or cancelled account on this cell does not get a second free number.
async function phoneAlreadyUsedTrial(rawPhone, userId) {
  const phone = normalizeUSPhone(rawPhone)
  if (!phone) return null
  const { data } = await supabase.from('businesses')
    .select('id, user_id, status, business_name')
    .in('owner_phone', phoneVariants(phone))
    .neq('user_id', userId)
    .limit(5)
  return (data || []).find(b => ['trial', 'trial_expired', 'cancelled', 'past_due'].includes(b.status)) || null
}

// ── Onboarding state ──────────────────────────────────────────────────────────
// Read-merge-write so a DEMO marked from the webhook and a drip step marked
// from the scheduler in the same minute never overwrite each other.
async function markStep(businessId, current, key, extra = {}) {
  const { data } = await supabase.from('businesses').select('onboarding').eq('id', businessId).maybeSingle()
  const next = { ...(current || {}), ...(data?.onboarding || {}), [key]: new Date().toISOString(), ...extra }
  await supabase.from('businesses').update({ onboarding: next }).eq('id', businessId)
  return next
}

function addCardLink() { return `${SITE_URL}/dashboard.html?add_card=1` }
function contactLink(biz) { return `${BOT_URL}/contact/${biz.id}.vcf` }
function trialEndLabel(biz, tz) {
  return new Date(biz.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz || biz.timezone || 'America/Los_Angeles' })
}

// ── Signup → number → hello ──────────────────────────────────────────────────
// Buys the number (local to the owner's cell when possible) and sends the
// welcome from it. Never throws: signup must succeed even if Twilio hiccups;
// the drip sweep retries number assignment for trial accounts with no number.
async function activateInstantTrial(businessId) {
  const { data: biz } = await supabase.from('businesses').select('*').eq('id', businessId).maybeSingle()
  if (!biz) return null

  let number = biz.sms_number
  if (!number) {
    const areaCode = (biz.owner_phone || '').replace(/\D/g, '').replace(/^1/, '').slice(0, 3)
    try {
      number = await assignNumberToBusiness(biz.id, areaCode || null)
    } catch (err) {
      console.error(`[InstantTrial] Number purchase failed for ${biz.business_name}:`, err.message)
      return null
    }
  }

  const fresh = { ...biz, sms_number: number }
  await sendTrialWelcome(fresh)
  return number
}

async function sendTrialWelcome(biz) {
  if (!biz.owner_phone || !biz.sms_number) return
  if (biz.onboarding?.welcome_sent_at) return

  const name = firstName(biz)
  const hello =
    `Hey ${name}, I'm your Wexly assistant. This is the new business number for ${biz.business_name}.\n\n` +
    `Save me as a contact: ${contactLink(biz)}\n\n` +
    `Clients text this number to book. You text it to run things. Try it now: reply "today" to see your schedule, or "block friday 2-4" to block time.`

  const sent = await sendSMS(biz.sms_number, biz.owner_phone, hello)
  if (!sent.success) return
  let state = await markStep(biz.id, biz.onboarding, 'welcome_sent_at')
  console.log(`[InstantTrial] Welcome sent from ${biz.sms_number} to ${biz.owner_phone}`)

  // The DEMO offer lands a beat later so it reads as a second thought, not a wall.
  setTimeout(async () => {
    try {
      await sendSMS(biz.sms_number, biz.owner_phone,
        `Want to see what a client sees? Reply DEMO and I'll walk you through a booking like I'm talking to one.`)
      await markStep(biz.id, state, 'demo_offered_at')
    } catch (e) { console.error('[InstantTrial] demo offer failed:', e.message) }
  }, 25 * 1000)
}

// ── DEMO: the client experience, played inside the owner thread ──────────────
// The owner's cell is flagged as owner, so they can't play client from it.
// This runs a scripted booking with the business's own first service.
async function runOwnerDemo(biz) {
  const to = biz.owner_phone, from = biz.sms_number
  if (!to || !from) return

  const { data: services } = await supabase.from('services')
    .select('name, duration_mins, price').eq('business_id', biz.id).neq('active', false)
    .order('sort_order').limit(1)
  const svc = services?.[0]
  const service = svc?.name || 'Haircut'
  const details = svc
    ? ` (${svc.duration_mins || 60} min${svc.price ? `, $${Number(svc.price).toFixed(0)}` : ''})`
    : ' (45 min, $60)'
  const botName = biz.bot_name || biz.business_name
  const tz = biz.timezone || 'America/Los_Angeles'
  const friday = new Date(); friday.setDate(friday.getDate() + ((5 - friday.getDay() + 7) % 7 || 7))
  const dateStr = friday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })

  const lines = [
    `Here's what a client sees. Say a client named Jess texts your number:`,
    `Jess: Hi! Do you have anything Friday afternoon for a ${service.toLowerCase()}?`,
    `${botName}: Hi Jess! I have Friday ${dateStr} at 1:00 PM or 3:30 PM for a ${service}${details}. Which works for you?`,
    `Jess: 3:30 works`,
    `${botName}: You're booked: ${service} on Friday ${dateStr} at 3:30 PM with ${biz.business_name}. I'll text you a reminder the day before. Text this number any time to reschedule.`,
    `That just happened without you touching anything. You'd get a notification: "New booking: Jess, Fri 3:30 PM, ${service}".\n\n` +
    `To make it real, put this number where clients already find you. Paste this in your Instagram bio:\nBook by text: ${formatPhone(from)}`
  ]
  for (let i = 0; i < lines.length; i++) {
    await sendSMS(from, to, lines[i])
    if (i < lines.length - 1) await sleep(1800)
  }
  await markStep(biz.id, biz.onboarding, 'demo_run_at')
  console.log(`[InstantTrial] DEMO played for ${biz.business_name}`)
}

// Owner texts anything after expiry → one clear path back.
function expiredOwnerReply(biz) {
  return `Your free trial ended, so I've stopped answering clients at this number. Everything you set up is saved. Add a card and I'm back on within a minute: ${addCardLink()}`
}

// ── Drip sweep (scheduler, every 10 min) ─────────────────────────────────────
async function runTrialOnboardingDrip() {
  const now = new Date()
  let sent = 0

  // 1. Retry: trial accounts that never got a number (Twilio failed at signup).
  const { data: noNumber } = await supabase.from('businesses')
    .select('id, business_name')
    .eq('status', 'trial').is('sms_number', null).not('owner_phone', 'is', null)
    .not('owner_phone_verified_at', 'is', null)
    .gt('created_at', new Date(now - 3 * 24 * 3600 * 1000).toISOString())
    .limit(10)
  for (const b of noNumber || []) {
    console.log(`[InstantTrial] Retrying number for ${b.business_name}`)
    await activateInstantTrial(b.id).catch(e => console.error('[InstantTrial] retry failed:', e.message))
  }

  // 2. Live instant trials. owner_phone_verified_at is the instant-flow marker
  // (legacy card-first accounts never have it), so expiry can never be skipped
  // just because the welcome text failed to send.
  const { data: trials } = await supabase.from('businesses')
    .select('*')
    .eq('status', 'trial')
    .not('sms_number', 'is', null).not('owner_phone', 'is', null)
    .not('owner_phone_verified_at', 'is', null)

  for (const biz of trials || []) {
    try {
      const ob = biz.onboarding || {}
      if (!ob.welcome_sent_at) {
        // Welcome never landed (carrier hiccup at signup). Try again; the rest
        // of the drip waits until it has.
        await sendTrialWelcome(biz)
        if (!(biz.trial_ends_at && new Date(biz.trial_ends_at) < now && !biz.stripe_subscription_id)) continue
      }
      const ageMin = (now - new Date(biz.created_at)) / 60000
      const hasCard = !!biz.stripe_subscription_id
      const endsAt = biz.trial_ends_at ? new Date(biz.trial_ends_at) : null
      const daysLeft = endsAt ? (endsAt - now) / 86400000 : null
      const from = biz.sms_number, to = biz.owner_phone
      const plan = PLAN_PRICE[biz.plan] || PLAN_PRICE.standard

      // Expiry wins over everything else.
      if (!hasCard && endsAt && endsAt < now) {
        await supabase.from('businesses').update({ status: 'trial_expired' }).eq('id', biz.id)
        await sendSMS(from, to, expiredOwnerReply(biz))
        await markStep(biz.id, ob, 'expired_at')
        console.log(`[InstantTrial] ${biz.business_name} trial expired`)
        sent++
        continue
      }

      // Services by text, 10 min in, only if they have none.
      if (!ob.services_nudge_at && ageMin >= 10) {
        const { count } = await supabase.from('services').select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id).neq('active', false)
        if (!count) {
          await sendSMS(from, to,
            `Quick one: text me your services and prices and I'll set them up. Like this:\n"Haircut 45 min $60, Color 2 hr $150"`)
          sent++
        }
        await markStep(biz.id, ob, 'services_nudge_at'); ob.services_nudge_at = now.toISOString()
      }

      // Setup interview offer, 30 min in, if never started.
      if (!ob.interview_offered_at && ageMin >= 30 && !biz.interview_state) {
        const { startSetupInterview } = require('./setupInterview')
        await startSetupInterview(biz)
        await markStep(biz.id, ob, 'interview_offered_at'); ob.interview_offered_at = now.toISOString()
        sent++
      }

      // Day 1: the one action that turns the trial into bookings.
      if (!ob.bio_nudge_at && ageMin >= 20 * 60) {
        await sendSMS(from, to,
          `Put your number where clients already find you. Paste this in your Instagram bio and Google Business profile:\n\nBook by text: ${formatPhone(from)}\n\nThat one line is what turns this on.`)
        await markStep(biz.id, ob, 'bio_nudge_at'); ob.bio_nudge_at = now.toISOString()
        sent++
      }

      // First real booking.
      if (!ob.first_booking_at) {
        const { count } = await supabase.from('appointments').select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id).neq('status', 'cancelled')
        if (count) {
          await sendSMS(from, to,
            `First booking just came in. That's the whole point: a client booked and you didn't touch anything. I'll keep going.`)
          await markStep(biz.id, ob, 'first_booking_at'); ob.first_booking_at = now.toISOString()
          sent++
        }
      }

      // Card asks, only while there is no card.
      if (!hasCard && daysLeft !== null) {
        if (!ob.card_day7_at && daysLeft <= 7) {
          await sendSMS(from, to,
            `You're a week in. Add a card so I keep answering clients after ${trialEndLabel(biz)}. $0 today, ${plan}/mo after, cancel any time: ${addCardLink()}`)
          await markStep(biz.id, ob, 'card_day7_at'); ob.card_day7_at = now.toISOString()
          sent++
        } else if (!ob.card_day13_at && daysLeft <= 1) {
          await sendSMS(from, to,
            `Last day of your trial. Add a card today or I go quiet for your clients tomorrow. Takes a minute: ${addCardLink()}`)
          await markStep(biz.id, ob, 'card_day13_at'); ob.card_day13_at = now.toISOString()
          sent++
        }
      }
    } catch (err) {
      console.error(`[InstantTrial] Drip error for ${biz.business_name}:`, err.message)
    }
  }

  // 3. Recycle numbers from trials that stayed dead.
  const cutoff = new Date(now - EXPIRED_NUMBER_GRACE_DAYS * 86400000).toISOString()
  const { data: dead } = await supabase.from('businesses')
    .select('id, business_name, sms_number')
    .eq('status', 'trial_expired').is('stripe_subscription_id', null)
    .not('sms_number', 'is', null).lt('trial_ends_at', cutoff).limit(10)
  for (const b of dead || []) {
    console.log(`[InstantTrial] Releasing ${b.sms_number} from expired trial ${b.business_name}`)
    await releaseNumberFromBusiness(b.id)
  }

  if (sent) console.log(`[Scheduler] Instant-trial drip: ${sent} message(s)`)
}

module.exports = {
  normalizeUSPhone, formatPhone,
  sendVerificationCode, verifyCode, isRecentlyVerified, phoneAlreadyUsedTrial,
  activateInstantTrial, sendTrialWelcome, runOwnerDemo, expiredOwnerReply,
  runTrialOnboardingDrip, addCardLink, TRIAL_DAYS
}
