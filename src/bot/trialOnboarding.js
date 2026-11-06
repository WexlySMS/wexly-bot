// ── Instant trial onboarding (v190) ───────────────────────────────────────────
// Signup → verified owner cell → number bought on the spot → the bot introduces
// itself from the owner's NEW business number. Everything after that (free
// setup offer, nudges, card ask, expiry) rides on the same owner thread.
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
// v199: refuse owner "cells" that can't take business texts. Google Voice,
// TextNow and other VoIP lines accept an ordinary long-code text (so the
// verification code lands) and then bounce 10DLC campaign traffic with 30003,
// which is exactly what happened to the second signup. Twilio Lookup line type:
// mobile = fine; landline / fixedVoip / nonFixedVoip / tollFree = refuse.
// Lookup failure or an unknown type lets the signup through (fail open).
async function lineTypeCheck(phone) {
  if (process.env.SKIP_LINE_TYPE_CHECK === '1') return { ok: true }
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    const info = await twilio.lookups.v2.phoneNumbers(phone).fetch({ fields: 'line_type_intelligence' })
    const lti = info.lineTypeIntelligence || {}
    const type = String(lti.type || '').toLowerCase()
    const carrier = lti.carrierName || ''
    console.log(`[Verify] Lookup ${phone}: ${type || 'unknown'} (${carrier})`)
    if (['landline', 'fixedvoip', 'nonfixedvoip', 'tollfree', 'premium', 'pager'].includes(type)) {
      const gv = /google/i.test(carrier)
      return {
        ok: false,
        type,
        message: gv
          ? 'That is a Google Voice number. Google Voice blocks business texts, so your Wexly texts would never arrive. Use the cell you actually carry.'
          : (type === 'landline'
              ? 'That looks like a landline. Use the cell you carry so Wexly can text you.'
              : 'That looks like a VoIP or app number, and those block business texts. Use the cell you actually carry.')
      }
    }
    return { ok: true, type }
  } catch (e) {
    console.error('[Verify] Lookup failed (allowing):', e.message)
    return { ok: true, type: 'unknown' }
  }
}

async function sendVerificationCode(rawPhone, ip) {
  const phone = normalizeUSPhone(rawPhone)
  if (!phone) return { ok: false, error: 'invalid_phone', message: 'Enter a valid US cell number.' }
  if (!process.env.TWILIO_PHONE_NUMBER) return { ok: false, error: 'not_configured', message: 'Texting is not configured.' }
  const lt = await lineTypeCheck(phone)
  if (!lt.ok) return { ok: false, error: 'bad_line_type', message: lt.message }

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
// Read-merge-write so a step marked from the webhook and a drip step marked
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
// v202: every business gets a live page at getwexly.com/book/<slug> the moment it
// exists. Slug from the name, de-duplicated with a numeric suffix. Idempotent.
async function ensureProfileSlug(biz) {
  if (!biz || biz.profile_slug) return biz?.profile_slug || null
  const base = String(biz.business_name || 'book').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'book'
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`
    const { data: taken } = await supabase.from('businesses').select('id').eq('profile_slug', slug).neq('id', biz.id).maybeSingle()
    if (taken) continue
    const { error } = await supabase.from('businesses').update({ profile_slug: slug, profile_enabled: true }).eq('id', biz.id)
    if (!error) { console.log(`[Profile] ${biz.business_name} → getwexly.com/book/${slug}`); return slug }
  }
  return null
}
function profileUrl(biz) { return biz?.profile_slug ? `${SITE_URL}/book/${biz.profile_slug}` : null }

async function activateInstantTrial(businessId) {
  const { data: biz } = await supabase.from('businesses').select('*').eq('id', businessId).maybeSingle()
  if (!biz) return null
  ensureProfileSlug(biz).catch(e => console.error('[Profile] slug failed:', e.message))

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
  // v199: not awaited. A brand-new number is held ~3 min for 10DLC propagation
  // (see utils/sms.js), and the dashboard/welcome email shouldn't wait on that.
  sendTrialWelcome(fresh).catch(e => console.error('[InstantTrial] welcome failed:', e.message))
  return number
}

async function sendTrialWelcome(biz) {
  if (!biz.owner_phone || !biz.sms_number) return
  if (biz.onboarding?.welcome_sent_at) return

  // v199: one text, one segment. Everything else (services, bio, interview)
  // waits for the drip. The old welcome was three segments plus a second text
  // 25 seconds later, and read as a wall the moment they signed up.
  const name = firstName(biz)
  // v200: trimmed to fit one GSM segment (160 chars) for typical names.
  const hello =
    `Hi ${name}, I'm your Wexly assistant for ${biz.business_name}. ` +
    `Please save this number. Reply SETUP for a free setup, or text me your services and I'll add them.`

  const sent = await sendSMS(biz.sms_number, biz.owner_phone, hello)
  if (!sent.success) return
  await markStep(biz.id, biz.onboarding, 'welcome_sent_at')
  console.log(`[InstantTrial] Welcome sent from ${biz.sms_number} to ${biz.owner_phone}`)
}

// ── SETUP: the free setup call, offered by text ───────────────────────────────
// Owner replies SETUP (from the welcome or any nudge) and gets the booking link.
function setupCallLink() { return `${SITE_URL}/#setup-call` }
function setupOfferReply(biz) {
  return `Easy. Send me the link to your current booking page or website (or a photo of your service menu) ` +
    `and we'll set up your services, hours and FAQs for you today. ` +
    `Rather talk it through? Book 20 minutes here: ${setupCallLink()}`
}

// The link or photo the owner sent after SETUP. Stored on onboarding, acked
// to the owner, forwarded to Brandon.
async function recordSetupSource(biz, text, mediaUrls) {
  const url = (String(text || '').match(/https?:\/\/\S+|\b[a-z0-9.-]+\.(com|net|co|io|app|biz|salon|beauty)\b\S*/i) || [])[0] || null
  const media = Array.isArray(mediaUrls) ? mediaUrls.slice(0, 5) : []
  const source = { url, media, text: String(text || '').slice(0, 300) }
  try { await markStep(biz.id, biz.onboarding, 'setup_source_at', { setup_source: source }) } catch (e) { console.error('[Setup] markStep failed:', e.message) }
  const OWNER_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
  const OWNER_PHONE = process.env.OWNER_NOTIFICATION_PHONE
  const who = `${biz.owner_name || 'Owner'} at ${biz.business_name}`
  try {
    const { sendEmail } = require('../utils/emailService')
    await sendEmail({
      from: { email: 'hello@getwexly.com', name: 'Wexly' }, to: OWNER_EMAIL,
      subject: `Setup material in — ${biz.business_name}`,
      html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:40px auto;">
        <h2 style="color:#0F0F0E;">${who} sent their setup material</h2>
        ${url ? `<p><strong>Link:</strong> <a href="${url.startsWith('http') ? url : 'https://' + url}">${url}</a></p>` : ''}
        ${media.length ? `<p><strong>Photos:</strong><br>${media.map(m => `<a href="${m}">${m}</a>`).join('<br>')}</p>` : ''}
        <p><strong>Their text:</strong> ${source.text.replace(/</g, '&lt;')}</p>
        <p>Cell: ${formatPhone(biz.owner_phone)} · Wexly number: ${formatPhone(biz.sms_number)}</p>
        <p>Build their services, hours and FAQs in the dashboard, then text them from the admin drawer when it's done.</p>
        <p><a href="${SITE_URL}/admin.html" style="display:inline-block;margin-top:12px;background:#1A6B4A;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">Open admin</a></p>
      </div>`
    })
  } catch (e) { console.error('[Setup] source email failed:', e.message) }
  if (OWNER_PHONE && process.env.TWILIO_PHONE_NUMBER) {
    await sendSMS(process.env.TWILIO_PHONE_NUMBER, OWNER_PHONE,
      `🛠 Setup material from ${who}: ${url || (media.length ? media.length + ' photo(s)' : 'see email')}`
    ).catch(e => console.error('[Setup] source SMS failed:', e.message))
  }
  console.log(`[Setup] ${who} sent setup source: ${url || media.length + ' media'}`)
}

// v203: when the setup source is a link, build the account from it right
// away. The owner gets a summary and a YES/fix prompt; Brandon still gets the
// email so a human can double-check. Photos of a menu still go the human route.
async function runAutoImport(biz, url) {
  const { importFromUrl, applyImport } = require('../utils/siteImporter')
  const data = await importFromUrl(url)
  if (data.error || !data.services || !data.services.length) {
    console.log(`[Setup] auto-import found nothing usable for ${biz.business_name}: ${data.error || 'no services'}`)
    return null
  }
  const result = await applyImport(biz.id, data)
  await announceImport(biz, result, { url })
  return result
}

// v204: tell the owner what was loaded and ask the one question that matters
// next: should clients be able to book all of it instantly, or does every
// request need the owner's OK first? The question is remembered in
// onboarding.pending_question so a bare "yes"/"no" reply is understood even
// after a restart, and the text is noted in the owner's chat history so any
// other reply ("make Balayage $240") still has context. Used by the SETUP text
// flow and by the admin drawer's Apply.
async function announceImport(biz, result, { url = null } = {}) {
  if (!biz.owner_phone || !biz.sms_number) return null
  const { data: fresh } = await supabase.from('businesses').select('profile_slug, onboarding').eq('id', biz.id).maybeSingle()
  const names = [...(result.services?.added || []), ...(result.services?.updated || [])]
  const list = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '')
  const bits = []
  if (names.length) bits.push(`${names.length} service${names.length === 1 ? '' : 's'} (${list})`)
  if (result.hours) bits.push('your hours')
  if (result.photos) bits.push(`${result.photos} photo${result.photos === 1 ? '' : 's'}`)
  if (!bits.length) return null
  const page = fresh?.profile_slug ? `${SITE_URL}/book/${fresh.profile_slug}` : null
  const msg = `Done. I loaded ${bits.join(', ')} from your page.` + (page ? ` Your booking page is live: ${page}` : '') +
    (names.length
      ? ` Quick question: should clients be able to book all of these instantly? Reply YES, or NO if you want to approve each request first. Anything to change, like "make Balayage $240", just tell me.`
      : ` Anything to change, just tell me.`)
  await sendSMS(biz.sms_number, biz.owner_phone, msg)
  try { require('./ownerCommands').noteOwnerOutbound(biz.id, msg) } catch (e) { console.error('[Setup] owner note failed:', e.message) }
  const extra = { auto_import: { url, services: names.length, hours: result.hours, photos: result.photos } }
  if (names.length) extra.pending_question = { kind: 'import_mode', at: new Date().toISOString(), services: names.length }
  await markStep(biz.id, fresh?.onboarding || biz.onboarding, 'auto_import_at', extra)
  return msg
}

const PENDING_QUESTION_TTL_MS = 48 * 60 * 60 * 1000
const YES_RE = /^\s*(y|yes|yeah|yep|yup|ya|sure|ok|okay|correct|instant|instantly|all|do it|sounds good|looks good|perfect|yes please|yes all)\s*[.!]*\s*$/i
const NO_RE  = /^\s*(n|no|nope|nah|approve|approval|approve first|request|requests|not yet|no thanks|none|skip)\s*[.!]*\s*$/i
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── Setup checklist (v204) ────────────────────────────────────────────────────
// After an import the bot walks the owner through everything a working account
// needs, one text at a time, remembering where it is in onboarding.pending_question
// so a restart or a day's gap changes nothing. Each step is skipped when the
// account already has the answer (hours imported, Stripe connected, ...).
// Order: import_mode → deposits → deposit_method → hours → staff → done.
const SETUP_STEPS = ['import_mode', 'deposits', 'deposit_method', 'hours', 'staff']

async function freshBiz(id) {
  const { data } = await supabase.from('businesses').select('id, business_name, owner_name, owner_phone, sms_number, plan, hours, staff_members, payment_link, stripe_account_connected, stripe_account_id, profile_slug, onboarding, timezone').eq('id', id).maybeSingle()
  return data
}
async function setPending(biz, kind, extra = {}) {
  const { data } = await supabase.from('businesses').select('onboarding').eq('id', biz.id).maybeSingle()
  const next = { ...(data?.onboarding || biz.onboarding || {}), ...extra }
  if (kind) next.pending_question = { kind, at: new Date().toISOString() }
  else delete next.pending_question
  await supabase.from('businesses').update({ onboarding: next }).eq('id', biz.id)
  return next
}
function stepNeeded(biz, services, step) {
  const anyDeposit = services.some(sv => sv.deposit_amount && String(sv.deposit_amount).trim() !== '' && String(sv.deposit_amount) !== '0')
  const hasHours = Array.isArray(biz.hours) && biz.hours.some(h => h && (h.open === true || (h.open && h.close)))
  const hasStaff = Array.isArray(biz.staff_members) && biz.staff_members.some(st => st && st.name)
  const hasDepositMethod = (biz.stripe_account_connected && biz.stripe_account_id) || /^https?:\/\//i.test(String(biz.payment_link || ''))
  if (step === 'deposits') return services.length > 0
  if (step === 'deposit_method') return anyDeposit && !hasDepositMethod
  if (step === 'hours') return !hasHours
  if (step === 'staff') return !hasStaff
  return false
}
function questionFor(biz, step, services) {
  const plan = String(biz.plan || '').toLowerCase()
  switch (step) {
    case 'deposits': return `Next: do any services need a deposit to book? Reply NO, or tell me which and how much, like "Balayage $50, Color $40" or "all $25".`
    case 'deposit_method': return `How should deposits be collected? Reply STRIPE and I'll text you a link to connect your Stripe (clients pay by card and bookings confirm themselves), or paste your payment link (Venmo, Zelle, Square, PayPal) and I'll send that to clients and tell you when they say they've paid so you can confirm.`
    case 'hours': return `What are your hours? Something like "Tue to Sat 9 to 6, closed Sun and Mon" is perfect.`
    case 'staff': return `Last one: is it just you taking appointments? Reply JUST ME, or the names of everyone who does, like "Mia, Jordan".`
    default: return null
  }
}
// Move to the next step that still needs an answer; text the question or the wrap-up.
async function advanceSetup(biz, fromStep) {
  const b = await freshBiz(biz.id) || biz
  const { data: services } = await supabase.from('services').select('id, name, deposit_amount, booking_mode').eq('business_id', b.id).neq('active', false)
  const svcs = services || []
  let i = SETUP_STEPS.indexOf(fromStep) + 1
  for (; i < SETUP_STEPS.length; i++) if (stepNeeded(b, svcs, SETUP_STEPS[i])) break
  if (i < SETUP_STEPS.length) {
    const step = SETUP_STEPS[i]
    const q = questionFor(b, step, svcs)
    await setPending(b, step)
    await sendSMS(b.sms_number, b.owner_phone, q)
    try { require('./ownerCommands').noteOwnerOutbound(b.id, q) } catch {}
    return q
  }
  // Done: everything a working account needs is in place.
  const page = b.profile_slug ? `${SITE_URL}/book/${b.profile_slug}` : null
  const deposits = svcs.filter(sv => sv.deposit_amount && String(sv.deposit_amount) !== '0').length
  const bits = [`${svcs.length} service${svcs.length === 1 ? '' : 's'}`]
  if (deposits) bits.push(`${deposits} with a deposit`)
  if (Array.isArray(b.hours) && b.hours.some(h => h && h.open)) bits.push('hours')
  if (Array.isArray(b.staff_members) && b.staff_members.some(st => st?.name)) bits.push(`${b.staff_members.filter(st => st?.name).length} staff`)
  const msg = `You're all set: ${bits.join(', ')}.` + (page ? ` Your booking page: ${page}` : '') +
    ` Put ${prettyNumber(b.sms_number)} on your Instagram and Google listing so clients text it. Anything you want changed, just tell me here, any time.`
  await setPending(b, null, { setup_complete_at: new Date().toISOString() })
  await sendSMS(b.sms_number, b.owner_phone, msg)
  try { require('./ownerCommands').noteOwnerOutbound(b.id, msg) } catch {}
  return msg
}
function prettyNumber(p) { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || 'your Wexly number') }

// Parse "Balayage $50, Color $40" / "all $25" / "$25 for everything" into [{name, amount}] or {all: amount}
function parseDeposits(text) {
  const t = String(text || '').trim()
  const allM = t.match(/\b(all|every(?:thing| service| one)?)\b[^$\d]*\$?\s*(\d+(?:\.\d+)?)/i) || t.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:for|on)\s+(?:all|every(?:thing| service)?)/i)
  if (allM) return { all: parseFloat(allM[2] || allM[1]) }
  const out = []
  for (const part of t.split(/[,;\n]| and /i)) {
    const m = part.match(/^\s*(.+?)\s*[:\-]?\s*\$\s*(\d+(?:\.\d+)?)\s*$/) || part.match(/^\s*\$\s*(\d+(?:\.\d+)?)\s+(?:for|on)\s+(.+?)\s*$/i) || part.match(/^\s*(.+?)\s+(\d+(?:\.\d+)?)\s*(?:dollars|bucks)?\s*$/i)
    if (!m) continue
    const name = (m[1].match(/^\d/) ? m[2] : m[1]).trim(), amount = parseFloat(m[1].match(/^\d/) ? m[1] : m[2])
    if (name && amount > 0) out.push({ name, amount })
  }
  return out.length ? { items: out } : null
}
// Hours by model, into the same shape the importer writes: [{day:'Mon', open:true, from:'09:00', to:'18:00'}|{day, open:false}] x7, Sun first
async function parseHours(text) {
  const Anthropic = require('@anthropic-ai/sdk'); const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const r = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 600, tools: [{ name: 'save_hours', description: 'Save weekly hours', input_schema: { type: 'object', properties: { days: { type: 'array', minItems: 7, maxItems: 7, description: 'Exactly 7 entries, Sunday first', items: { type: 'object', properties: { open: { type: 'boolean' }, from: { type: 'string', description: 'HH:MM 24h' }, to: { type: 'string', description: 'HH:MM 24h' } }, required: ['open'] } } }, required: ['days'] } }], tool_choice: { type: 'tool', name: 'save_hours' },
    messages: [{ role: 'user', content: `Business hours as the owner typed them: "${text}". Return 7 days, Sunday first. Days not mentioned as open are closed. "9 to 6" means 09:00 to 18:00.` }] })
  const tu = r.content.find(c => c.type === 'tool_use'); const days = tu?.input?.days
  if (!Array.isArray(days) || days.length !== 7) return null
  const week = days.map((d, i) => (d.open && d.from && d.to) ? { day: DAY_NAMES[i], open: true, from: d.from, to: d.to } : { day: DAY_NAMES[i], open: false })
  return week.some(d => d.open) ? week : null
}
function describeHours(week) {
  return week.filter(d => d.open).map(d => `${d.day} ${to12(d.from)}-${to12(d.to)}`).join(', ')
}
function to12(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); const hr = ((h + 11) % 12) + 1; return `${hr}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}` }
async function stripeConnectUrl(biz) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
  const state = Buffer.from(JSON.stringify({ businessId: biz.id })).toString('base64')
  const url = stripe.oauth.authorizeUrl({ response_type: 'code', client_id: process.env.STRIPE_CONNECT_CLIENT_ID, scope: 'read_write', state, redirect_uri: `${BOT_URL}/stripe-connect/callback` })
  try { const { shortenUrl } = require('../utils/shortener'); return await shortenUrl(url, { businessId: biz.id }) } catch { return url }
}

// Returns a reply string when the owner's text answers a question the bot is
// waiting on; null means "not for me", and the normal owner handler runs.
// Only short, bare replies are claimed for yes/no steps, so "yes but make
// Balayage $240" still reaches the model (with the question in its context).
async function handlePendingOwnerReply(biz, text) {
  const ob = biz.onboarding || {}
  const pq = ob.pending_question
  if (!pq || !pq.kind) return null
  if (pq.at && Date.now() - new Date(pq.at).getTime() > PENDING_QUESTION_TTL_MS) { await setPending(biz, null); return null }
  const t = String(text || '').trim()
  const note = (m) => { try { require('./ownerCommands').noteOwnerOutbound(biz.id, m) } catch {} }
  const say = async (m) => { await sendSMS(biz.sms_number, biz.owner_phone, m); note(m) }

  if (pq.kind === 'import_mode') {
    const yes = YES_RE.test(t), no = NO_RE.test(t)
    if (!yes && !no) return null
    const mode = yes ? 'instant' : 'request'
    if (mode === 'request' && String(biz.plan || '').toLowerCase() === 'solo') {
      await say(`Approval mode is part of the Standard plan, so on Solo every service books instantly for now. You can upgrade any time in your dashboard under Billing.`)
    } else {
      const { error } = await supabase.from('services').update({ booking_mode: mode }).eq('business_id', biz.id)
      if (error) { console.error('[Setup] booking_mode update failed:', error.message); return null }
      await say(yes ? `Done. Everything is instant book: a client texts, picks a time, and it goes straight on your calendar. If any should need your OK first, just tell me which.`
                    : `Done. Every booking request comes to you first, and nothing is confirmed until you approve it.`)
    }
    await setPending(biz, null, { import_mode_at: new Date().toISOString(), import_mode: mode })
    await advanceSetup(biz, 'import_mode')
    return '__sent__'
  }

  if (pq.kind === 'deposits') {
    if (NO_RE.test(t)) {
      await say(`No deposits. You can add one any time, like "Balayage needs a $50 deposit".`)
      await setPending(biz, null, { deposits_at: new Date().toISOString() })
      await advanceSetup(biz, 'deposits'); return '__sent__'
    }
    const parsed = parseDeposits(t)
    if (!parsed) return null  // let the model handle it; question stays open
    const { data: services } = await supabase.from('services').select('id, name').eq('business_id', biz.id).neq('active', false)
    const svcs = services || []
    const applied = [], missed = []
    if (parsed.all) {
      await supabase.from('services').update({ deposit_amount: String(parsed.all) }).eq('business_id', biz.id)
      applied.push(`all ${svcs.length} services $${parsed.all}`)
    } else {
      for (const it of parsed.items) {
        const w = it.name.toLowerCase()
        const hits = svcs.filter(sv => sv.name.toLowerCase() === w || sv.name.toLowerCase().includes(w) || w.includes(sv.name.toLowerCase()))
        if (!hits.length) { missed.push(it.name); continue }
        await supabase.from('services').update({ deposit_amount: String(it.amount) }).in('id', hits.map(h => h.id))
        applied.push(`${hits.map(h => h.name).join(', ')} $${it.amount}`)
      }
    }
    if (!applied.length) { await say(`I couldn't match ${missed.join(', ')} to your services. Your services: ${svcs.map(sv => sv.name).join(', ')}. Try again like "Balayage $50".`); return '__sent__' }
    await say(`Deposits set: ${applied.join('; ')}.` + (missed.length ? ` I couldn't find ${missed.join(', ')}.` : ''))
    await setPending(biz, null, { deposits_at: new Date().toISOString() })
    await advanceSetup(biz, 'deposits'); return '__sent__'
  }

  if (pq.kind === 'deposit_method') {
    const url = (t.match(/https?:\/\/\S+/i) || [])[0] || (t.match(/\b(?:venmo\.com|cash\.app|paypal\.me|square\.link|squareup\.com|zelle)\S*/i) || [])[0]
    if (/^\s*stripe\s*[.!]*\s*$/i.test(t) || /\bconnect stripe\b/i.test(t)) {
      try {
        const link = await stripeConnectUrl(biz)
        await say(`Here's your Stripe link: ${link} It takes about two minutes. Once it's connected, deposits are charged by card and bookings confirm on their own. I'll text you when it's done.`)
        await setPending(biz, null, { deposit_method: 'stripe', deposit_method_at: new Date().toISOString() })
        await advanceSetup(biz, 'deposit_method'); return '__sent__'
      } catch (e) { console.error('[Setup] stripe link failed:', e.message); await say(`I couldn't make your Stripe link just now. You can connect Stripe from your dashboard under Billing, or paste a payment link here instead.`); return '__sent__' }
    }
    if (url) {
      const link = /^https?:\/\//i.test(url) ? url : 'https://' + url
      await supabase.from('businesses').update({ payment_link: link }).eq('id', biz.id)
      await say(`Saved. When a client books a service with a deposit, I'll send them ${link} and text you when they say they've paid, so you can reply "confirm <name>" to lock it in.`)
      await setPending(biz, null, { deposit_method: 'link', deposit_method_at: new Date().toISOString() })
      await advanceSetup(biz, 'deposit_method'); return '__sent__'
    }
    if (NO_RE.test(t)) { await say(`No problem. Deposits stay off until you connect Stripe or send me a payment link.`); await setPending(biz, null); await advanceSetup(biz, 'deposit_method'); return '__sent__' }
    return null
  }

  if (pq.kind === 'hours') {
    if (NO_RE.test(t)) { await say(`Okay, you can set hours any time in your dashboard or just text them to me.`); await setPending(biz, null); await advanceSetup(biz, 'hours'); return '__sent__' }
    let week = null
    try { week = await parseHours(t) } catch (e) { console.error('[Setup] hours parse failed:', e.message) }
    if (!week) return null
    await supabase.from('businesses').update({ hours: week }).eq('id', biz.id)
    await say(`Hours set: ${describeHours(week)}. Closed the other days.`)
    await setPending(biz, null, { hours_at: new Date().toISOString() })
    await advanceSetup(biz, 'hours'); return '__sent__'
  }

  if (pq.kind === 'staff') {
    if (/\b(just me|only me|solo|myself|me)\b/i.test(t) || NO_RE.test(t)) {
      await say(`Got it, just you.`)
      await setPending(biz, null, { staff_at: new Date().toISOString() })
      await advanceSetup(biz, 'staff'); return '__sent__'
    }
    const names = t.replace(/\b(and|&)\b/gi, ',').split(/[,\n]/).map(x => x.trim().replace(/[.!]+$/, '')).filter(x => x && x.length <= 40 && /^[a-z' .-]+$/i.test(x))
    if (!names.length) return null
    const existing = Array.isArray(biz.staff_members) ? biz.staff_members.filter(st => st && st.name) : []
    const have = new Set(existing.map(st => st.name.toLowerCase()))
    const added = names.filter(n => !have.has(n.toLowerCase())).map(n => ({ name: n.replace(/\b\w/g, c => c.toUpperCase()), phone: '', email: '', auto_schedule: false, notify_via: 'email' }))
    await supabase.from('businesses').update({ staff_members: [...existing, ...added] }).eq('id', biz.id)
    await say(`Added ${added.map(a => a.name).join(', ')}. Clients can ask for them by name. Add their phone or email in your dashboard under Staff if you want them notified.`)
    await setPending(biz, null, { staff_at: new Date().toISOString() })
    await advanceSetup(biz, 'staff'); return '__sent__'
  }
  return null
}

function setupSourceAck(biz) {
  return `Got it. We'll set everything up from that and text you here when it's done, usually within a few hours. ` +
    `Anything you want handled differently from what's on there, just tell me.`
}

// The owner asked for setup. Record it (admin drawer shows "Asked for setup")
// and tell Brandon right away, same channels as the new-signup alert, so a
// SETUP that never turns into a booked call still gets a human follow-up.
async function recordSetupRequest(biz) {
  try { await markStep(biz.id, biz.onboarding, 'setup_requested_at') } catch (e) { console.error('[Setup] markStep failed:', e.message) }
  const OWNER_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
  const OWNER_PHONE = process.env.OWNER_NOTIFICATION_PHONE
  const who = `${biz.owner_name || 'Owner'} at ${biz.business_name}`
  const line = `${who} replied SETUP. Cell: ${formatPhone(biz.owner_phone)} · Email: ${biz.email || '—'} · Their Wexly number: ${formatPhone(biz.sms_number)}`
  try {
    const { sendEmail } = require('../utils/emailService')
    await sendEmail({
      from: { email: 'hello@getwexly.com', name: 'Wexly' }, to: OWNER_EMAIL,
      subject: `SETUP requested — ${biz.business_name}`,
      html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:40px auto;">
        <h2 style="color:#0F0F0E;">Trial owner asked for free setup</h2>
        <p><strong>${who}</strong></p>
        <p>Cell: ${formatPhone(biz.owner_phone)}<br>Email: ${biz.email || '—'}<br>Wexly number: ${formatPhone(biz.sms_number)}</p>
        <p>They were asked for their booking-page link or a menu photo. You'll get a second alert when it arrives; if nothing comes within a day, text them.</p>
        <p><a href="${SITE_URL}/admin.html" style="display:inline-block;margin-top:12px;background:#1A6B4A;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">Open admin</a></p>
      </div>`
    })
  } catch (e) { console.error('[Setup] owner email failed:', e.message) }
  if (OWNER_PHONE && process.env.TWILIO_PHONE_NUMBER) {
    await sendSMS(process.env.TWILIO_PHONE_NUMBER, OWNER_PHONE, `🛠 ${line}`).catch(e => console.error('[Setup] owner SMS failed:', e.message))
  }
  console.log(`[Setup] ${who} requested setup`)
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
      if (!biz.profile_slug) await ensureProfileSlug(biz).catch(() => {})   // v202 backfill
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

      // Services by text, 2 hours in, only if they still have none.
      if (!ob.services_nudge_at && ageMin >= 120) {
        const { count } = await supabase.from('services').select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id).neq('active', false)
        if (!count) {
          await sendSMS(from, to,
            `No services in yet, and that's the one thing I need to start booking. Two ways, both free:\n\n` +
            `1. Text them to me like "Haircut 45 min $60, Color 2 hr $150"\n` +
            `2. Book a 20-minute setup call and we do all of it with you: ${setupCallLink()}`)
          sent++
        }
        await markStep(biz.id, ob, 'services_nudge_at'); ob.services_nudge_at = now.toISOString()
      }

      // Setup interview offer on day 2, if never started. It's seven questions;
      // day 0 is for one thing (reply "today"), not a questionnaire.
      if (!ob.interview_offered_at && ageMin >= 44 * 60 && !biz.interview_state) {
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
  lineTypeCheck, activateInstantTrial, sendTrialWelcome, ensureProfileSlug, profileUrl, runAutoImport, announceImport, handlePendingOwnerReply, advanceSetup, setupOfferReply, recordSetupRequest, recordSetupSource, setupSourceAck, expiredOwnerReply,
  runTrialOnboardingDrip, addCardLink, TRIAL_DAYS
}
