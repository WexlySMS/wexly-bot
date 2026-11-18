// ── Native app push notifications (iOS + Android via Firebase Cloud Messaging) ─
//
// ADDITIVE channel. Existing email/SMS owner notifications are untouched; the
// call sites fire this alongside them. Everything here is a no-op until the
// FIREBASE_SERVICE_ACCOUNT env var is set on Render (see wexly-app/LINK-ME.md),
// so deploying this file changes nothing in production by itself.
//
// Device tokens come from the app via POST /push/register (index.js) and live
// in the push_tokens table (migration: add-push-tokens.sql).
//
// iOS goes straight to APNs with the .p8 key (see "APNs direct" below); Android
// goes through FCM. Either one being configured turns push on for that platform.

const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

let messaging = null
let initTried = false

function getMessaging() {
  if (messaging || initTried) return messaging
  initTried = true
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) { console.log('[Push] FIREBASE_SERVICE_ACCOUNT not set — push disabled (app not linked yet)'); return null }
  try {
    const admin = require('firebase-admin')
    const cred = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'))
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred) })
    messaging = admin.messaging()
    console.log(`[Push] Firebase initialised for project ${cred.project_id}`)
  } catch (e) {
    console.error('[Push] Firebase init failed — push disabled:', e.message)
  }
  return messaging
}

// ── APNs direct (iOS) ─────────────────────────────────────────────────────────
// The iOS app is a remote-loaded Capacitor shell with no Firebase SDK, so its
// PushNotifications plugin hands us the raw APNs device token. We send to Apple
// directly over HTTP/2 with a token-based (.p8) key: no FirebaseMessaging pod,
// no AppDelegate changes, no GoogleService-Info.plist. Android still uses FCM.
//
// Env (Render): APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY (the .p8 contents; raw PEM,
// "\n"-escaped, or base64), optional APNS_BUNDLE_ID (default com.getwexly.app).
const http2 = require('http2')
const crypto = require('crypto')
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.getwexly.app'
let apnsJwt = null, apnsJwtAt = 0, apnsKeyObj = null, apnsWarned = false

// Env values pasted into a UI often carry quotes or whitespace; both IDs are exactly 10 chars.
function envId(name) { return String(process.env[name] || '').trim().replace(/^["']|["']$/g, '').trim() }
function apnsConfigured() { return !!(envId('APNS_KEY_ID') && envId('APNS_TEAM_ID') && process.env.APNS_KEY) }
// Non-secret diagnostics for the in-app "Send test" (IDs + key curve + a short fingerprint).
function apnsDiagnostics() {
  const out = { keyId: envId('APNS_KEY_ID'), teamId: envId('APNS_TEAM_ID'), bundleId: APNS_BUNDLE_ID }
  try { const k = apnsPrivateKey(); out.curve = k.asymmetricKeyDetails?.namedCurve || k.asymmetricKeyType; out.keyFingerprint = crypto.createHash('sha256').update(k.export({ type: 'pkcs8', format: 'der' })).digest('hex').slice(0, 12) } catch (e) { out.keyError = e.message }
  return out
}

// Accepts the .p8 in any shape an env-var UI can produce: proper multi-line PEM,
// the whole PEM collapsed onto one line, "\n"-escaped, surrounded by quotes, or the
// bare base64 body (with or without the BEGIN/END lines). Rebuilds a canonical PEM.
function normalizeP8(raw) {
  let v = String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').replace(/\r/g, '')
  // Someone may paste the base64 of the whole PEM file (openssl base64 / base64 -w0).
  if (!/BEGIN/.test(v)) { try { const d = Buffer.from(v, 'base64').toString('utf8'); if (/BEGIN/.test(d)) v = d } catch (e) {} }
  const body = v.replace(/-----BEGIN[^-]*-----/g, '').replace(/-----END[^-]*-----/g, '').replace(/\s+/g, '')
  if (!body) throw new Error('APNS_KEY is empty')
  const lines = body.match(/.{1,64}/g).join('\n')
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`
}

function apnsPrivateKey() {
  if (apnsKeyObj) return apnsKeyObj
  try {
    apnsKeyObj = crypto.createPrivateKey(normalizeP8(process.env.APNS_KEY))
  } catch (e) {
    throw new Error('APNS_KEY could not be parsed (' + e.message + '). Paste the full contents of the .p8 file; line breaks, quotes or a one-line paste are all fine.')
  }
  return apnsKeyObj
}

// Apple accepts a provider token for up to 60 min; refresh every 50.
function apnsToken() {
  const now = Math.floor(Date.now() / 1000)
  if (apnsJwt && now - apnsJwtAt < 50 * 60) return apnsJwt
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = b64({ alg: 'ES256', kid: envId('APNS_KEY_ID') }) + '.' + b64({ iss: envId('APNS_TEAM_ID'), iat: now })
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: apnsPrivateKey(), dsaEncoding: 'ieee-p1363' })
  apnsJwt = unsigned + '.' + sig.toString('base64url'); apnsJwtAt = now
  return apnsJwt
}

// One push to one device. Resolves { ok, status, reason }. Tries production first; a
// BadDeviceToken answer means the token came from an Xcode/debug build, so retry on sandbox.
function apnsSendOne(token, payload, host, opts) {
  opts = opts || {}
  return new Promise((resolve) => {
    let client
    try { client = http2.connect('https://' + host) } catch (e) { return resolve({ ok: false, reason: e.message }) }
    const done = (r) => { try { client.close() } catch (e) {} resolve(r) }
    client.on('error', (e) => done({ ok: false, reason: e.message }))
    const req = client.request({
      ':method': 'POST', ':path': '/3/device/' + token,
      'authorization': 'bearer ' + apnsToken(), 'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': opts.background ? 'background' : 'alert', 'apns-priority': opts.background ? '5' : '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
      'content-type': 'application/json',
    })
    let status = 0, body = ''
    req.on('response', (h) => { status = h[':status'] })
    req.on('data', (c) => { body += c })
    req.on('end', () => { let reason = ''; try { reason = JSON.parse(body).reason || '' } catch (e) {} done({ ok: status === 200, status, reason }) })
    req.on('error', (e) => done({ ok: false, reason: e.message }))
    req.setTimeout(10000, () => { req.close(); done({ ok: false, reason: 'timeout' }) })
    req.end(JSON.stringify(payload))
  })
}

// What the app icon badge should show: the same "needs you" count the dashboard shows.
// Threads the assistant paused for the owner + bookings waiting on approval, a quote, or a deposit
// (today or later). Never throws; a lookup failure falls back to 1 so an alert still badges.
async function badgeCount(businessId) {
  try {
    const today = new Date(Date.now() - 12 * 3600e3).toISOString().slice(0, 10)   // generous: any tz
    const [c, a] = await Promise.all([
      supabase.from('conversation_sessions').select('id', { count: 'exact', head: true }).eq('business_id', businessId).eq('needs_attention', true),
      supabase.from('appointments').select('id', { count: 'exact', head: true }).eq('business_id', businessId).in('status', ['pending_approval', 'quote_sent', 'deposit_pending']).gte('appointment_date', today),
    ])
    if (c.error || a.error) throw new Error((c.error || a.error).message)
    return (c.count || 0) + (a.count || 0)
  } catch (e) { console.error('[Push] badgeCount failed:', e.message); return 1 }
}

async function apnsSend(tokens, { title, body, data, badge }) {
  const payload = { aps: { alert: { title, body }, sound: 'default', badge: Number.isFinite(badge) ? badge : 1 }, ...(data || {}) }
  const dead = [], reasons = []; let sent = 0, failed = 0
  for (const t of tokens) {
    let r = await apnsSendOne(t, payload, 'api.push.apple.com')
    if (!r.ok && r.reason === 'BadDeviceToken') r = await apnsSendOne(t, payload, 'api.sandbox.push.apple.com')
    if (r.ok) sent++
    else {
      failed++
      reasons.push(`${r.status || ''} ${r.reason || 'unknown'}`.trim())
      if (r.status === 410 || r.reason === 'Unregistered' || r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic') dead.push(t)
      console.error('[Push] APNs', r.status || '', r.reason || '', 'token', String(t).slice(0, 10) + '…')
    }
  }
  return { sent, failed, dead, reasons }
}

function isEnabled() { return apnsConfigured() || !!getMessaging() }

// Send to every registered device for a business.
//   title/body: the notification
//   data: flat string map; the app routes on data.page / data.phone (native-bridge.js)
async function pushToBusiness(businessId, { title, body, data }) {
  const m = getMessaging()
  const apns = apnsConfigured()
  if ((!m && !apns) || !businessId) { if (businessId) console.log('[Push] not configured (no APNS_* / FIREBASE_SERVICE_ACCOUNT)'); return { sent: 0, skipped: true, configured: false } }
  try {
    const { data: allRows, error } = await supabase.from('push_tokens')
      .select('token, platform').eq('business_id', businessId)
    if (error) { console.error('[Push] token lookup failed (table missing?):', error.message); return { sent: 0, error: error.message } }
    if (!allRows?.length) { console.log(`[Push] "${title}" → business ${businessId}: no registered devices`); return { sent: 0, devices: 0 } }

    const strData = {}
    for (const [k, v] of Object.entries(data || {})) if (v !== undefined && v !== null) strData[k] = String(v)
    const badge = await badgeCount(businessId)

    // iOS → APNs directly when configured; everything else (Android, or iOS when only FCM is set up) → FCM
    let total = { sent: 0, failed: 0, devices: allRows.length, configured: true }
    const iosRows = apns ? allRows.filter(r => r.platform === 'ios') : []
    if (iosRows.length) {
      const r = await apnsSend(iosRows.map(x => x.token), { title, body, data: strData, badge })
      total.sent += r.sent; total.failed += r.failed; if (r.reasons?.length) total.reasons = r.reasons
      if (r.dead.length) { await supabase.from('push_tokens').delete().in('token', r.dead); console.log(`[Push] pruned ${r.dead.length} dead iOS token(s)`) }
    }
    const rows = allRows.filter(r => !iosRows.includes(r))
    if (!rows.length || !m) { console.log(`[Push] "${title}" → business ${businessId}: ${total.sent} sent, ${total.failed} failed`); return total }

    const res = await m.sendEachForMulticast({
      tokens: rows.map(r => r.token),
      notification: { title, body },
      data: strData,
      apns: { payload: { aps: { sound: 'default', badge } } },
      android: { priority: 'high', notification: { sound: 'default', channelId: 'wexly_default' } },
    })

    // Prune tokens FCM says are dead (uninstalled app, rotated token).
    const dead = []
    res.responses.forEach((r, i) => {
      const code = r.error?.code || ''
      if (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) dead.push(rows[i].token)
    })
    if (dead.length) {
      await supabase.from('push_tokens').delete().in('token', dead)
      console.log(`[Push] pruned ${dead.length} dead token(s)`)
    }
    total.sent += res.successCount; total.failed += res.failureCount
    console.log(`[Push] "${title}" → business ${businessId}: ${total.sent} sent, ${total.failed} failed`)
    return total
  } catch (e) {
    console.error('[Push] send failed:', e.message)
    return { sent: 0, error: e.message }
  }
}

// ── Ready-made notifications used by the bot's existing call sites ───────────
// Owner preference per push type: pro_settings.notifications.push_booking / push_cancellation /
// push_escalation (dashboard Settings → Notifications; default ON). Callers often pass a
// business row without pro_settings, so fetch it when missing.
async function pushAllowed(business, key) {
  let ps = business?.pro_settings
  if (ps === undefined) {
    try { const { data } = await supabase.from('businesses').select('pro_settings').eq('id', business.id).maybeSingle(); ps = data?.pro_settings } catch (e) { ps = null }
  }
  return ps?.notifications?.[key] !== false
}

async function pushNewBooking(business, { customerName, serviceName, appointmentDate, appointmentTime, customerPhone, isReschedule }) {
  if (!business?.id) return
  if (!(await pushAllowed(business, 'push_booking'))) return { sent: 0, muted: true }
  const when = `${appointmentDate}${appointmentTime ? ' ' + appointmentTime : ''}`
  return pushToBusiness(business.id, {
    title: isReschedule ? '🔁 Rescheduled booking' : '📅 New booking',
    body: `${customerName || 'A customer'} · ${serviceName || 'Appointment'} · ${when}`,
    data: { page: 'appointments', phone: customerPhone || '', date: appointmentDate || '', type: 'booking' },
  })
}

async function pushEscalation(business, { customerPhone, customerMessage, trigger }) {
  if (!business?.id) return
  if (!(await pushAllowed(business, 'push_escalation'))) return { sent: 0, muted: true }
  return pushToBusiness(business.id, {
    title: '⚠️ Customer needs you',
    body: (customerMessage || trigger || 'A customer asked for a person').slice(0, 120),
    data: { page: 'conversations', phone: customerPhone || '', type: 'escalation' },
  })
}

async function pushCancellation(business, { customerName, serviceName, appointmentDate, appointmentTime, customerPhone }) {
  if (!business?.id) return
  if (!(await pushAllowed(business, 'push_cancellation'))) return { sent: 0, muted: true }
  return pushToBusiness(business.id, {
    title: '❌ Booking cancelled',
    body: `${customerName || 'A customer'} · ${serviceName || 'Appointment'} · ${appointmentDate}${appointmentTime ? ' ' + appointmentTime : ''}`,
    data: { page: 'appointments', phone: customerPhone || '', date: appointmentDate || '', type: 'cancellation' },
  })
}

// Silent badge update: no banner, no sound, just sets the icon number to the real count.
// The app asks for this when it opens or when the owner clears something, so a badge never
// outlives the thing it was counting. Returns the count it pushed.
async function syncBadge(businessId) {
  if (!businessId) return { count: 0, sent: 0 }
  const count = await badgeCount(businessId)
  const { data: rows } = await supabase.from('push_tokens').select('token, platform').eq('business_id', businessId)
  if (!rows?.length) return { count, sent: 0 }
  let sent = 0
  const ios = apnsConfigured() ? rows.filter(r => r.platform === 'ios') : []
  const payload = { aps: { badge: count, 'content-available': 1 } }
  const dead = []
  for (const r of ios) {
    let x = await apnsSendOne(r.token, payload, 'api.push.apple.com', { background: true })
    if (!x.ok && x.reason === 'BadDeviceToken') x = await apnsSendOne(r.token, payload, 'api.sandbox.push.apple.com', { background: true })
    if (x.ok) sent++
    else if (x.status === 410 || x.reason === 'Unregistered' || x.reason === 'BadDeviceToken' || x.reason === 'DeviceTokenNotForTopic') dead.push(r.token)
  }
  if (dead.length) await supabase.from('push_tokens').delete().in('token', dead)
  const m = getMessaging(); const rest = rows.filter(r => !ios.includes(r))
  if (m && rest.length) {
    try {
      const res = await m.sendEachForMulticast({ tokens: rest.map(r => r.token), data: { badge: String(count) },
        apns: { headers: { 'apns-push-type': 'background', 'apns-priority': '5' }, payload: { aps: { badge: count, 'content-available': 1 } } },
        android: { priority: 'normal' } })
      sent += res.successCount
    } catch (e) { console.error('[Push] badge sync FCM failed:', e.message) }
  }
  return { count, sent }
}

module.exports = { isEnabled, badgeCount, syncBadge, pushToBusiness, pushNewBooking, pushEscalation, pushCancellation, apnsDiagnostics }
