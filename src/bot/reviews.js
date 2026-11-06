// ── Client reviews (v205) ─────────────────────────────────────────────────────
// Text-first reviews, modelled on what GlossGenius does but without an app:
//   1. ~2 hours after an appointment ends the client gets ONE text: "How did we
//      do? Reply 1 to 5."  (businesses.reviews_ask_enabled, default on)
//   2. The rating reply is caught in the webhook before the model sees it. 4 and 5
//      publish straight to the booking page; 1 to 3 are saved as private feedback
//      (hidden) and the owner is told. Then: "want to add a few words? or SKIP".
//   3. The owner is texted every review and can "hide Sarah's review" /
//      "show Sarah's review" by text, or toggle them in the dashboard.
//   4. The booking page merges these with any reviews imported from their old
//      platform (businesses.profile_reviews). businesses.reviews_show_enabled hides all.
// State lives in public.reviews (one row per appointment); nothing in memory.
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { sendSMS } = require('../utils/sms')

const ASK_AFTER_MS = 2 * 60 * 60 * 1000       // appointment end + 2h
const REPLY_WINDOW_MS = 48 * 60 * 60 * 1000   // how long a reply still counts as the review
const RATING_RE = /^\s*([1-5])\s*(?:\/\s*5|stars?|⭐+|out of 5)?\s*[.!]*\s*$/i
const SKIP_RE = /^\s*(skip|no|nope|no thanks|nah|n|pass|done|all good|that's it|thats it)\s*[.!]*\s*$/i
const BOOKING_WORDS = /\b(book|appointment|appt|reschedule|cancel|available|availability|opening|what time|tomorrow|next week|how much|price|deposit|pay|hours|open)\b/i
const missingTable = (e) => e && /relation .*reviews.* does not exist|42P01/i.test(e.message || e.code || '')

function firstName(n) { return String(n || '').trim().split(' ')[0] || 'there' }
function publicName(n) { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : (p[0] || 'Client') }
function endOf(appt) {
  const t = String(appt.appointment_time || '12:00').slice(0, 5)
  const dur = Number(appt.duration_mins || appt.duration || 60) || 60
  // Interpreted in the business timezone by the caller (we compare whole-hour granularity, good enough)
  return { date: appt.appointment_date, time: t, dur }
}

// Hourly: ask for a rating after yesterday's/today's finished appointments.
async function sendReviewRequests() {
  const now = Date.now()
  const d0 = new Date(now).toISOString().slice(0, 10), d1 = new Date(now - 86400000).toISOString().slice(0, 10), d2 = new Date(now - 2 * 86400000).toISOString().slice(0, 10)
  const { data: appts, error } = await supabase.from('appointments')
    .select('id, business_id, customer_phone, customer_name, service_name, appointment_date, appointment_time, duration_mins, status, businesses(business_name, sms_number, owner_name, timezone, reviews_ask_enabled, status, demo_mode)')
    .in('appointment_date', [d0, d1, d2]).in('status', ['confirmed', 'completed'])
  if (error) { if (!missingTable(error)) console.error('[Reviews] query failed:', error.message); return }
  let sent = 0
  for (const a of appts || []) {
    const biz = a.businesses; if (!biz?.sms_number || biz.reviews_ask_enabled === false || biz.demo_mode) continue
    if (['cancelled', 'past_due', 'trial_expired', 'pending_checkout'].includes(biz.status)) continue
    if (!a.customer_phone || !/^\+\d{10,15}$/.test(a.customer_phone)) continue
    const { date, time, dur } = endOf(a)
    const tz = biz.timezone || 'America/Los_Angeles'
    // local end time → epoch: build the local wall-clock string and let Date parse it as if UTC, then correct by the tz offset
    const endLocal = new Date(`${date}T${time}:00Z`).getTime() + dur * 60000
    const offsetMs = tzOffsetMs(tz, endLocal)
    const endEpoch = endLocal - offsetMs
    if (now - endEpoch < ASK_AFTER_MS) continue
    if (now - endEpoch > 36 * 60 * 60 * 1000) continue        // too old, don't nag days later
    const { data: existing, error: e2 } = await supabase.from('reviews').select('id').eq('appointment_id', a.id).maybeSingle()
    if (e2) { if (missingTable(e2)) return; continue }
    if (existing) continue
    // one ask per client per 14 days, even across appointments
    const { data: recent } = await supabase.from('reviews').select('id').eq('business_id', a.business_id).eq('customer_phone', a.customer_phone).gte('requested_at', new Date(now - 14 * 86400000).toISOString()).limit(1)
    if (recent?.length) { await supabase.from('reviews').insert({ business_id: a.business_id, appointment_id: a.id, customer_phone: a.customer_phone, customer_name: a.customer_name, service_name: a.service_name, status: 'skipped' }); continue }
    const { error: insErr } = await supabase.from('reviews').insert({ business_id: a.business_id, appointment_id: a.id, customer_phone: a.customer_phone, customer_name: a.customer_name, service_name: a.service_name, status: 'requested' })
    if (insErr) continue
    try {
      await sendSMS(biz.sms_number, a.customer_phone, `Hi ${firstName(a.customer_name)}, thanks for coming in to ${biz.business_name}! How did we do today? Reply with a number from 1 to 5.`)
      sent++
    } catch (e) { console.error('[Reviews] ask failed:', e.message) }
  }
  if (sent) console.log(`[Reviews] asked ${sent} client(s) for a rating`)
}
function tzOffsetMs(tz, epoch) {
  try {
    const d = new Date(epoch)
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d)
    const g = (t) => Number(parts.find(p => p.type === t).value)
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
    return asUtc - d.getTime()
  } catch { return 0 }
}

// Webhook hook: returns true when the text was consumed as part of a review.
async function handleCustomerReply(business, customerPhone, text) {
  const t = String(text || '').trim()
  if (!t || t.length > 600) return false
  let q = await supabase.from('reviews').select('*').eq('business_id', business.id).eq('customer_phone', customerPhone)
    .in('status', ['requested', 'awaiting_comment']).gte('requested_at', new Date(Date.now() - REPLY_WINDOW_MS).toISOString())
    .order('requested_at', { ascending: false }).limit(1).maybeSingle()
  if (q.error || !q.data) return false
  const rv = q.data
  const owner = (business.owner_name || '').split(' ')[0]

  if (rv.status === 'requested') {
    const m = t.match(RATING_RE)
    if (!m) return false                         // not a rating: let the model handle it, the ask stays open
    const rating = Number(m[1])
    const status = rating >= 4 ? 'published' : 'hidden'
    await supabase.from('reviews').update({ rating, rated_at: new Date().toISOString(), status: 'awaiting_comment', hidden_at: rating >= 4 ? null : new Date().toISOString() }).eq('id', rv.id)
    let reply = rating >= 4
      ? `Thank you${rv.customer_name ? ', ' + firstName(rv.customer_name) : ''}! Want to add a few words about your visit? Reply with your review and we'll share it on our page, or reply SKIP.`
      : `Thanks for the honesty. What could we have done better? Reply here and ${owner || 'the owner'} will see it directly.`
    if (rating === 5 && business.google_review_link) reply += ` And if you have 30 seconds, a Google review means the world to us: ${business.google_review_link}`
    await sendSMS(business.sms_number, customerPhone, reply)
    await notifyOwner(business, { ...rv, rating, status }, null)
    return true
  }

  // awaiting_comment
  const finalStatus = (rv.rating || 0) >= 4 ? 'published' : 'hidden'
  if (SKIP_RE.test(t)) {
    await supabase.from('reviews').update({ status: finalStatus }).eq('id', rv.id)
    await sendSMS(business.sms_number, customerPhone, `Thanks ${firstName(rv.customer_name)}! See you next time.`)
    return true
  }
  if (BOOKING_WORDS.test(t) && t.length > 25) {
    // Reads like a new request, not a review: close the review without words and let the model answer.
    await supabase.from('reviews').update({ status: finalStatus }).eq('id', rv.id)
    return false
  }
  await supabase.from('reviews').update({ comment: t.slice(0, 500), commented_at: new Date().toISOString(), status: finalStatus }).eq('id', rv.id)
  await sendSMS(business.sms_number, customerPhone, finalStatus === 'published'
    ? `Thank you ${firstName(rv.customer_name)}, that's on our page now. See you next time!`
    : `Thank you for telling us, ${firstName(rv.customer_name)}. ${owner || 'The owner'} will read this personally.`)
  await notifyOwner(business, { ...rv, status: finalStatus }, t.slice(0, 500))
  return true
}

async function notifyOwner(business, rv, comment) {
  if (!business.owner_phone || !business.sms_number) return
  const who = rv.customer_name || rv.customer_phone
  const first = firstName(rv.customer_name)
  const stars = '★'.repeat(rv.rating) + '☆'.repeat(5 - rv.rating)
  let msg
  if (comment) {
    msg = rv.status === 'published'
      ? `New review from ${who} (${stars}): "${comment}" It's live on your booking page. Reply "hide ${first}'s review" to take it down.`
      : `Private feedback from ${who} (${stars}): "${comment}" Not shown on your page. Reply "show ${first}'s review" if you want it public.`
  } else {
    msg = rv.status === 'published'
      ? `${who} rated their visit ${stars}. If they add words I'll send them over. Reply "hide ${first}'s review" any time to keep it off your page.`
      : `${who} rated their visit ${stars}. I asked what we could do better and will pass it along. It's not shown on your page.`
  }
  try { await sendSMS(business.sms_number, business.owner_phone, msg); require('./ownerCommands').noteOwnerOutbound(business.id, msg) } catch (e) { console.error('[Reviews] owner notify failed:', e.message) }
}

// Owner side: "hide Sarah's review" / "show Sarah's review" / list
async function setVisibility(business, customerName, hidden) {
  const w = String(customerName || '').toLowerCase().replace(/'s\b/, '').trim()
  const { data: rows, error } = await supabase.from('reviews').select('id, customer_name, rating, comment, status').eq('business_id', business.id).in('status', ['published', 'hidden']).order('rated_at', { ascending: false })
  if (error) return missingTable(error) ? `Reviews aren't switched on for your account yet.` : `I couldn't load your reviews just now.`
  const hits = (rows || []).filter(r => (r.customer_name || '').toLowerCase().includes(w))
  if (!hits.length) return `I couldn't find a review from "${customerName}". Recent reviews: ${(rows || []).slice(0, 6).map(r => `${r.customer_name || 'unknown'} (${r.rating}★${r.status === 'hidden' ? ', hidden' : ''})`).join(', ') || 'none yet'}.`
  const r = hits[0]
  await supabase.from('reviews').update({ status: hidden ? 'hidden' : 'published', hidden_at: hidden ? new Date().toISOString() : null }).eq('id', r.id)
  return hidden ? `Done. ${r.customer_name || 'That'} review (${r.rating}★) is hidden from your booking page.` : `Done. ${r.customer_name || 'That'} review (${r.rating}★) is live on your booking page.`
}
async function summary(business) {
  const { data: rows, error } = await supabase.from('reviews').select('customer_name, rating, comment, status, rated_at').eq('business_id', business.id).in('status', ['published', 'hidden']).order('rated_at', { ascending: false }).limit(50)
  if (error) return missingTable(error) ? `Reviews aren't switched on for your account yet.` : `I couldn't load your reviews just now.`
  const rated = (rows || []).filter(r => r.rating)
  if (!rated.length) return `No reviews yet. I ask every client for a rating a couple of hours after their appointment.`
  const avg = (rated.reduce((s, r) => s + r.rating, 0) / rated.length).toFixed(1)
  const vis = rated.filter(r => r.status === 'published').length
  const latest = rated.slice(0, 3).map(r => `${r.customer_name || 'Client'} ${r.rating}★${r.comment ? ': "' + r.comment.slice(0, 60) + (r.comment.length > 60 ? '…' : '') + '"' : ''}${r.status === 'hidden' ? ' (hidden)' : ''}`).join('\n')
  return `${rated.length} review${rated.length === 1 ? '' : 's'}, ${avg}★ average, ${vis} shown on your page.\n${latest}`
}

// Booking page: published reviews in the same shape as imported ones.
async function publicReviews(businessId) {
  const { data, error } = await supabase.from('reviews').select('customer_name, rating, comment, rated_at').eq('business_id', businessId).eq('status', 'published').order('rated_at', { ascending: false }).limit(40)
  if (error) return []
  return (data || []).map(r => ({ name: publicName(r.customer_name), rating: r.rating, text: r.comment || '', date: r.rated_at ? String(r.rated_at).slice(0, 10) : null, source: 'Wexly' }))
}

module.exports = { sendReviewRequests, handleCustomerReply, setVisibility, summary, publicReviews }
