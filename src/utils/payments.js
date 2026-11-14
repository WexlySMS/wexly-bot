// Manual (non-Stripe) deposits and invoices. Owners pay three ways that are
// not a link: Zelle (a phone or email), Venmo (@handle) and Cash App ($cashtag).
// businesses.payment_link holds either a URL or "Zelle: 760-555-0142" style text;
// everything that shows it to a client goes through payInstruction().
const { toE164 } = require('./phone')

const METHOD_RE = /\b(zelle|venmo|cash ?app|apple ?pay|paypal|square)\b/i
const URL_RE = /https?:\/\/\S+|\b(?:venmo\.com|cash\.app|paypal\.me|square\.link|squareup\.com|buy\.stripe\.com)\/\S*/i
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/
const HANDLE_RE = /(?:^|\s)@([A-Za-z0-9_.-]{2,40})/
const CASHTAG_RE = /(?:^|\s)\$([A-Za-z][A-Za-z0-9_.-]{1,30})\b/

function prettyMethod(m) { const k = String(m || '').toLowerCase().replace(/\s+/g, ''); return k === 'cashapp' ? 'Cash App' : k === 'applepay' ? 'Apple Pay' : k === 'paypal' ? 'PayPal' : k.charAt(0).toUpperCase() + k.slice(1) }

// Owner text → { stored, method, detail } or null. Also { needs: 'method' } when
// we got a phone/email but cannot tell what app it is (we assume Zelle; the
// caller says so and offers a correction).
function parsePayInstruction(text) {
  const t = String(text || '').trim()
  if (!t) return null
  const url = (t.match(URL_RE) || [])[0]
  if (url) { const link = /^https?:\/\//i.test(url) ? url : 'https://' + url; return { stored: link, method: 'link', detail: link } }
  const method = (t.match(METHOD_RE) || [])[1]
  const email = (t.match(EMAIL_RE) || [])[0]
  const phone = toE164((t.match(PHONE_RE) || [])[0])
  const handle = (t.match(HANDLE_RE) || [])[1]
  const cashtag = (t.match(CASHTAG_RE) || [])[1]
  if (cashtag) return { stored: `Cash App: $${cashtag}`, method: 'Cash App', detail: `$${cashtag}` }
  if (handle) { const m = method ? prettyMethod(method) : 'Venmo'; return { stored: `${m}: @${handle}`, method: m, detail: `@${handle}` } }
  if (email || phone) {
    const m = method ? prettyMethod(method) : 'Zelle'
    const detail = email || `${phone.slice(2, 5)}-${phone.slice(5, 8)}-${phone.slice(8)}`
    return { stored: `${m}: ${detail}`, method: m, detail, assumed: !method }
  }
  return null
}

function hasPayMethod(business) { return !!String(business?.payment_link || '').trim() }

// { kind: 'link'|'handle', method, detail, text } where text reads naturally in
// a sentence: "at https://..." or "with Zelle to 760-555-0142 (Cielle Studio)".
function payInstruction(business) {
  const raw = String(business?.payment_link || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return { kind: 'link', method: 'link', detail: raw, text: `here: ${raw}` }
  const m = raw.match(/^([^:]+):\s*(.+)$/)
  const method = m ? m[1].trim() : 'Zelle', detail = m ? m[2].trim() : raw
  const who = business?.business_name ? ` (${business.business_name})` : ''
  return { kind: 'handle', method, detail, text: `with ${method} to ${detail}${who}` }
}

module.exports = { parsePayInstruction, payInstruction, hasPayMethod }
