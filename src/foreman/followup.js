// Foreman lead storage and the follow-up emails for people who filled in the
// form but never finished the $1 checkout.
//
// Table: foreman_leads (one row per phone number; see the SQL in the repo notes).
//
// - store(lead)      called by the lead endpoint on every form post
// - markPaid(ref)    called when the welcome page loads after checkout
// - tick()           every 10 minutes: sends whichever follow-up is due
// - unsubscribe      GET /foreman/unsub?id=<lead id>
//
// Three emails, then it stops: 45 minutes, 1 day and 3 days after the form.
// Nothing is sent to someone who paid, unsubscribed, or gave no email.

const SITE = 'https://foremancalls.com'
const CHECKOUT = 'https://buy.stripe.com/cNi00k5T48SLerRbpnbfO01'
const ADDRESS = '22271 Bronc Ct, Canyon Lake, CA 92587'
const STEPS_AFTER_MS = [45 * 60 * 1000, 24 * 60 * 60 * 1000, 72 * 60 * 60 * 1000]
const GIVE_UP_AFTER_MS = 10 * 24 * 60 * 60 * 1000

let client = null
function db() {
  if (!client) client = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  return client
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

async function store(lead) {
  const row = { phone: lead.phone, stage: lead.stage, updated_at: new Date().toISOString() }
  // A later post never blanks out something an earlier one captured.
  for (const k of ['name', 'business', 'trade', 'email', 'src', 'page', 'ref']) if (lead[k]) row[k] = lead[k]
  const { data: existing } = await db().from('foreman_leads').select('id, stage').eq('phone', lead.phone).maybeSingle()
  if (existing) {
    if (existing.stage === 'details') row.stage = 'details'
    const { error } = await db().from('foreman_leads').update(row).eq('id', existing.id)
    if (error) throw error
  } else {
    const { error } = await db().from('foreman_leads').insert(row)
    if (error) throw error
  }
}

async function markPaid(ref) {
  if (!/^fm[a-z0-9]{4,14}$/.test(String(ref || ''))) return false
  const { data, error } = await db().from('foreman_leads')
    .update({ paid_at: new Date().toISOString() }).eq('ref', ref).is('paid_at', null).select('id')
  if (error) throw error
  return !!(data && data.length)
}

function shell(lead, inner) {
  const unsub = `${SITE}/api/foreman/unsub?id=${lead.id}`
  return `<div style="background:#EEF1F7;padding:28px 14px;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">
    <div style="background:#0A1640;padding:20px 26px;color:#fff;font-size:19px;font-weight:800;letter-spacing:.03em;border-bottom:4px solid #FF6B1A;"><img src="https://foremancalls.com/logo-email.png" width="28" height="28" alt="" style="vertical-align:middle;margin-right:10px;border-radius:6px;">FOREMAN</div>
    <div style="padding:26px;color:#0A1640;font-size:16px;line-height:1.55;">${inner}
      <p style="margin:24px 0 0;"><a href="${CHECKOUT}?client_reference_id=${esc(lead.ref || '')}" style="display:inline-block;background:#FF6B1A;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px;">Start my $1 first month</a></p>
      <p style="margin:18px 0 0;font-size:14px;color:#4B587A;">$1 today, then $249 a month after 30 days. Cancel before then and $1 is all you pay. Questions? Just reply to this email.</p>
    </div>
  </div>
  <p style="max-width:480px;margin:14px auto 0;text-align:center;font-size:11px;line-height:1.5;color:#7A86A6;">You got this because you started a Foreman setup at foremancalls.com.<br><a href="${unsub}" style="color:#7A86A6;">Unsubscribe</a> · Foreman, ${ADDRESS}</p>
</div>`
}

function emailFor(lead, step) {
  const first = esc((lead.name || '').trim().split(/\s+/)[0] || 'there')
  const biz = esc(lead.business || 'your business')
  if (step === 0) return {
    subject: `${lead.business || 'Your site'}: one step left`,
    html: shell(lead, `<h1 style="margin:0 0 12px;font-size:23px;line-height:1.2;">You were one step from done, ${first}.</h1>
      <p style="margin:0 0 12px;">We have what we need to start on ${biz}. The only thing left is the $1 that kicks off your build.</p>
      <p style="margin:0;">Once that's in, we text you a few questions and get your site and your text-back line going.</p>`)
  }
  if (step === 1) return {
    subject: 'The call you missed today',
    html: shell(lead, `<h1 style="margin:0 0 12px;font-size:23px;line-height:1.2;">Somebody called today and got voicemail.</h1>
      <p style="margin:0 0 12px;">Most people don't leave one. They call the next name on the list. If one of those a week was a $450 job, that's about $1,800 a month walking past ${biz}.</p>
      <p style="margin:0;">Foreman texts that caller back while you're still on the job and books the visit. Your first month is $1, so finding out costs you nothing.</p>`)
  }
  return {
    subject: `Should we hold your spot, ${(lead.name || '').trim().split(/\s+/)[0] || 'or let it go'}?`,
    html: shell(lead, `<h1 style="margin:0 0 12px;font-size:23px;line-height:1.2;">Last note from us.</h1>
      <p style="margin:0 0 12px;">You started setting up ${biz} a few days ago and didn't finish. If the timing's wrong, no problem, this is the last email you'll get about it.</p>
      <p style="margin:0;">If something held you up, reply and tell us what. A real person reads it.</p>`)
  }
}

async function tick() {
  const now = Date.now()
  const { data: leads, error } = await db().from('foreman_leads')
    .select('id, created_at, name, business, email, ref, followups_sent')
    .eq('stage', 'details').is('paid_at', null).is('unsubscribed_at', null)
    .not('email', 'is', null).lt('followups_sent', STEPS_AFTER_MS.length)
    .gt('created_at', new Date(now - GIVE_UP_AFTER_MS).toISOString())
    .limit(200)
  if (error) { console.error('[Foreman followup] query failed:', error.message); return }
  for (const lead of leads || []) {
    const step = lead.followups_sent || 0
    if (!lead.email || /^test\b/i.test(lead.name || '')) continue
    if (now - new Date(lead.created_at).getTime() < STEPS_AFTER_MS[step]) continue
    // Claim the step first so two server instances can't both send it.
    const { data: claimed } = await db().from('foreman_leads')
      .update({ followups_sent: step + 1, last_followup_at: new Date().toISOString() })
      .eq('id', lead.id).eq('followups_sent', step).is('paid_at', null).select('id')
    if (!claimed || !claimed.length) continue
    try {
      const mail = emailFor(lead, step)
      await require('@sendgrid/mail').send({
        brand: 'foreman', from: { email: 'hello@foremancalls.com', name: 'Foreman' }, to: lead.email,
        subject: mail.subject, html: mail.html,
        headers: { 'List-Unsubscribe': `<${SITE}/api/foreman/unsub?id=${lead.id}>` }
      })
      console.log(`[Foreman followup] step ${step + 1} sent`)
    } catch (err) {
      console.error('[Foreman followup] send failed:', err.message)
    }
  }
}

async function unsubscribe(req, res) {
  const id = String(req.query.id || '')
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    await db().from('foreman_leads').update({ unsubscribed_at: new Date().toISOString() }).eq('id', id).is('unsubscribed_at', null)
      .then(() => {}, err => console.error('[Foreman unsub]', err.message))
  }
  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribed | Foreman</title></head><body style="margin:0;font-family:system-ui,sans-serif;color:#0A1640;"><div style="background:#1740E0;color:#fff;font-weight:800;font-size:20px;padding:18px 22px;">Foreman</div><div style="max-width:520px;margin:0 auto;padding:12vh 22px;text-align:center;"><h1 style="font-size:30px;margin:0 0 10px;">You're unsubscribed.</h1><p style="color:#34416A;font-size:17px;line-height:1.6;">We won't email you again. If you change your mind, <a href="${SITE}" style="color:#1740E0;">foremancalls.com</a> is always there.</p></div></body></html>`)
}

function start() {
  setTimeout(() => tick().catch(e => console.error('[Foreman followup]', e.message)), 90 * 1000)
  setInterval(() => tick().catch(e => console.error('[Foreman followup]', e.message)), 10 * 60 * 1000)
}

module.exports = { store, markPaid, tick, unsubscribe, start, emailFor }
