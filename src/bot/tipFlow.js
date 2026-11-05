// ── SMS tip prompt flow (Entry 56) ────────────────────────────────────────────
//
// When an owner checks a customer out with Stripe connected, instead of relying
// on Stripe's per-account "collect tips" dashboard setting (which every owner
// had to find and enable themselves), Wexly asks the customer by text:
//
//   "Your total is $95. Would you like to add a tip for Mia? Reply 1 for 15%
//    ($14.25), 2 for 20% ($19.00), 3 for 25% ($23.75), or 0 for no tip. You
//    can also reply with an amount like $10."
//
// The reply is parsed here, the tip becomes its own UNTAXED line item on the
// Stripe checkout session, and the payment link is texted. No reply within
// TIP_TIMEOUT_MS → the link goes out with no tip so a slow reply never blocks
// payment. State lives in its own table (pending_tip_invoices) — deliberately
// NOT in conversation_sessions.session_state, so the intake/qualification
// machinery (PROTECTED Entry 23) is untouched.
//
// 🔒 PROTECTED — See PROTECTED_DECISIONS.md Entry 56.

const { createClient } = require('@supabase/supabase-js')
const { sendSMS } = require('../utils/sms')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const TIP_TIMEOUT_MS = 10 * 60 * 1000          // send link with no tip after 10 min
const SWEEP_AGE_MS = 12 * 60 * 1000            // scheduler safety net (covers restarts)
const DEFAULT_PERCENTAGES = [15, 20, 25]
const MAX_CUSTOM_TIP_CENTS = 50000             // $500 sanity cap on a typed amount

// In-process guard so the 10-min timer and the scheduler sweep can never both
// resolve the same prompt (and never double-text a link).
const resolving = new Set()
const timers = new Map()

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(cents) { return '$' + (Math.round(cents) / 100).toFixed(2) }

function normalizePercentages(raw) {
  let arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : null)
  if (!Array.isArray(arr)) return DEFAULT_PERCENTAGES.slice()
  arr = arr.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0 && n <= 100)
  arr = [...new Set(arr)].sort((a, b) => a - b).slice(0, 4)
  return arr.length ? arr : DEFAULT_PERCENTAGES.slice()
}

// Shorten a URL the same way /shorten does (pay.getwexly.com/s/xxx). Kept as a
// standalone helper so this module doesn't depend on index.js. Falls back to
// the full URL on any failure — a long link beats no link.
async function shortenUrl(url, businessId) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
  const base = process.env.SHORT_LINK_BASE || 'https://pay.getwexly.com'
  for (let attempt = 0; attempt < 5; attempt++) {
    let slug = ''
    for (let i = 0; i < 6; i++) slug += chars[Math.floor(Math.random() * chars.length)]
    const { error } = await supabase.from('short_links').insert({ slug, url, business_id: businessId || null })
    if (!error) return `${base}/s/${slug}`
    if (error.code !== '23505') { console.error('[Tip] shorten failed:', error.message); return url }
  }
  return url
}

// Persist a message into the customer's conversation thread WITHOUT flipping
// manual_mode (same semantics as /admin/send-sms with skipManualMode:true —
// see PROTECTED Entries 32/35). role: 'user' | 'assistant'.
async function persistToThread(businessId, customerPhone, role, content) {
  try {
    const { data: sess } = await supabase.from('conversation_sessions')
      .select('messages').eq('business_id', businessId).eq('customer_phone', customerPhone).maybeSingle()
    const msgs = Array.isArray(sess?.messages) ? sess.messages : []
    msgs.push({ role, content, system: role === 'assistant' ? true : undefined, timestamp: new Date().toISOString() })
    await supabase.from('conversation_sessions').upsert({
      business_id: businessId, customer_phone: customerPhone, messages: msgs, last_activity: new Date().toISOString()
    }, { onConflict: 'business_id,customer_phone' })
  } catch (e) { console.error('[Tip] persistToThread failed:', e.message) }
}

// ── Stripe session builder (shared by tip flow) ──────────────────────────────
//
// Mirrors /stripe-connect/create-invoice exactly, plus an optional tip line.
//   • Tip is its own line item, added AFTER the Tax line → never taxed.
//   • 🔒 Entry 2: platform fee = max(50¢, 1%) — computed on the PRE-TIP total.
//     Tips are the staff's money; Wexly takes no cut of them (Brandon, 2026-09-30).
//   • tip_cents rides in metadata so the paid-webhook can record it exactly
//     (amount_total − amount_subtotal is 0 once the tip is a line item).
async function createInvoiceCheckoutSession({ biz, customerName, customerPhone, lineItems, discountCents, tipCents, staffName, transactionId }) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

  const stripeLineItems = lineItems.map(item => ({
    price_data: {
      currency: 'usd',
      product_data: { name: item.name },
      unit_amount: Math.round(item.amount / (item.qty || 1)),
    },
    quantity: item.qty || 1,
  }))

  const preTipTotalCents = lineItems.reduce((sum, item) => sum + Math.round(item.amount), 0) - Math.round(discountCents || 0)
  // 🔒 PROTECTED — Platform fee = 1% with 50¢ floor (Entry 2), on the pre-tip total.
  const platformFee = Math.max(50, Math.round(preTipTotalCents * 0.01))

  const tip = Math.max(0, Math.round(tipCents || 0))
  if (tip > 0) {
    stripeLineItems.push({
      price_data: { currency: 'usd', product_data: { name: staffName ? `Tip for ${staffName}` : 'Tip' }, unit_amount: tip },
      quantity: 1,
    })
  }

  const metadata = {
    businessId: biz.id, customerPhone: customerPhone || '', customerName: customerName || '', type: 'invoice',
    tip_cents: String(tip), pre_tip_total_cents: String(preTipTotalCents),
    transaction_id: transactionId || ''
  }

  const sessionParams = {
    mode: 'payment',
    line_items: stripeLineItems,
    payment_intent_data: {
      application_fee_amount: platformFee,
      statement_descriptor_suffix: (biz.business_name || '').slice(0, 22).trim(),
      metadata
    },
    metadata,
    custom_text: {
      submit: { message: tip > 0
        ? `Thank you for visiting ${biz.business_name}! Your tip is included above.`
        : `Thank you for visiting ${biz.business_name}!` }
    },
    success_url: `${process.env.SITE_URL || 'https://getwexly.com'}/payment-confirmed.html`,
    cancel_url: `${process.env.SITE_URL || 'https://getwexly.com'}/payment-cancelled.html`,
  }

  if (discountCents > 0) {
    const coupon = await stripe.coupons.create(
      { amount_off: Math.round(discountCents), currency: 'usd', duration: 'once', name: 'Discount' },
      { stripeAccount: biz.stripe_account_id }
    )
    sessionParams.discounts = [{ coupon: coupon.id }]
  }

  const session = await stripe.checkout.sessions.create(sessionParams, { stripeAccount: biz.stripe_account_id })
  return { url: session.url, preTipTotalCents, tipCents: tip, platformFee, totalCents: preTipTotalCents + tip }
}

// ── Reply parsing ────────────────────────────────────────────────────────────
//
// Returns { kind: 'none' | 'option' | 'custom' | 'unrecognized', tipCents }.
//   "0" / "no" / "none" / "no tip" / "no thanks"      → none (tip 0)
//   bare integer 1..N (N = number of options)          → option N
//   "$10", "10.50", "20" (> N), "20%"                  → custom
//   anything else                                      → unrecognized
function parseTipReply(text, { percentages, subtotalCents }) {
  const t = String(text || '').trim().toLowerCase().replace(/[!.,]+$/g, '')
  if (!t) return { kind: 'unrecognized', tipCents: 0 }

  if (/^(0|no|nope|none|no tip|no thanks|no thank you|nah|skip)$/.test(t)) return { kind: 'none', tipCents: 0 }

  const n = percentages.length
  if (/^[1-9]$/.test(t) && parseInt(t, 10) <= n) {
    const pct = percentages[parseInt(t, 10) - 1]
    return { kind: 'option', tipCents: Math.round(subtotalCents * pct / 100), pct }
  }

  // "20%" → percentage
  const pctMatch = t.match(/^(\d{1,3})\s*%$/)
  if (pctMatch) {
    const pct = parseInt(pctMatch[1], 10)
    if (pct > 0 && pct <= 100) return { kind: 'custom', tipCents: Math.round(subtotalCents * pct / 100), pct }
    return { kind: 'unrecognized', tipCents: 0 }
  }

  // "$10", "10", "10.50", "tip 10", "$ 12"
  const amtMatch = t.match(/^(?:tip\s*)?\$?\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:dollars?|bucks)?$/)
  if (amtMatch) {
    const cents = Math.round(parseFloat(amtMatch[1]) * 100)
    if (cents > 0 && cents <= MAX_CUSTOM_TIP_CENTS) return { kind: 'custom', tipCents: cents }
    if (cents === 0) return { kind: 'none', tipCents: 0 }
    return { kind: 'unrecognized', tipCents: 0 }
  }

  return { kind: 'unrecognized', tipCents: 0 }
}

// ── Start: called from the dashboard's send-invoice ──────────────────────────
async function startTipPrompt({ biz, customerName, customerPhone, lineItems, discountCents, notes, subtotalCents, taxCents, staffName, appointmentId, transactionId }) {
  if (!biz?.sms_number) throw new Error('No SMS number assigned to this business')
  if (!customerPhone || String(customerPhone).replace(/\D/g, '').length < 10) throw new Error('Customer has no valid phone number')

  const percentages = normalizePercentages(biz.tip_percentages)
  const preTipTotalCents = lineItems.reduce((s, i) => s + Math.round(i.amount), 0) - Math.round(discountCents || 0)
  const base = Math.max(0, Math.round(subtotalCents || 0))

  // Only one live prompt per customer per business. Cancel any stale one.
  await supabase.from('pending_tip_invoices')
    .update({ status: 'cancelled', resolved_at: new Date().toISOString() })
    .eq('business_id', biz.id).eq('customer_phone', customerPhone).eq('status', 'awaiting')

  const payload = { customerName, lineItems, discountCents: Math.round(discountCents || 0), notes: notes || '', subtotalCents: base,
    taxCents: Math.round(taxCents || 0), staffName: staffName || null, appointmentId: appointmentId || null, transactionId: transactionId || null,
    preTipTotalCents, percentages }

  const { data: row, error } = await supabase.from('pending_tip_invoices')
    .insert({ business_id: biz.id, customer_phone: customerPhone, payload, status: 'awaiting' })
    .select().single()
  if (error) throw new Error(`pending_tip_invoices insert failed: ${error.message} (run add-sms-tip-prompt.sql?)`)

  const first = (customerName || 'there').split(' ')[0]
  const opts = percentages.map((p, i) => `${i + 1} for ${p}% (${fmt(base * p / 100)})`).join(', ')
  const who = staffName ? ` for ${staffName}` : ''
  const msg = `Hi ${first}! Your total from ${biz.business_name} today is ${fmt(preTipTotalCents)}. Would you like to add a tip${who}? Reply ${opts}, or 0 for no tip. You can also reply with an amount like $10.`

  await sendSMS(biz.sms_number, customerPhone, msg)
  await persistToThread(biz.id, customerPhone, 'assistant', msg)

  // 10-minute fallback. Scheduler sweep (sweepExpiredTipPrompts) is the
  // restart-safe backup; both go through resolvePendingTip's guard.
  const t = setTimeout(() => {
    resolvePendingTip(row.id, { tipCents: 0, reason: 'timeout' }).catch(e => console.error('[Tip] timeout resolve failed:', e.message))
  }, TIP_TIMEOUT_MS)
  if (typeof t.unref === 'function') t.unref()
  timers.set(row.id, t)

  console.log(`[Tip] Prompt sent to ${customerPhone} for ${biz.business_name} — pre-tip ${fmt(preTipTotalCents)}, options ${percentages.join('/')}%${staffName ? ', staff ' + staffName : ''}`)
  return { id: row.id, message: msg, percentages, preTipTotalCents }
}

// ── Resolve: build the Stripe link (with or without tip) and text it ─────────
async function resolvePendingTip(rowId, { tipCents, reason, replyKind }) {
  if (resolving.has(rowId)) return null
  resolving.add(rowId)
  try {
    const { data: row } = await supabase.from('pending_tip_invoices').select('*').eq('id', rowId).maybeSingle()
    if (!row || row.status !== 'awaiting') return null

    // Claim it first so nothing else can send a second link.
    const { data: claimed } = await supabase.from('pending_tip_invoices')
      .update({ status: 'resolved', tip_cents: Math.round(tipCents || 0), resolved_at: new Date().toISOString() })
      .eq('id', rowId).eq('status', 'awaiting').select().maybeSingle()
    if (!claimed) return null

    const tm = timers.get(rowId); if (tm) { clearTimeout(tm); timers.delete(rowId) }

    const p = row.payload || {}
    const { data: biz } = await supabase.from('businesses')
      .select('id, business_name, sms_number, stripe_account_id, stripe_account_connected').eq('id', row.business_id).maybeSingle()
    if (!biz) return null

    if (!biz.stripe_account_connected || !biz.stripe_account_id) {
      await sendSMS(biz.sms_number, row.customer_phone, `Thanks! ${biz.business_name} will follow up with your payment link shortly.`)
      console.error(`[Tip] Business ${biz.id} lost Stripe connection mid-flow; could not build link`)
      return null
    }

    const result = await createInvoiceCheckoutSession({
      biz, customerName: p.customerName, customerPhone: row.customer_phone, lineItems: p.lineItems || [],
      discountCents: p.discountCents || 0, tipCents, staffName: p.staffName, transactionId: p.transactionId
    })
    const link = await shortenUrl(result.url, biz.id)

    // Keep the dashboard's transaction row in sync (tip + final total, still 'sent').
    // 'tip' is stored in cents (matches saveTransaction in dashboard.html).
    try {
      if (p.transactionId) {
        await supabase.from('transactions').update({ tip: result.tipCents, total: result.totalCents }).eq('id', p.transactionId)
      }
    } catch (e) { console.error('[Tip] transaction sync failed:', e.message) }

    const first = (p.customerName || 'there').split(' ')[0]
    let msg
    if (result.tipCents > 0) {
      msg = `Thanks ${first}! ${fmt(result.tipCents)} tip added${p.staffName ? ' for ' + p.staffName : ''}. Here's your secure payment link for ${fmt(result.totalCents)}: ${link} 😊`
    } else if (reason === 'timeout') {
      msg = `Hi ${first}, here's your secure payment link from ${biz.business_name} for ${fmt(result.totalCents)}: ${link} 😊`
    } else {
      msg = `No problem! Here's your secure payment link for ${fmt(result.totalCents)}: ${link} 😊`
    }
    await sendSMS(biz.sms_number, row.customer_phone, msg)
    await persistToThread(biz.id, row.customer_phone, 'assistant', msg)

    console.log(`[Tip] Resolved ${rowId} (${reason}${replyKind ? '/' + replyKind : ''}) — tip ${fmt(result.tipCents)}, total ${fmt(result.totalCents)}, fee ${fmt(result.platformFee)} → ${row.customer_phone}`)
    return result
  } finally {
    resolving.delete(rowId)
  }
}

// ── Webhook hook: is this inbound customer text a tip reply? ─────────────────
//
// Returns { handled: false } when there's no live prompt (or the table is
// missing) so the normal bot flow proceeds untouched.
// Returns { handled: true, consumed: true } when the reply was a tip answer and
// the link has been sent — the message must NOT go to the AI.
// Returns { handled: true, consumed: false } when the reply wasn't a tip answer:
// the link goes out with no tip AND the message continues to normal handling.
async function checkPendingTipReply(business, customerPhone, incomingText) {
  let row
  try {
    const { data, error } = await supabase.from('pending_tip_invoices')
      .select('*').eq('business_id', business.id).eq('customer_phone', customerPhone).eq('status', 'awaiting')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (error) { console.error('[Tip] lookup failed (table missing?):', error.message); return { handled: false } }
    row = data
  } catch (e) { console.error('[Tip] lookup threw:', e.message); return { handled: false } }
  if (!row) return { handled: false }

  const p = row.payload || {}
  const parsed = parseTipReply(incomingText, { percentages: normalizePercentages(p.percentages), subtotalCents: p.subtotalCents || 0 })

  // Not a tip answer → link goes out with no tip, and the message continues to
  // the normal flow (which persists it to the thread itself — don't double-save).
  if (parsed.kind === 'unrecognized') {
    await resolvePendingTip(row.id, { tipCents: 0, reason: 'unrecognized-reply', replyKind: 'unrecognized' })
    return { handled: true, consumed: false }
  }
  // Tip answer → we consume the message, so record it in the thread ourselves.
  await persistToThread(business.id, customerPhone, 'user', incomingText)
  await resolvePendingTip(row.id, { tipCents: parsed.tipCents, reason: 'reply', replyKind: parsed.kind })
  return { handled: true, consumed: true }
}

// ── Scheduler safety net (covers process restarts losing setTimeout) ─────────
async function sweepExpiredTipPrompts() {
  try {
    const cutoff = new Date(Date.now() - SWEEP_AGE_MS).toISOString()
    const { data: rows, error } = await supabase.from('pending_tip_invoices')
      .select('id').eq('status', 'awaiting').lt('created_at', cutoff).limit(50)
    if (error) return                                   // table missing → nothing to do
    for (const r of rows || []) {
      await resolvePendingTip(r.id, { tipCents: 0, reason: 'timeout' }).catch(e => console.error('[Tip] sweep resolve failed:', e.message))
    }
    if (rows?.length) console.log(`[Tip] Sweep resolved ${rows.length} expired prompt(s)`)
  } catch (e) { console.error('[Tip] sweep error:', e.message) }
}

module.exports = { startTipPrompt, checkPendingTipReply, sweepExpiredTipPrompts, parseTipReply, normalizePercentages, createInvoiceCheckoutSession, TIP_TIMEOUT_MS }
