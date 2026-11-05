// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ ⚠️ ⚠️  ORPHAN FILE — NOT LOADED AT RUNTIME — DO NOT ADD ROUTES HERE  ⚠️ ⚠️ ⚠️
// ═══════════════════════════════════════════════════════════════════════════
// This file is NOT the entry point. package.json declares "main": "index.js"
// (the top-level one). Nothing in the codebase requires this file.
//
// All Express routes MUST go in the top-level /home/claude/bot-v3/index.js
// or in a router that's required by it (e.g. src/routes/stripe.js).
//
// Kept around as reference for some auth patterns. If you find yourself
// tempted to add a route here — DON'T. It will silently 404 at runtime.
//
// See PROTECTED_DECISIONS.md Entry 12 for the full story.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const morgan = require('morgan')
const webhookRouter = require('./routes/webhook')
const { sendReminders, sendFollowUps } = require('./bot/scheduler')

const app = express()
const PORT = process.env.PORT || 3000

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'https://getwexly.com',
      'https://www.getwexly.com',
      'http://localhost:3000',
      'http://localhost:8888'
    ]
    // Allow Twilio/Stripe webhooks (no origin header) and allowed origins
    if (!origin || allowed.includes(origin)) return callback(null, true)
    callback(new Error('Not allowed by CORS'))
  },
  credentials: true
}))
app.use(morgan('dev'))
app.use(express.urlencoded({ extended: false }))  // Twilio sends form-encoded bodies
app.use(express.json())

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRouter)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdminSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.body?.secret || req.query?.secret
  if (!process.env.ADMIN_SECRET || secret === process.env.ADMIN_SECRET) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

// ── Owner action auth — verify business owns the appointment ──────────────────
async function requireBusinessAuth(req, res, next) {
  const { businessId, appointmentId } = req.body
  if (!businessId) return res.status(400).json({ error: 'Missing businessId' })
  // Basic check — businessId must be a valid UUID
  if (!/^[0-9a-f-]{36}$/.test(businessId)) return res.status(400).json({ error: 'Invalid businessId' })
  next()
}

// Manual trigger endpoints for scheduler jobs (protect these in production!)
app.post('/admin/run-reminders', requireAdminSecret, async (req, res) => {
  try {
    await sendReminders()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/admin/run-followups', requireAdminSecret, async (req, res) => {
  try {
    await sendFollowUps()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Owner action endpoints (called from dashboard) ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// 🔒 PROTECTED — See PROTECTED_DECISIONS.md Entry 12 (Send-quote URL + media proxy)
// 🔒 Route MUST stay at /owner-action/send-quote — dashboard calls this URL.
// 🔒 Body MUST accept both camelCase AND snake_case field names — do not tighten.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/owner-action/send-quote', requireBusinessAuth, async (req, res) => {
  try {
    // Accept both naming conventions for resilience — see PROTECTED_DECISIONS
    // Entry 12 for context on why we tolerate both.
    const appointmentId = req.body.appointmentId || req.body.appointment_id
    const businessId = req.body.businessId || req.body.business_id
    const price = req.body.price || req.body.quote_amount
    if (!appointmentId || !businessId || !price) {
      return res.status(400).json({ error: 'Missing appointmentId/businessId/price' })
    }
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

    const { data: appt } = await sb.from('appointments').select('*').eq('id', appointmentId).maybeSingle()
    if (!appt) return res.status(404).json({ error: 'Appointment not found' })

    const { data: biz } = await sb.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (!biz) return res.status(404).json({ error: 'Business not found' })

    const firstName = appt.customer_name?.split(' ')[0] || 'there'
    const serviceName = appt.service_name || 'your service'

    // Format price for display. Accept "$120", "120", 120, 120.50 — all become "$120.00".
    // The dashboard sends a number (numericPrice). The endpoint also accepts strings.
    let priceFormatted
    if (typeof price === 'number') {
      priceFormatted = '$' + price.toFixed(2)
    } else {
      const numeric = parseFloat(String(price).replace(/[^0-9.]/g, ''))
      priceFormatted = isNaN(numeric) ? String(price) : '$' + numeric.toFixed(2)
    }

    // Text the customer the quote
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    await twilio.messages.create({
      body: `Hi ${firstName}! Your quote for ${serviceName} is ${priceFormatted}. Would you like to go ahead and book? 😊`,
      from: biz.sms_number,
      to: appt.customer_phone
    })

    // Update appointment status
    await sb.from('appointments')
      .update({ status: 'quote_sent', notes: (appt.notes ? appt.notes + ' | ' : '') + `Quote sent: ${priceFormatted}` })
      .eq('id', appointmentId)

    res.json({ success: true })
  } catch (err) {
    console.error('[owner-action/send-quote]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/owner-action/approve', requireBusinessAuth, async (req, res) => {
  try {
    const { appointmentId, businessId } = req.body
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

    const { data: appt } = await sb.from('appointments').select('*').eq('id', appointmentId).maybeSingle()
    if (!appt) return res.status(404).json({ error: 'Appointment not found' })

    await sb.from('appointments').update({ status: 'confirmed' }).eq('id', appointmentId)

    const { data: biz } = await sb.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (biz?.sms_number && appt.customer_phone) {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      await twilio.messages.create({
        body: `Great news! Your booking request for ${appt.service_name} on ${appt.appointment_date}${appt.appointment_time ? ' at ' + appt.appointment_time : ''} has been confirmed. We look forward to seeing you! 😊`,
        from: biz.sms_number,
        to: appt.customer_phone
      })
    }
    res.json({ success: true })
  } catch (err) {
    console.error('[owner-action/approve]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/owner-action/deny', requireBusinessAuth, async (req, res) => {
  try {
    const { appointmentId, businessId } = req.body
    const { createClient } = require('@supabase/supabase-js')
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

    const { data: appt } = await sb.from('appointments').select('*').eq('id', appointmentId).maybeSingle()
    if (!appt) return res.status(404).json({ error: 'Appointment not found' })

    await sb.from('appointments').update({ status: 'cancelled' }).eq('id', appointmentId)

    const { data: biz } = await sb.from('businesses').select('*').eq('id', businessId).maybeSingle()
    if (biz?.sms_number && appt.customer_phone) {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      const firstName = appt.customer_name?.split(' ')[0] || 'there'
      await twilio.messages.create({
        body: `Hi ${firstName}! Unfortunately we weren't able to accommodate your request at this time. Feel free to reach out if you'd like to explore other options. 😊`,
        from: biz.sms_number,
        to: appt.customer_phone
      })
    }
    res.json({ success: true })
  } catch (err) {
    console.error('[owner-action/deny]', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   TableFame Reservation Bot          ║
  ║   Running on port ${PORT}               ║
  ║                                      ║
  ║   Webhook: POST /webhook/sms         ║
  ║   Health:  GET  /health              ║
  ╚══════════════════════════════════════╝
  `)
})

module.exports = app
