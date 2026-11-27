// Foreman website leads. Separate brand on this engine; nothing here touches
// business, customer or session data.
//
// POST /foreman/lead  { stage: 'phone' | 'details', phone, name?, business?, trade?, email?, src? }
//
// A lead is sent to the owner right away by email and text, on the same channels
// as new-signup alerts. The form posts twice: once with just the phone number
// (so a half-finished form still reaches a person) and again with the details.

const PER_IP = { max: 12, windowMs: 60 * 60 * 1000 }
const hits = new Map()

function allowed(ip) {
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || now - h.start > PER_IP.windowMs) { hits.set(ip, { start: now, n: 1 }); return true }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > PER_IP.windowMs) hits.delete(k)
  return ++h.n <= PER_IP.max
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const text = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)

function clean(body) {
  const digits = String(body?.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  if (digits.length !== 10) return null
  const email = text(body.email, 120)
  return {
    stage: body.stage === 'details' ? 'details' : 'phone',
    phone: digits,
    name: text(body.name, 80), business: text(body.business, 100), trade: text(body.trade, 40),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    src: text(body.src, 60), page: text(body.page, 40)
  }
}

const pretty = d => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`

async function handler(req, res) {
  try {
    const lead = clean(req.body)
    if (!lead) return res.status(400).json({ error: 'bad_request' })
    if (!allowed(req.ip || 'unknown')) return res.status(429).json({ error: 'slow_down' })

    const full = lead.stage === 'details'
    const headline = full ? `Foreman lead: ${lead.business || lead.name || pretty(lead.phone)}` : `Foreman lead started: ${pretty(lead.phone)}`
    const rows = [['Phone', pretty(lead.phone)], ['Name', lead.name], ['Business', lead.business], ['Trade', lead.trade], ['Email', lead.email], ['Source', lead.src], ['Page', lead.page]].filter(r => r[1])
    console.log(`[Foreman lead] ${lead.stage} ${lead.phone} ${lead.business} ${lead.trade}`)

    const OWNER_EMAIL = process.env.FOREMAN_LEAD_EMAIL || process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
    const OWNER_PHONE = process.env.FOREMAN_LEAD_PHONE || process.env.OWNER_NOTIFICATION_PHONE
    const jobs = []
    jobs.push(require('../utils/emailService').sendEmail({
      brand: 'foreman', from: { email: 'hello@foremancalls.com', name: 'Foreman leads' }, to: OWNER_EMAIL, subject: headline,
      html: `<div style="font:16px/1.5 Helvetica,Arial,sans-serif;color:#0A1640;max-width:480px;"><h2 style="margin:0 0 12px;">${esc(headline)}</h2>${full ? '' : '<p style="color:#4B587A;">They entered a phone number and have not finished the form yet.</p>'}<table cellpadding="6" style="border-collapse:collapse;">${rows.map(r => `<tr><td style="color:#4B587A;">${r[0]}</td><td><b>${esc(r[1])}</b></td></tr>`).join('')}</table><p><a href="sms:+1${lead.phone}">Text them</a> &nbsp; <a href="tel:+1${lead.phone}">Call them</a></p></div>`
    }).catch(e => console.error('[Foreman lead] email failed:', e.message)))
    // Text only on the finished form, so one lead is one text.
    if (full && OWNER_PHONE && process.env.TWILIO_PHONE_NUMBER) {
      jobs.push(require('../utils/sms').sendSMS(process.env.TWILIO_PHONE_NUMBER, OWNER_PHONE,
        `New Foreman lead\n${lead.business || '(no business name)'}${lead.trade ? ' · ' + lead.trade : ''}\n${lead.name} · ${pretty(lead.phone)}${lead.email ? '\n' + lead.email : ''}`
      ).catch(e => console.error('[Foreman lead] text failed:', e.message)))
    }
    await Promise.all(jobs)
    res.json({ ok: true })
  } catch (err) {
    console.error('[Foreman lead]', err.message)
    res.status(500).json({ error: 'unavailable' })
  }
}

module.exports = { handler, clean }
