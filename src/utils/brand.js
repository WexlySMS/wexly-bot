// Brand boundary.
//
// One engine runs two businesses: Wexly, and Foreman (home service trades).
// A Foreman account is any business with pro_settings.brand === 'foreman'.
// Nothing a Foreman owner or their customers receive may carry the Wexly name,
// a Wexly address or a getwexly.com link.
//
// Rather than teach every send site about brands, the rule is enforced at the
// two places everything leaves through:
//   - sendSMS (utils/sms.js): any text sent FROM a Foreman line is rebranded.
//   - sgMail.send: any email TO a Foreman owner, or about a Foreman business
//     (its text line or booking page appears in the email), is rebranded and
//     sent from the Foreman domain.
// Wexly accounts are never touched: if the lookup fails or finds nothing,
// messages go out exactly as written.

const DOMAIN = 'foremancalls.com'
const SITE = `https://${DOMAIN}`
const REFRESH_MS = 5 * 60 * 1000
const REPLY_TO = process.env.FOREMAN_REPLY_TO || 'brandon@wolfestudiosca.com'

let registry = { numbers: new Set(), emails: new Set(), slugs: [], loadedAt: 0 }
let loading = null

let client = null
function db() {
  if (!client) client = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  return client
}

function digits(v) { return String(v || '').replace(/\D/g, '').slice(-10) }

async function load() {
  try {
    const supabase = db()
    const { data, error } = await supabase
      .from('businesses')
      .select('sms_number, email, profile_slug')
      .eq('pro_settings->>brand', 'foreman')
    if (error) throw error
    const next = { numbers: new Set(), emails: new Set(), slugs: [], loadedAt: Date.now() }
    for (const b of data || []) {
      if (digits(b.sms_number).length === 10) next.numbers.add(digits(b.sms_number))
      if (b.email) next.emails.add(String(b.email).trim().toLowerCase())
      if (b.profile_slug) next.slugs.push(String(b.profile_slug))
    }
    registry = next
  } catch (err) {
    // Keep the last good copy; stamp the time so a database blip isn't retried on every send.
    registry.loadedAt = Date.now()
    console.error('[Brand] Could not refresh Foreman accounts:', err.message)
  }
}

async function ready() {
  if (Date.now() - registry.loadedAt < REFRESH_MS) return
  if (!loading) loading = load().finally(() => { loading = null })
  await loading
}

function isForeman(business) { return business?.pro_settings?.brand === 'foreman' }
// Where a customer lands after paying: each brand's own site.
function siteFor(business) { return isForeman(business) ? SITE : (process.env.SITE_URL || 'https://getwexly.com') }
function isForemanNumber(number) { return registry.numbers.has(digits(number)) }

// Swap every Wexly reference for its Foreman equivalent. Order matters: links
// and addresses first, the bare name last.
function rebrand(text) {
  if (typeof text !== 'string' || !/wexly/i.test(text)) return text
  return text
    .replace(/https?:\/\/pay\.getwexly\.com/gi, SITE)
    .replace(/https?:\/\/(?:www\.)?getwexly\.com\/(?:dashboard|admin)\.html[^\s"'<)]*/gi, `${SITE}/app`)
    .replace(/https?:\/\/(?:www\.)?getwexly\.com\/login\.html[^\s"'<)]*/gi, `${SITE}/admin`)
    .replace(/https?:\/\/(?:www\.)?getwexly\.com/gi, SITE)
    .replace(/[a-z0-9._-]+@(?:mail\.)?getwexly\.com/gi, `hello@${DOMAIN}`)
    .replace(/(?:www\.)?getwexly\.com/gi, DOMAIN)
    .replace(/Wexly(?: Inc\.)?/g, 'Foreman')
    .replace(/wexly/gi, 'Foreman')
}

async function forSms(from, body) {
  try {
    await ready()
    return isForemanNumber(from) ? rebrand(body) : body
  } catch { return body }
}

function addresses(to) {
  return (Array.isArray(to) ? to : [to])
    .map(t => (typeof t === 'string' ? t : t?.email) || '')
    .map(e => e.trim().toLowerCase()).filter(Boolean)
}

function aboutForeman(msg) {
  if (msg.brand === 'foreman') return true
  if (addresses(msg.to).some(e => registry.emails.has(e))) return true
  const body = `${msg.subject || ''} ${msg.html || ''} ${msg.text || ''}`
  if (registry.slugs.some(s => body.includes(`/book/${s}`))) return true
  if (registry.numbers.size) {
    const found = body.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || []
    if (found.some(n => registry.numbers.has(digits(n)))) return true
  }
  return false
}

function foremanSender(from) {
  const name = rebrand((typeof from === 'object' && from?.name) || 'Foreman')
  const original = (typeof from === 'string' ? from : from?.email) || ''
  const local = /^(noreply|bookings|billing)@/i.test(original) ? original.split('@')[0].toLowerCase() : 'hello'
  return { email: `${local}@${DOMAIN}`, name }
}

function forEmail(msg) {
  if (!msg || typeof msg !== 'object') return msg
  const { brand, ...rest } = msg
  if (!aboutForeman(msg)) return rest
  const out = { ...rest, from: foremanSender(msg.from) }
  for (const key of ['subject', 'html', 'text']) if (out[key]) out[key] = rebrand(out[key])
  const reply = typeof out.replyTo === 'string' ? out.replyTo : out.replyTo?.email
  // hello@foremancalls.com sends but has no inbox, so replies go to the owner's
  // own address. A reply-to that already points at a customer or owner is kept.
  if (!reply || /getwexly\.com$/i.test(reply) || new RegExp('@' + DOMAIN.replace('.', '\\.') + '$', 'i').test(reply)) out.replyTo = REPLY_TO
  return out
}

// Wrap SendGrid's shared client once so every caller is covered, including
// the ones that require('@sendgrid/mail') directly.
function install() {
  const sgMail = require('@sendgrid/mail')
  if (sgMail.__brandWrapped) return
  const send = sgMail.send.bind(sgMail)
  sgMail.send = async (data, ...args) => {
    try {
      await ready()
      data = Array.isArray(data) ? data.map(forEmail) : forEmail(data)
    } catch (err) {
      console.error('[Brand] Email left as written:', err.message)
    }
    return send(data, ...args)
  }
  sgMail.__brandWrapped = true
}

module.exports = { siteFor, install, ready, rebrand, forSms, forEmail, isForeman, isForemanNumber, DOMAIN, SITE, _set: r => { registry = { loadedAt: Date.now(), slugs: [], emails: new Set(), numbers: new Set(), ...r } } }
