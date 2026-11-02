require('dotenv').config()
const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const { requireAuth, requireBusinessAuth, requireInternalOrBusinessAuth, requireAdmin } = require('./src/middleware/auth')

const { createClient } = require('@supabase/supabase-js')

const webhookRouter = require('./src/routes/webhook')
const stripeRouter  = require('./src/routes/stripe')
const { startScheduler } = require('./src/bot/scheduler')
const { syncAllWebhooks, assignNumberToBusiness } = require('./src/utils/twilioManager')
const testSuiteRouter = require('./src/routes/testSuite')

// ── Global Supabase client (service key — full access, bypasses RLS) ────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ── STARTUP: Verify DB connection ──────────────────────────────────────────
async function disableRLS() {
  try {
    // Service key automatically bypasses RLS — just verify connection works
    const { error } = await supabase.from('businesses').select('id').limit(1)
    if (error) {
      console.warn('[Startup] ⚠️ DB connection issue:', error.message)
    } else {
      console.log('[Startup] ✓ Database connected and accessible')
    }
  } catch(err) {
    console.warn('[Startup] DB check failed:', err.message)
  }
}

const app = express()
const PORT = process.env.PORT || 3000

// 🔒 PROTECTED — Unified admin secret check. See PROTECTED_DECISIONS.md Entry 16.
// The codebase historically had TWO admin secrets: ADMIN_SECRET (used by the
// admin dashboard /admin/* endpoints) and WEXLY_ADMIN_KEY (used by /test/*).
// This caused repeated "403 / wrong password" confusion because the admin
// console wanted ADMIN_SECRET but people kept entering WEXLY_ADMIN_KEY.
// This helper accepts EITHER value so whichever one is set in Render and
// whichever one the operator remembers will work. Both are admin-only secrets,
// so accepting either does not weaken security.
function isValidAdminSecret(provided) {
  if (!provided) return false
  const a = process.env.ADMIN_SECRET
  const b = process.env.WEXLY_ADMIN_KEY
  return (a && provided === a) || (b && provided === b)
}

app.set('trust proxy', true)
app.use(cors())
app.use(morgan('dev'))

// !! Stripe webhooks need the RAW body for signature verification — these MUST
// come BEFORE express.json(), or the JSON parser consumes the body first and
// signature verification fails with "payload must be provided as the raw body".
// 🔒 PROTECTED — See PROTECTED_DECISIONS.md Entry 34. Both webhook paths need this.
app.use('/stripe/webhook', express.raw({ type: 'application/json' }))
app.use('/stripe-connect/webhook', express.raw({ type: 'application/json' }))

// Everything else gets JSON parsing
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// Routes
app.use('/webhook', webhookRouter)
app.use('/stripe', stripeRouter)
app.use('/test', testSuiteRouter)

const Anthropic = require('@anthropic-ai/sdk')

// ── Demo bot proxy — routes homepage demo through server to avoid CORS ────────
// ── Debug services — check what's actually in the database ──────────────────
app.post('/tester/debug-services', async (req, res) => {
  const { businessId } = req.body
  if (!businessId) return res.status(400).json({ error: 'Need businessId' })
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: services, error } = await sb.from('services').select('*').eq('business_id', businessId)
    if (error) return res.json({ error: error.message })
    
    // Also check what columns exist
    const columns = services?.[0] ? Object.keys(services[0]) : []
    
    res.json({
      service_count: (services || []).length,
      columns_present: columns,
      has_booking_mode_column: columns.includes('booking_mode'),
      has_active_column: columns.includes('active'),
      services: (services || []).map(s => ({
        name: s.name,
        booking_mode: s.booking_mode,
        active: s.active,
        duration_mins: s.duration_mins,
        price: s.price
      }))
    })
  } catch(err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Debug availability — see exactly what the bot sees ──────────────────────
app.post('/tester/debug-availability', async (req, res) => {
  const { businessId, date } = req.body
  if (!businessId || !date) return res.status(400).json({ error: 'Need businessId and date' })

  try {
    const { getAvailableSlots } = require('./src/utils/dateHelpers')
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: business } = await sb.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (!business) return res.status(404).json({ error: 'Business not found' })

    const { data: appts } = await sb.from('appointments').select('*').eq('business_id', businessId).eq('appointment_date', date).neq('status', 'cancelled')
    const { data: blocked } = await sb.from('blocked_dates').select('*').eq('business_id', businessId)
    const { data: services } = await sb.from('services').select('*').eq('business_id', businessId)

    const hours = business.hours || []
    const staff = business.staff_members || []
    const maxDaily = business.max_daily || 10

    const slots = getAvailableSlots(business, date, appts || [], 45, blocked || [], 1, null)

    res.json({
      date,
      hours_format: hours.length > 0 ? (hours[0]?.day ? 'named' : 'indexed') : 'empty',
      hours_raw: hours,
      staff_count: staff.length,
      staff_names: staff.map(s => s.name),
      existing_appointments: (appts || []).length,
      max_daily: maxDaily,
      blocked_on_date: (blocked || []).filter(b => b.blocked_date === date),
      available_slots: slots,
      services: (services || []).map(s => s.name + ' (' + s.duration_mins + 'min)')
    })
  } catch(err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Test chat — full conversation engine without SMS ────────────────────────
app.post('/tester/chat', async (req, res) => {
  const { businessId, message, testPhone } = req.body
  if (!businessId || !message) return res.status(400).json({ error: 'Missing businessId or message' })

  try {
    const { handleIncomingMessage } = require('./src/bot/conversationEngine')
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: business } = await sb.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (!business) return res.status(404).json({ error: 'Business not found' })

    const customerPhone = testPhone || '+10000000000'

    const reply = await handleIncomingMessage({
      business,
      customerPhone,
      incomingText: message,
      mediaUrls: []
    })

    res.json({ reply: reply || '(no reply — bot silent)' })
  } catch (err) {
    console.error('[Test] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Test owner commands — full owner engine without SMS ─────────────────────
app.post('/tester/owner', async (req, res) => {
  const { businessId, message } = req.body
  if (!businessId || !message) return res.status(400).json({ error: 'Missing businessId or message' })

  try {
    const { handleOwnerMessage, getOwnerWelcome } = require('./src/bot/ownerCommands')
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: business } = await sb.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (!business) return res.status(404).json({ error: 'Business not found' })

    const lowerText = message.toLowerCase().trim()
    var reply
    if (['hi', 'hey', 'hello', 'help', '?'].includes(lowerText)) {
      reply = getOwnerWelcome(business)
    } else {
      reply = await handleOwnerMessage(business, message)
    }

    res.json({ reply: reply || '(no reply)' })
  } catch (err) {
    console.error('[Test Owner] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/demo/chat', async (req, res) => {
  const { systemPrompt, messages } = req.body
  if (!systemPrompt || !messages) return res.status(400).json({ error: 'Missing fields' })
  if (messages.length > 20) return res.status(400).json({ error: 'Too many messages' })

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system: systemPrompt,
      messages: messages.slice(-8) // last 8 only
    })
    res.json({ reply: response.content[0].text })
  } catch (err) {
    console.error('[Demo] API error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

const { startSetupInterview } = require('./src/bot/setupInterview')

// Admin — manually trigger setup interview for a business
app.post('/admin/start-interview', requireAuth, async (req, res) => {
  const { businessId, secret } = req.body
  if (!isValidAdminSecret(secret)) return res.status(403).json({ error: 'Forbidden' })
  try {
    const { data: business } = await require('@supabase/supabase-js')
      .createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      .from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (!business) return res.status(404).json({ error: 'Business not found' })
    await startSetupInterview(business)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Health check
// ── Media proxy — fetch Twilio media with auth ──────────────────────────────
app.get('/media-proxy', async (req, res) => {
  var url = req.query.url
  if (!url || !url.includes('twilio.com')) return res.status(400).send('Invalid URL')
  try {
    var response = await fetch(url, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64')
      }
    })
    if (!response.ok) return res.status(response.status).send('Failed')
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg')
    res.set('Cache-Control', 'public, max-age=86400')
    var buffer = Buffer.from(await response.arrayBuffer())
    res.send(buffer)
  } catch(err) {
    res.status(500).send('Proxy error')
  }
})

app.get('/', (req, res) => res.json({ status: 'ok', service: 'wexly-bot' }))
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' })
})

// ── URL Shortener ───────────────────────────────────────────────────────────
// Lives at pay.getwexly.com (same Render service, just different DNS). Used by
// the bot to shorten deposit/checkout links before sending them via SMS — saves
// SMS segments and looks more trustworthy than raw Stripe URLs.
//
// Schema: short_links(slug text PK, url text, appointment_id uuid, business_id
// uuid, created_at timestamptz). Migration shipped separately.

// Generate a random URL-safe slug. 6 chars of [A-Za-z0-9] = ~57 billion combos,
// effectively zero collision risk for our volume.
function generateSlug(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

// Internal endpoint — called by the bot to create a short link.
// Body: { url, appointmentId?, businessId? }
// Returns: { slug, shortUrl }
app.post('/shorten', requireInternalOrBusinessAuth, async (req, res) => {
  const { url, appointmentId, businessId } = req.body
  if (!url) return res.status(400).json({ error: 'Missing url' })

  try {
    // Try a few times in case of slug collision (statistically improbable but safe)
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = generateSlug(6)
      const { error } = await supabase.from('short_links').insert({
        slug,
        url,
        appointment_id: appointmentId || null,
        business_id: businessId || null
      })
      if (!error) {
        const base = process.env.SHORT_LINK_BASE || 'https://pay.getwexly.com'
        return res.json({ slug, shortUrl: `${base}/s/${slug}` })
      }
      // Postgres unique_violation = 23505 → collision, retry. Anything else is fatal.
      if (error.code !== '23505') {
        console.error('[Shorten] DB error:', error.message)
        return res.status(500).json({ error: error.message })
      }
    }
    return res.status(500).json({ error: 'Could not generate unique slug after 5 attempts' })
  } catch (err) {
    console.error('[Shorten] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Public redirect — anyone hitting pay.getwexly.com/s/SLUG gets 302'd to the
// real Stripe (or other) URL stored in the short_links row.
app.get('/s/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('short_links')
      .select('url')
      .eq('slug', req.params.slug)
      .maybeSingle()
    if (error || !data?.url) {
      return res.status(404).send('Link not found or expired.')
    }
    return res.redirect(302, data.url)
  } catch (err) {
    console.error('[Shorten] Redirect error:', err.message)
    res.status(500).send('Server error')
  }
})

// ── Email funnel tracking ───────────────────────────────────────────────────
// Cold emails link DIRECTLY to getwexly.com with clean UTM params, e.g.
//   https://getwexly.com/?utm_source=email&utm_campaign=batch1&utm_content=prospectID
// The landing page (index.html) already captures those and pings /t/view below
// so we record the visit. No redirect/tracker URL — the visible link is just
// the real domain. Signup attribution (signup_campaign/content) fires as before.
function hashIp(req) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()
    if (!ip) return null
    return require('crypto').createHash('sha256').update(ip).digest('hex').slice(0, 16)
  } catch { return null }
}

// Landing page pings this on load when the visit came from an email campaign,
// so the admin funnel can count landing-page visits per campaign.
app.get('/t/view', async (req, res) => {
  const campaign = (req.query.c || '').toString().slice(0, 120) || null
  const prospect = (req.query.p || '').toString().slice(0, 120) || null
  const source = (req.query.s || '').toString().slice(0, 60) || null
  supabase.from('email_events').insert({
    event_type: 'view', campaign, prospect, source,
    user_agent: (req.headers['user-agent'] || '').slice(0, 300), ip_hash: hashIp(req)
  }).then(({ error }) => { if (error) console.error('[Track] view insert:', error.message) })
   .catch(e => console.error('[Track] view error:', e.message))
  res.set('Access-Control-Allow-Origin', '*')
  res.json({ ok: true })
})

// Admin: email funnel report — visits → signups → paid, per campaign.
app.get('/admin/email-funnel', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: events } = await sb.from('email_events').select('event_type, campaign, prospect, source, ip_hash')
    const { data: businesses } = await sb.from('businesses')
      .select('signup_campaign, signup_source, status')

    // Bucket by channel: prefer campaign label, else the source (email / meta_lp).
    const TRACKED = new Set(['email', 'meta_lp', 'meta', 'facebook', 'instagram', 'ig_post'])
    const byCampaign = {}
    const ensure = (label) => {
      const cc = label || '(none)'
      byCampaign[cc] = byCampaign[cc] || { campaign: cc, visits: 0, signups: 0, paid: 0, _pros: new Set() }
      return byCampaign[cc]
    }
    // Normalize any source value to a clean channel label. Meta sends numeric
    // campaign IDs and assorted source strings; collapse them to 'meta_lp'.
    const channelOf = (source, campaign) => {
      const s = (source || '').toLowerCase()
      if (s === 'email') return 'email'
      // Boosted/promoted IG POST — a tag only Brandon's own link produces
      // (?src=ig_post). Kept separate from paid Meta ads so the two can be
      // compared head to head. Accepts a few natural variants.
      if (['ig_post', 'igpost', 'ig_promo', 'ig_boost', 'boosted_post'].includes(s)) return 'ig_post'
      // Generic instagram tag — this is what META auto-appends for Instagram-
      // PLACEMENT clicks on paid ads. Distinct from the boosted-post link above.
      if (['instagram', 'ig'].includes(s)) return 'instagram'
      if (['meta_lp', 'meta', 'facebook', 'fb'].includes(s)) return 'meta_lp'
      if (s) return s            // some other explicit, non-numeric source
      // No source: only fall back to a campaign if it's not a numeric id
      if (campaign && !/^\d+$/.test(campaign)) return campaign
      return null
    }
    for (const e of (events || [])) {
      if (e.event_type !== 'view') continue
      const label = channelOf(e.source, e.campaign)
      if (!label) continue
      const r = ensure(label); r.visits++; const k = e.prospect || e.ip_hash; if (k) r._pros.add(k)
    }
    for (const b of (businesses || [])) {
      // Bucket signups by clean channel (source), not the raw numeric campaign.
      const label = channelOf(b.signup_source, b.signup_campaign)
      if (!label || !TRACKED.has(label)) continue
      const r = ensure(label)
      r.signups++
      if (b.status === 'active') r.paid++
    }
    const rows = Object.values(byCampaign)
      .filter(r => r.campaign !== '(none)')  // never show the no-campaign bucket
      .map(r => {
        const uniqueVisitors = r._pros.size || r.visits
        delete r._pros
        return {
          ...r, unique_visitors: uniqueVisitors,
          visit_to_signup_pct: r.visits ? +(r.signups / r.visits * 100).toFixed(1) : 0,
          signup_to_paid_pct: r.signups ? +(r.paid / r.signups * 100).toFixed(1) : 0
        }
      }).sort((a, b) => b.visits - a.visits)
    res.json({ campaigns: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})


// ── Native app: push notification device tokens ─────────────────────────────
// Called by native-bridge.js inside the iOS/Android app after login. JWT-auth'd
// and business-scoped (requireBusinessAuth) so a user can only register
// devices for a business they own. Upsert on token so re-registering is safe.
app.post('/push/register', requireBusinessAuth, async (req, res) => {
  const { businessId, token, platform } = req.body
  if (!businessId || !token || !['ios', 'android'].includes(platform)) return res.status(400).json({ error: 'Missing fields' })
  try {
    const { error } = await supabase.from('push_tokens').upsert({
      business_id: businessId, user_id: req.userId, token, platform, last_seen_at: new Date().toISOString()
    }, { onConflict: 'token' })
    if (error) return res.status(500).json({ error: error.message })
    console.log(`[Push] registered ${platform} device for business ${businessId}`)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/push/unregister', requireBusinessAuth, async (req, res) => {
  const { businessId, token } = req.body
  if (!businessId || !token) return res.status(400).json({ error: 'Missing fields' })
  try {
    await supabase.from('push_tokens').delete().eq('business_id', businessId).eq('token', token)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Admin: send a test push to a business's devices (verifies the whole chain).
app.post('/admin/push-test', requireAuth, async (req, res) => {
  const { businessId, secret } = req.body
  if (!isValidAdminSecret(secret)) return res.status(403).json({ error: 'Forbidden' })
  try {
    const push = require('./src/utils/push')
    if (!push.isEnabled()) return res.json({ sent: 0, configured: false, error: 'Push is not configured on the server (APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY)' })
    const r = await push.pushToBusiness(businessId, { title: '✅ Wexly push works', body: 'Notifications are set up on this device.', data: { page: 'overview', type: 'test' } })
    r.apns = push.apnsDiagnostics()
    console.log('[Push] test →', businessId, JSON.stringify(r))
    res.json(r)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Account deletion (App Store guideline 5.1.1(v) requires an in-app path) ──
// Owner-initiated, JWT-auth'd, must own the business. Irreversible. Order:
//   1. cancel the Stripe subscription immediately (no further charges)
//   2. release the Twilio number (stops the ~$1.15/mo and all inbound texts)
//   3. delete child rows table-by-table (works whether or not FKs cascade)
//   4. delete the business row
//   5. delete the Supabase auth user (signs them out everywhere)
// Each step logs and continues so a partial failure never leaves a half-deleted
// account billing them: Stripe and Twilio go first on purpose.
app.post('/account/delete', requireBusinessAuth, async (req, res) => {
  const { businessId, confirm } = req.body
  if (!businessId || confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' })
  const log = (m) => console.log(`[AccountDelete ${businessId}] ${m}`)
  try {
    const { data: biz } = await supabase.from('businesses')
      .select('id, user_id, business_name, email, stripe_subscription_id, stripe_customer_id, sms_number')
      .eq('id', businessId).maybeSingle()
    if (!biz) return res.status(404).json({ error: 'Business not found' })
    if (biz.user_id !== req.userId) return res.status(403).json({ error: 'Not your business' })

    // 1. Stripe
    if (biz.stripe_subscription_id) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
        await stripe.subscriptions.cancel(biz.stripe_subscription_id, { prorate: false })
        log('stripe subscription cancelled')
      } catch (e) { log('stripe cancel failed (continuing): ' + e.message) }
    }
    // 2. Twilio
    try { const { releaseNumberFromBusiness } = require('./src/utils/twilioManager'); await releaseNumberFromBusiness(businessId); log('number released') }
    catch (e) { log('number release failed (continuing): ' + e.message) }

    // 3. Child tables (any that don't exist or don't have business_id just error quietly)
    const CHILD_TABLES = ['push_tokens','pending_tip_invoices','transactions','appointments','conversation_sessions','customers',
      'blocked_dates','services','service_bundles','products','promotions','faqs','followup_sequences','waitlist',
      'intake_responses','intake_form_questions','intake_form_services','intake_forms','qualification_questions',
      'sms_group_broadcasts','sms_group_members','sms_groups','sms_campaigns','email_campaigns','digest_log',
      'short_links','setup_calls','referral_credits','referral_payouts','compliance_violations']
    for (const t of CHILD_TABLES) {
      const { error } = await supabase.from(t).delete().eq('business_id', businessId)
      if (error && !/does not exist|column .* does not exist/i.test(error.message)) log(`delete ${t}: ${error.message}`)
    }
    // 4. Business
    const { error: bizErr } = await supabase.from('businesses').delete().eq('id', businessId)
    if (bizErr) { log('business delete failed: ' + bizErr.message); return res.status(500).json({ error: 'Could not delete business: ' + bizErr.message }) }
    // 5. Auth user (only if they have no other business)
    const { data: others } = await supabase.from('businesses').select('id').eq('user_id', req.userId).limit(1)
    if (!others?.length) {
      try { await supabase.auth.admin.deleteUser(req.userId); log('auth user deleted') }
      catch (e) { log('auth user delete failed: ' + e.message) }
    }
    log(`DONE — ${biz.business_name} (${biz.email})`)
    res.json({ success: true })
  } catch (err) {
    console.error('[AccountDelete] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Public endpoint used by signup.html for live feedback as the user types.
// Returns minimal info: { valid: true, business_name } if the code maps to an
// active business, or { valid: false } otherwise. Referral codes aren't
// sensitive — they're meant to be shared — so no auth needed.
app.get('/referral/validate', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim().toUpperCase()
    if (!code || code.length < 4) return res.json({ valid: false })
    const { data: biz } = await supabase.from('businesses')
      .select('business_name, status')
      .eq('referral_code', code)
      .maybeSingle()
    if (!biz || biz.status === 'cancelled') return res.json({ valid: false })
    return res.json({ valid: true, business_name: biz.business_name })
  } catch (err) {
    console.error('[Referral] Validate error:', err.message)
    res.json({ valid: false }) // never 500 — fail closed silently
  }
})

// Admin — toggle manual mode for a conversation
app.post('/admin/manual-mode', requireAuth, async (req, res) => {
  const { businessId, customerPhone, enabled, secret } = req.body
  if (!isValidAdminSecret(secret)) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    await sb.from('conversation_sessions').upsert({
      business_id: businessId,
      customer_phone: customerPhone,
      manual_mode: enabled,
      manual_mode_until: null
    }, { onConflict: 'business_id,customer_phone' })
    res.json({ success: true, manual_mode: enabled })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Admin — send a manual SMS from a business number
app.post('/admin/send-sms', requireAuth, async (req, res) => {
  const { businessId, toPhone, message, secret, systemMessage, skipManualMode } = req.body
  if (!isValidAdminSecret(secret)) return res.status(403).json({ error: 'Forbidden' })
  const skipFlip = systemMessage === true || skipManualMode === true
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: business } = await sb.from('businesses').select('sms_number').eq('id', businessId).maybeSingle()
    if (!business?.sms_number) return res.status(400).json({ error: 'No SMS number assigned' })
    const { sendSMS } = require('./src/utils/sms')
    await sendSMS(business.sms_number, toPhone, message)

    // Persist the manually-sent message into the conversation so it survives
    // reloads/realtime refreshes (otherwise it shows locally then vanishes when
    // the thread re-renders from the DB). Read-modify-write the messages array.
    try {
      const { data: sess } = await sb.from('conversation_sessions')
        .select('messages').eq('business_id', businessId).eq('customer_phone', toPhone).maybeSingle()
      const existingMsgs = Array.isArray(sess?.messages) ? sess.messages : []
      existingMsgs.push({ role: 'assistant', content: message, manual: true, timestamp: new Date().toISOString() })
      const upsertRow = {
        business_id: businessId,
        customer_phone: toPhone,
        messages: existingMsgs,
        last_activity: new Date().toISOString()
      }
      // 🔒 PROTECTED — See PROTECTED_DECISIONS.md Entry 32/35. Only flip manual_mode
      // for a GENUINE owner takeover. Automated sends pass skipManualMode:true.
      if (!skipFlip) {
        upsertRow.manual_mode = true
        upsertRow.manual_mode_until = null
      }
      await sb.from('conversation_sessions').upsert(upsertRow, { onConflict: 'business_id,customer_phone' })
      if (skipFlip) console.log(`[admin/send-sms] system send to ${toPhone} — manual_mode NOT flipped`)
    } catch (persistErr) {
      console.error('[admin/send-sms] failed to persist message:', persistErr.message)
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// Admin — test owner notification
app.post('/admin/test-notify', async (req, res) => {
  const { secret } = req.body
  if (!isValidAdminSecret(secret)) return res.status(403).json({ error: 'Forbidden' })
  try {
    const { sendOwnerNewSignupNotification } = require('./src/utils/emailService')
    const { sendSMS } = require('./src/utils/sms')
    const emailDest = process.env.OWNER_NOTIFICATION_EMAIL
    const smsDest = process.env.OWNER_NOTIFICATION_PHONE
    const adminSecret = process.env.ADMIN_SECRET

    console.log(`[Test] ADMIN_SECRET=${adminSecret}, EMAIL=${emailDest}, PHONE=${smsDest}`)

    const testBiz = { business_name: 'Test Business', owner_name: 'Test Owner', email: 'test@test.com', business_type: 'salon' }
    if (emailDest) {
      await sendOwnerNewSignupNotification(testBiz)
      console.log(`[Test] Email sent to ${emailDest}`)
    }
    if (smsDest) {
      await sendSMS(process.env.TWILIO_PHONE_NUMBER, smsDest, `Test notification from Wexly — working!`)
      console.log(`[Test] SMS sent to ${smsDest}`)
    }
    res.json({
      success: true,
      admin_secret_set: !!adminSecret,
      email: emailDest || 'NOT SET',
      phone: smsDest || 'NOT SET',
      twilio_number: process.env.TWILIO_PHONE_NUMBER || 'NOT SET'
    })
  } catch (err) {
    console.error('[Test] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /admin/assign-number { businessId, areaCode }
app.post('/admin/assign-number', async (req, res) => {
  const { businessId, areaCode, secret } = req.body
  if (!isValidAdminSecret(secret)) return res.status(403).json({ error: 'Forbidden' })
  try {
    const number = await assignNumberToBusiness(businessId, areaCode)
    res.json({ success: true, number })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Admin — sync all Twilio webhooks to current bot URL
app.post('/admin/sync-webhooks', async (req, res) => {
  const { secret } = req.body
  if (!isValidAdminSecret(secret)) return res.status(403).json({ error: 'Forbidden' })
  await syncAllWebhooks()
  res.json({ success: true })
})

// ── Admin: Twilio number audit — reconcile owned numbers vs businesses ──────
// Categorizes every Twilio number you're paying for so stale/orphan numbers
// can't pile up silently as people sign up and cancel.
app.get('/admin/number-audit', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

    // All numbers Twilio bills you for
    const twilioNumbers = await twilio.incomingPhoneNumbers.list({ limit: 1000 })
    // All businesses + their assigned number
    const { data: businesses } = await sb.from('businesses')
      .select('id, business_name, status, active, sms_number')

    const norm = (n) => (n || '').replace(/\D/g, '').replace(/^1/, '')
    const bizByNumber = {}
    for (const b of (businesses || [])) {
      if (b.sms_number) bizByNumber[norm(b.sms_number)] = b
    }

    const active = []      // Twilio number → live (non-cancelled) business
    const orphan = []      // Twilio owns it, but no active business uses it (COSTING $)
    const assignedButInactive = [] // attached to a cancelled/paused business

    for (const num of twilioNumbers) {
      const biz = bizByNumber[norm(num.phoneNumber)]
      const row = { phoneNumber: num.phoneNumber, sid: num.sid, friendlyName: num.friendlyName }
      if (!biz) {
        orphan.push(row)
      } else if (biz.status === 'cancelled' || biz.active === false) {
        assignedButInactive.push({ ...row, business_name: biz.business_name, business_id: biz.id, status: biz.status })
      } else {
        active.push({ ...row, business_name: biz.business_name, business_id: biz.id, status: biz.status })
      }
    }

    // Businesses that THINK they have a number Twilio doesn't actually own
    const twilioSet = new Set(twilioNumbers.map(n => norm(n.phoneNumber)))
    const missing = (businesses || [])
      .filter(b => b.sms_number && !twilioSet.has(norm(b.sms_number)))
      .map(b => ({ business_id: b.id, business_name: b.business_name, sms_number: b.sms_number, status: b.status }))

    res.json({
      summary: {
        total_twilio_numbers: twilioNumbers.length,
        active: active.length,
        orphan_costing_money: orphan.length,
        assigned_to_cancelled: assignedButInactive.length,
        missing_from_twilio: missing.length,
        estimated_monthly_waste_usd: (orphan.length + assignedButInactive.length) * 1.15
      },
      orphan,                 // release these — nobody's using them
      assignedButInactive,    // cancelled businesses still holding a number
      missing,                // data mismatch — investigate
      active
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: release a specific number (cleanup orphans found by the audit) ───
app.post('/admin/release-number', async (req, res) => {
  if (!isValidAdminSecret(req.body?.secret)) return res.status(403).json({ error: 'Forbidden' })
  const { sid, phoneNumber } = req.body
  if (!sid && !phoneNumber) return res.status(400).json({ error: 'Provide sid or phoneNumber' })
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    let targetSid = sid
    if (!targetSid && phoneNumber) {
      const found = await twilio.incomingPhoneNumbers.list({ phoneNumber, limit: 1 })
      if (!found.length) return res.status(404).json({ error: 'Number not found in Twilio' })
      targetSid = found[0].sid
    }
    await twilio.incomingPhoneNumbers(targetSid).remove()
    // Also clear it off any business row that still references it
    if (phoneNumber) {
      const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      await sb.from('businesses').update({ sms_number: null }).eq('sms_number', phoneNumber)
    }
    console.log(`[Twilio] Manually released ${phoneNumber || targetSid} via admin audit`)
    res.json({ success: true, released: phoneNumber || targetSid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: release ALL orphan numbers (not tied to an active business) ──────
// Pass { secret, dryRun:false } to actually release. Default is a dry run that
// only reports. Only touches numbers whose friendlyName starts with "Wexly".
app.post('/admin/release-all-orphans', async (req, res) => {
  if (!isValidAdminSecret(req.body?.secret)) return res.status(403).json({ error: 'Forbidden' })
  const dryRun = req.body?.dryRun !== false // must explicitly pass false to release
  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

    const twilioNumbers = await twilio.incomingPhoneNumbers.list({ limit: 1000 })
    const { data: businesses } = await sb.from('businesses')
      .select('sms_number, status, active')

    const norm = (n) => (n || '').replace(/\D/g, '').replace(/^1/, '')
    // Numbers belonging to LIVE businesses — never release these.
    const inUse = new Set(
      (businesses || [])
        .filter(b => b.sms_number && b.status !== 'cancelled' && b.active !== false)
        .map(b => norm(b.sms_number))
    )

    const toRelease = twilioNumbers.filter(num =>
      (num.friendlyName || '').startsWith('Wexly') && !inUse.has(norm(num.phoneNumber))
    )

    if (dryRun) {
      return res.json({
        dryRun: true,
        message: 'Nothing released. Pass dryRun:false to actually release these.',
        would_release_count: toRelease.length,
        would_release: toRelease.map(n => ({ phoneNumber: n.phoneNumber, sid: n.sid, friendlyName: n.friendlyName }))
      })
    }

    const released = []
    const failed = []
    for (const num of toRelease) {
      try {
        await twilio.incomingPhoneNumbers(num.sid).remove()
        await sb.from('businesses').update({ sms_number: null }).eq('sms_number', num.phoneNumber)
        released.push(num.phoneNumber)
        console.log(`[Twilio] Released orphan ${num.phoneNumber}`)
      } catch (e) {
        failed.push({ phoneNumber: num.phoneNumber, error: e.message })
        console.error(`[Twilio] Failed to release ${num.phoneNumber}: ${e.message}`)
      }
    }
    res.json({ dryRun: false, released_count: released.length, released, failed })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: get all subscribers ─────────────────────────────────────────────────
app.get('/admin/subscribers', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data } = await sb.from('businesses')
      .select('id, business_name, owner_name, email, plan, status, trial_ends_at, sms_number, business_type, created_at, active')
      .order('created_at', { ascending: false })
    res.json({ subscribers: data || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: get stats ───────────────────────────────────────────────────────────
app.get('/admin/stats', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: businesses } = await sb.from('businesses').select('status, plan, created_at')
    const { data: appts } = await sb.from('appointments').select('id, created_at, status')

    const now = new Date()
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000)

    const active = businesses?.filter(b => b.status === 'active') || []
    const trial = businesses?.filter(b => b.status === 'trial') || []
    const cancelled = businesses?.filter(b => b.status === 'cancelled') || []
    const pro = businesses?.filter(b => b.plan === 'pro' && b.status !== 'cancelled') || []
    const standard = businesses?.filter(b => b.plan !== 'pro' && b.status !== 'cancelled') || []
    const newThisMonth = businesses?.filter(b => new Date(b.created_at) > thirtyDaysAgo) || []
    const totalAppts = appts?.length || 0
    const apptThisMonth = appts?.filter(a => new Date(a.created_at) > thirtyDaysAgo).length || 0

    const mrr = (active.filter(b => b.plan === 'pro').length * 199) +
                (active.filter(b => b.plan !== 'pro').length * 149)

    res.json({
      total: businesses?.length || 0,
      active: active.length,
      trial: trial.length,
      cancelled: cancelled.length,
      pro: pro.length,
      standard: standard.length,
      newThisMonth: newThisMonth.length,
      mrr: Math.round(mrr),
      totalAppts,
      apptThisMonth
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: send announcement email to all subscribers ─────────────────────────
app.post('/admin/announce', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { subject, message, filter } = req.body
  if (!subject || !message) return res.status(400).json({ error: 'Missing subject or message' })

  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const sgMail = require('@sendgrid/mail')
    sgMail.setApiKey(process.env.SENDGRID_API_KEY)

    let query = sb.from('businesses').select('email, owner_name, business_name, plan, status')
    if (filter === 'active') query = query.eq('status', 'active')
    else if (filter === 'trial') query = query.eq('status', 'trial')
    else if (filter === 'pro') query = query.eq('plan', 'pro')
    else query = query.in('status', ['active', 'trial']) // default: all active

    const { data: businesses } = await query
    if (!businesses?.length) return res.json({ sent: 0 })

    let sent = 0
    for (const biz of businesses) {
      const firstName = biz.owner_name?.split(' ')[0] || 'there'
      const personalizedMessage = message
        .replace(/\{name\}/g, firstName)
        .replace(/\{business\}/g, biz.business_name)

      await sgMail.send({
        from: 'Wexly <hello@getwexly.com>',
        to: biz.email,
        subject,
        html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
    <div style="background:#0F0F0E;padding:24px 32px;">
      <div style="font-family:Georgia,serif;font-size:22px;color:#FAF9F6;letter-spacing:-0.5px;">Wex<em style="color:#4ade80;">ly</em></div>
    </div>
    <div style="padding:40px;">
      <div style="font-size:16px;color:#3A3A36;line-height:1.8;white-space:pre-wrap;">${personalizedMessage}</div>
      <div style="margin-top:32px;text-align:center;">
        <a href="https://getwexly.com/dashboard.html" style="display:inline-block;background:#1A6B4A;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">Go to dashboard →</a>
      </div>
    </div>
    <div style="padding:16px 32px;background:#F3F2EE;text-align:center;">
      <p style="font-size:12px;color:#B8B6AD;margin:0;">You're receiving this because you're a Wexly subscriber · <a href="https://getwexly.com" style="color:#B8B6AD;">getwexly.com</a></p>
    </div>
  </div>
</body>
</html>`
      })
      sent++
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 100))
    }

    console.log(`[Admin] Announcement sent to ${sent} subscribers`)
    res.json({ sent, total: businesses.length })
  } catch (err) {
    console.error('[Admin] Announce error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: cancel a subscriber's account ──────────────────────────────────────
app.post('/admin/cancel-account', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { businessId } = req.body
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    await sb.from('businesses').update({ status: 'cancelled', active: false }).eq('id', businessId)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: extend trial ────────────────────────────────────────────────────────
app.post('/admin/extend-trial', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { businessId, days = 7 } = req.body
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: biz } = await sb.from('businesses').select('trial_ends_at').eq('id', businessId).maybeSingle()
    const currentEnd = new Date(biz.trial_ends_at || Date.now())
    const newEnd = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000)
    await sb.from('businesses').update({ trial_ends_at: newEnd.toISOString(), status: 'trial' }).eq('id', businessId)
    res.json({ success: true, newTrialEnd: newEnd.toISOString() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Intake form to PDF ──────────────────────────────────────────────────────
app.get('/intake/pdf/:businessId/:appointmentId', async (req, res) => {
  const { businessId, appointmentId } = req.params

  // Auth: opened via window.open (new tab) which can't send headers, so accept
  // a token query param (the business's id) OR a normal auth header. Appointment
  // must also belong to the business (checked below).
  const token = req.query.token
  const headerAuth = req.headers['authorization']
  if (!headerAuth && token !== businessId) {
    return res.status(401).send('Authentication required')
  }
  try {
    const PDFDocument = require('pdfkit')

    // Fetch appointment and intake responses
    const { data: appt } = await supabase.from('appointments')
      .select('*').eq('id', appointmentId).eq('business_id', businessId).maybeSingle()

    const { data: biz } = await supabase.from('businesses')
      .select('business_name, address, phone').eq('id', businessId).maybeSingle()

    const { data: responses } = await supabase.from('intake_responses')
      .select('*').eq('appointment_id', appointmentId).maybeSingle()

    const { data: customer } = await supabase.from('customers')
      .select('*').eq('business_id', businessId).eq('phone', appt?.customer_phone).maybeSingle()

    if (!appt) return res.status(404).send('Appointment not found')

    // Build PDF
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="intake-${appt.customer_name?.replace(/\s/g,'-') || 'form'}.pdf"`)
    doc.pipe(res)

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(biz?.business_name || 'Business', { align: 'center' })
    doc.fontSize(10).font('Helvetica').fillColor('#666').text('Patient / Client Intake Form', { align: 'center' })
    doc.moveDown(0.5)
    doc.moveTo(50, doc.y).lineTo(560, doc.y).strokeColor('#ddd').stroke()
    doc.moveDown(0.5)

    // Patient info
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Client Information')
    doc.moveDown(0.3)
    const infoItems = [
      ['Name', appt.customer_name || '—'],
      ['Phone', appt.customer_phone || '—'],
      ['Email', customer?.email || '—'],
      ['Birthday', customer?.birthday || '—'],
      ['Service', appt.service_name || '—'],
      ['Appointment', `${appt.appointment_date} at ${appt.appointment_time?.slice(0,5) || ''}`],
    ]
    doc.fontSize(10).font('Helvetica')
    infoItems.forEach(([label, value]) => {
      doc.text(`${label}: `, { continued: true }).font('Helvetica-Bold').text(value).font('Helvetica')
    })

    doc.moveDown(0.8)
    doc.moveTo(50, doc.y).lineTo(560, doc.y).strokeColor('#ddd').stroke()
    doc.moveDown(0.5)

    // Intake responses
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Intake Responses')
    doc.moveDown(0.3)

    const responseData = responses?.responses || {}

    if (!Object.keys(responseData).length) {
      doc.fontSize(10).font('Helvetica').fillColor('#666').text('No intake responses on file.')
    } else {
      // Responses are stored keyed by question label (see runIntakeFlow).
      // Render them directly in stored order.
      Object.entries(responseData).forEach(([label, answer]) => {
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text(label + ':', { continued: false })
        doc.font('Helvetica').fillColor('#000').text(answer || '—')
        doc.moveDown(0.4)
      })
    }

    // Appointment notes
    if (appt.notes) {
      doc.moveDown(0.5)
      doc.moveTo(50, doc.y).lineTo(560, doc.y).strokeColor('#ddd').stroke()
      doc.moveDown(0.5)
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Notes')
      doc.moveDown(0.3)
      doc.fontSize(10).font('Helvetica').text(appt.notes)
    }

    // Footer
    doc.moveDown(2)
    doc.fontSize(8).fillColor('#999').text(`Generated by Wexly · ${new Date().toLocaleDateString()} · ${biz?.business_name}`, { align: 'center' })

    doc.end()

  } catch (err) {
    console.error('[PDF] Error:', err.message)
    res.status(500).send('Error generating PDF: ' + err.message)
  }
})

// ── Multi-location: add new location ───────────────────────────────────────
app.post('/locations/add', requireBusinessAuth, async (req, res) => {
  const { businessId, locationName, copyFrom } = req.body
  if (!businessId || !locationName) return res.status(400).json({ error: 'Missing businessId or locationName' })
  try {
    const { data: parent } = await supabase.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (!parent) return res.status(404).json({ error: 'Business not found' })
    const sourceId = copyFrom || businessId
    const { data: source } = await supabase.from('businesses').select('*').eq('id', sourceId).maybeSingle()

    const { data: newLoc, error } = await supabase.from('businesses').insert({
      user_id: parent.user_id,
      owner_name: parent.owner_name,
      email: parent.email,
      business_name: parent.business_name,
      location_name: locationName,
      parent_business_id: businessId,
      business_type: source.business_type,
      bot_greeting: source.bot_greeting,
      bot_tone: source.bot_tone,
      bot_restrictions: source.bot_restrictions,
      bot_staff: source.bot_staff,
      bot_name: source.bot_name,
      hours: source.hours,
      buffer_mins: source.buffer_mins,
      advance_booking_days: source.advance_booking_days,
      min_notice_mins: source.min_notice_mins,
      max_daily: source.max_daily,
      rebook_enabled: source.rebook_enabled,
      rebook_interval_weeks: source.rebook_interval_weeks,
      cancel_rebook_enabled: source.cancel_rebook_enabled,
      birthday_enabled: source.birthday_enabled,
      birthday_message: source.birthday_message,
      birthday_offer: source.birthday_offer,
      noshow_recovery_enabled: source.noshow_recovery_enabled,
      website: source.website,
      review_link: source.review_link,
      status: parent.status,
      plan: parent.plan,
      stripe_customer_id: parent.stripe_customer_id,
      trial_ends_at: parent.trial_ends_at,
      timezone: parent.timezone,
      active: true
    }).select().single()

    if (error) return res.status(500).json({ error: error.message })

    // Copy services
    const { data: services } = await supabase.from('services').select('*').eq('business_id', sourceId)
    if (services?.length) {
      await supabase.from('services').insert(services.map(s => ({ ...s, id: undefined, business_id: newLoc.id, created_at: undefined })))
    }
    // Copy FAQs
    const { data: faqs } = await supabase.from('faqs').select('*').eq('business_id', sourceId)
    if (faqs?.length) {
      await supabase.from('faqs').insert(faqs.map(f => ({ ...f, id: undefined, business_id: newLoc.id, created_at: undefined })))
    }

    await supabase.from('businesses').update({ is_parent: true }).eq('id', businessId)
    res.json({ success: true, location: newLoc })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Multi-location: get all locations ──────────────────────────────────────
app.get('/locations/:businessId', requireAuth, async (req, res) => {
  try {
    const { data: locations } = await supabase.from('businesses')
      .select('id, location_name, business_name, sms_number, address, status, plan, active')
      .or(`id.eq.${req.params.businessId},parent_business_id.eq.${req.params.businessId}`)
      .order('created_at')
    res.json({ locations: locations || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── SMS Groups ─────────────────────────────────────────────────────────────

// Get all groups for a business
app.get('/groups/:businessId', requireAuth, async (req, res) => {
  try {
    const { data: groups } = await supabase
      .from('sms_groups')
      .select('*, sms_group_members(count)')
      .eq('business_id', req.params.businessId)
      .order('created_at')
    res.json({ groups: groups || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Create a group
app.post('/groups', requireBusinessAuth, async (req, res) => {
  const { businessId, name, description } = req.body
  if (!businessId || !name) return res.status(400).json({ error: 'Missing fields' })
  try {
    const { data, error } = await supabase.from('sms_groups').insert({
      business_id: businessId, name, description
    }).select().single()
    if (error) throw error
    res.json({ success: true, group: data })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Delete a group
app.delete('/groups/:groupId', requireAuth, async (req, res) => {
  try {
    await supabase.from('sms_groups').delete().eq('id', req.params.groupId)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Get members of a group
app.get('/groups/:groupId/members', requireAuth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('sms_group_members')
      .select('*, customers(id, name, phone, email)')
      .eq('group_id', req.params.groupId)
    res.json({ members: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Add customer to group
app.post('/groups/:groupId/members', requireAuth, async (req, res) => {
  const { customerId, businessId } = req.body
  if (!customerId || !businessId) return res.status(400).json({ error: 'Missing fields' })
  try {
    await supabase.from('sms_group_members').upsert({
      group_id: req.params.groupId,
      customer_id: customerId,
      business_id: businessId
    }, { onConflict: 'group_id,customer_id' })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Remove customer from group
app.delete('/groups/:groupId/members/:customerId', requireAuth, async (req, res) => {
  try {
    await supabase.from('sms_group_members')
      .delete()
      .eq('group_id', req.params.groupId)
      .eq('customer_id', req.params.customerId)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Send broadcast to a group
app.post('/groups/:groupId/broadcast', requireAuth, async (req, res) => {
  const { businessId, message } = req.body
  if (!businessId || !message) return res.status(400).json({ error: 'Missing fields' })

  try {
    // Get business SMS number
    const { data: biz } = await supabase.from('businesses')
      .select('sms_number, plan, business_name, bot_name')
      .eq('id', businessId).maybeSingle()

    if (!biz?.sms_number) return res.status(400).json({ error: 'No SMS number assigned' })
    if (biz.plan !== 'pro') return res.status(403).json({ error: 'SMS groups are a Pro feature' })

    // Get all group members with phone numbers
    const { data: members } = await supabase
      .from('sms_group_members')
      .select('customers(id, name, phone, opted_out, marketing_opted_out, fully_opted_out)')
      .eq('group_id', req.params.groupId)
      .eq('business_id', businessId)

    if (!members?.length) return res.json({ success: true, sent: 0, skipped: 0 })

    const { sendSMS } = require('./src/utils/sms')
    let sent = 0
    let skipped = 0

    for (const member of members) {
      const customer = member.customers
      // Skip if fully opted out OR marketing opted out — but NOT just for appointment comms
      if (!customer?.phone || customer.fully_opted_out || customer.opted_out || customer.marketing_opted_out) {
        skipped++
        continue
      }

      // Personalize message with customer name
      const firstName = customer.name?.split(' ')[0] || 'there'
      const personalizedMsg = message
        .replace(/{name}/gi, firstName)
        .replace(/{business}/gi, biz.business_name)

      // Add STOP instructions if not already in message
      const finalMsg = personalizedMsg.includes('STOP')
        ? personalizedMsg
        : `${personalizedMsg}\n\nReply STOP to unsubscribe.`

      try {
        await sendSMS(biz.sms_number, customer.phone, finalMsg)
        sent++
        await new Promise(r => setTimeout(r, 100)) // rate limit
      } catch (err) {
        console.error(`[Groups] Failed to send to ${customer.phone}:`, err.message)
        skipped++
      }
    }

    // Log the broadcast
    await supabase.from('sms_group_broadcasts').insert({
      business_id: businessId,
      group_id: req.params.groupId,
      message,
      sent_count: sent
    })

    console.log(`[Groups] Broadcast sent to ${sent} members in group ${req.params.groupId}`)
    res.json({ success: true, sent, skipped })

  } catch (err) {
    console.error('[Groups] Broadcast error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Compliance violation log ────────────────────────────────────────────────
app.post('/compliance/violation', requireBusinessAuth, async (req, res) => {
  const { businessId, message, flaggedTerms, action, groupId } = req.body
  if (!businessId || !message) return res.status(400).json({ error: 'Missing fields' })
  try {
    await supabase.from('compliance_violations').insert({
      business_id: businessId,
      message,
      flagged_terms: flaggedTerms || [],
      action: action || 'sent_anyway',
      group_id: groupId || null
    })

    const { count } = await supabase
      .from('compliance_violations')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('action', 'sent_anyway')

    console.log(`[Compliance] Violation logged for ${businessId} — total: ${count}`)

    if (count >= 3) {
      await supabase.from('businesses')
        .update({ compliance_flagged: true, compliance_flag_reason: `${count} broadcast violations` })
        .eq('id', businessId)
      console.warn(`[Compliance] ⚠️ Business ${businessId} auto-flagged after ${count} violations`)
    }

    res.json({ success: true, totalViolations: count })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/admin/compliance', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  try {
    const { data: violations } = await supabase
      .from('compliance_violations')
      .select('*, businesses(business_name, email, sms_number)')
      .order('created_at', { ascending: false })
      .limit(200)

    const byBusiness = {}
    for (const v of violations || []) {
      const id = v.business_id
      if (!byBusiness[id]) {
        byBusiness[id] = {
          business_id: id,
          business_name: v.businesses?.business_name,
          email: v.businesses?.email,
          sms_number: v.businesses?.sms_number,
          total: 0,
          sent_anyway: 0,
          last_violation: v.created_at,
          violations: []
        }
      }
      byBusiness[id].total++
      if (v.action === 'sent_anyway') byBusiness[id].sent_anyway++
      byBusiness[id].violations.push(v)
    }

    res.json({
      businesses: Object.values(byBusiness).sort((a, b) => b.sent_anyway - a.sent_anyway),
      total: violations?.length || 0
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: bulk discount ────────────────────────────────────────────────────
app.post('/admin/bulk-discount', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { percent, duration, reason, filter } = req.body
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

  try {
    // Get all businesses with stripe subscriptions
    let query = supabase.from('businesses').select('id, email, business_name, stripe_subscription_id').neq('status', 'cancelled')
    if (filter === 'active') query = query.eq('status', 'active')
    else if (filter === 'trial') query = query.eq('status', 'trial')
    const { data: businesses } = await query

    // Create a coupon in Stripe
    const durationVal = duration === 'repeating_3' ? 'repeating' : duration
    const coupon = await stripe.coupons.create({
      percent_off: percent,
      duration: durationVal,
      ...(durationVal === 'repeating' ? { duration_in_months: 3 } : {}),
      name: reason || 'Wexly discount',
      max_redemptions: businesses.length + 10
    })

    let applied = 0
    let skipped = 0

    for (const biz of businesses) {
      if (!biz.stripe_subscription_id) { skipped++; continue }
      try {
        await stripe.subscriptions.update(biz.stripe_subscription_id, {
          coupon: coupon.id
        })
        applied++
      } catch (err) {
        console.error(`[Discount] Failed for ${biz.business_name}:`, err.message)
        skipped++
      }
    }

    res.json({ success: true, applied, skipped, couponId: coupon.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: single discount ──────────────────────────────────────────────────
app.post('/admin/single-discount', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { businessId, percent, duration } = req.body
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

  try {
    const { data: biz } = await supabase.from('businesses')
      .select('stripe_subscription_id, business_name')
      .eq('id', businessId).maybeSingle()

    if (!biz?.stripe_subscription_id) return res.status(400).json({ error: 'No Stripe subscription found for this business' })

    const durationVal = duration === 'repeating_3' ? 'repeating' : duration
    const coupon = await stripe.coupons.create({
      percent_off: percent,
      duration: durationVal,
      ...(durationVal === 'repeating' ? { duration_in_months: 3 } : {}),
      name: `Wexly discount — ${biz.business_name}`,
      max_redemptions: 1
    })

    await stripe.subscriptions.update(biz.stripe_subscription_id, { coupon: coupon.id })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: bulk discount ────────────────────────────────────────────────────
app.post('/admin/bulk-discount', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { percent, duration = 'once', reason = 'Bulk discount' } = req.body
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

    // Create a coupon in Stripe
    const coupon = await stripe.coupons.create({
      percent_off: percent,
      duration,
      name: reason,
      max_redemptions: 10000
    })

    // Get all active subscribers with Stripe subscriptions
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, stripe_subscription_id, email, owner_name')
      .neq('status', 'cancelled')
      .not('stripe_subscription_id', 'is', null)

    let applied = 0
    let skipped = 0

    for (const biz of businesses || []) {
      try {
        await stripe.subscriptions.update(biz.stripe_subscription_id, {
          coupon: coupon.id
        })
        applied++
      } catch (err) {
        console.error(`[Discount] Failed for ${biz.email}:`, err.message)
        skipped++
      }
    }

    res.json({ success: true, applied, skipped, couponId: coupon.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: single discount ──────────────────────────────────────────────────
app.post('/admin/single-discount', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { businessId, percent, duration = 'once' } = req.body
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

    const { data: biz } = await supabase
      .from('businesses')
      .select('stripe_subscription_id, email')
      .eq('id', businessId)
      .maybeSingle()

    if (!biz?.stripe_subscription_id) return res.status(400).json({ error: 'No Stripe subscription found for this business' })

    const coupon = await stripe.coupons.create({
      percent_off: percent,
      duration,
      max_redemptions: 1
    })

    await stripe.subscriptions.update(biz.stripe_subscription_id, {
      coupon: coupon.id
    })

    res.json({ success: true, email: biz.email })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin: change plan ──────────────────────────────────────────────────────
app.post('/admin/change-plan', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { businessId, plan } = req.body
  try {
    await supabase.from('businesses').update({ plan }).eq('id', businessId)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Admin: reset interview ──────────────────────────────────────────────────
app.post('/admin/reset-interview', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { businessId } = req.body
  try {
    await supabase.from('businesses').update({
      interview_state: 'waiting_start',
      interview_step: 0,
      interview_answers: {}
    }).eq('id', businessId)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Admin: clear conversation ───────────────────────────────────────────────
app.post('/admin/clear-conversation', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const { businessId, phone } = req.body
  try {
    await supabase.from('conversation_sessions')
      .delete()
      .eq('business_id', businessId)
      .eq('customer_phone', phone)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Admin: database health check ────────────────────────────────────────────
app.get('/admin/db-health', async (req, res) => {
  if (!isValidAdminSecret(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Forbidden' })
  const tables = ['businesses', 'services', 'appointments', 'customers', 'email_campaigns']
  const results = []
  let allOk = true
  for (const table of tables) {
    try {
      const { error } = await supabase.from(table).select('id').limit(1)
      if (error) { results.push(`${table}: ⚠️ ${error.message}`); allOk = false }
      else results.push(table)
    } catch(err) { results.push(`${table}: ❌ ${err.message}`); allOk = false }
  }
  res.json({ ok: allOk, tables: results })
})

// ── Broadcast: generate email HTML ─────────────────────────────────────────
app.post('/broadcasts/generate', requireBusinessAuth, async (req, res) => {
  const { businessId, businessName, businessType, logoUrl, prompt, brandColor, emailStyle } = req.body
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' })

  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic()
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: biz } = await sb.from('businesses').select('sms_number').eq('id', businessId).maybeSingle()
    const smsNumber = biz?.sms_number || ''
    const color = brandColor || '#0D9488'
    const style = emailStyle || 'professional'

    var styleGuide = ''
    if (style === 'playful') styleGuide = 'Use rounded corners (border-radius: 16px), fun emoji in headings, warm gradient accents, a casual friendly tone, and generous padding.'
    else if (style === 'minimal') styleGuide = 'Ultra clean and minimal. Lots of white space, thin borders, small text, no background colors except white and light gray. Elegant restraint.'
    else if (style === 'bold') styleGuide = 'High contrast. Dark background (#111111) for the full email body, white text, brand color only for the CTA button. Dramatic and modern.'
    else styleGuide = 'Clean professional layout. White background, subtle borders, polished typography, brand color header and CTA button.'

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are an expert HTML email designer. Generate a beautiful, complete HTML email for a business campaign.

STRICT RULES:
- Use table-based layout ONLY (required for email client compatibility)
- Max width 600px centered
- Use inline styles only — NO <style> tags, NO <head>, NO <html>, NO <body> tags
- Return ONLY the HTML content starting with <table, nothing else
- No markdown, no explanation, no backticks, just pure HTML
- The email MUST have ALL sections below — do not skip any

DESIGN STYLE: ${style.toUpperCase()}
${styleGuide}

BRAND COLOR: ${color}
Business: ${businessName || 'Our Business'}
Type: ${businessType || 'service business'}
SMS Number: ${smsNumber}

Campaign request: ${prompt}

REQUIRED SECTIONS (generate ALL of these):
1. HEADER — business name "${businessName || 'Our Business'}" on brand color background, white text, padded 28px
2. HERO — compelling headline (24-30px) about the promotion
3. BODY — 2-3 paragraphs explaining the offer with details, dates, terms. Use {name} for customer first name
4. CTA BUTTON — prominent button in brand color, text "Book Now" or similar, href="sms:${smsNumber}${smsNumber ? '?body=Hi!%20I%27d%20like%20to%20book' : ''}", minimum 48px height, centered
5. FOOTER — small gray text with "Reply STOP to unsubscribe" and business name

Generate the complete HTML email now:`
      }]
    })

    var html = message.content?.[0]?.text?.trim() || ''
    // Clean up any markdown fences the AI might add
    html = html.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim()
    if (!html || !html.startsWith('<')) throw new Error('No valid HTML generated')
    res.json({ html })
  } catch(err) {
    console.error('[Broadcast] Generate error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 🔒 PROTECTED — Generic AI text generation for dashboard AI writers
// 🔒 Used by callAI() in dashboard.html — at least 6 places call this:
// 🔒   - AI greeting writer (bot setup)
// 🔒   - Bot rules suggester
// 🔒   - SMS message writer
// 🔒   - Automation message writer
// 🔒   - Broadcast SMS writer
// 🔒   - Quick SMS AI assistant
// 🔒 DO NOT remove or rename this route — multiple dashboard features
// 🔒 depend on it. See PROTECTED_DECISIONS.md Entry 14.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/ai/generate', requireBusinessAuth, async (req, res) => {
  const { prompt, max_tokens } = req.body
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt' })
  }
  // Cap max_tokens defensively — dashboard requests range from 150-500
  const maxTokens = Math.min(Math.max(parseInt(max_tokens) || 200, 50), 1500)

  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic()
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = message.content?.[0]?.text?.trim() || ''
    res.json({ text })
  } catch (err) {
    console.error('[AI Generate] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Broadcast: generate subject line ───────────────────────────────────────
app.post('/broadcasts/subject', requireBusinessAuth, async (req, res) => {
  const { businessName, prompt } = req.body
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' })

  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic()
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `Write a compelling email subject line for this campaign: ${prompt}
Business: ${businessName || 'Our Business'}
Keep it under 50 characters. Use an emoji if it fits naturally. Return ONLY the subject line, nothing else.`
      }]
    })
    const subject = message.content?.[0]?.text?.trim()
    res.json({ subject })
  } catch(err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Auth: create business record during signup ──────────────────────────────
// Pending leads outreach — called when owner saves their first services
// Texts all leads that came in before services were configured
app.post('/pending-leads/reach-out', requireBusinessAuth, async (req, res) => {
  const { businessId } = req.body
  if (!businessId) return res.status(400).json({ error: 'Missing businessId' })

  try {
    const { data: biz } = await supabase.from('businesses')
      .select('*').eq('id', businessId).maybeSingle()
    if (!biz?.sms_number) return res.json({ sent: 0 })

    const { data: leads } = await supabase.from('pending_leads')
      .select('*').eq('business_id', businessId).eq('reached_out', false)

    if (!leads?.length) return res.json({ sent: 0 })

    const { sendSMS } = require('./src/utils/sms')
    let sent = 0

    for (const lead of leads) {
      try {
        await sendSMS(biz.sms_number, lead.customer_phone,
          `Hey! We're all set up now at ${biz.business_name} and ready to get you booked in. What day works best for you? 😊`
        )
        await supabase.from('pending_leads').update({ reached_out: true, reached_out_at: new Date().toISOString() }).eq('id', lead.id)
        sent++
        await new Promise(r => setTimeout(r, 300))
      } catch (err) {
        console.error(`[PendingLeads] Failed to reach ${lead.customer_phone}:`, err.message)
      }
    }

    console.log(`[PendingLeads] Reached out to ${sent} leads for ${biz.business_name}`)
    res.json({ sent })
  } catch (err) {
    console.error('[PendingLeads] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Signup phone verification (🔒 v190 instant trial) ────────────────────────
// The owner's cell is verified by a 6-digit text before the account exists.
// Codes come from the shared Wexly number (TWILIO_PHONE_NUMBER). Small in-memory
// per-IP limiter on top of the per-phone limit inside trialOnboarding.
const trialOnboarding = require('./src/bot/trialOnboarding')
const codeHits = new Map() // ip -> [timestamps]
function codeRateLimited(ip) {
  const now = Date.now()
  const hits = (codeHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000)
  hits.push(now)
  codeHits.set(ip, hits)
  if (codeHits.size > 5000) codeHits.clear()
  return hits.length > 12
}

app.post('/auth/send-code', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
  if (codeRateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' })
  try {
    const result = await trialOnboarding.sendVerificationCode(req.body?.phone, ip)
    if (!result.ok) return res.status(result.error === 'too_many' ? 429 : 400).json({ error: result.message, code: result.error })
    res.json({ sent: true, masked: result.masked })
  } catch (err) {
    console.error('[Verify] send-code error:', err.message)
    res.status(500).json({ error: 'Could not send the code. Try again.' })
  }
})

app.post('/auth/verify-code', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
  if (codeRateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' })
  try {
    const result = await trialOnboarding.verifyCode(req.body?.phone, req.body?.code)
    if (!result.ok) return res.status(400).json({ error: result.message, code: result.error })
    res.json({ verified: true, phone: result.phone })
  } catch (err) {
    console.error('[Verify] verify-code error:', err.message)
    res.status(500).json({ error: 'Could not verify the code. Try again.' })
  }
})

// ── Demo: have the bot text the visitor first (🔒 v193) ──────────────────────
// Desktop visitors cannot tap an sms: link, so the panel offers to text them.
// One message per number per 24h, rate limited per IP, STOP wording included.
app.post('/demo/text-me', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
  if (codeRateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' })
  try {
    const phone = trialOnboarding.normalizeUSPhone(req.body?.phone)
    if (!phone) return res.status(400).json({ error: 'Enter a valid US mobile number.' })

    const { data: demoBiz } = await supabase.from('businesses')
      .select('*')
      .eq('demo_mode', true).not('sms_number', 'is', null).limit(1).maybeSingle()
    if (!demoBiz) return res.status(503).json({ error: 'The demo line is offline right now.' })

    // One outbound per number per day — this endpoint is public, so it must
    // never be usable to send someone repeated texts.
    const { data: lead } = await supabase.from('demo_leads')
      .select('id, texted_first_at').eq('phone', phone).maybeSingle()
    if (lead?.texted_first_at && Date.now() - new Date(lead.texted_first_at).getTime() < 24 * 3600 * 1000) {
      return res.status(429).json({ error: 'We already texted that number today. Check your messages.' })
    }

    // A prior STOP to this number is binding, website form or not. (Twilio also
    // rejects the send at the carrier level, but refuse cleanly here first.)
    const { data: optOut } = await supabase.from('customers')
      .select('opted_out, fully_opted_out').eq('business_id', demoBiz.id).eq('phone', phone).maybeSingle()
    if (optOut?.opted_out || optOut?.fully_opted_out) {
      return res.status(400).json({ error: 'That number has opted out of texts from us. Text START to the number to opt back in.' })
    }

    const { sendSMS } = require('./src/utils/sms')

    // Run their message through the real bot, exactly as if they had texted it
    // to the demo number, and send the answer to their phone. They land in a
    // live thread with the bot's real reply, not a canned invitation.
    const opener = String(req.body?.message || '').trim().slice(0, 160) || 'Hi! What services do you offer?'
    let reply
    try {
      const { handleIncomingMessage } = require('./src/bot/conversationEngine')
      reply = await handleIncomingMessage({ business: demoBiz, customerPhone: phone, incomingText: opener })
    } catch (botErr) {
      console.error('[Demo] engine failed, falling back to greeting:', botErr.message)
    }
    if (!reply) {
      reply = `Hi! This is ${demoBiz.business_name}, the live Wexly demo. Ask me anything one of your customers would and I'll book you in.`
    }
    const sent = await sendSMS(demoBiz.sms_number, phone, reply)
    if (!sent.success) return res.status(502).json({ error: 'That number could not receive our text.' })

    if (lead) {
      await supabase.from('demo_leads').update({
        texted_first_at: new Date().toISOString(), last_message_at: new Date().toISOString()
      }).eq('id', lead.id)
    } else {
      await supabase.from('demo_leads').insert({
        phone, business_id: demoBiz.id, first_message: opener, last_message: opener,
        message_count: 1, texted_first_at: new Date().toISOString(), last_message_at: new Date().toISOString()
      })
    }
    console.log(`[Demo] Texted first: ${phone}`)

    const ownerPhone = process.env.OWNER_NOTIFICATION_PHONE
    if (ownerPhone && process.env.TWILIO_PHONE_NUMBER) {
      sendSMS(process.env.TWILIO_PHONE_NUMBER, ownerPhone, `🔥 Demo requested from the site: ${phone}`).catch(() => {})
    }
    res.json({ sent: true })
  } catch (err) {
    console.error('[Demo] text-me failed:', err.message)
    res.status(500).json({ error: 'Could not send that text. Try again.' })
  }
})

app.post('/auth/create-business', async (req, res) => {
  const {
    userId, ownerName, email, bizName, bizType, plan, ownerPhone,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content, referred_by_code
  } = req.body
  if (!userId || !email) return res.status(400).json({ error: 'Missing fields' })

  // 🔒 v190: the owner cell is required and must have been verified by text in
  // the last 30 minutes. No verified cell = no number = no trial. (Legacy
  // callers that omit ownerPhone, e.g. an old cached signup page, fall back to
  // the card-first pending_checkout flow so nobody is stranded.)
  const verifiedPhone = ownerPhone ? trialOnboarding.normalizeUSPhone(ownerPhone) : null
  const instant = !!verifiedPhone
  if (ownerPhone && !verifiedPhone) return res.status(400).json({ error: 'Enter a valid US cell number.' })
  if (instant && !(await trialOnboarding.isRecentlyVerified(verifiedPhone))) {
    return res.status(400).json({ error: 'Please verify your cell number first.', code: 'phone_not_verified' })
  }
  if (instant) {
    const used = await trialOnboarding.phoneAlreadyUsedTrial(verifiedPhone, userId)
    if (used) {
      return res.status(409).json({
        error: 'This cell number already has a Wexly account. Log in to that account, or email info@getwexly.com and we will sort it out.',
        code: 'phone_in_use'
      })
    }
  }

  try {
    const bizData = {
      user_id: userId,
      owner_name: ownerName,
      email,
      business_name: bizName,
      // Default to 'other' if not provided — signup.html doesn't currently
      // collect business type. 'other' is the safe fallback persona in the
      // bot's conversationEngine.js. Owner can change later in dashboard.
      business_type: bizType || 'other',
      plan: ['solo','standard','pro'].includes(plan) ? plan : 'standard',
      // 🔒 v190: instant trial starts the 14-day clock NOW, because the number
      // is live now (supersedes the old "clock starts at checkout" rule, which
      // existed only because pending_checkout accounts had no number to use).
      status: instant ? 'trial' : 'pending_checkout',
      trial_ends_at: instant ? new Date(Date.now() + trialOnboarding.TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString() : null,
      active: true,
      ...(instant ? { owner_phone: verifiedPhone, owner_phone_verified_at: new Date().toISOString() } : {}),
      // Attribution saved at signup now (flow no longer hits create-checkout first)
      signup_source: utm_source || null,
      signup_medium: utm_medium || null,
      signup_campaign: utm_campaign || null,
      signup_term: utm_term || null,
      signup_content: utm_content || null,
      referred_by_code: referred_by_code || null
    }

    // A business that already went live (trial/active/past_due/cancelled/
    // trial_expired) must never have its status, trial clock or number reset by
    // someone re-running the signup page. Only fresh rows and rows still parked
    // in pending_checkout/incomplete take the lifecycle fields.
    const LIFECYCLE = ['status', 'trial_ends_at', 'active', 'owner_phone', 'owner_phone_verified_at']
    const stripLifecycle = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !LIFECYCLE.includes(k)))
    const isParked = (row) => !row?.status || ['pending_checkout', 'incomplete'].includes(row.status)

    // Try to find existing business for this user
    const { data: existing } = await supabase
      .from('businesses')
      .select('id, status, sms_number')
      .eq('user_id', userId)
      .maybeSingle()

    let businessId
    let activateNow = instant
    if (existing) {
      const payload = isParked(existing) ? bizData : stripLifecycle(bizData)
      if (!isParked(existing)) activateNow = false
      const { error } = await supabase
        .from('businesses')
        .update(payload)
        .eq('id', existing.id)
      if (error) throw error
      businessId = existing.id
      console.log(`[Auth] Business updated for ${email}: ${businessId}`)
    } else {
      // Also try by email
      const { data: byEmail } = await supabase
        .from('businesses')
        .select('id, status, sms_number')
        .eq('email', email)
        .maybeSingle()

      if (byEmail) {
        const payload = isParked(byEmail) ? bizData : stripLifecycle(bizData)
        if (!isParked(byEmail)) activateNow = false
        const { error } = await supabase
          .from('businesses')
          .update({ ...payload, user_id: userId })
          .eq('id', byEmail.id)
        if (error) throw error
        businessId = byEmail.id
        console.log(`[Auth] Business linked to user for ${email}: ${businessId}`)
      } else {
        // Insert new
        const { data, error } = await supabase
          .from('businesses')
          .insert(bizData)
          .select('id')
          .single()
        if (error) throw error
        businessId = data.id
        console.log(`[Auth] Business created for ${email}: ${businessId}`)
      }
    }

    console.log(`[Auth] Plan: ${plan || 'standard'} | Status: ${activateNow ? 'trial (instant)' : existing ? 'unchanged' : 'pending_checkout'}`)

    // Mark abandoned cart lead as converted
    try { await supabase.from('pending_signups').update({ converted: true }).eq('email', email) } catch(e) {}

    // 🔒 v190: buy the number and say hello from it. We wait up to 8s so the
    // dashboard lands with the number already on screen; if Twilio is slower
    // than that the purchase keeps running in the background and the drip
    // sweep covers any outright failure. Signup never fails on this step.
    let smsNumber = null
    if (activateNow) {
      const activation = trialOnboarding.activateInstantTrial(businessId)
        .then(async (num) => {
          if (!num) return null
          // Welcome email now goes out at signup (it used to go at card time).
          try {
            const { sendWelcomeEmail } = require('./src/utils/emailService')
            await sendWelcomeEmail({
              email, firstName: (ownerName || '').split(' ')[0] || 'there',
              businessName: bizName, smsNumber: num
            })
          } catch (e) { console.error('[Email] Welcome failed:', e.message) }
          try {
            const { sendOwnerNewSignupNotification } = require('./src/utils/emailService')
            await sendOwnerNewSignupNotification({ businessName: bizName, ownerName, email, businessType: bizType || 'other' })
          } catch (e) { console.error('[Notify] Signup email failed:', e.message) }
          return num
        })
        .catch(err => { console.error('[InstantTrial] activation failed:', err.message); return null })
      smsNumber = await Promise.race([activation, new Promise(r => setTimeout(() => r(null), 8000))])
    }

    res.json({ success: true, businessId, smsNumber, instant: activateNow })
  } catch(err) {
    console.error('[Auth] Create business error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Dashboard SMS — send notifications from dashboard (cancel, reschedule) ──
app.post('/dashboard/send-sms', requireBusinessAuth, async (req, res) => {
  try {
    const { businessId, to, message } = req.body
    if (!businessId || !to || !message) return res.status(400).json({ error: 'Missing fields' })

    const { data: biz } = await supabase.from('businesses')
      .select('sms_number').eq('id', businessId).maybeSingle()

    if (!biz?.sms_number) return res.status(400).json({ error: 'No SMS number assigned' })

    const { sendSMS } = require('./src/utils/sms')
    await sendSMS(biz.sms_number, to, message)
    console.log(`[Dashboard SMS] Sent to ${to} from ${biz.sms_number}`)
    res.json({ success: true })
  } catch (err) {
    console.error('[Dashboard SMS] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 🔒 PROTECTED — See PROTECTED_DECISIONS.md Entry 12 (Send-quote URL + media proxy)
// 🔒 Route MUST stay at /owner-action/send-quote — dashboard calls this URL.
// 🔒 Body MUST accept both camelCase AND snake_case field names — do not tighten.
// 🔒 Route MUST live in top-level index.js (the actually-loaded entry point).
// 🔒 The file src/index.js is an UNUSED ORPHAN — adding routes there does nothing.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/owner-action/send-quote', requireBusinessAuth, async (req, res) => {
  try {
    // Accept both naming conventions for resilience
    const appointmentId = req.body.appointmentId || req.body.appointment_id
    const businessId = req.body.businessId || req.body.business_id
    const price = req.body.price || req.body.quote_amount
    if (!appointmentId || !businessId || !price) {
      return res.status(400).json({ error: 'Missing appointmentId/businessId/price' })
    }

    const { data: appt } = await supabase.from('appointments').select('*').eq('id', appointmentId).maybeSingle()
    if (!appt) return res.status(404).json({ error: 'Appointment not found' })

    const { data: biz } = await supabase.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (!biz) return res.status(404).json({ error: 'Business not found' })
    if (!biz.sms_number) return res.status(400).json({ error: 'Business has no SMS number assigned' })

    const firstName = appt.customer_name?.split(' ')[0] || 'there'
    const serviceName = appt.service_name || 'your service'

    // Format price properly — accept number or string with optional $
    let priceFormatted
    if (typeof price === 'number') {
      priceFormatted = '$' + price.toFixed(2)
    } else {
      const numeric = parseFloat(String(price).replace(/[^0-9.]/g, ''))
      priceFormatted = isNaN(numeric) ? String(price) : '$' + numeric.toFixed(2)
    }

    // Text the customer the quote
    const { sendSMS } = require('./src/utils/sms')
    await sendSMS(
      biz.sms_number,
      appt.customer_phone,
      `Hi ${firstName}! Your quote for ${serviceName} is ${priceFormatted}. Would you like to go ahead and book? 😊`
    )

    // Update appointment status
    await supabase.from('appointments')
      .update({ status: 'quote_sent', notes: (appt.notes ? appt.notes + ' | ' : '') + `Quote sent: ${priceFormatted}` })
      .eq('id', appointmentId)

    console.log(`[Quote] Sent ${priceFormatted} quote to ${appt.customer_phone} for appt ${appointmentId}`)
    res.json({ success: true })
  } catch (err) {
    console.error('[owner-action/send-quote] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Public contact card (.vcf) — "Save our number" for owners and their clients ─
// Public by design: it only exposes the business name, its Wexly SMS number, logo
// and booking page, all of which are already public. Keyed by business UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function vcardEscape(v) { return String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m) }
app.get('/contact/:businessId.vcf', async (req, res) => {
  try {
    const { businessId } = req.params
    if (!UUID_RE.test(businessId)) return res.status(400).send('Invalid id')
    const { data: biz } = await supabase
      .from('businesses')
      .select('business_name, sms_number, logo_url, profile_slug, profile_enabled, status')
      .eq('id', businessId)
      .maybeSingle()
    if (!biz || !biz.sms_number) return res.status(404).send('Not found')

    const name = biz.business_name || 'Wexly'
    const digits = String(biz.sms_number).replace(/\D/g, '')
    const tel = digits.length === 10 ? '+1' + digits : (biz.sms_number.startsWith('+') ? biz.sms_number : '+' + digits)
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `N:;${vcardEscape(name)};;;`,
      `FN:${vcardEscape(name)}`,
      `ORG:${vcardEscape(name)}`,
      `TEL;TYPE=CELL,VOICE,pref:${tel}`,
      'NOTE:Text this number any time to book or reschedule an appointment.',
    ]
    if (biz.profile_enabled && biz.profile_slug) lines.push(`URL:https://getwexly.com/book/${biz.profile_slug}`)
    if (biz.logo_url && /^https:\/\//i.test(biz.logo_url)) lines.push(`PHOTO;VALUE=URI:${biz.logo_url}`)
    lines.push('END:VCARD')

    const safe = name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'contact'
    res.set({
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe}.vcf"`,
      'Cache-Control': 'public, max-age=300',
    })
    res.send(lines.join('\r\n') + '\r\n')
  } catch (err) {
    console.error('[contact.vcf] Error:', err.message)
    res.status(500).send('Error')
  }
})

// ── Public profile — serves business data for the booking page ───────────────
app.get('/public/profile/:slug', async (req, res) => {
  try {
    const { slug } = req.params
    if (!slug || slug.length < 2) return res.status(400).json({ error: 'Invalid slug' })

    const { data: biz } = await supabase
      .from('businesses')
      .select('business_name, business_type, logo_url, sms_number, hours, timezone, profile_description, profile_photos, profile_social, profile_theme, profile_enabled')
      .eq('profile_slug', slug.toLowerCase())
      .eq('profile_enabled', true)
      .maybeSingle()

    if (!biz) return res.status(404).json({ error: 'Business not found' })

    // Get active services
    const { data: services } = await supabase
      .from('services')
      .select('name, duration_mins, price, description, booking_mode')
      .eq('business_id', (await supabase.from('businesses').select('id').eq('profile_slug', slug.toLowerCase()).maybeSingle()).data?.id)
      

    // Get active bundles
    const { data: bundles } = await supabase
      .from('service_bundles')
      .select('name, services, bundle_price, description')
      .eq('business_id', (await supabase.from('businesses').select('id').eq('profile_slug', slug.toLowerCase()).maybeSingle()).data?.id)

    res.json({
      name: biz.business_name,
      type: biz.business_type,
      logo: biz.logo_url,
      phone: biz.sms_number,
      hours: biz.hours || [],
      timezone: biz.timezone,
      description: biz.profile_description,
      photos: biz.profile_photos || [],
      social: biz.profile_social || {},
      theme: biz.profile_theme || 'default',
      services: (services || []).map(s => ({
        name: s.name,
        duration: s.duration_mins,
        price: s.price,
        description: s.description,
        mode: s.booking_mode
      })),
      bundles: (bundles || []).map(b => ({
        name: b.name,
        services: b.services,
        price: b.bundle_price,
        description: b.description
      }))
    })
  } catch (err) {
    console.error('[Public Profile] Error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// Optimized version — single query for business ID
app.get('/public/profile-v2/:slug', async (req, res) => {
  try {
    const { slug } = req.params
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, business_name, business_type, business_type_custom, logo_url, sms_number, hours, timezone, profile_description, profile_photos, profile_social, profile_theme, profile_enabled, stripe_account_connected')
      .eq('profile_slug', slug.toLowerCase())
      .eq('profile_enabled', true)
      .maybeSingle()

    if (!biz) return res.status(404).json({ error: 'Business not found' })

    const [services, bundles] = await Promise.all([
      supabase.from('services').select('*')
        .eq('business_id', biz.id),
      supabase.from('service_bundles').select('name, services, bundle_price, description')
        .eq('business_id', biz.id)
    ])

    var typeLabels = {dental:'Dental Office',restaurant:'Restaurant',salon:'Hair Salon',medical:'Medical Practice',spa:'Day Spa & Massage',gym:'Fitness Studio',barbershop:'Barbershop',nails:'Nail Salon',autorepair:'Auto Repair'}
    var displayType = biz.business_type === 'other' ? (biz.business_type_custom || '') : (typeLabels[biz.business_type] || biz.business_type || '')

    // Normalize hours format
    var rawHours = biz.hours || []
    var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    var normalizedHours = []
    if (rawHours.length > 0 && !rawHours[0]?.day) {
      // Indexed format: [{open,from,to}, ...] → convert to named
      rawHours.forEach(function(h, i) {
        if (h && h.open) normalizedHours.push({ day: dayNames[i], open: h.from || '09:00', close: h.to || '17:00' })
        else normalizedHours.push({ day: dayNames[i], closed: true })
      })
    } else {
      normalizedHours = rawHours
    }

    res.json({
      name: biz.business_name,
      type: displayType,
      logo: biz.logo_url,
      phone: biz.sms_number,
      hours: normalizedHours,
      timezone: biz.timezone,
      description: biz.profile_description,
      photos: biz.profile_photos || [],
      social: biz.profile_social || {},
      theme: biz.profile_theme || 'default',
      depositsEnabled: biz.stripe_account_connected || false,
      services: (services.data || [])
        .filter(s => s.active !== false) // only filter if active column exists and is false
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
        .map(s => ({
        name: s.name, duration: s.duration_mins, price: s.price,
        description: s.description, mode: s.booking_mode,
        deposit: s.deposit_amount || null, category: s.category || null
      })),
      bundles: (bundles.data || []).map(b => ({
        name: b.name, services: b.services, price: b.bundle_price,
        description: b.description
      }))
    })
  } catch (err) {
    console.error('[Public Profile] Error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Public availability check — returns open time slots for a date ───────────
app.get('/public/availability/:slug', async (req, res) => {
  try {
    const { slug } = req.params
    const { date, service_name } = req.query
    if (!date) return res.status(400).json({ error: 'Date required' })

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, hours, buffer_mins, advance_booking_days, profile_enabled, profile_slug')
      .eq('profile_slug', slug.toLowerCase())
      .eq('profile_enabled', true)
      .maybeSingle()

    if (!biz) return res.status(404).json({ error: 'Business not found' })

    // Enforce advance booking limit
    const today = new Date()
    today.setHours(0,0,0,0)
    const requestedDate = new Date(date + 'T12:00:00')
    const maxDays = biz.advance_booking_days || 30
    const diffDays = Math.round((requestedDate - today) / (1000 * 60 * 60 * 24))
    if (diffDays < 0) return res.json({ slots: [], message: 'That date is in the past' })
    if (diffDays > maxDays) return res.json({ slots: [], message: `Bookings available up to ${maxDays} days ahead` })

    // Get service duration
    const { data: services } = await supabase
      .from('services').select('*').eq('business_id', biz.id)

    const service = service_name
      ? (services || []).find(s => s.name.toLowerCase() === service_name.toLowerCase()) || (services || [])[0]
      : (services || [])[0]

    const duration = service?.duration_mins || 60
    const capacity = service?.capacity || 1

    // Get existing appointments and blocked dates
    const { data: existing } = await supabase
      .from('appointments').select('*').eq('business_id', biz.id)
      .eq('appointment_date', date).in('status', ['pending', 'confirmed'])

    const { data: blocked } = await supabase
      .from('blocked_dates').select('*').eq('business_id', biz.id)

    // Check if fully blocked
    const fullBlock = (blocked || []).find(b => b.blocked_date === date && !b.start_time)
    if (fullBlock) return res.json({ slots: [], message: 'Not available on this date' })

    // Check if business has hours configured
    if (!biz.hours || !Array.isArray(biz.hours) || biz.hours.length === 0) {
      return res.json({ slots: [], message: 'Business hours not set up yet — contact us to book' })
    }

    const { getAvailableSlots } = require('./src/utils/dateHelpers')
    const slots = getAvailableSlots(biz, date, existing || [], duration, blocked || [], capacity, service_name)

    res.json({ slots, date, service: service?.name })
  } catch (err) {
    console.error('[Public Availability] Error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── Public online booking — creates appointment from website ────────────────
const onlineBookingLimiter = new Map() // IP → timestamp[]

app.post('/public/book/:slug', async (req, res) => {
  try {
    // Basic rate limiting — max 5 bookings per IP per hour
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown'
    const now = Date.now()
    const ipHistory = (onlineBookingLimiter.get(ip) || []).filter(t => now - t < 3600000)
    if (ipHistory.length >= 5) return res.status(429).json({ error: 'Too many bookings — please try again later' })
    ipHistory.push(now)
    onlineBookingLimiter.set(ip, ipHistory)

    const { slug } = req.params
    const { service_name, date, time, customer_name, phone, email } = req.body

    // Validate required fields
    if (!service_name || !date || !time || !customer_name || !phone) {
      return res.status(400).json({ error: 'Missing required fields: service, date, time, name, and phone' })
    }

    // Normalize phone
    const digits = phone.replace(/\D/g, '')
    const normalizedPhone = digits.length === 10 ? '+1' + digits
      : digits.length === 11 && digits[0] === '1' ? '+' + digits
      : phone

    // Find business
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, business_name, email, owner_phone, sms_number, pro_settings, plan, hours, buffer_mins, advance_booking_days, max_daily, profile_enabled, staff_members, stripe_account_connected, stripe_account_id')
      .eq('profile_slug', slug.toLowerCase())
      .eq('profile_enabled', true)
      .maybeSingle()

    if (!biz) return res.status(404).json({ error: 'Business not found' })

    // Get service
    const { data: services } = await supabase
      .from('services').select('*').eq('business_id', biz.id)

    const service = (services || []).find(s =>
      s.name.toLowerCase() === service_name.toLowerCase()
    ) || (services || [])[0]

    if (!service) return res.status(400).json({ error: 'Service not found' })

    // Verify slot is still available
    const { data: existing } = await supabase
      .from('appointments').select('*').eq('business_id', biz.id)
      .eq('appointment_date', date).in('status', ['pending', 'confirmed'])

    const { data: blocked } = await supabase
      .from('blocked_dates').select('*').eq('business_id', biz.id)

    const { getAvailableSlots, findAvailableStaff } = require('./src/utils/dateHelpers')
    const slots = getAvailableSlots(biz, date, existing || [], service.duration_mins || 60, blocked || [], service.capacity || 1, service_name)

    if (!slots.includes(time)) {
      return res.status(409).json({ error: 'That time slot is no longer available' })
    }

    // Find available staff
    const staffName = findAvailableStaff(biz, date, time, service.duration_mins || 60, existing || [], service.name)

    // Create customer record if doesn't exist
    const { data: existingCustomer } = await supabase
      .from('customers').select('id').eq('business_id', biz.id).eq('phone', normalizedPhone).maybeSingle()

    if (!existingCustomer) {
      await supabase.from('customers').insert({
        business_id: biz.id,
        name: customer_name,
        phone: normalizedPhone,
        email: email || null,
        source: 'website'
      })
    }

    // Create appointment
    const db = require('./src/db/client')
    const appt = await db.createAppointment({
      business_id: biz.id,
      customer_name,
      customer_phone: normalizedPhone,
      customer_email: email || null,
      service_name: service.name,
      service_id: service.id,
      appointment_date: date,
      appointment_time: time,
      duration_mins: service.duration_mins || 60,
      status: service.booking_mode === 'request' ? 'pending_approval' : 'confirmed',
      staff_name: staffName || null,
      source: 'website',
      notes: 'Booked online via public profile'
    })

    // Native app push (additive; no-op when no device is registered)
    try { require('./src/utils/push').pushNewBooking(biz, { customerName: customer_name, customerPhone: normalizedPhone, serviceName: service.name, appointmentDate: date, appointmentTime: time, isReschedule: false }).catch(() => {}) } catch (e) {}

    // Send notification to business owner
    const { sendBookingNotification } = require('./src/utils/emailService')
    const { shouldSendNotification: shouldNotify } = require('./src/bot/proFeatures')
    sendBookingNotification({
      ownerEmail: shouldNotify(biz, 'new_booking_email') ? biz.email : null,
      ownerPhone: shouldNotify(biz, 'new_booking_sms') ? biz.owner_phone : null,
      businessName: biz.business_name,
      smsNumber: biz.sms_number,
      customerName: customer_name,
      customerPhone: normalizedPhone,
      serviceName: service.name,
      appointmentDate: date,
      appointmentTime: time
    }).catch(err => console.error('[Online Booking] Notification failed:', err.message))

    // Send confirmation to customer via SMS if we have a number
    if (biz.sms_number && normalizedPhone) {
      const { sendSMS } = require('./src/utils/sms')
      const { formatDate, formatTime } = require('./src/utils/dateHelpers')
      const confirmMsg = service.booking_mode === 'request'
        ? `Hi ${customer_name}! Your appointment request for ${service.name} on ${formatDate(date)} at ${formatTime(time)} has been received. We'll confirm shortly!`
        : `Hi ${customer_name}! You're booked for ${service.name} on ${formatDate(date)} at ${formatTime(time)}${staffName ? ` with ${staffName}` : ''}. See you then! Reply STOP to opt out.`

      sendSMS(biz.sms_number, normalizedPhone, confirmMsg)
        .catch(err => console.error('[Online Booking] SMS confirmation failed:', err.message))

      // Send deposit link if service requires one and Stripe is connected
      if (service.deposit_amount && biz.stripe_account_connected && biz.stripe_account_id && appt?.id) {
        try {
          // Parse deposit amount — could be "$25" or "20%" or "25"
          var depStr = String(service.deposit_amount).trim()
          var depCents = 0
          if (depStr.includes('%')) {
            var pct = parseFloat(depStr) / 100
            var priceNum = parseFloat(String(service.price || '0').replace(/[^0-9.]/g, ''))
            depCents = Math.round(priceNum * pct * 100)
          } else {
            depCents = Math.round(parseFloat(depStr.replace(/[^0-9.]/g, '')) * 100)
          }

          if (depCents > 0) {
            var stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
            // 🔒 PROTECTED — Platform fee = 1% with 50¢ floor. See PROTECTED_DECISIONS.md Entry 2.
            var platformFee = Math.max(50, Math.round(depCents * 0.01))
            var depSession = await stripe.checkout.sessions.create({
              mode: 'payment',
              line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Deposit — ' + service.name + ' at ' + biz.business_name }, unit_amount: depCents }, quantity: 1 }],
              payment_intent_data: { application_fee_amount: platformFee, statement_descriptor_suffix: (biz.business_name || '').slice(0, 22).trim(), metadata: { businessId: biz.id, appointmentId: appt.id } },
              metadata: { businessId: biz.id, appointmentId: appt.id },
              success_url: (process.env.SITE_URL || 'https://getwexly.com') + '/deposit-confirmed.html',
              cancel_url: (process.env.SITE_URL || 'https://getwexly.com') + '/deposit-cancelled.html',
            }, { stripeAccount: biz.stripe_account_id })

            await supabase.from('appointments').update({ deposit_link: depSession.url, deposit_status: 'pending', deposit_amount: depCents }).eq('id', appt.id)

            // Shorten the Stripe URL before sending via SMS — saves segments
            // and looks cleaner. Falls back to the long URL if shortening fails.
            const { shortenUrl } = require('./src/utils/shortener')
            const payUrl = await shortenUrl(depSession.url, {
              appointmentId: appt.id,
              businessId: biz.id
            })

            // Send deposit link via SMS
            setTimeout(function() {
              sendSMS(biz.sms_number, normalizedPhone,
                'To confirm your ' + service.name + ' appointment, please pay your ' + depStr + ' deposit here: ' + payUrl + '\n\nYour spot will be held for 4 hours. Reply STOP to opt out.'
              ).catch(err => console.error('[Online Booking] Deposit SMS failed:', err.message))
            }, 3000) // Delay 3s so confirmation arrives first

            console.log('[Online Booking] Deposit link sent: ' + depCents + ' cents for appt ' + appt.id)
          }
        } catch (depErr) {
          console.error('[Online Booking] Deposit creation failed:', depErr.message)
        }
      }
    }

    console.log(`[Online Booking] ${customer_name} booked ${service.name} on ${date} at ${time} for ${biz.business_name}`)

    res.json({
      success: true,
      appointment: {
        service: service.name,
        date,
        time,
        staff: staffName || null,
        status: service.booking_mode === 'request' ? 'pending_approval' : 'confirmed'
      }
    })
  } catch (err) {
    console.error('[Online Booking] Error:', err.message)
    res.status(500).json({ error: 'Booking failed — please try again or text us directly' })
  }
})

// ── Unsubscribe (email campaign) — marketing opt-out only ──────────────────
app.post('/unsubscribe', async (req, res) => {
  const { bizId, phone } = req.body
  try {
    if (bizId && phone) {
      await supabase.from('customers')
        .update({ marketing_opted_out: true })
        .eq('business_id', bizId)
        .eq('phone', phone)
    }
    const { data: biz } = await supabase.from('businesses')
      .select('business_name, sms_number')
      .eq('id', bizId).maybeSingle()
    res.json({ success: true, businessName: biz?.business_name, smsNumber: biz?.sms_number })
  } catch(err) {
    res.json({ success: true })
  }
})

app.post('/resubscribe', async (req, res) => {
  const { bizId, phone } = req.body
  try {
    if (bizId && phone) {
      await supabase.from('customers')
        .update({ marketing_opted_out: false, fully_opted_out: false, opted_out: false })
        .eq('business_id', bizId)
        .eq('phone', phone)
    }
    res.json({ success: true })
  } catch(err) {
    res.json({ success: true })
  }
})

// ── Email broadcast send ────────────────────────────────────────────────────
app.post('/broadcasts/send', requireBusinessAuth, async (req, res) => {
  const { businessId, subject, html, audience } = req.body
  if (!businessId || !subject || !html) return res.status(400).json({ error: 'Missing fields' })

  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const sgMail = require('@sendgrid/mail')
    sgMail.setApiKey(process.env.SENDGRID_API_KEY)

    const { data: biz } = await sb.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (!biz) return res.status(404).json({ error: 'Business not found' })

    const { data: customers } = await sb.from('customers')
      .select('name, email, phone')
      .eq('business_id', businessId)
      .neq('marketing_opted_out', true)
      .neq('fully_opted_out', true)
      .not('email', 'is', null)

    if (!customers?.length) return res.json({ sent: 0 })

    let sent = 0
    for (const customer of customers) {
      if (!customer.email) continue
      try {
        const unsubUrl = `https://getwexly.com/unsubscribe.html?b=${businessId}&p=${encodeURIComponent(customer.phone || '')}`
        const unsubFooter = `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:20px;text-align:center;font-size:11px;color:#999999;border-top:1px solid #eeeeee;">You received this because you're a customer of ${biz.business_name}. <a href="${unsubUrl}" style="color:#999999;text-decoration:underline;">Unsubscribe</a></td></tr></table>`
        const personalizedHtml = html.replace(/\{name\}/gi, customer.name?.split(' ')[0] || 'there') + unsubFooter
        await sgMail.send({
          from: { email: 'noreply@mail.getwexly.com', name: biz.business_name },
          to: customer.email,
          subject,
          html: personalizedHtml,
          replyTo: biz.email || 'hello@getwexly.com'
        })
        sent++
        await new Promise(r => setTimeout(r, 100))
      } catch(err) {
        console.error(`[Broadcast] Failed ${customer.email}:`, err.message)
      }
    }

    await sb.from('email_campaigns').insert({
      business_id: businessId, subject, sent_count: sent, audience: audience || 'all'
    })

    console.log(`[Broadcast] Sent ${sent} for ${biz.business_name}`)
    res.json({ success: true, sent })
  } catch(err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/support/ticket', async (req, res) => {
  const { name, email, business, category, description, conversation } = req.body
  if (!name || !email || !description) return res.status(400).json({ error: 'Missing fields' })

  try {
    const sgMail = require('@sendgrid/mail')
    sgMail.setApiKey(process.env.SENDGRID_API_KEY)
    const ownerEmail = process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
    const categoryLabels = {
      'bot-not-responding': 'Bot not responding',
      'setup-help': 'Setup help',
      'billing': 'Billing question',
      'feature-question': 'Feature question',
      'bug': 'Something broken',
      'other': 'Other'
    }

    await sgMail.send({
      from: 'Wexly Support <hello@getwexly.com>',
      to: ownerEmail,
      replyTo: email,
      subject: `🎫 Support ticket — ${categoryLabels[category] || category} — ${name}`,
      html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
    <div style="background:#0F0F0E;padding:24px 32px;">
      <div style="font-family:Georgia,serif;font-size:22px;color:#FAF9F6;letter-spacing:-0.5px;">Wex<em style="color:#4ade80;">ly</em></div>
    </div>
    <div style="padding:32px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#7A7972;margin-bottom:16px;">Support ticket</div>
      <h1 style="font-family:Georgia,serif;font-size:22px;color:#0F0F0E;margin:0 0 24px;letter-spacing:-0.5px;">${categoryLabels[category] || 'Support request'}</h1>

      <div style="background:#F3F2EE;border-radius:10px;padding:20px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(15,15,14,0.06);">
          <span style="font-size:13px;color:#7A7972;">Name</span>
          <span style="font-size:13px;font-weight:500;color:#0F0F0E;">${name}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(15,15,14,0.06);">
          <span style="font-size:13px;color:#7A7972;">Email</span>
          <span style="font-size:13px;font-weight:500;color:#1A6B4A;">${email}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(15,15,14,0.06);">
          <span style="font-size:13px;color:#7A7972;">Business</span>
          <span style="font-size:13px;font-weight:500;color:#0F0F0E;">${business || 'Not specified'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:7px 0;">
          <span style="font-size:13px;color:#7A7972;">Category</span>
          <span style="font-size:13px;font-weight:500;color:#0F0F0E;">${categoryLabels[category] || category}</span>
        </div>
      </div>

      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#7A7972;margin-bottom:8px;">Issue description</div>
        <div style="background:#F3F2EE;border-radius:10px;padding:16px;font-size:14px;color:#3A3A36;line-height:1.7;">${description}</div>
      </div>

      ${conversation && conversation !== 'No prior chat conversation.' ? `
      <div>
        <div style="font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#7A7972;margin-bottom:8px;">Chat conversation before ticket</div>
        <div style="background:#F3F2EE;border-radius:10px;padding:16px;font-size:13px;color:#7A7972;line-height:1.7;white-space:pre-wrap;">${conversation}</div>
      </div>` : ''}

      <div style="margin-top:24px;padding:14px;background:#E8F4EE;border-radius:8px;font-size:13px;color:#1A6B4A;">
        💡 Reply directly to this email to respond to ${name}
      </div>
    </div>
  </div>
</body>
</html>`
    })

    console.log(`[Support] Ticket from ${name} (${email}) — ${category}`)
    res.json({ success: true })
  } catch (err) {
    console.error('[Support] Ticket error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── STRIPE CONNECT ──────────────────────────────────────────────────────────

// Step 1: Generate OAuth URL for owner to connect their Stripe account
app.get('/stripe-connect/oauth-url', requireAuth, async (req, res) => {
  const { businessId } = req.query
  if (!businessId) return res.status(400).json({ error: 'Missing businessId' })

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
  const state = Buffer.from(JSON.stringify({ businessId })).toString('base64')

  const url = stripe.oauth.authorizeUrl({
    response_type: 'code',
    client_id: process.env.STRIPE_CONNECT_CLIENT_ID,
    scope: 'read_write',
    state,
    redirect_uri: `${process.env.BOT_URL}/stripe-connect/callback`,
  })

  res.json({ url })
})

// Step 2: OAuth callback — exchange code for account ID
app.get('/stripe-connect/callback', async (req, res) => {
  const { code, state } = req.query
  if (!code || !state) return res.status(400).send('Missing code or state')

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
    const { businessId } = JSON.parse(Buffer.from(state, 'base64').toString())
    const response = await stripe.oauth.token({ grant_type: 'authorization_code', code })
    const accountId = response.stripe_user_id

    await supabase.from('businesses')
      .update({ stripe_account_id: accountId, stripe_account_connected: true })
      .eq('id', businessId)

    // Redirect back to dashboard billing section
    res.redirect(`${process.env.SITE_URL}/dashboard.html?stripe_connected=1`)
  } catch (err) {
    console.error('[Stripe Connect] OAuth error:', err.message)
    res.redirect(`${process.env.SITE_URL}/dashboard.html?stripe_error=1`)
  }
})

// Step 3: Disconnect Stripe account
app.post('/stripe-connect/disconnect', requireBusinessAuth, async (req, res) => {
  const { businessId } = req.body
  if (!businessId) return res.status(400).json({ error: 'Missing businessId' })

  const { data: biz } = await supabase.from('businesses')
    .select('stripe_account_id').eq('id', businessId).maybeSingle()

  if (biz?.stripe_account_id) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
      await stripe.oauth.deauthorize({ client_id: process.env.STRIPE_CONNECT_CLIENT_ID, stripe_user_id: biz.stripe_account_id })
    } catch (e) { /* ignore deauth errors */ }
  }

  await supabase.from('businesses')
    .update({ stripe_account_id: null, stripe_account_connected: false })
    .eq('id', businessId)

  res.json({ success: true })
})

// Refund a deposit on a connected Stripe account
app.post('/stripe-connect/refund-deposit', requireBusinessAuth, async (req, res) => {
  const { businessId, appointmentId } = req.body
  if (!businessId || !appointmentId) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { data: biz } = await supabase.from('businesses')
      .select('stripe_account_id, stripe_account_connected').eq('id', businessId).maybeSingle()

    if (!biz?.stripe_account_connected || !biz?.stripe_account_id) {
      return res.status(400).json({ error: 'Stripe not connected' })
    }

    const { data: appt } = await supabase.from('appointments')
      .select('*').eq('id', appointmentId).maybeSingle()

    if (!appt) return res.status(404).json({ error: 'Appointment not found' })
    if (!appt.deposit_payment_intent_id) return res.status(400).json({ error: 'No deposit payment found for this appointment' })

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
    const refund = await stripe.refunds.create(
      { payment_intent: appt.deposit_payment_intent_id },
      { stripeAccount: biz.stripe_account_id }
    )

    await supabase.from('appointments').update({
      deposit_status: 'refunded',
      refund_requested: false,
      refund_processed_at: new Date().toISOString()
    }).eq('id', appointmentId)

    console.log(`[Refund] Processed refund for appt ${appointmentId} — ${refund.id}`)
    res.json({ success: true, refund_id: refund.id })
  } catch (err) {
    console.error('[Refund] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Step 3.5: Create a post-visit invoice with tip options (10/15/20/custom)
app.post('/stripe-connect/create-invoice', requireBusinessAuth, async (req, res) => {
  const { businessId, customerName, customerPhone, lineItems, discountCents, notes } = req.body
  if (!businessId || !lineItems?.length) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { data: biz } = await supabase.from('businesses')
      .select('stripe_account_id, stripe_account_connected, business_name')
      .eq('id', businessId).maybeSingle()

    if (!biz?.stripe_account_connected || !biz?.stripe_account_id)
      return res.status(400).json({ error: 'Stripe not connected' })

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

    const stripeLineItems = lineItems.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: { name: item.name },
        unit_amount: Math.round(item.amount / (item.qty || 1)),
      },
      quantity: item.qty || 1,
    }))

    // Calculate total and 1% platform fee
    const totalCents = lineItems.reduce((sum, item) => sum + Math.round(item.amount), 0) - Math.round(discountCents || 0)
    // 🔒 PROTECTED — Platform fee = 1% with 50¢ floor. See PROTECTED_DECISIONS.md Entry 2.
    const platformFee = Math.max(50, Math.round(totalCents * 0.01))

    const sessionParams = {
      mode: 'payment',
      line_items: stripeLineItems,
      payment_intent_data: {
        application_fee_amount: platformFee,
        statement_descriptor_suffix: (biz.business_name || '').slice(0, 22).trim(),
        metadata: { businessId, customerPhone: customerPhone || '', customerName: customerName || '', type: 'invoice' }
      },
      metadata: { businessId, customerPhone: customerPhone || '', customerName: customerName || '', type: 'invoice' },
      custom_text: {
        submit: { message: `Thank you for visiting ${biz.business_name}! A tip is optional but always appreciated.` }
      },
      success_url: `${process.env.SITE_URL || 'https://getwexly.com'}/payment-confirmed.html`,
      cancel_url: `${process.env.SITE_URL || 'https://getwexly.com'}/payment-cancelled.html`,
    }

    // Add discount coupon if applicable
    if (discountCents > 0) {
      const coupon = await stripe.coupons.create(
        { amount_off: Math.round(discountCents), currency: 'usd', duration: 'once', name: 'Discount' },
        { stripeAccount: biz.stripe_account_id }
      )
      sessionParams.discounts = [{ coupon: coupon.id }]
    }

    const session = await stripe.checkout.sessions.create(sessionParams, { stripeAccount: biz.stripe_account_id })

    console.log(`[Invoice] Stripe checkout created for ${customerName} at ${biz.business_name} — platform fee: $${(platformFee/100).toFixed(2)}`)
    res.json({ url: session.url })
  } catch (err) {
    console.error('[Invoice] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Step 3.6: SMS tip prompt before the invoice link.
// 🔒 PROTECTED — See PROTECTED_DECISIONS.md Entry 56. Texts the customer a
// tip prompt (percentages from businesses.tip_percentages), then the reply
// handler in src/bot/tipFlow.js builds the Stripe session with the tip as an
// untaxed line item and texts the link. 10-min no-reply fallback sends the link
// with no tip. Dashboard falls back to /create-invoice if this returns an error.
app.post('/stripe-connect/checkout-tip-prompt', requireBusinessAuth, async (req, res) => {
  const { businessId, customerName, customerPhone, lineItems, discountCents, notes, subtotalCents, taxCents, staffName, appointmentId, transactionId } = req.body
  if (!businessId || !lineItems?.length) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { data: biz } = await supabase.from('businesses')
      .select('id, stripe_account_id, stripe_account_connected, business_name, sms_number, tip_prompt_enabled, tip_percentages')
      .eq('id', businessId).maybeSingle()

    if (!biz?.stripe_account_connected || !biz?.stripe_account_id)
      return res.status(400).json({ error: 'Stripe not connected' })
    if (biz.tip_prompt_enabled === false)
      return res.status(409).json({ error: 'Tip prompt disabled for this business', code: 'TIP_PROMPT_DISABLED' })

    const { startTipPrompt } = require('./src/bot/tipFlow')
    const result = await startTipPrompt({ biz, customerName, customerPhone, lineItems, discountCents, notes, subtotalCents, taxCents, staffName, appointmentId, transactionId })
    res.json({ success: true, pendingId: result.id, percentages: result.percentages, preTipTotalCents: result.preTipTotalCents })
  } catch (err) {
    console.error('[Tip] checkout-tip-prompt error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
app.post('/stripe-connect/create-deposit', requireInternalOrBusinessAuth, async (req, res) => {
  const { businessId, appointmentId, amount, description } = req.body
  if (!businessId || !appointmentId || !amount) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { data: biz } = await supabase.from('businesses')
      .select('stripe_account_id, stripe_account_connected, business_name, sms_number')
      .eq('id', businessId).maybeSingle()

    if (!biz?.stripe_account_connected || !biz?.stripe_account_id)
      return res.status(400).json({ error: 'Stripe not connected' })

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

    // 🔒 PROTECTED — Platform fee = 1% with 50¢ floor. See PROTECTED_DECISIONS.md Entry 2.
    const amountCents = Math.round(amount)
    const platformFee = Math.max(50, Math.round(amountCents * 0.01))

    // Create checkout session on connected account with platform fee
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: description || `Deposit — ${biz.business_name}` },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: platformFee,
        statement_descriptor_suffix: (biz.business_name || '').slice(0, 22).trim(),
        metadata: { businessId, appointmentId }
      },
      metadata: { businessId, appointmentId },
      success_url: `${process.env.SITE_URL || 'https://getwexly.com'}/deposit-confirmed.html`,
      cancel_url: `${process.env.SITE_URL || 'https://getwexly.com'}/deposit-cancelled.html`,
    }, { stripeAccount: biz.stripe_account_id })

    // Save link on appointment
    await supabase.from('appointments')
      .update({ deposit_link: session.url, deposit_status: 'pending', deposit_amount: amountCents })
      .eq('id', appointmentId)

    res.json({ url: session.url })
  } catch (err) {
    console.error('[Stripe Connect] Create deposit error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Step 5: Stripe webhook — deposit paid
// Stripe sends this when customer pays the deposit link.
// Raw body is provided by the global carve-out near the top (before express.json).
app.post('/stripe-connect/webhook', async (req, res) => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
  const sig = req.headers['stripe-signature']

  // Try multiple secrets — if more than one webhook endpoint points at this URL
  // (e.g. the live Connect endpoint plus a leftover or Stripe-CLI endpoint),
  // each delivery is signed with a DIFFERENT secret. Verifying against only one
  // makes the others 400 with "no signatures found matching". We accept any.
  const candidateSecrets = [
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET_2,
    process.env.STRIPE_WEBHOOK_SECRET
  ].filter(Boolean)

  let event = null
  let matchedIndex = -1
  for (let i = 0; i < candidateSecrets.length; i++) {
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, candidateSecrets[i])
      matchedIndex = i
      break
    } catch (err) { /* try next secret */ }
  }

  if (!event) {
    // Couldn't verify with any known secret. This is almost always noise from a
    // stray/duplicate webhook endpoint (e.g. account.updated) signed with a
    // secret we don't hold. Return 200 (not 400) so Stripe stops retrying it and
    // our logs stay clean — a 400 here just triggers a retry storm at scale.
    // We log ONE concise line, not a wall of errors.
    console.warn(`[Stripe-Connect Webhook] ignored unverifiable delivery (${req.body?.length || 0} bytes) — not signed by a known secret; acking 200 to stop retries`)
    return res.status(200).json({ received: true, ignored: 'unverified' })
  }

  const SECRET_LABELS = ['STRIPE_CONNECT_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET_2', 'STRIPE_WEBHOOK_SECRET']
  console.log(`[Stripe-Connect Webhook] ✅ verified ${event.type}${event.account ? ` (acct ${event.account})` : ''} via ${SECRET_LABELS[matchedIndex] || 'secret#' + matchedIndex}`)

  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    const obj = event.data.object
    const { businessId, appointmentId, customerPhone, customerName, type } = obj.metadata || {}
    if (!businessId) return res.json({ received: true })

    try {
      const { sendSMS } = require('./src/utils/sms')
      const { data: biz } = await supabase.from('businesses')
        .select('sms_number, business_name').eq('id', businessId).maybeSingle()
      if (!biz) return res.json({ received: true })

      const amountTotal = obj.amount_total || obj.amount_received || 0  // cents
      const amountSubtotal = obj.amount_subtotal || amountTotal

      if (type === 'invoice') {
        // Post-visit invoice paid — record tip in transaction.
        // 🔒 Entry 56: with the SMS tip flow the tip is its own LINE ITEM, so
        // amount_total − amount_subtotal is 0. Prefer metadata.tip_cents (set by
        // tipFlow.createInvoiceCheckoutSession); fall back to the old math for
        // sessions built without it (e.g. Stripe-native tipping still enabled).
        const metaTip = parseInt(obj.metadata?.tip_cents, 10)
        const tipCents = Number.isFinite(metaTip) ? metaTip : (amountTotal - amountSubtotal)
        const firstName = (customerName || 'there').split(' ')[0]

        // Find the transaction: by id when the session carries it, else the
        // most recent 'sent' row for this customer.
        const metaTxId = obj.metadata?.transaction_id || null
        let txn = null
        if (metaTxId) {
          const { data } = await supabase.from('transactions').select('*').eq('id', metaTxId).maybeSingle()
          txn = data
        }
        if (!txn) {
          const { data } = await supabase.from('transactions')
            .select('*')
            .eq('business_id', businessId)
            .eq('customer_phone', customerPhone)
            .eq('status', 'sent')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          txn = data
        }

        // Update ONLY that row. (The previous .update().order().limit(1) did not
        // limit on PostgREST — it stamped every 'sent' row for the phone.)
        if (txn?.id) {
          await supabase.from('transactions')
            .update({ status: 'paid', tip: Math.max(0, tipCents), total: amountTotal })
            .eq('id', txn.id)
        }

        // Auto-decrement product qty for any products in the line items
        if (txn?.line_items?.length) {
          for (const item of txn.line_items) {
            if (!item.product_id) continue
            try {
              const { data: product } = await supabase.from('products')
                .select('id, name, qty, low_stock_threshold, business_id')
                .eq('id', item.product_id).maybeSingle()

              if (!product || product.qty === null) continue

              const newQty = Math.max(0, (product.qty || 0) - (item.qty || 1))
              await supabase.from('products').update({ qty: newQty }).eq('id', product.id)

              // Low stock alert to owner
              if (product.low_stock_threshold !== null && newQty <= product.low_stock_threshold) {
                if (biz.sms_number && biz.owner_phone) {
                  await sendSMS(biz.sms_number, biz.owner_phone,
                    `⚠️ Low stock alert: ${product.name} — only ${newQty} left. Text "restock [product] [qty]" to update.`
                  ).catch(() => {})
                }
              }
              console.log(`[Products] Decremented ${product.name} qty: ${product.qty} → ${newQty}`)
            } catch (err) {
              console.error('[Products] Qty decrement error:', err.message)
            }
          }
        }

        // Send thank you text
        const tipMsg = tipCents > 0 ? ` (including $${(tipCents/100).toFixed(2)} tip — thank you so much!)` : ''
        await sendSMS(biz.sms_number, customerPhone,
          `✅ Payment received${tipMsg} — thank you ${firstName}! See you next time at ${biz.business_name} 😊`
        ).catch(() => {})

        console.log(`[Invoice] Paid — ${customerName} $${(amountTotal/100).toFixed(2)} tip: $${(tipCents/100).toFixed(2)}`)

      } else if (appointmentId) {
        // Deposit paid — confirm the appointment.
        // Idempotency: if already marked paid, don't re-process or re-notify
        // (guards against Stripe retries / manual resends sending duplicate texts).
        const { data: existingAppt } = await supabase.from('appointments')
          .select('deposit_status').eq('id', appointmentId).maybeSingle()
        if (existingAppt?.deposit_status === 'paid') {
          console.log(`[Deposit] appt ${appointmentId} already marked paid — skipping duplicate processing`)
          return res.json({ received: true, already_processed: true })
        }
        const paymentIntentId = obj.payment_intent || obj.id || null
        await supabase.from('appointments')
          .update({
            status: 'confirmed',
            deposit_status: 'paid',
            deposit_expires_at: null,  // clear expiry since they paid
            deposit_payment_intent_id: paymentIntentId
          })
          .eq('id', appointmentId)

        const { data: appt } = await supabase.from('appointments')
          .select('*').eq('id', appointmentId).maybeSingle()

        if (appt) {
          const firstName = appt.name?.split(' ')[0] || 'there'
          const service = appt.service || 'appointment'
          const date = appt.date ? new Date(appt.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : ''

          // 🔒 PROTECTED — Zoom link delivered AFTER deposit paid. See
          // PROTECTED_DECISIONS.md Entry 19. For virtual businesses, the meeting
          // link is intentionally NOT in the booking confirmation when a deposit
          // is required — it's held until payment so the customer can't get the
          // join link without securing the slot. Load the business's virtual
          // settings to append it here.
          const { data: bizVirtual } = await supabase.from('businesses')
            .select('location_type, meeting_link').eq('id', businessId).maybeSingle()
          let zoomAppend = ''
          if (bizVirtual?.location_type === 'virtual' && bizVirtual?.meeting_link) {
            zoomAppend = `\n\n🎥 Join via video: ${bizVirtual.meeting_link}`
          }

          await sendSMS(biz.sms_number, appt.phone || appt.customer_phone,
            `✅ Deposit received! Your ${service} at ${biz.business_name} on ${date} is confirmed. See you then ${firstName}!${zoomAppend}`
          ).catch(() => {})
          console.log(`[Deposit] Paid for appt ${appointmentId} — ${firstName}${zoomAppend ? ' (zoom link sent)' : ''}`)
        }
      }
    } catch (err) {
      console.error('[Stripe Webhook] Processing error:', err.message)
    }
  }

  res.json({ received: true })
})

// ── NO-SHOW RECOVERY ────────────────────────────────────────────────────────
// Called from dashboard when owner marks an appointment as no-show
app.post('/appointments/no-show', requireBusinessAuth, async (req, res) => {
  const { appointmentId, businessId } = req.body
  if (!appointmentId || !businessId) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { sendSMS } = require('./src/utils/sms')
    const sb = require('./src/db/client')

    // Get business settings
    const { data: biz } = await sb.from('businesses')
      .select('sms_number, business_name, noshow_recovery_enabled, noshow_recovery_message')
      .eq('id', businessId)
      .maybeSingle()

    if (!biz) return res.status(404).json({ error: 'Business not found' })
    if (!biz.noshow_recovery_enabled) return res.json({ sent: false, reason: 'Recovery not enabled' })

    // Get appointment + customer
    const { data: appt } = await sb.from('appointments')
      .select('*, customers(phone, name)')
      .eq('id', appointmentId)
      .maybeSingle()

    if (!appt) return res.status(404).json({ error: 'Appointment not found' })

    const customerPhone = appt.customers?.phone || appt.phone
    const customerName = appt.customers?.name || appt.name || 'there'
    const firstName = customerName.split(' ')[0]
    const service = appt.service || 'appointment'

    const defaultMsg = `Hey ${firstName}! We had you down for a ${service} today — did something come up? No worries, just text back whenever you're ready to reschedule 😊`
    let msg = biz.noshow_recovery_message || defaultMsg
    msg = msg.replace(/{name}/gi, firstName).replace(/{service}/gi, service)

    await sendSMS(biz.sms_number, customerPhone, msg)

    console.log(`[No-show] Recovery text sent to ${customerPhone} for appt ${appointmentId}`)
    res.json({ sent: true })
  } catch (err) {
    console.error('[No-show] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── SETUP CALLS ──────────────────────────────────────────────────────────────

// GET available slots — reads admin_settings for call config, returns open slots
app.get('/setup-calls/slots', async (req, res) => {
  try {
    const zoomLink = process.env.SETUP_CALL_ZOOM_LINK || ''
    const days = (process.env.SETUP_CALL_DAYS || 'Mon,Tue,Wed,Thu,Fri').split(',').map(d => d.trim())
    const startHour = parseInt(process.env.SETUP_CALL_START_HOUR || '10')
    const endHour = parseInt(process.env.SETUP_CALL_END_HOUR || '14')
    const duration = parseInt(process.env.SETUP_CALL_DURATION || '20')
    const tzOffset = parseInt(process.env.SETUP_CALL_TZ_OFFSET || '-7') // PDT = -7, PST = -8

    const slots = []
    const now = new Date()

    for (let i = 1; i <= 14; i++) {
      const date = new Date(now)
      date.setDate(now.getDate() + i)
      const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]
      if (!days.includes(dayName)) continue

      // Generate slots as UTC timestamps that represent the correct local time
      let h = startHour
      let m = 0
      while (h < endHour) {
        // Create a date at midnight UTC for this date, then add hours offset by timezone
        const slot = new Date(date)
        slot.setUTCHours(h - tzOffset, m, 0, 0)
        slots.push(slot.toISOString())
        m += duration
        if (m >= 60) { h += Math.floor(m/60); m = m % 60 }
      }
    }

    const { data: booked } = await supabase
      .from('setup_calls').select('scheduled_at')
      .eq('status', 'scheduled').gte('scheduled_at', now.toISOString())

    const bookedSet = new Set((booked || []).map(b => new Date(b.scheduled_at).toISOString()))
    const available = slots.filter(s => !bookedSet.has(s))

    res.json({ slots: available, zoom_link: zoomLink })
  } catch (err) {
    console.error('[SetupCalls] Slots error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST book a setup call
app.post('/setup-calls/book', async (req, res) => {
  const { name, business_name, email, phone, scheduled_at } = req.body
  if (!name || !email || !scheduled_at) return res.status(400).json({ error: 'Missing required fields' })

  try {
    // Check slot is still available
    const { data: existing } = await supabase
      .from('setup_calls')
      .select('id').eq('scheduled_at', scheduled_at).eq('status', 'scheduled').maybeSingle()

    if (existing) return res.status(409).json({ error: 'That time slot is no longer available — please pick another.' })

    // Get zoom link from env var
    const zoomLink = process.env.SETUP_CALL_ZOOM_LINK || ''

    // Insert the booking
    const { data: call, error } = await supabase.from('setup_calls').insert({
      name, business_name, email, phone, scheduled_at, status: 'scheduled'
    }).select().single()

    if (error) throw error

    // Format date for messages
    const dt = new Date(scheduled_at)
    const dateStr = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

    // Send emails via SendGrid directly
    const sgMail = require('@sendgrid/mail')
    if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY)
    const fromEmail = { email: 'hello@getwexly.com', name: 'Wexly' }

    if (email && process.env.SENDGRID_API_KEY) {
      sgMail.send({
        from: fromEmail,
        to: email,
        subject: `Your Wexly setup call is confirmed`,
        html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:40px auto;">
          <div style="background:#1A6B4A;padding:24px 32px;border-radius:12px 12px 0 0;"><img src="https://getwexly.com/logo-email.png" style="height:32px;" alt="Wexly"></div>
          <div style="padding:32px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
            <h2 style="font-size:22px;color:#0F0F0E;margin:0 0 12px;">You're booked, ${name.split(' ')[0]}!</h2>
            <p style="color:#666;line-height:1.7;margin:0 0 20px;">Your free setup call is confirmed for <strong>${dateStr} at ${timeStr}</strong>.</p>
            ${zoomLink ? `<a href="${zoomLink}" style="display:inline-block;background:#1A6B4A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">Join Zoom call →</a>` : ''}
            <p style="color:#999;font-size:13px;margin-top:20px;">Questions? Reply to this email.</p>
          </div>
        </div>`
      }).catch(err => console.error('[SetupCalls] Customer email failed:', err.message))
    }

    // Alert owner
    const ownerEmail = process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
    if (process.env.SENDGRID_API_KEY) {
      sgMail.send({
        from: fromEmail,
        to: ownerEmail,
        subject: `New setup call — ${name} · ${dateStr} at ${timeStr}`,
        html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:40px auto;">
          <h2 style="color:#0F0F0E;">New setup call booked</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Business:</strong> ${business_name || '—'}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Phone:</strong> ${phone || '—'}</p>
          <p><strong>When:</strong> ${dateStr} at ${timeStr}</p>
          ${zoomLink ? `<a href="${zoomLink}" style="display:inline-block;margin-top:12px;background:#1A6B4A;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">Join Zoom →</a>` : ''}
        </div>`
      }).catch(err => console.error('[SetupCalls] Owner email failed:', err.message))
    }

    console.log(`[SetupCalls] Booked — ${name} at ${scheduled_at}`)
    res.json({ success: true, call_id: call.id })
  } catch (err) {
    console.error('[SetupCalls] Book error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   Wexly SMS Bot v2.0                 ║
  ║   BUILD: v197 (audit fixes)          ║
  ║   Running on port ${PORT}               ║
  ║                                      ║
  ║   SMS:    POST /webhook/sms          ║
  ║   Stripe: POST /stripe/webhook       ║
  ║   Health: GET  /health               ║
  ╚══════════════════════════════════════╝
  `)
  disableRLS()
  startScheduler()

  // Verify the session_state column exists — intake/booking flows depend on it.
  ;(async () => {
    try {
      const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      const { error } = await sb.from('conversation_sessions').select('session_state').limit(1)
      if (error && /session_state|column/i.test(error.message || '')) {
        console.error('🔴🔴🔴 STARTUP CHECK FAILED: conversation_sessions.session_state column is MISSING.')
        console.error('🔴 Intake-before-booking and multi-step flows will NOT work until you run add-session-state-column.sql in Supabase. 🔴')
      } else {
        console.log('✅ Startup check: session_state column present — flow persistence enabled.')
      }
    } catch (e) {
      console.warn('[Startup] Could not verify session_state column:', e.message)
    }
  })()
})

module.exports = app

// ── SMS CAMPAIGNS ────────────────────────────────────────────────────────────
app.post('/campaigns/sms/send', requireBusinessAuth, async (req, res) => {
  const { businessId, message, audience, scheduleTime } = req.body
  if (!message) return res.status(400).json({ error: 'Message required' })

  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendSMS } = require('./src/utils/sms')

  // Get business
  const { data: biz } = await sb.from('businesses').select('*').eq('id', businessId).maybeSingle()
  if (!biz || !biz.sms_number) return res.status(400).json({ error: 'Business has no SMS number' })
  if (biz.plan !== 'pro') return res.status(403).json({ error: 'SMS campaigns require Pro plan' })

  // Quiet hours check
  const tz = biz.timezone || 'America/New_York'
  const localHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()))
  if (localHour < 8 || localHour >= 21) {
    return res.status(400).json({ error: 'SMS campaigns can only be sent between 8 AM and 9 PM in your timezone. Current local time: ' + localHour + ':00' })
  }

  // If scheduled, save and return
  if (scheduleTime) {
    await sb.from('sms_campaigns').insert({
      business_id: businessId,
      message,
      audience,
      scheduled_at: scheduleTime,
      status: 'scheduled',
      sent_count: 0,
      failed_count: 0
    })
    return res.json({ scheduled: true, time: scheduleTime })
  }

  // Get eligible recipients
  let query = sb.from('customers').select('phone, name')
    .eq('business_id', businessId)
    .not('phone', 'is', null)
    .neq('fully_opted_out', true)
    .neq('marketing_opted_out', true)

  if (audience === 'recent') {
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    // Get phones that have appointments in last 30 days
    const { data: recentAppts } = await sb.from('appointments')
      .select('customer_phone')
      .eq('business_id', businessId)
      .gte('appointment_date', thirtyDaysAgo.toISOString().split('T')[0])
    const recentPhones = [...new Set((recentAppts || []).map(a => a.customer_phone).filter(Boolean))]
    if (recentPhones.length === 0) return res.json({ sent: 0, failed: 0 })
    query = query.in('phone', recentPhones)
  } else if (audience === 'inactive') {
    const sixtyDaysAgo = new Date()
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)
    const { data: activeAppts } = await sb.from('appointments')
      .select('customer_phone')
      .eq('business_id', businessId)
      .gte('appointment_date', sixtyDaysAgo.toISOString().split('T')[0])
    const activePhones = new Set((activeAppts || []).map(a => a.customer_phone).filter(Boolean))
    // Fetch all eligible, then filter out active ones in JS
    const { data: allCusts } = await query
    query = null // Mark as consumed
    var inactiveRecipients = (allCusts || []).filter(c => !activePhones.has(c.phone))
  }

  const recipients = inactiveRecipients || (query ? (await query).data : null) || []
  if (!recipients?.length) return res.json({ sent: 0, failed: 0 })

  // Send with rate limiting (1 per 200ms to stay under Twilio limits)
  const fullMsg = message + '\n\nReply STOP to unsubscribe.'
  let sent = 0, failed = 0

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i]
    try {
      await sendSMS(biz.sms_number, r.phone, fullMsg)
      sent++

      // Save campaign message to customer's conversation session so bot has context
      const { data: session } = await sb.from('conversation_sessions')
        .select('messages')
        .eq('business_id', businessId)
        .eq('customer_phone', r.phone)
        .maybeSingle()

      const msgs = session?.messages || []
      msgs.push({ role: 'assistant', content: '[CAMPAIGN] ' + message })
      // Keep last 30
      const trimmed = msgs.length > 30 ? msgs.slice(-30) : msgs

      await sb.from('conversation_sessions').upsert({
        business_id: businessId,
        customer_phone: r.phone,
        messages: trimmed,
        last_activity: new Date().toISOString(),
        abandoned_reminder_sent: false
      }, { onConflict: 'business_id,customer_phone' })
    } catch(err) {
      console.error(`[SMS Campaign] Failed to send to ${r.phone}:`, err.message)
      failed++
    }
    // Rate limit: 1 message per 200ms = 5/sec (Twilio allows ~10/sec on 10DLC)
    if (i < recipients.length - 1) await new Promise(resolve => setTimeout(resolve, 200))
  }

  // Save campaign record
  await sb.from('sms_campaigns').insert({
    business_id: businessId,
    message,
    audience,
    status: 'sent',
    sent_count: sent,
    failed_count: failed,
    recipient_count: recipients.length
  })

  console.log(`[SMS Campaign] ${biz.business_name}: sent ${sent}, failed ${failed} of ${recipients.length}`)
  res.json({ sent, failed, total: recipients.length })
})

// ── ABANDONED SIGNUP CART ────────────────────────────────────────────────────
app.post('/signup/capture', async (req, res) => {
  const { email, name, business_name, business_type, plan } = req.body
  if (!email) return res.status(400).json({ error: 'Email required' })

  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

  // Check if already a customer
  const { data: existing } = await sb.from('businesses').select('id').eq('email', email).maybeSingle()
  if (existing) return res.json({ status: 'already_signed_up' })

  // Upsert pending signup
  await sb.from('pending_signups').upsert({
    email,
    name: name || null,
    business_name: business_name || null,
    business_type: business_type || null,
    plan: plan || null,
    captured_at: new Date().toISOString(),
    converted: false
  }, { onConflict: 'email' })

  console.log(`[Cart] Captured signup: ${email} (${business_name || 'no biz name'})`)
  res.json({ status: 'captured' })
})

// ── TRACKING PIXELS — public endpoint for dynamic injection ─────────────────
app.get('/tracking-pixels', async (req, res) => {
  try {
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data } = await sb.from('tracking_pixels').select('type, value, active').eq('active', true)

    var scripts = (data || []).map(function(p) {
      switch(p.type) {
        case 'meta':
          return "!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','" + p.value + "');fbq('track','PageView');"
        case 'tiktok':
          return "!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};ttq.load=function(e,n){var i='https://analytics.tiktok.com/i18n/pixel/events.js';ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=document.createElement('script');o.type='text/javascript';o.async=!0;o.src=i+'?sdkid='+e+'&lib='+t;var a=document.getElementsByTagName('script')[0];a.parentNode.insertBefore(o,a)}}(window,document,'ttq');ttq.load('" + p.value + "');ttq.page();"
        case 'ga4':
          return "(function(){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=" + p.value + "';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','" + p.value + "')})();"
        case 'google_ads':
          return "(function(){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=" + p.value + "';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','" + p.value + "')})();"
        case 'custom':
          return p.value
        default:
          return ''
      }
    }).filter(Boolean)

    res.set('Cache-Control', 'public, max-age=300')
    res.set('Access-Control-Allow-Origin', '*')
    res.json({ scripts })
  } catch(err) {
    res.json({ scripts: [] })
  }
})
