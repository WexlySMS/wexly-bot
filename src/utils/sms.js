const twilio = require('twilio')
require('dotenv').config()

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

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
  try {
    var params = { to, from, body }
    if (mediaUrls && mediaUrls.length) params.mediaUrl = mediaUrls.slice(0, 10) // Twilio max 10
    const message = await twilioClient.messages.create(params)
    console.log(`[SMS] Sent ${from} → ${to}${mediaUrls?.length ? ' (+' + mediaUrls.length + ' photos)' : ''} | SID: ${message.sid}`)
    return { success: true, sid: message.sid }
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

module.exports = { sendSMS, validateTwilioSignature }
