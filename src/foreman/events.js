// Anonymous page events from foremancalls.com, so the funnel can be read:
// who landed, how far they scrolled, whether they reached or touched the form.
//
// POST /foreman/ev  { sid, name, page?, src?, ad? }
//
// No personal data: sid is a random per-tab id made in the browser, and only
// names on the list below are stored. Always answers 204 so the page never waits.

const NAMES = new Set(['view', 'scroll25', 'scroll50', 'scroll75', 'scroll100', 'form_seen', 'form_focus', 'phone_sent', 'details_sent', 'checkout', 'chat_shown', 'chat_open', 'cta', 'faq', 'stay30'])
const PER_IP = { max: 120, windowMs: 60 * 60 * 1000 }
const hits = new Map()
let client = null
const db = () => client || (client = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }))

function allowed(ip) {
  const now = Date.now(), h = hits.get(ip)
  if (!h || now - h.start > PER_IP.windowMs) { hits.set(ip, { start: now, n: 1 }); return true }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > PER_IP.windowMs) hits.delete(k)
  return ++h.n <= PER_IP.max
}
const slug = (v, max) => String(v == null ? '' : v).replace(/[^\w\-./]/g, '').slice(0, max)

async function handler(req, res) {
  res.status(204).end()
  try {
    let b = req.body
    if (typeof b === 'string') { try { b = JSON.parse(b) } catch (e) { return } }   // sendBeacon posts text/plain
    const sid = slug(b?.sid, 24), name = String(b?.name || '')
    if (sid.length < 8 || !NAMES.has(name) || !allowed(req.ip)) return
    const { error } = await db().from('foreman_events').insert({ sid, name, page: slug(b.page, 40) || '/', src: slug(b.src, 60) || null, ad: slug(b.ad, 60) || null })
    if (error) console.error('[Foreman events]', error.message)
  } catch (err) { console.error('[Foreman events]', err.message) }
}

module.exports = { handler, NAMES }
