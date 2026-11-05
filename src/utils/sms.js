const twilio = require('twilio')
require('dotenv').config()

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

// ── 10DLC propagation hold (v199) ─────────────────────────────────────────────
// A number bought seconds ago is attached to the A2P campaign immediately, but
// Twilio takes a few minutes to propagate that registration. Sends in that
// window are accepted by the API and then bounce as error 30034 ("message from
// an unregistered number"), which is how the first trial welcome got lost.
// twilioManager marks every fresh purchase here; sendSMS holds any send from
// that number until the window has passed. In-memory on purpose: the window is
// minutes, and a restart inside it is covered by the 30034 retry below.
const PROPAGATION_MS = 3 * 60 * 1000
const provisionedAt = new Map()
function markNumberProvisioned(number) { provisionedAt.set(number, Date.now()) }

// Status-callback safety net. One retry per message SID, in memory:
//   30034 (unregistered number, 10DLC propagation) → re-send after 3 min
//   30003 (unreachable handset: phone off, carrier hiccup, a new sender the
//          carrier hasn't seen yet) → re-send after 10 min
// Only for messages under 15 minutes old so a stale callback can't replay.
const RETRY_DELAY = { '30034': PROPAGATION_MS, '30003': 10 * 60 * 1000 }
const retried = new Set()
async function retryUnregistered(messageSid) {
  if (!messageSid || retried.has(messageSid)) return
  retried.add(messageSid)
  try {
    const m = await twilioClient.messages(messageSid).fetch()
    const code = String(m.errorCode)
    const delay = RETRY_DELAY[code]
    const ageMs = Date.now() - new Date(m.dateCreated).getTime()
    if (!delay || ageMs > 15 * 60 * 1000 || !m.body) return
    console.log(`[SMS] ${code} on ${messageSid} (${m.from} → ${m.to}); re-sending in ${delay / 1000}s`)
    setTimeout(async () => {
      try {
        const again = await twilioClient.messages.create({ to: m.to, from: m.from, body: m.body })
        console.log(`[SMS] Re-sent ${m.from} → ${m.to} after ${code} | SID: ${again.sid}`)
      } catch (e) { console.error(`[SMS] ${code} re-send failed:`, e.message) }
    }, delay)
  } catch (e) {
    console.error('[SMS] retry lookup failed:', e.message)
  }
}

// Send an SMS from a Wexly number to a customer
// Usage: sendSMS(fromNumber, toNumber, messageBody)
async function sendSMS(from, to, body, mediaUrls) {
  if (!from || !to || !body) {
    console.error('[SMS] Missing required fields — from, to, or body is empty')
    return { success: false, error: 'Missing fields' }
  }
  // Guard: never attempt to text a non-phone. Imported appointments/customers
  // may have a missing or placeholder phone (e.g. calendar imports with no
  // number). A real phone has at least 10 digits; anything less (empty string,
  // 'no-phone...' placeholder, junk) is skipped here rather than sent to Twilio.
  // This is the single chokepoint every send path uses, so it protects them all.
  const digitCount = String(to).replace(/\D/g, '').length
  if (digitCount < 10) {
    console.log(`[SMS] Skipped — "${to}" is not a valid phone number (no real number on file)`)
    return { success: false, error: 'No valid phone number', skipped: true }
  }
  const readyAt = (provisionedAt.get(from) || 0) + PROPAGATION_MS
  const hold = readyAt - Date.now()
  if (hold > 0) {
    console.log(`[SMS] Holding ${from} → ${to} for ${Math.ceil(hold / 1000)}s (new number, waiting for 10DLC propagation)`)
    await new Promise(r => setTimeout(r, hold))
  }
  // v199: route every send through the 10DLC messaging service explicitly.
  // With `from` alone Twilio only applies the campaign if the number happens to
  // be in the pool; if the attach at purchase failed, the message goes out as a
  // bare long code and carriers reject it (30034, or 30003 on some carriers).
  // Passing messagingServiceSid + from makes it the request's problem: a number
  // that isn't in the pool fails synchronously (21712) and we fall back to a
  // plain send, logged loudly, instead of a silent carrier bounce.
  const serviceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null
  const base = { to, from, body }
  if (mediaUrls && mediaUrls.length) base.mediaUrl = mediaUrls.slice(0, 10) // Twilio max 10
  const attempt = async (params) => {
    const message = await twilioClient.messages.create(params)
    console.log(`[SMS] Sent ${from} → ${to}${mediaUrls?.length ? ' (+' + mediaUrls.length + ' photos)' : ''}${params.messagingServiceSid ? ' via service' : ''} | SID: ${message.sid}`)
    return { success: true, sid: message.sid }
  }
  try {
    if (serviceSid) {
      try {
        return await attempt({ ...base, messagingServiceSid: serviceSid })
      } catch (err) {
        // 21712: "from" is not in this messaging service. Say so where it will be seen, then send plain.
        if (String(err.code) === '21712') {
          console.error(`[SMS] ⚠️ ${from} is NOT in messaging service ${serviceSid}; sending as a bare long code. Add it to the sender pool.`)
          return await attempt(base)
        }
        throw err
      }
    }
    return await attempt(base)
  } catch (err) {
    console.error(`[SMS] Failed to send to ${to}:`, err.message)
    return { success: false, error: err.message }
  }
}

// Validate that an incoming Twilio webhook is genuine
function validateTwilioSignature(req) {
  if (process.env.NODE_ENV === 'development') return true

  const authToken = process.env.TWILIO_AUTH_TOKEN
  const signature = req.headers['x-twilio-signature']
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`

  return twilio.validateRequest(authToken, signature, url, req.body)
}

module.exports = { sendSMS, validateTwilioSignature, markNumberProvisioned, retryUnregistered }
