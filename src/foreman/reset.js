// Foreman password reset.
//
// POST /foreman/reset  { email }
//
// Supabase's own reset email is Wexly-branded for every account on the project,
// so the Foreman sign-in page asks here instead. For a Foreman account we mint
// the same recovery link Supabase would have sent and deliver it from the
// Foreman domain. The answer is identical whether or not the email matches an
// account, so the endpoint can't be used to find out who has one.

const PER_IP = { max: 5, windowMs: 60 * 60 * 1000 }
const hits = new Map()
const SITE = 'https://foremancalls.com'

function allowed(ip) {
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || now - h.start > PER_IP.windowMs) { hits.set(ip, { start: now, n: 1 }); return true }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > PER_IP.windowMs) hits.delete(k)
  return ++h.n <= PER_IP.max
}

let client = null
function db() {
  if (!client) client = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  return client
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function resetHtml(link, businessName) {
  return `<div style="background:#EEF1F7;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">
    <div style="background:#1740E0;padding:22px 28px;color:#fff;font-size:20px;font-weight:800;">Foreman</div>
    <div style="padding:28px;color:#0A1640;font-size:16px;line-height:1.5;">
      <h1 style="margin:0 0 12px;font-size:22px;line-height:1.2;">Set a new password</h1>
      <p style="margin:0 0 22px;color:#4B587A;">Use the button below to choose a new password${businessName ? ' for ' + esc(businessName) : ''}. The link works once and expires in an hour.</p>
      <a href="${esc(link)}" style="display:inline-block;background:#FF6B1A;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px;">Choose a new password</a>
      <p style="margin:22px 0 0;font-size:13px;color:#4B587A;">Didn't ask for this? Ignore this email and your password stays the same.</p>
    </div>
  </div>
</div>`
}

async function handler(req, res) {
  const ip = String(req.headers['x-nf-client-connection-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()
  if (!allowed(ip)) return res.status(429).json({ error: 'Too many tries. Wait an hour and try again.' })
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 160)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter the email you sign in with.' })
  res.json({ ok: true })

  try {
    const { data: biz } = await db().from('businesses').select('business_name')
      .eq('pro_settings->>brand', 'foreman').ilike('email', email).limit(1).maybeSingle()
    if (!biz) return
    const { data, error } = await db().auth.admin.generateLink({
      type: 'recovery', email, options: { redirectTo: `${SITE}/app/update-password.html` }
    })
    const link = data?.properties?.action_link
    if (error || !link) throw new Error(error?.message || 'no link returned')
    await require('@sendgrid/mail').send({
      brand: 'foreman',
      from: { email: 'hello@foremancalls.com', name: 'Foreman' },
      to: email,
      subject: 'Set a new Foreman password',
      html: resetHtml(link, biz.business_name)
    })
    console.log('[Foreman reset] link sent')
  } catch (err) {
    console.error('[Foreman reset] failed:', err.message)
  }
}

module.exports = { handler, resetHtml }
