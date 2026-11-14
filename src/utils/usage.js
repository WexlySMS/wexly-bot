// v216: per-business usage ledger. Every model call and every text writes one
// row to public.usage_events with an estimated cost in cents, so the admin
// report and the monthly spend alert can say what each client actually costs.
// Best effort: a missing table or a failed insert never breaks a send.
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// List prices, USD per million tokens. Override with env if Anthropic changes them.
const MODEL_PRICES = {
  default: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.30 }
}
// Twilio US list prices in cents. Outbound carries the 10DLC carrier fee (about 0.3c avg).
const SMS_CENTS = { out: Number(process.env.SMS_COST_CENTS_OUT || 1.13), in: Number(process.env.SMS_COST_CENTS_IN || 0.83), mms_extra: Number(process.env.MMS_EXTRA_CENTS || 1.2) }

let tableMissingLoggedAt = 0
async function insert(row) {
  try {
    const { error } = await supabase.from('usage_events').insert(row)
    if (error) {
      if (/usage_events|42P01|relation/i.test(error.message || '') && Date.now() - tableMissingLoggedAt > 60 * 60 * 1000) {
        tableMissingLoggedAt = Date.now()
        console.warn('[Usage] usage_events table missing. Run usage-events.sql in Supabase to start the per-business ledger.')
      } else if (!/usage_events|42P01|relation/i.test(error.message || '')) console.error('[Usage] insert failed:', error.message)
    }
  } catch (e) { console.error('[Usage] insert threw:', e.message) }
}

function modelCostCents(model, usage = {}) {
  const p = MODEL_PRICES[model] || MODEL_PRICES.default
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0
  const cw = usage.cache_creation_input_tokens || 0, cr = usage.cache_read_input_tokens || 0
  const usd = (inTok * p.input + outTok * p.output + cw * p.cache_write + cr * p.cache_read) / 1e6
  return Math.round(usd * 10000) / 100 // cents, 2 decimals
}

/** Record a model call. `kind`: client | owner | setup | import | other. */
function recordModel({ businessId = null, kind = 'other', model, usage }) {
  if (!usage) return
  const cents = modelCostCents(model, usage)
  insert({
    business_id: businessId, kind: 'model', detail: kind, model,
    input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0, cache_write_tokens: usage.cache_creation_input_tokens || 0,
    cost_cents: cents
  })
  return cents
}

/** Estimate GSM/UCS-2 segments the way Twilio bills them. */
function segmentsFor(body = '') {
  const s = String(body || '')
  const ucs2 = /[^\u0000-\u007F]/.test(s) && !/^[\u0000-\u007F -ÿ€]*$/.test(s)
  const per = ucs2 ? 70 : 160, perMulti = ucs2 ? 67 : 153
  if (s.length <= per) return 1
  return Math.ceil(s.length / perMulti)
}

/** Record a text. Resolves business by sms_number when businessId is not known. */
function recordSms({ businessId = null, smsNumber = null, direction = 'out', body = '', media = 0 }) {
  const segments = segmentsFor(body)
  const cents = Math.round((segments * SMS_CENTS[direction === 'in' ? 'in' : 'out'] + (media ? SMS_CENTS.mms_extra : 0)) * 100) / 100
  insert({ business_id: businessId, sms_number: smsNumber, kind: 'sms', detail: direction, segments, cost_cents: cents })
  return cents
}

/** Month-to-date cost per business, cents. Rows with no business_id are matched on sms_number. */
async function monthToDate() {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
  const { data, error } = await supabase.from('usage_events').select('business_id, sms_number, kind, cost_cents').gte('created_at', start.toISOString())
  if (error) return { byBusiness: {}, error: error.message }
  const { data: bizzes } = await supabase.from('businesses').select('id, business_name, plan, status, sms_number')
  const byNumber = {}; (bizzes || []).forEach(b => { if (b.sms_number) byNumber[b.sms_number] = b.id })
  const byBusiness = {}
  for (const r of data || []) {
    const id = r.business_id || byNumber[r.sms_number] || 'unattributed'
    const b = byBusiness[id] ||= { business_id: id, model_cents: 0, sms_cents: 0, total_cents: 0 }
    const c = Number(r.cost_cents || 0)
    if (r.kind === 'model') b.model_cents += c; else b.sms_cents += c
    b.total_cents += c
  }
  for (const b of bizzes || []) if (byBusiness[b.id]) Object.assign(byBusiness[b.id], { business_name: b.business_name, plan: b.plan, status: b.status })
  return { byBusiness, since: start.toISOString() }
}

module.exports = { recordModel, recordSms, segmentsFor, modelCostCents, monthToDate, SMS_CENTS }
