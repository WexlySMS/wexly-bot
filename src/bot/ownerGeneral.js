// v230 GENERAL OWNER TOOLS
//
// The owner bot used to be ~40 scenario tools ("running_late", "unblock_date").
// Anything nobody scripted fell through a hole. These are the opposite: a small
// set of building blocks over the app's own data (look anything up, text any
// set of clients, change any appointment / client / setting) that the model
// combines to do what the owner asked, however they phrase it.
//
// Safety is enforced HERE, not by the prompt:
//   - every query and write is scoped to business.id
//   - writes only touch whitelisted fields
//   - anything that texts more than MASS people, or cancels, is a two-step:
//     the first call returns a preview, and it only runs when the owner has
//     answered in a LATER text (turn counter), so the model cannot preview and
//     confirm in one breath
//   - a request the bot truly cannot do is logged and emailed to Wexly (cant_do)
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const crypto = require('crypto')
const { formatDate, formatTime } = require('../utils/dateHelpers')
const { phoneVariants, toE164 } = require('../utils/phone')

const MASS = 3            // texting more than this many people needs the owner's yes
const MAX_ROWS = 40
const LIVE = ['pending', 'confirmed', 'deposit_pending', 'pending_approval', 'quote_sent']

const GENERAL_TOOLS = [
  {
    name: 'look_up',
    description: 'Read anything in this business. Use it whenever you need facts before acting or answering: who is booked when, a client\'s history or number, what services cost, what is blocked, who has not paid, who is on the waitlist, current settings. Returns rows with ids you can pass to text_clients / change_appointments. Prefer this over guessing. Filters are optional and combine.',
    input_schema: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['appointments', 'clients', 'services', 'staff', 'blocked_dates', 'payments', 'waitlist', 'products', 'settings', 'conversations'], description: 'Which records to read' },
        from_date: { type: 'string', description: 'YYYY-MM-DD inclusive (appointments, blocked_dates, payments)' },
        to_date: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        from_time: { type: 'string', description: 'HH:MM 24h, appointments at or after this time' },
        to_time: { type: 'string', description: 'HH:MM 24h, appointments at or before this time' },
        client: { type: 'string', description: 'Client name (partial ok) or phone' },
        service: { type: 'string', description: 'Service name (partial ok)' },
        staff: { type: 'string', description: 'Staff name (partial ok)' },
        status: { type: 'string', description: 'appointments: live (default), all, confirmed, pending, cancelled, completed, no_show, pending_approval, deposit_pending. payments: paid, pending, refunded. clients: vip, blocked, opted_out' },
        order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort by date/time. Default asc.' },
        limit: { type: 'number', description: 'Max rows (default 20, max 40). 1 with order asc = "first", with desc = "last".' }
      },
      required: ['what']
    }
  },
  {
    name: 'text_clients',
    description: 'Text any set of clients from the business number, with one message. Pick recipients with appointment_ids (from look_up) or with client names/phones. Use {first_name}, {time}, {date}, {service} in the message and each client gets their own details. Use this for anything like "text my first client", "tell everyone after 2 I\'m running behind", "let my Friday people know we moved". More than 3 recipients needs the owner\'s yes: the first call returns a preview to show them.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_ids: { type: 'array', items: { type: 'string' }, description: 'Appointment ids from look_up' },
        clients: { type: 'array', items: { type: 'string' }, description: 'Client names or phone numbers' },
        message: { type: 'string', description: 'The text to send. Placeholders: {first_name} {time} {date} {service}' },
        owner_confirmed: { type: 'boolean', description: 'true only after the owner replied yes to the preview in a later text' }
      },
      required: ['message']
    }
  },
  {
    name: 'change_appointments',
    description: 'Change one or more appointments by id (from look_up): move date/time, change status (confirmed, cancelled, completed, no_show), staff, service, duration, notes. Optionally text each client about it with notify_message (same placeholders as text_clients, filled with the NEW details). Cancelling, or changing more than 3 at once, needs the owner\'s yes first: the first call returns a preview. For a single booking the specific tools (book_client, reschedule_appointment, cancel_appointment) are still fine; use this when they do not fit.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_ids: { type: 'array', items: { type: 'string' } },
        set: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            time: { type: 'string', description: 'HH:MM 24h' },
            shift_minutes: { type: 'number', description: 'Move each appointment later (+) or earlier (-) by this many minutes, keeping its date' },
            status: { type: 'string', enum: ['confirmed', 'cancelled', 'completed', 'no_show', 'pending'] },
            staff_name: { type: 'string' },
            service_name: { type: 'string' },
            duration_mins: { type: 'number' },
            notes: { type: 'string' }
          }
        },
        notify_message: { type: 'string', description: 'If set, text each affected client this message' },
        owner_confirmed: { type: 'boolean', description: 'true only after the owner replied yes to the preview in a later text' }
      },
      required: ['appointment_ids', 'set']
    }
  },
  {
    name: 'change_client',
    description: 'Update a client\'s record: name, phone, email, birthday, VIP flag and note, blocked, deposit waived, marketing opt out. Creates the client if they do not exist and a phone is given.',
    input_schema: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Client name or phone to find' },
        set: {
          type: 'object',
          properties: {
            name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, birthday: { type: 'string', description: 'YYYY-MM-DD or MM-DD' },
            is_vip: { type: 'boolean' }, vip_note: { type: 'string' }, is_blocked: { type: 'boolean' }, deposit_waived: { type: 'boolean' }, marketing_opted_out: { type: 'boolean' }
          }
        }
      },
      required: ['client', 'set']
    }
  },
  {
    name: 'change_settings',
    description: 'Change how the business runs: greeting, tone, things the assistant must not say or do, assistant name, buffer between appointments, how far ahead clients can book, minimum notice, max bookings per day, address, website, review link, missed call text on/off and wording, rebooking reminders on/off and interval, birthday texts, no-show follow up, business name, timezone. Call look_up settings first if you need the current value.',
    input_schema: {
      type: 'object',
      properties: {
        set: {
          type: 'object',
          properties: {
            business_name: { type: 'string' }, bot_name: { type: 'string' }, bot_greeting: { type: 'string' }, bot_tone: { type: 'string' }, bot_restrictions: { type: 'string' },
            buffer_mins: { type: 'number' }, advance_booking_days: { type: 'number' }, min_notice_mins: { type: 'number' }, max_daily: { type: 'number' },
            address: { type: 'string' }, website: { type: 'string' }, google_review_link: { type: 'string' }, timezone: { type: 'string', description: 'IANA zone, e.g. America/Los_Angeles' },
            missed_call_enabled: { type: 'boolean' }, missed_call_message: { type: 'string' },
            rebook_enabled: { type: 'boolean' }, rebook_interval_weeks: { type: 'number' },
            birthday_enabled: { type: 'boolean' }, birthday_message: { type: 'string' },
            noshow_recovery_enabled: { type: 'boolean' }, noshow_recovery_message: { type: 'string' }
          }
        }
      },
      required: ['set']
    }
  },
  {
    name: 'cant_do',
    description: 'Call this ONLY when the owner asked for something that no tool or combination of tools can do. It records the request and alerts the Wexly team so it gets built. Then tell the owner plainly it is not possible by text yet and where in the app they can do it, if they can.',
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'What the owner asked for, in their words' },
        missing: { type: 'string', description: 'What ability would be needed' }
      },
      required: ['request']
    }
  }
]
const GENERAL_NAMES = new Set(GENERAL_TOOLS.map(t => t.name))

// ── two-step confirmation, enforced server-side ─────────────────────────────
const turns = new Map()      // businessId -> counter, bumped once per owner text
const pending = new Map()    // businessId:hash -> { turn, at }
function beginTurn(businessId) { turns.set(businessId, (turns.get(businessId) || 0) + 1) }
function gate(business, kind, payload, ownerConfirmed) {
  const key = business.id + ':' + crypto.createHash('sha1').update(kind + JSON.stringify(payload)).digest('hex')
  const now = Date.now(), turn = turns.get(business.id) || 0
  const p = pending.get(key)
  if (ownerConfirmed && p && p.turn < turn && now - p.at < 15 * 60e3) { pending.delete(key); return true }
  pending.set(key, { turn: p ? Math.min(p.turn, turn) : turn, at: p ? p.at : now })
  for (const [k, v] of pending) if (now - v.at > 30 * 60e3) pending.delete(k)
  return false
}

const hhmm = t => String(t || '').slice(0, 5)
const realPhone = p => String(p || '').replace(/\D/g, '').length >= 10
const first = n => String(n || '').trim().split(/\s+/)[0] || 'there'
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))
const isTime = t => /^\d{1,2}:\d{2}$/.test(String(t || ''))
const pad = t => { const [h, m] = String(t).split(':'); return `${String(h).padStart(2, '0')}:${m}` }
function fill(msg, a) {
  return String(msg)
    .replace(/\{first_name\}/gi, first(a.customer_name || a.name))
    .replace(/\{time\}/gi, a.appointment_time ? formatTime(a.appointment_time) : 'your appointment time')
    .replace(/\{date\}/gi, a.appointment_date ? formatDate(a.appointment_date) : 'your appointment day')
    .replace(/\{service\}/gi, a.service_name || 'appointment')
}
const apptLine = a => `${a.id} | ${a.appointment_date} ${hhmm(a.appointment_time)} | ${a.customer_name || 'Unknown'} | ${a.service_name || '-'}${a.staff_name ? ' | with ' + a.staff_name : ''} | ${a.status}${realPhone(a.customer_phone) ? '' : ' | NO PHONE'}`

async function loadAppts(business, ids) {
  const clean = [...new Set((ids || []).map(String).filter(x => /^[0-9a-f-]{36}$/i.test(x)))]
  if (!clean.length) return []
  const { data } = await supabase.from('appointments').select('*').eq('business_id', business.id).in('id', clean).order('appointment_date').order('appointment_time')
  return data || []
}
async function findClients(business, terms) {
  const out = [], unknown = []
  for (const raw of terms || []) {
    const t = String(raw || '').trim(); if (!t) continue
    if (realPhone(t) && !/[a-z]/i.test(t)) {
      const e = toE164(t)
      const { data: c } = await supabase.from('customers').select('name, phone').eq('business_id', business.id).in('phone', phoneVariants(e)).limit(1)
      out.push({ name: c?.[0]?.name || null, customer_phone: c?.[0]?.phone || e }); continue
    }
    const { data: cs } = await supabase.from('customers').select('name, phone').eq('business_id', business.id).ilike('name', `%${t}%`).limit(6)
    const good = (cs || []).filter(c => realPhone(c.phone))
    const exact = good.find(c => (c.name || '').toLowerCase() === t.toLowerCase())
    if (exact || good.length === 1) { const c = exact || good[0]; out.push({ name: c.name, customer_phone: c.phone }) }
    else if (good.length > 1) unknown.push(`"${t}" matches ${good.map(c => c.name).join(', ')}: which one?`)
    else unknown.push(`"${t}": no client with a phone number by that name`)
  }
  return { out, unknown }
}

async function lookUp(business, input, today) {
  const lim = Math.max(1, Math.min(MAX_ROWS, Math.floor(+input.limit || 20)))
  const asc = input.order !== 'desc'
  const B = business.id
  switch (input.what) {
    case 'appointments': {
      let q = supabase.from('appointments').select('id, customer_name, customer_phone, service_name, appointment_date, appointment_time, duration_mins, status, staff_name, notes, deposit_status').eq('business_id', B)
      const st = String(input.status || 'live').toLowerCase()
      if (st === 'live') q = q.in('status', LIVE); else if (st !== 'all') q = q.eq('status', st)
      if (isDate(input.from_date)) q = q.gte('appointment_date', input.from_date); else if (!isDate(input.to_date) && !input.client) q = q.gte('appointment_date', today)
      if (isDate(input.to_date)) q = q.lte('appointment_date', input.to_date)
      if (isTime(input.from_time)) q = q.gte('appointment_time', pad(input.from_time))
      if (isTime(input.to_time)) q = q.lte('appointment_time', pad(input.to_time) + ':59')
      if (input.client) { if (realPhone(input.client) && !/[a-z]/i.test(input.client)) q = q.in('customer_phone', phoneVariants(toE164(input.client))); else q = q.ilike('customer_name', `%${String(input.client).trim()}%`) }
      if (input.service) q = q.ilike('service_name', `%${String(input.service).trim()}%`)
      if (input.staff) q = q.ilike('staff_name', `%${String(input.staff).trim()}%`)
      const { data, error } = await q.order('appointment_date', { ascending: asc }).order('appointment_time', { ascending: asc }).limit(lim)
      if (error) return `Lookup failed: ${error.message}`
      if (!data?.length) return 'No appointments match.'
      return `${data.length} appointment${data.length !== 1 ? 's' : ''} (id | date time | client | service | status):\n` + data.map(apptLine).join('\n')
    }
    case 'clients': {
      let q = supabase.from('customers').select('name, phone, email, birthday, is_vip, vip_note, is_blocked, deposit_waived, opted_out, marketing_opted_out, created_at').eq('business_id', B)
      if (input.client) { if (realPhone(input.client) && !/[a-z]/i.test(input.client)) q = q.in('phone', phoneVariants(toE164(input.client))); else q = q.ilike('name', `%${String(input.client).trim()}%`) }
      const st = String(input.status || '').toLowerCase()
      if (st === 'vip') q = q.eq('is_vip', true); if (st === 'blocked') q = q.eq('is_blocked', true); if (st === 'opted_out') q = q.eq('opted_out', true)
      const { data, error } = await q.order('created_at', { ascending: asc }).limit(lim)
      if (error) return `Lookup failed: ${error.message}`
      if (!data?.length) return 'No clients match.'
      const { count } = await supabase.from('customers').select('id', { count: 'exact', head: true }).eq('business_id', B)
      return `${data.length} shown of ${count ?? '?'} clients:\n` + data.map(c => `${c.name || 'Unknown'} | ${c.phone || 'no phone'}${c.email ? ' | ' + c.email : ''}${c.birthday ? ' | bday ' + c.birthday : ''}${c.is_vip ? ' | VIP' + (c.vip_note ? ' (' + c.vip_note + ')' : '') : ''}${c.is_blocked ? ' | BLOCKED' : ''}${c.opted_out ? ' | opted out of texts' : ''}${c.deposit_waived ? ' | deposit waived' : ''}`).join('\n')
    }
    case 'services': {
      const { data } = await supabase.from('services').select('name, duration_mins, price, price_cents, deposit_amount, category, active, staff_members').eq('business_id', B).order('sort_order')
      if (!data?.length) return 'No services set up yet.'
      return data.map(s => `${s.name} | ${s.duration_mins} min | $${s.price ?? (s.price_cents != null ? s.price_cents / 100 : '?')}${s.deposit_amount ? ' | deposit $' + s.deposit_amount : ''}${s.category ? ' | ' + s.category : ''}${s.active === false ? ' | HIDDEN' : ''}`).join('\n')
    }
    case 'staff': {
      const list = (business.staff_members || []).filter(s => s && s.name)
      return list.length ? list.map(s => `${s.name}${s.phone ? ' | ' + s.phone : ''}${s.commission_pct != null ? ' | ' + s.commission_pct + '% cut' : ''}${s.services?.length ? ' | does ' + s.services.join(', ') : ''}`).join('\n') : 'No staff added. The owner is the only provider.'
    }
    case 'blocked_dates': {
      let q = supabase.from('blocked_dates').select('blocked_date, start_time, end_time, reason').eq('business_id', B).gte('blocked_date', isDate(input.from_date) ? input.from_date : today)
      if (isDate(input.to_date)) q = q.lte('blocked_date', input.to_date)
      const { data } = await q.order('blocked_date').limit(60)
      return data?.length ? data.map(b => `${b.blocked_date} | ${b.start_time ? hhmm(b.start_time) + '-' + hhmm(b.end_time) : 'full day'}${b.reason ? ' | ' + b.reason : ''}`).join('\n') : 'Nothing is blocked.'
    }
    case 'payments': {
      let q = supabase.from('transactions').select('customer_name, total, tip, status, staff_name, created_at, refunded_amount').eq('business_id', B)
      if (isDate(input.from_date)) q = q.gte('created_at', input.from_date + 'T00:00:00')
      if (isDate(input.to_date)) q = q.lte('created_at', input.to_date + 'T23:59:59')
      if (input.client) q = q.ilike('customer_name', `%${String(input.client).trim()}%`)
      if (input.staff) q = q.ilike('staff_name', `%${String(input.staff).trim()}%`)
      if (input.status && input.status !== 'all') q = q.eq('status', String(input.status).toLowerCase())
      const { data, error } = await q.order('created_at', { ascending: asc }).limit(lim)
      if (error) return `Lookup failed: ${error.message}`
      if (!data?.length) return 'No payments match.'
      const sum = data.reduce((n, t) => n + (+t.total || 0), 0), tips = data.reduce((n, t) => n + (+t.tip || 0), 0)
      return `${data.length} payment${data.length !== 1 ? 's' : ''}, total $${sum.toFixed(2)} (tips $${tips.toFixed(2)}):\n` + data.map(t => `${String(t.created_at).slice(0, 10)} | ${t.customer_name || 'Unknown'} | $${(+t.total || 0).toFixed(2)}${+t.tip ? ' (tip $' + (+t.tip).toFixed(2) + ')' : ''} | ${t.status}${t.staff_name ? ' | ' + t.staff_name : ''}`).join('\n')
    }
    case 'waitlist': {
      const { data } = await supabase.from('waitlist').select('customer_name, customer_phone, service_name, preferred_date, preferred_time').eq('business_id', B).order('created_at').limit(lim)
      return data?.length ? data.map(w => `${w.customer_name || 'Unknown'} | ${w.customer_phone || ''} | ${w.service_name || '-'} | wants ${w.preferred_date || 'any day'} ${w.preferred_time ? hhmm(w.preferred_time) : ''}`).join('\n') : 'Nobody is on the waitlist.'
    }
    case 'products': {
      const { data } = await supabase.from('products').select('name, price, qty, low_stock_threshold, active').eq('business_id', B).order('name').limit(60)
      return data?.length ? data.map(p => `${p.name} | $${p.price} | ${p.qty} in stock${p.qty <= (p.low_stock_threshold ?? -1) ? ' | LOW' : ''}`).join('\n') : 'No products set up.'
    }
    case 'settings': {
      const keys = ['business_name', 'bot_name', 'bot_greeting', 'bot_tone', 'bot_restrictions', 'buffer_mins', 'advance_booking_days', 'min_notice_mins', 'max_daily', 'address', 'website', 'google_review_link', 'timezone', 'plan', 'sms_number', 'missed_call_enabled', 'missed_call_message', 'rebook_enabled', 'rebook_interval_weeks', 'birthday_enabled', 'noshow_recovery_enabled', 'hours']
      const { data: b } = await supabase.from('businesses').select('*').eq('id', B).maybeSingle()
      return keys.filter(k => b && b[k] !== undefined).map(k => `${k}: ${typeof b[k] === 'object' ? JSON.stringify(b[k]) : b[k] === null || b[k] === '' ? '(not set)' : b[k]}`).join('\n')
    }
    case 'conversations': {
      let q = supabase.from('conversation_sessions').select('customer_phone, last_activity, needs_attention, attention_reason, messages').eq('business_id', B).not('customer_phone', 'like', 'owner%')
      if (input.client && realPhone(input.client)) q = q.in('customer_phone', phoneVariants(toE164(input.client)))
      const { data } = await q.order('last_activity', { ascending: false }).limit(Math.min(lim, 10))
      if (!data?.length) return 'No client conversations.'
      return data.map(c => { const m = (c.messages || []).filter(x => typeof x.content === 'string').slice(-3); return `${c.customer_phone} | last ${String(c.last_activity).slice(0, 16)}${c.needs_attention ? ' | NEEDS YOU: ' + (c.attention_reason || '') : ''}\n` + m.map(x => `   ${x.role === 'user' ? 'client' : 'us'}: ${String(x.content).slice(0, 140)}`).join('\n') }).join('\n')
    }
  }
  return `I can't look up "${input.what}".`
}

async function textClients(business, input, deps) {
  const msg = String(input.message || '').trim()
  if (!msg) return 'No message given, so nothing was sent.'
  const appts = await loadAppts(business, input.appointment_ids)
  const { out: named, unknown } = await findClients(business, input.clients)
  // one text per phone
  const seen = new Set(), targets = [], noPhone = []
  for (const a of [...appts, ...named]) {
    if (!realPhone(a.customer_phone)) { noPhone.push(a.customer_name || a.name || 'Unknown'); continue }
    const k = String(a.customer_phone).replace(/\D/g, '').slice(-10); if (seen.has(k)) continue; seen.add(k); targets.push(a)
  }
  if (!targets.length) return `Nobody to text.${unknown.length ? ' ' + unknown.join(' ') : ''}${noPhone.length ? ' No phone on file for ' + noPhone.join(', ') + '.' : ''} Nothing was sent.`
  if (unknown.length) return `Not sent yet. ${unknown.join(' ')}`
  const who = targets.map(a => `${a.customer_name || a.name || a.customer_phone}${a.appointment_time ? ' (' + formatTime(a.appointment_time) + ')' : ''}`)
  if (targets.length > MASS && !gate(business, 'text', { p: [...seen].sort(), msg }, input.owner_confirmed === true)) {
    return `PREVIEW, NOT SENT. This would text ${targets.length} clients: ${who.join(', ')}.\nMessage: "${fill(msg, targets[0])}"\nShow the owner this and ask them to reply yes. Only after they reply, call text_clients again with the same recipients and message and owner_confirmed true.`
  }
  const { sendSMS } = require('../utils/sms')
  const sent = [], failed = []
  for (const a of targets) {
    const body = fill(msg, a)
    try {
      const r = await sendSMS(business.sms_number, a.customer_phone, body)
      if (r?.success) { sent.push(a); if (deps?.noteClientThread) await deps.noteClientThread(business.id, a.customer_phone, `[The owner had this sent to the client] ${body}`).catch(() => {}) }
      else failed.push(a.customer_name || a.name || a.customer_phone)
      await new Promise(r => setTimeout(r, 250))
    } catch (e) { failed.push(a.customer_name || a.name || a.customer_phone) }
  }
  const names = sent.map(a => `${a.customer_name || a.name || a.customer_phone}${a.appointment_time ? ' (' + formatTime(a.appointment_time) + ')' : ''}`)
  return `${sent.length ? `SENT to ${sent.length}: ${names.join(', ')}. Message: "${fill(msg, sent[0])}"` : 'Nothing was sent.'}${failed.length ? ` Could not reach: ${failed.join(', ')}.` : ''}${noPhone.length ? ` No phone on file: ${noPhone.join(', ')}.` : ''}`
}

function addMinutes(t, mins) {
  const [h, m] = hhmm(t).split(':').map(Number); let x = h * 60 + m + mins
  if (x < 0 || x >= 24 * 60) return null
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`
}

async function changeAppointments(business, input, deps) {
  const appts = await loadAppts(business, input.appointment_ids)
  if (!appts.length) return 'No matching appointments. Use look_up to get their ids first. Nothing changed.'
  const set = input.set || {}
  const patchFor = a => {
    const p = {}
    if (isDate(set.date)) p.appointment_date = set.date
    if (isTime(set.time)) p.appointment_time = pad(set.time)
    if (Number.isFinite(+set.shift_minutes) && +set.shift_minutes !== 0 && !p.appointment_time) { const t = addMinutes(a.appointment_time, Math.round(+set.shift_minutes)); if (t) p.appointment_time = t; else p.__bad = 'would move past midnight' }
    if (['confirmed', 'cancelled', 'completed', 'no_show', 'pending'].includes(set.status)) p.status = set.status
    if (typeof set.staff_name === 'string') p.staff_name = set.staff_name.trim() || null
    if (typeof set.service_name === 'string' && set.service_name.trim()) p.service_name = set.service_name.trim()
    if (Number.isFinite(+set.duration_mins) && +set.duration_mins > 0) p.duration_mins = Math.round(+set.duration_mins)
    if (typeof set.notes === 'string') p.notes = set.notes
    return p
  }
  const plans = appts.map(a => ({ a, p: patchFor(a) }))
  if (!Object.keys(plans[0].p).length) return 'Nothing to change: no valid fields in set. Nothing changed.'
  const bad = plans.filter(x => x.p.__bad)
  if (bad.length) return `Not changed: ${bad.map(x => x.a.customer_name).join(', ')} ${bad[0].p.__bad}. Nothing changed.`
  const describe = ({ a, p }) => `${a.customer_name || 'Unknown'} ${a.appointment_date} ${hhmm(a.appointment_time)}` + ((p.appointment_date || p.appointment_time) ? ` -> ${p.appointment_date || a.appointment_date} ${hhmm(p.appointment_time || a.appointment_time)}` : '') + (p.status ? ` -> ${p.status}` : '') + (p.staff_name !== undefined ? ` -> with ${p.staff_name || 'no staff'}` : '') + (p.service_name ? ` -> ${p.service_name}` : '')
  const needsYes = set.status === 'cancelled' || appts.length > MASS
  if (needsYes && !gate(business, 'appt', { ids: appts.map(a => a.id).sort(), set, n: input.notify_message || '' }, input.owner_confirmed === true)) {
    return `PREVIEW, NOTHING CHANGED. This would change ${appts.length} appointment${appts.length !== 1 ? 's' : ''}:\n${plans.map(describe).join('\n')}${input.notify_message ? `\nand text each client: "${fill(input.notify_message, { ...appts[0], ...plans[0].p })}"` : '\n(no text to clients)'}\nShow the owner this and ask them to reply yes. Only after they reply, call change_appointments again with the same ids and set and owner_confirmed true.`
  }
  // moving onto a slot someone else already has: warn, don't silently double book
  const clashes = []
  for (const { a, p } of plans) {
    if (!(p.appointment_date || p.appointment_time)) continue
    const d = p.appointment_date || a.appointment_date, t = p.appointment_time || hhmm(a.appointment_time)
    const { data: same } = await supabase.from('appointments').select('id, customer_name, staff_name').eq('business_id', business.id).eq('appointment_date', d).eq('appointment_time', t + ':00').in('status', LIVE)
    const other = (same || []).filter(o => !appts.some(x => x.id === o.id) && (!a.staff_name || !o.staff_name || o.staff_name === (p.staff_name ?? a.staff_name)))
    if (other.length) clashes.push(`${a.customer_name} at ${formatTime(t)} on ${formatDate(d)} overlaps ${other[0].customer_name}`)
  }
  const done = [], failed = []
  for (const { a, p } of plans) {
    const { error } = await supabase.from('appointments').update({ ...p, updated_at: new Date().toISOString() }).eq('id', a.id).eq('business_id', business.id)
    if (error) failed.push(`${a.customer_name}: ${error.message}`); else done.push({ a, p })
  }
  let texted = 0; const noText = []
  if (input.notify_message && done.length) {
    const { sendSMS } = require('../utils/sms')
    for (const { a, p } of done) {
      if (!realPhone(a.customer_phone)) { noText.push(a.customer_name); continue }
      const body = fill(input.notify_message, { ...a, ...p })
      try { const r = await sendSMS(business.sms_number, a.customer_phone, body); if (r?.success) { texted++; if (deps?.noteClientThread) await deps.noteClientThread(business.id, a.customer_phone, `[The owner changed this booking and had this sent] ${body}`).catch(() => {}) } else noText.push(a.customer_name) } catch (e) { noText.push(a.customer_name) }
      await new Promise(r => setTimeout(r, 250))
    }
  }
  return `${done.length ? `CHANGED ${done.length}: ${done.map(describe).join('; ')}.` : 'Nothing changed.'}${failed.length ? ` FAILED: ${failed.join('; ')}.` : ''}${input.notify_message ? ` Texted ${texted} client${texted !== 1 ? 's' : ''}.${noText.length ? ' Could not text: ' + noText.join(', ') + '.' : ''}` : ' Clients were NOT texted about this.'}${clashes.length ? ` Heads up, double booked: ${clashes.join('; ')}.` : ''}`
}

async function changeClient(business, input) {
  const set = input.set || {}, patch = {}
  for (const k of ['name', 'email', 'vip_note', 'birthday']) if (typeof set[k] === 'string') patch[k] = set[k].trim() || null
  for (const k of ['is_vip', 'is_blocked', 'deposit_waived', 'marketing_opted_out']) if (typeof set[k] === 'boolean') patch[k] = set[k]
  if (set.phone) { if (!realPhone(set.phone)) return 'That phone number does not look complete. Nothing changed.'; patch.phone = toE164(set.phone) }
  if (!Object.keys(patch).length) return 'Nothing to change. Nothing changed.'
  const term = String(input.client || '').trim()
  let q = supabase.from('customers').select('id, name, phone').eq('business_id', business.id)
  q = realPhone(term) && !/[a-z]/i.test(term) ? q.in('phone', phoneVariants(toE164(term))) : q.ilike('name', `%${term}%`)
  const { data: found } = await q.limit(6)
  let c = (found || []).find(x => (x.name || '').toLowerCase() === term.toLowerCase()) || ((found || []).length === 1 ? found[0] : null)
  if (!c && (found || []).length > 1) return `More than one client matches "${term}": ${found.map(x => x.name).join(', ')}. Which one? Nothing changed.`
  if (!c) {
    const phone = patch.phone || (realPhone(term) ? toE164(term) : null)
    if (!phone) return `No client named "${term}". Give me their phone number and I'll add them. Nothing changed.`
    const { error } = await supabase.from('customers').insert({ business_id: business.id, name: patch.name || (realPhone(term) ? null : term), ...patch, phone, source: 'owner_text' })
    return error ? `Couldn't add them: ${error.message}. Nothing changed.` : `ADDED client ${patch.name || term} ${phone}.`
  }
  const { error } = await supabase.from('customers').update(patch).eq('id', c.id).eq('business_id', business.id)
  if (error) return `Couldn't update ${c.name}: ${error.message}. Nothing changed.`
  // keep their upcoming bookings pointed at the new number / name
  if (patch.phone && c.phone) await supabase.from('appointments').update({ customer_phone: patch.phone }).eq('business_id', business.id).in('customer_phone', phoneVariants(c.phone))
  if (patch.name && c.phone) await supabase.from('appointments').update({ customer_name: patch.name }).eq('business_id', business.id).in('customer_phone', phoneVariants(patch.phone || c.phone))
  return `UPDATED ${c.name}: ${Object.entries(patch).map(([k, v]) => `${k} = ${v}`).join(', ')}.`
}

const SETTINGS = {
  business_name: 'str', bot_name: 'str', bot_greeting: 'str', bot_tone: 'str', bot_restrictions: 'str', address: 'str', website: 'str', google_review_link: 'str', timezone: 'tz',
  missed_call_message: 'str', birthday_message: 'str', noshow_recovery_message: 'str',
  buffer_mins: [0, 240], advance_booking_days: [1, 365], min_notice_mins: [0, 10080], max_daily: [1, 200], rebook_interval_weeks: [1, 52],
  missed_call_enabled: 'bool', rebook_enabled: 'bool', birthday_enabled: 'bool', noshow_recovery_enabled: 'bool',
}
async function changeSettings(business, input) {
  const set = input.set || {}, patch = {}, bad = []
  for (const [k, v] of Object.entries(set)) {
    const rule = SETTINGS[k]
    if (!rule) { bad.push(`${k} can't be changed by text`); continue }
    if (rule === 'str') { if (typeof v !== 'string' || v.length > 1200) bad.push(`${k} is not valid`); else if (k === 'business_name' && !v.trim()) bad.push('business name cannot be empty'); else patch[k] = v.trim() }
    else if (rule === 'bool') { if (typeof v !== 'boolean') bad.push(`${k} must be on or off`); else patch[k] = v }
    else if (rule === 'tz') { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); patch[k] = v } catch (e) { bad.push(`"${v}" is not a timezone I know`) } }
    else { const n = Math.round(+v); if (!Number.isFinite(n) || n < rule[0] || n > rule[1]) bad.push(`${k} must be between ${rule[0]} and ${rule[1]}`); else patch[k] = n }
  }
  if (!Object.keys(patch).length) return `Nothing changed.${bad.length ? ' ' + bad.join('; ') + '.' : ''}`
  const { error } = await supabase.from('businesses').update(patch).eq('id', business.id)
  if (error) return `Couldn't save that: ${error.message}. Nothing changed.`
  Object.assign(business, patch)
  return `SAVED: ${Object.entries(patch).map(([k, v]) => `${k} = ${typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : v}`).join(', ')}.${bad.length ? ' Not changed: ' + bad.join('; ') + '.' : ''}`
}

async function cantDo(business, input) {
  const req = String(input.request || '').slice(0, 600), missing = String(input.missing || '').slice(0, 300)
  console.warn(`[OwnerGap] ${business.business_name}: "${req}" needs: ${missing}`)
  try { await supabase.from('usage_events').insert({ business_id: business.id, sms_number: business.sms_number || null, kind: 'owner_gap', detail: `${req} || needs: ${missing}`.slice(0, 900) }) } catch (e) {}
  try {
    const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    await require('../utils/emailService').sendEmail({ from: { email: 'hello@getwexly.com', name: 'Wexly' }, to: 'hello@getwexly.com', subject: `Owner asked for something Wexly can't do: ${business.business_name}`, html: `<p><b>${esc(business.business_name)}</b> texted:</p><blockquote>${esc(req)}</blockquote><p>Missing: ${esc(missing || 'not stated')}</p>` })
  } catch (e) {}
  return 'Logged and the Wexly team has been alerted. Tell the owner plainly this is not possible by text yet, and point them to where in the app they can do it if there is a place.'
}

async function executeGeneralTool(name, input, business, today, deps) {
  input = input || {}
  switch (name) {
    case 'look_up': return lookUp(business, input, today)
    case 'text_clients': return textClients(business, input, deps)
    case 'change_appointments': return changeAppointments(business, input, deps)
    case 'change_client': return changeClient(business, input)
    case 'change_settings': return changeSettings(business, input)
    case 'cant_do': return cantDo(business, input)
  }
  return `Unknown tool ${name}`
}

module.exports = { GENERAL_TOOLS, GENERAL_NAMES, executeGeneralTool, beginTurn }
