// v216: who may receive MARKETING texts (rebooking nudges, birthday, campaigns,
// group blasts, review asks, custom automations). Transactional texts about a
// booking the client has (confirmations, reminders, deposit, moves) are never
// gated here.
//
// customers.consent_source: 'texted_in' | 'web_booking' | 'imported' | 'owner_added' | null
//   texted_in    they messaged the business number themselves          → marketable
//   web_booking  they booked on the public page and gave their number  → marketable
//   imported     came in from GlossGenius/Booksy/calendar/CSV           → not until they text in
//   owner_added  the owner typed them in (dashboard or "book Jess…")    → not until they text in
//   null         older rows: marketable only if a conversation exists
// The webhook flips any row to texted_in the first time that number texts in.
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { phoneVariants } = require('./phone')

const MARKETABLE = new Set(['texted_in', 'web_booking'])
let columnMissing = false
let warnedAt = 0

async function canMarket(businessId, phone) {
  if (!businessId || !phone) return false
  const variants = phoneVariants(phone)
  if (!columnMissing) {
    const { data, error } = await supabase.from('customers').select('consent_source').eq('business_id', businessId).in('phone', variants).limit(1).maybeSingle()
    if (error && /consent_source|42703|column/i.test(error.message || '')) {
      columnMissing = true
      if (Date.now() - warnedAt > 60 * 60 * 1000) { warnedAt = Date.now(); console.warn('[Consent] customers.consent_source missing; run customer-consent.sql. Marketing texts are not gated until then.') }
      return true
    }
    if (data?.consent_source) return MARKETABLE.has(data.consent_source)
  } else return true
  // Unknown (older row or no customer row): a conversation means they texted in.
  const { data: sess } = await supabase.from('conversation_sessions').select('customer_phone').eq('business_id', businessId).in('customer_phone', variants).limit(1).maybeSingle()
  return !!sess
}

/** Upgrade (never downgrade) a customer's consent source. */
async function markConsent(businessId, phone, source) {
  if (columnMissing || !businessId || !phone || !source) return
  try {
    const variants = phoneVariants(phone)
    const q = supabase.from('customers').update({ consent_source: source, consented_at: new Date().toISOString() }).eq('business_id', businessId).in('phone', variants)
    const { error } = MARKETABLE.has(source) ? await q.not('consent_source', 'in', '("texted_in","web_booking")') : await q.is('consent_source', null)
    if (error && /consent_source|42703|column/i.test(error.message || '')) columnMissing = true
  } catch (e) { console.error('[Consent] mark failed:', e.message) }
}

module.exports = { canMarket, markConsent, MARKETABLE }
