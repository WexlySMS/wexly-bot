// ── URL Shortener helper ─────────────────────────────────────────────────────
// Wraps calls to our internal /shorten endpoint. The shortener lives in the
// same Express server (pay.getwexly.com == wexly-bot.onrender.com, same DNS
// origin), but the bot calls it via HTTP so the shortening logic stays in
// exactly one place.
//
// CRITICAL: This function NEVER throws. If shortening fails for any reason
// (table missing, network blip, env unset), it returns the original URL so
// the caller's payment SMS flow keeps working. Pretty URLs are nice-to-have;
// working payment links are not.

async function shortenUrl(longUrl, { appointmentId = null, businessId = null } = {}) {
  if (!longUrl) return longUrl
  try {
    const base = process.env.BOT_URL || 'https://wexly-bot.onrender.com'
    const res = await fetch(`${base}/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.ADMIN_SECRET || 'internal-bot-call'
      },
      body: JSON.stringify({ url: longUrl, appointmentId, businessId })
    })
    const data = await res.json().catch(() => ({}))
    return data?.shortUrl || longUrl
  } catch (err) {
    console.warn('[Shorten] Helper failed, falling back to long URL:', err.message)
    return longUrl
  }
}

module.exports = { shortenUrl }
