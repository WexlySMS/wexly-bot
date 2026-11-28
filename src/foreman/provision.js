// Foreman account provisioning.
//
// POST /foreman/stripe-webhook      Stripe (Foreman account) -> checkout.session.completed
// GET  /foreman/admin/open?b&t      owner link: opens that customer's dashboard, signed in as them
// GET  /foreman/admin/live?b&t      owner link: confirm page before telling the customer they are live
// POST /foreman/admin/live?b&t      marks the account live and emails the customer their sign-in link
// GET  /foreman/start?b&t           customer link from the go-live email: choose a password
//
// Flow: payment creates the login and the business profile from what the person
// typed on the site. Nobody is given a password. The owner sets the profile up
// through the "open" link while building the website, then sends the go-live
// email, and the customer picks their own password from it.
//
// The webhook is the only thing that creates accounts, and it only acts on a
// request Stripe signed. Without FOREMAN_STRIPE_WEBHOOK_SECRET it refuses.

const crypto = require('crypto')

const SITE = 'https://foremancalls.com'
const START_LINK_DAYS = 14
const TOLERANCE_S = 300

let client = null
function db() {
  if (!client) client = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  return client
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const text = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
const ownerEmail = () => process.env.FOREMAN_LEAD_EMAIL || process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'

// ── Signed links ────────────────────────────────────────────────────────────
// Keyed off the service key so there is no extra secret to manage. A token is
// tied to one action and one business.
function token(action, id) {
  const key = crypto.createHash('sha256').update('foreman-links:' + (process.env.SUPABASE_SERVICE_KEY || '')).digest()
  return crypto.createHmac('sha256', key).update(`${action}:${id}`).digest('base64url').slice(0, 32)
}
function tokenOk(action, id, given) {
  if (!process.env.SUPABASE_SERVICE_KEY || !/^[0-9a-f-]{36}$/i.test(String(id || ''))) return false
  const want = Buffer.from(token(action, id)), got = Buffer.from(String(given || ''))
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}
const link = (path, action, id) => `${SITE}/api/foreman/${path}?b=${id}&t=${token(action, id)}`

// ── Stripe signature ────────────────────────────────────────────────────────
function verified(raw, header, secret) {
  const parts = Object.create(null)
  for (const p of String(header || '').split(',')) { const i = p.indexOf('='); if (i > 0) (parts[p.slice(0, i)] = parts[p.slice(0, i)] || []).push(p.slice(i + 1)) }
  const t = parts.t && parts.t[0]
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_S) return false
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex'))
  return parts.v1.some(sig => { const got = Buffer.from(sig); return got.length === want.length && crypto.timingSafeEqual(got, want) })
}

// ── Emails ──────────────────────────────────────────────────────────────────
function card(inner) {
  return `<div style="background:#EEF1F7;padding:28px 14px;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">
    <div style="background:#1740E0;padding:20px 26px;color:#fff;font-size:20px;font-weight:800;">Foreman</div>
    <div style="padding:26px;color:#0A1640;font-size:16px;line-height:1.55;">${inner}</div>
  </div>
</div>`
}
const button = (href, label) => `<p style="margin:22px 0 0;"><a href="${esc(href)}" style="display:inline-block;background:#FF6B1A;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px;">${esc(label)}</a></p>`
const send = msg => require('@sendgrid/mail').send({ brand: 'foreman', from: { email: 'hello@foremancalls.com', name: 'Foreman' }, ...msg })

function ownerAlert(subject, rows, extra) {
  return send({
    to: ownerEmail(), from: { email: 'hello@foremancalls.com', name: 'Foreman signups' }, subject,
    html: `<div style="font:16px/1.5 Helvetica,Arial,sans-serif;color:#0A1640;max-width:500px;"><h2 style="margin:0 0 12px;">${esc(subject)}</h2><table cellpadding="6" style="border-collapse:collapse;">${rows.filter(r => r[1]).map(r => `<tr><td style="color:#4B587A;">${r[0]}</td><td><b>${esc(r[1])}</b></td></tr>`).join('')}</table>${extra || ''}</div>`
  })
}

// ── Provisioning ────────────────────────────────────────────────────────────
const DEFAULT_HOURS = [0, 1, 2, 3, 4, 5, 6].map(d => ({ open: d >= 1 && d <= 5, from: '07:00', to: '17:00' }))

function slugFor(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'pro'
  return `${base}-${crypto.randomBytes(2).toString('hex')}`
}

async function provision(session) {
  const ref = /^fm[a-z0-9]{4,14}$/.test(String(session.client_reference_id || '')) ? session.client_reference_id : ''
  const paid = session.customer_details || {}
  let lead = null
  if (ref) lead = (await db().from('foreman_leads').select('*').eq('ref', ref).maybeSingle()).data
  const email = text(paid.email || lead?.email, 160).toLowerCase()
  if (!lead && email) lead = (await db().from('foreman_leads').select('*').ilike('email', email).order('updated_at', { ascending: false }).limit(1).maybeSingle()).data

  if (lead && !lead.paid_at) await db().from('foreman_leads').update({ paid_at: new Date().toISOString() }).eq('id', lead.id)

  const digits = String(lead?.phone || paid.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  const person = text(lead?.name || paid.name, 80)
  const business = text(lead?.business, 100) || (person ? `${person}'s business` : 'New Foreman account')
  const facts = [['Business', business], ['Name', person], ['Trade', lead?.trade], ['Phone', digits], ['Email', email], ['Checkout ref', ref]]

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await ownerAlert(`Foreman payment needs you: no email on ${business}`, facts, '<p>They paid, but there was no email to make a login with. Set this one up by hand.</p>')
    return 'no_email'
  }

  // Stripe retries deliveries. One checkout makes one account.
  const { data: already } = await db().from('businesses').select('id')
    .eq('pro_settings->>brand', 'foreman').eq('pro_settings->foreman->>checkout', session.id).limit(1).maybeSingle()
  if (already) return 'duplicate'

  let userId = null
  const created = await db().auth.admin.createUser({ email, email_confirm: true, password: crypto.randomBytes(24).toString('base64url') })
  if (created.data?.user) userId = created.data.user.id
  else {
    // The email already has a login on this project. Reuse it only if it owns nothing yet.
    const found = await db().auth.admin.generateLink({ type: 'magiclink', email })
    userId = found.data?.user?.id || null
    const owns = userId && (await db().from('businesses').select('id').eq('user_id', userId).limit(1).maybeSingle()).data
    if (!userId || owns) {
      await ownerAlert(`Foreman payment needs you: ${business}`, facts, `<p>They paid, but <b>${esc(email)}</b> already has an account here${owns ? ' with a business on it' : ''}, so nothing was created automatically. Set this one up by hand.</p>`)
      return 'needs_manual'
    }
  }

  const row = {
    user_id: userId, business_name: business, email, plan: 'standard', status: 'active', active: true,
    location_type: 'mobile', business_type: 'contractor', timezone: 'America/Los_Angeles',
    profile_slug: slugFor(business), hours: DEFAULT_HOURS,
    missed_call_enabled: true,
    pro_settings: {
      brand: 'foreman',
      trades: { arrival_window_mins: 120, emergency_alert: true, estimate_service: 'Estimate visit' },
      foreman: { checkout: session.id, ref, trade: text(lead?.trade, 40), contact: person, paid_at: new Date().toISOString(), stripe_customer: text(session.customer, 60), stripe_subscription: text(session.subscription, 60), live_at: null }
    }
  }
  if (digits.length === 10) row.owner_phone = `+1${digits}`
  if (person) row.owner_name = person
  const { data: biz, error } = await db().from('businesses').insert(row).select('id').single()
  if (error) {
    await ownerAlert(`Foreman payment needs you: ${business}`, facts, `<p>They paid and a login was made, but the profile could not be saved: ${esc(error.message)}</p>`)
    throw new Error('business insert: ' + error.message)
  }

  await Promise.all([
    ownerAlert(`New Foreman customer: ${business}`, facts, `<p>Their account exists and is waiting on you. They have not been sent a login.</p>
      ${button(link('admin/open', 'open', biz.id), 'Open their dashboard')}
      <p style="color:#4B587A;font-size:14px;">Signs this browser in as them. Set services, hours, service area and logo while you build the site.</p>
      ${button(link('admin/live', 'live', biz.id), 'It is live, send their login')}
      <p style="color:#4B587A;font-size:14px;">Asks you to confirm first. Then they get an email to choose a password.</p>`)
      .catch(e => console.error('[Foreman provision] owner email failed:', e.message)),
    send({
      to: email, subject: 'You are in. Here is what happens next',
      html: card(`<h1 style="margin:0 0 12px;font-size:22px;line-height:1.2;">Thanks${person ? ', ' + esc(person.split(' ')[0]) : ''}. We are on it.</h1>
        <p style="margin:0 0 14px;color:#4B587A;">We are building the website and setting up the text-back line for ${esc(business)} now. Most are ready within a day.</p>
        <p style="margin:0 0 8px;"><b>Reply to this email with three things and it goes faster:</b></p>
        <p style="margin:0 0 6px;">1. Your logo, if you have one.</p>
        <p style="margin:0 0 6px;">2. The services you offer and the towns you cover.</p>
        <p style="margin:0 0 14px;">3. Your website address if you already own one, and the company you bought it from. No address yet is fine, we will sort one out.</p>
        <p style="margin:0;color:#4B587A;">You will get one more email from us the moment everything is live, with a button to set your password.</p>`)
    }).catch(e => console.error('[Foreman provision] welcome email failed:', e.message))
  ])
  console.log('[Foreman provision] account created', biz.id)
  return 'created'
}

async function webhook(req, res) {
  const secret = process.env.FOREMAN_STRIPE_WEBHOOK_SECRET
  if (!secret) { console.error('[Foreman provision] FOREMAN_STRIPE_WEBHOOK_SECRET is not set'); return res.status(503).send('not configured') }
  const raw = Buffer.isBuffer(req.body) ? req.body : null
  if (!raw || !verified(raw, req.headers['stripe-signature'], secret)) return res.status(400).send('bad signature')
  let event
  try { event = JSON.parse(raw.toString('utf8')) } catch (e) { return res.status(400).send('bad body') }
  if (event.type !== 'checkout.session.completed') return res.json({ received: true })
  const session = event.data?.object || {}
  if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return res.json({ received: true })
  try {
    res.json({ received: true, result: await provision(session) })
  } catch (err) {
    console.error('[Foreman provision]', err.message)
    res.status(500).send('failed')   // Stripe retries
  }
}

// ── Owner and customer links ────────────────────────────────────────────────
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>body{margin:0;background:#EEF1F7;font:17px/1.5 Helvetica,Arial,sans-serif;color:#0A1640}main{max-width:440px;margin:12vh auto 0;background:#fff;border-radius:18px;padding:30px;box-shadow:0 10px 30px rgba(10,22,64,.08)}b.l{display:block;color:#1740E0;font-size:20px;font-weight:800;margin-bottom:18px}h1{font-size:24px;line-height:1.2;margin:0 0 10px}p{margin:0 0 16px;color:#4B587A}button,a.b{display:inline-block;border:0;background:#FF6B1A;color:#fff;font:700 17px Helvetica,Arial,sans-serif;padding:15px 28px;border-radius:999px;cursor:pointer;text-decoration:none}button:focus-visible,a.b:focus-visible{outline:3px solid #1740E0;outline-offset:3px}</style></head><body><main><b class="l">Foreman</b>${body}</main></body></html>`
}
const noStore = res => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' })

async function business(id) {
  const { data } = await db().from('businesses').select('id, business_name, email, pro_settings').eq('id', id).eq('pro_settings->>brand', 'foreman').maybeSingle()
  return data
}
const expired = res => noStore(res).status(404).send(page('Link not valid', '<h1>This link is not valid.</h1><p>It may have been mistyped or is no longer in use.</p>'))

async function open(req, res) {
  try {
    if (!tokenOk('open', req.query.b, req.query.t)) return expired(res)
    const biz = await business(req.query.b)
    if (!biz?.email) return expired(res)
    const { data, error } = await db().auth.admin.generateLink({ type: 'magiclink', email: biz.email, options: { redirectTo: `${SITE}/app/dashboard.html` } })
    if (error || !data?.properties?.action_link) throw new Error(error?.message || 'no link')
    noStore(res).redirect(302, data.properties.action_link)
  } catch (err) {
    console.error('[Foreman open]', err.message)
    noStore(res).status(500).send(page('Try again', '<h1>That did not open.</h1><p>Give it a minute and tap the link in the email again.</p>'))
  }
}

async function live(req, res) {
  try {
    if (!tokenOk('live', req.query.b, req.query.t)) return expired(res)
    const biz = await business(req.query.b)
    if (!biz?.email) return expired(res)
    const self = `/api/foreman/admin/live?b=${biz.id}&t=${token('live', biz.id)}`
    const sentAt = biz.pro_settings?.foreman?.live_at

    if (req.method !== 'POST') {
      return noStore(res).send(page('Send their login', `<h1>Tell ${esc(biz.business_name)} they are live?</h1>
        <p>This emails <b style="color:#0A1640">${esc(biz.email)}</b> a button to choose their password and open their dashboard.${sentAt ? ' It was already sent once. Sending again gives them a fresh link.' : ''}</p>
        <form method="post" action="${esc(self)}"><button type="submit">${sentAt ? 'Send it again' : 'Send their login'}</button></form>`))
    }

    const pro = { ...(biz.pro_settings || {}), foreman: { ...(biz.pro_settings?.foreman || {}), live_at: new Date().toISOString() } }
    const { error } = await db().from('businesses').update({ pro_settings: pro }).eq('id', biz.id)
    if (error) throw new Error(error.message)
    await send({
      to: biz.email, subject: `${biz.business_name} is live on Foreman`,
      html: card(`<h1 style="margin:0 0 12px;font-size:22px;line-height:1.2;">You are live.</h1>
        <p style="margin:0 0 6px;color:#4B587A;">Your website and your text-back line for ${esc(biz.business_name)} are set up and running. One step left: choose a password so you can sign in.</p>
        ${button(link('start', 'start', biz.id), 'Choose my password')}
        <p style="margin:22px 0 0;font-size:14px;color:#4B587A;">The button works for ${START_LINK_DAYS} days. After that, use "Forgot password" at foremancalls.com/admin. Sign in any time from the top of foremancalls.com.</p>`)
    })
    console.log('[Foreman live] login sent', biz.id)
    noStore(res).send(page('Sent', `<h1>Sent.</h1><p>${esc(biz.email)} has their sign-in email. They choose their own password from it.</p>`))
  } catch (err) {
    console.error('[Foreman live]', err.message)
    noStore(res).status(500).send(page('Not sent', '<h1>That did not send.</h1><p>Nothing went out. Go back and try again in a minute.</p>'))
  }
}

async function start(req, res) {
  try {
    if (!tokenOk('start', req.query.b, req.query.t)) return expired(res)
    const biz = await business(req.query.b)
    const liveAt = Date.parse(biz?.pro_settings?.foreman?.live_at || '')
    if (!biz?.email || !liveAt || Date.now() - liveAt > START_LINK_DAYS * 86400000) return noStore(res).redirect(302, `${SITE}/admin`)
    const { data, error } = await db().auth.admin.generateLink({ type: 'recovery', email: biz.email, options: { redirectTo: `${SITE}/app/update-password.html` } })
    if (error || !data?.properties?.action_link) throw new Error(error?.message || 'no link')
    noStore(res).redirect(302, data.properties.action_link)
  } catch (err) {
    console.error('[Foreman start]', err.message)
    noStore(res).redirect(302, `${SITE}/admin`)
  }
}

// One-time proof that provisioning works end to end without a card. It can only
// ever make the single fixed test account below, and every email it sends goes to
// the owner's own inbox. Remove once a real checkout has been seen.
async function selftest(req, res) {
  try {
    const owner = ownerEmail()
    const at = owner.indexOf('@')
    const email = `${owner.slice(0, at)}+foremantest${owner.slice(at)}`
    const id = 'cs_selftest_1'
    const result = await provision({ id, client_reference_id: '', customer: 'cus_selftest', subscription: 'sub_selftest', payment_status: 'paid',
      customer_details: { email, name: 'Test Plumber', phone: '+13105550142' } })
    const { data: biz } = await db().from('businesses').select('id, business_name, user_id, status, plan, missed_call_enabled, pro_settings')
      .eq('pro_settings->>brand', 'foreman').eq('pro_settings->foreman->>checkout', id).maybeSingle()
    const out = { result, account: !!biz, name: biz?.business_name, login_linked: !!biz?.user_id, status: biz?.status, missed_call_on: biz?.missed_call_enabled, live: !!biz?.pro_settings?.foreman?.live_at }
    if (biz) {
      const magic = await db().auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: `${SITE}/app/dashboard.html` } })
      const rec = await db().auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: `${SITE}/app/update-password.html` } })
      out.owner_open_link_ok = !!magic.data?.properties?.action_link && !magic.error
      out.customer_password_link_ok = !!rec.data?.properties?.action_link && !rec.error
      out.redirects_to_foreman = String(magic.data?.properties?.redirect_to || '').startsWith(SITE)
    }
    res.json(out)
  } catch (err) { res.status(500).json({ error: err.message }) }
}

module.exports = { selftest, webhook, open, live, start, provision, verified, token, tokenOk }
