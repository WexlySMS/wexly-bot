// ── Calendar importer (v206, Entry 77) ────────────────────────────────────────
// Brings an owner's existing appointments into Wexly so nothing double-books
// while they switch platforms. Three inputs, one pipeline:
//
//   1. A calendar link (Google "secret address", Apple public calendar, Acuity /
//      Mangomint / Fresha subscribe URL, any .ics). Fetched, parsed, normalised
//      by the model against the business's services and staff, written as
//      confirmed appointments. The feed is then re-read every 15 minutes for
//      SYNC_DAYS so bookings made on the old platform during the overlap keep
//      flowing in, moves are mirrored, and cancellations are honoured.
//   2. Screenshots of their old calendar (MMS). Read by the model, same apply.
//   3. (dashboard, pre-existing) an uploaded .ics file.
//
// Rules the whole file obeys:
//   - Never text a client because of an import. Imported appointments get the
//     business's ordinary reminders later, nothing else.
//   - A client with no phone still lands on the schedule (it blocks the slot);
//     the phone is a digit-free `nophone-...` placeholder the SMS layer skips.
//     Same convention as the dashboard's .ics upload.
//   - Wexly wins. Once the owner changes an imported appointment in Wexly, a
//     later feed read never moves it back (snapshot check in applyEvents).
//   - Idempotent. Re-reading a feed, or re-sending a screenshot, adds nothing
//     twice (UID when the DB has the column, date|time|name otherwise).

const crypto = require('crypto')
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const MODEL = process.env.IMPORT_MODEL || 'claude-sonnet-4-6'
const FETCH_MS = 15000
const MAX_ICS_BYTES = 6 * 1024 * 1024
const WINDOW_DAYS = 90          // how far ahead we import
const MAX_EVENTS = 400
const MODEL_BATCH = 40
const SYNC_DAYS = 45            // how long a linked feed keeps mirroring
const SYNC_FAILS_BEFORE_OFF = 6 // ~90 minutes of consecutive fetch errors
const IMPORT_NOTE = 'Imported from calendar'

// ── Link detection & platform knowledge ──────────────────────────────────────
const CAL_URL_RE = /(webcal:\/\/[^\s<>"']+|https?:\/\/[^\s<>"']+?\.ics(?:\?[^\s<>"']*)?|https?:\/\/calendar\.google\.com\/calendar\/ical\/[^\s<>"']+|https?:\/\/p\d+-caldav\.icloud\.com\/published\/[^\s<>"']+|https?:\/\/outlook\.(?:live|office)\.com\/owa\/calendar\/[^\s<>"']+|https?:\/\/[^\s<>"']*(?:acuityscheduling\.com|mangomint\.com|fresha\.com)\/[^\s<>"']*(?:calendar|ical|feed)[^\s<>"']*)/i

function extractCalendarUrl(text) {
  const m = String(text || '').match(CAL_URL_RE)
  if (!m) return null
  return m[1].replace(/[.,;:!?)]+$/, '')
}

// Which booking platform does a URL belong to? Used to tailor the "turn on
// sync" instructions. Mirrors the siteImporter's platform names.
function platformFromUrl(url) {
  const u = String(url || '').toLowerCase()
  if (!u) return null
  if (/glossgenius/.test(u)) return 'glossgenius'
  if (/vagaro/.test(u)) return 'vagaro'
  if (/booksy/.test(u)) return 'booksy'
  if (/square(?:up)?\.(?:com|site|link)|squareup/.test(u)) return 'square'
  if (/fresha/.test(u)) return 'fresha'
  if (/acuity|as\.me\b/.test(u)) return 'acuity'
  if (/styleseat/.test(u)) return 'styleseat'
  if (/mangomint/.test(u)) return 'mangomint'
  if (/joinblvd|joinboulevard|boulevard/.test(u)) return 'boulevard'
  if (/schedulicity/.test(u)) return 'schedulicity'
  if (/goldie|appointfix/.test(u)) return 'goldie'
  if (/setmore/.test(u)) return 'setmore'
  if (/zenoti/.test(u)) return 'zenoti'
  return null
}

const PLATFORM = {
  glossgenius: { name: 'GlossGenius', sync: true,  step: 'In GlossGenius: Settings > Personal > My Preferences > Two-Way Calendar Sync, and pick Google.' },
  vagaro:      { name: 'Vagaro',      sync: true,  step: 'In Vagaro: Settings > Calendar Sync, and connect Google.' },
  square:      { name: 'Square',      sync: true,  step: 'In Square Appointments: Settings > Calendar Sync, and connect Google.' },
  fresha:      { name: 'Fresha',      sync: true,  step: 'In Fresha: your team profile > Calendar sync, and link Google.' },
  acuity:      { name: 'Acuity',      sync: true,  step: 'In Acuity: Sync with Other Calendars, connect Google (or copy the Subscribe link there and text me that).' },
  styleseat:   { name: 'StyleSeat',   sync: true,  step: 'In StyleSeat: Settings > Calendar Sync, and connect Google.' },
  mangomint:   { name: 'Mangomint',   sync: true,  step: 'In Mangomint: your profile > Link calendar, copy the iCal link and text me that.' },
  schedulicity:{ name: 'Schedulicity',sync: true,  step: 'In Schedulicity: Settings > Calendar Sync, and connect Google.' },
  goldie:      { name: 'Goldie',      sync: true,  step: 'In Goldie: Settings > Calendar sync, and connect Google.' },
  setmore:     { name: 'Setmore',     sync: true,  step: 'In Setmore: Integrations > Google Calendar, and connect it.' },
  zenoti:      { name: 'Zenoti',      sync: false },
  booksy:      { name: 'Booksy',      sync: false },
  boulevard:   { name: 'Boulevard',   sync: false }
}
const GOOGLE_STEP = 'Then in Google Calendar on a computer: Settings > click your calendar on the left > Integrate calendar > copy the "Secret address in iCal format" and text it here.'
const APPLE_STEP = 'On Apple Calendar: tap the (i) next to the calendar, turn on Public Calendar, and text me the link.'

// The two texts the setup step sends. First the ask, then the how-to, so the
// ask itself stays short enough to read in one glance.
function bookingsQuestion(platformKey) {
  const p = PLATFORM[platformKey]
  if (p && !p.sync) {
    return [
      `Last thing: want me to bring over your upcoming appointments so nothing double-books while you switch? ${p.name} doesn't share its calendar, so screenshots are the move: open your ${p.name} calendar, screenshot each week for the next month or so, and text them here. Reply SKIP to pass.`
    ]
  }
  const ask = `Last thing: want me to bring over your upcoming appointments so nothing double-books while you switch? Text me your calendar link and I'll do the rest. Screenshots of your calendar work too. Reply SKIP to pass.`
  const how = `To get the link: ${p?.step ? p.step + ' ' : 'turn on calendar sync in your current booking app and pick Google. '}${GOOGLE_STEP} ${APPLE_STEP}`
  return [ask, how]
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
function normalizeCalendarUrl(raw) {
  let u = String(raw || '').trim().replace(/^webcal:\/\//i, 'https://')
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try { const x = new URL(u); if (!/\./.test(x.hostname)) return null; return x.toString() } catch { return null }
}

async function fetchIcs(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Wexly/1.0 (+https://getwexly.com)', Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' }, redirect: 'follow', signal: ctl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > MAX_ICS_BYTES) throw new Error('calendar file too large')
    const text = buf.toString('utf8')
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      if (/<html/i.test(text)) throw new Error('that link opens a web page, not a calendar feed')
      throw new Error('not a calendar feed')
    }
    return text
  } finally { clearTimeout(t) }
}

// ── ICS parsing ───────────────────────────────────────────────────────────────
const WINDOWS_TZ = {
  'pacific standard time': 'America/Los_Angeles', 'mountain standard time': 'America/Denver', 'us mountain standard time': 'America/Phoenix',
  'central standard time': 'America/Chicago', 'eastern standard time': 'America/New_York', 'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu', 'atlantic standard time': 'America/Halifax', 'gmt standard time': 'Europe/London',
  'central europe standard time': 'Europe/Berlin', 'w. europe standard time': 'Europe/Berlin', 'aus eastern standard time': 'Australia/Sydney'
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false } }
function resolveTz(tzid, fallback) {
  if (!tzid) return fallback
  const clean = tzid.replace(/^"|"$/g, '').replace(/^\//, '')
  if (validTz(clean)) return clean
  const w = WINDOWS_TZ[clean.toLowerCase()]
  if (w) return w
  // Outlook style "(UTC-08:00) Pacific Time (US & Canada)" or Apple's long names
  const tail = clean.split('/').slice(-2).join('/')
  if (validTz(tail)) return tail
  return fallback
}

// Wall-clock in tz → UTC Date (two-pass offset, handles DST edges without a lib)
function zonedToUtc(y, mo, d, hh, mm, ss, tz) {
  const asUtc = Date.UTC(y, mo - 1, d, hh, mm, ss || 0)
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))
    const g = (k) => Number(parts.find(p => p.type === k).value)
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - ms
  }
  let guess = asUtc - offsetAt(asUtc)
  guess = asUtc - offsetAt(guess)
  return new Date(guess)
}
// UTC Date → {date:'YYYY-MM-DD', time:'HH:MM'} in tz
function utcToZoned(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date)
  const g = (k) => parts.find(p => p.type === k).value
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${String(Number(g('hour')) % 24).padStart(2, '0')}:${g('minute')}` }
}

// "20261110T180000Z" | "20261110T100000" (+TZID) | "20261110" (DATE)
function parseDt(value, params, bizTz) {
  const v = String(value || '').trim()
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, hh, mm, ss, z] = m
  if (hh == null) return { allDay: true, date: new Date(Date.UTC(+y, +mo - 1, +d)) }
  if (z) return { allDay: false, date: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss || 0))) }
  const tz = resolveTz(params.TZID, bizTz)
  return { allDay: false, date: zonedToUtc(+y, +mo, +d, +hh, +mm, +(ss || 0), tz) }
}
function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const mins = (+(m[2] || 0) * 7 * 1440) + (+(m[3] || 0) * 1440) + (+(m[4] || 0) * 60) + (+(m[5] || 0)) + Math.round(+(m[6] || 0) / 60)
  return mins || null
}
const unescapeText = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim()

// One VEVENT block → property list [{name, params, value}] (a name may repeat: ATTENDEE, EXDATE)
function parseProps(block) {
  const props = []
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':'); if (idx < 1) continue
    let head = line.slice(0, idx), value = line.slice(idx + 1)
    // Params may contain quoted values with colons: CN="Smith, Jane":mailto:...
    const q = (head.match(/"/g) || []).length
    if (q % 2 === 1) { const close = line.indexOf('"', idx + 1); if (close > 0) { const next = line.indexOf(':', close); head = line.slice(0, next); value = line.slice(next + 1) } }
    const [name, ...rest] = head.split(';')
    const params = {}
    for (const p of rest) { const e = p.indexOf('='); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, '') }
    props.push({ name: name.toUpperCase(), params, value })
  }
  return props
}

// Expand a simple RRULE (DAILY / WEEKLY[;BYDAY] / MONTHLY) into instance start
// Dates between now and the horizon. Standing appointments ("every 4 weeks")
// are common in salons, so this matters; exotic rules fall back to the first
// instance only.
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
function expandRrule(rule, start, horizon, exdates) {
  const r = {}; for (const part of String(rule).split(';')) { const [k, v] = part.split('='); if (k) r[k.toUpperCase()] = v }
  const freq = r.FREQ, interval = Math.max(1, parseInt(r.INTERVAL || '1', 10))
  const count = r.COUNT ? parseInt(r.COUNT, 10) : null
  const until = r.UNTIL ? (parseDt(r.UNTIL, {}, 'UTC')?.date || null) : null
  const out = []
  const ex = new Set(exdates.map(d => d.getTime()))
  const push = (d) => { if (d > horizon) return false; if (until && d > until) return false; if (!ex.has(d.getTime())) out.push(d); return true }
  let produced = 0
  if (freq === 'DAILY' || (freq === 'WEEKLY' && !r.BYDAY) || freq === 'MONTHLY' || freq === 'YEARLY') {
    const d = new Date(start)
    for (let i = 0; i < 400; i++) {
      if (count && produced >= count) break
      if (!push(new Date(d))) { if (d > horizon || (until && d > until)) break }
      produced++
      if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + interval)
      else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7 * interval)
      else if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + interval)
      else d.setUTCFullYear(d.getUTCFullYear() + interval)
    }
    return out
  }
  if (freq === 'WEEKLY') {
    const days = r.BYDAY.split(',').map(x => BYDAY[x.slice(-2)]).filter(x => x != null).sort()
    // walk week by week from the week containing `start`
    const weekStart = new Date(start); weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay())
    for (let w = 0; w < 120; w++) {
      for (const dow of days) {
        const d = new Date(weekStart); d.setUTCDate(d.getUTCDate() + w * 7 * interval + dow)
        if (d < start) continue
        if (count && produced >= count) return out
        if (d > horizon || (until && d > until)) return out
        push(d); produced++
      }
    }
    return out
  }
  return [start]
}

// Full text → events [{uid, start:Date, end:Date, allDay, summary, description, location, status, attendees:[{name,email}], recurring}]
function parseIcs(text, bizTz, { now = new Date(), windowDays = WINDOW_DAYS } = {}) {
  const unfolded = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '')
  const horizon = new Date(now.getTime() + windowDays * 86400000)
  const dayAgo = new Date(now.getTime() - 86400000)
  const blocks = unfolded.split(/^BEGIN:VEVENT\s*$/m).slice(1).map(b => b.split(/^END:VEVENT\s*$/m)[0])
  // Instances of a recurring series that were edited individually carry
  // RECURRENCE-ID; those dates must not also come from the expanded master.
  const overridden = new Map()
  const parsed = blocks.map(parseProps)
  for (const props of parsed) {
    const rid = props.find(p => p.name === 'RECURRENCE-ID'), uid = props.find(p => p.name === 'UID')
    if (rid && uid) { const d = parseDt(rid.value, rid.params, bizTz)?.date; if (d) { if (!overridden.has(uid.value)) overridden.set(uid.value, new Set()); overridden.get(uid.value).add(d.getTime()) } }
  }
  const events = []
  for (const props of parsed) {
    const get = (n) => props.find(p => p.name === n)
    const uid = (get('UID')?.value || '').trim() || crypto.createHash('md5').update(props.map(p => p.value).join('|')).digest('hex')
    const ds = get('DTSTART'); if (!ds) continue
    const start = parseDt(ds.value, ds.params, bizTz); if (!start) continue
    const de = get('DTEND'); const dur = get('DURATION')
    let durationMins = null
    if (de) { const end = parseDt(de.value, de.params, bizTz); if (end) durationMins = Math.round((end.date - start.date) / 60000) }
    else if (dur) durationMins = parseDuration(dur.value)
    if (start.allDay) durationMins = durationMins && durationMins >= 1440 ? durationMins : 1440
    const hasDuration = !!(durationMins && durationMins > 0)
    if (!hasDuration) durationMins = 60
    const status = (get('STATUS')?.value || '').toUpperCase()
    const attendees = props.filter(p => p.name === 'ATTENDEE').map(p => ({ name: p.params.CN || null, email: (p.value.match(/mailto:([^\s;]+)/i) || [])[1] || null }))
    const base = {
      uid, allDay: start.allDay, durationMins, hasDuration,
      summary: unescapeText(get('SUMMARY')?.value).slice(0, 200),
      description: unescapeText(get('DESCRIPTION')?.value).slice(0, 1500),
      location: unescapeText(get('LOCATION')?.value).slice(0, 200),
      status, attendees, cancelled: status === 'CANCELLED'
    }
    const rrule = get('RRULE')
    if (rrule && !get('RECURRENCE-ID')) {
      const exdates = props.filter(p => p.name === 'EXDATE').flatMap(p => p.value.split(',').map(v => parseDt(v.trim(), p.params, bizTz)?.date).filter(Boolean))
      const skip = overridden.get(uid) || new Set()
      for (const inst of expandRrule(rrule.value, start.date, horizon, exdates)) {
        if (skip.has(inst.getTime())) continue
        if (inst < dayAgo) continue
        events.push({ ...base, uid: `${uid}@${inst.toISOString()}`, start: inst, end: new Date(inst.getTime() + durationMins * 60000), recurring: true })
      }
      continue
    }
    if (start.date < dayAgo || start.date > horizon) continue
    const rid = get('RECURRENCE-ID')
    events.push({ ...base, uid: rid ? `${uid}@${(parseDt(rid.value, rid.params, bizTz)?.date || start.date).toISOString()}` : uid, start: start.date, end: new Date(start.date.getTime() + durationMins * 60000), recurring: !!rid })
  }
  // Oldest first, capped.
  events.sort((a, b) => a.start - b.start)
  return events.slice(0, MAX_EVENTS)
}

// ── Deterministic pre-extraction (phone/email) ───────────────────────────────
function phoneFrom(text) {
  const t = String(text || '')
  const labeled = t.match(/(?:phone|tel|mobile|cell|number)\s*[:\-]?\s*(\+?[\d\s().-]{10,20})/i)
  const cand = [labeled?.[1], ...(t.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) || [])].filter(Boolean)
  for (const c of cand) {
    let d = c.replace(/\D/g, '')
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
    if (d.length === 10 && !/^[01]/.test(d)) return '+1' + d
  }
  return null
}
function emailFrom(text) { return (String(text || '').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [])[0] || null }

// ── Model normalisation ───────────────────────────────────────────────────────
// The model turns raw calendar lines into structured appointments. It never
// invents: a client it can't find stays '', a service it can't match stays as
// written with service_id null.
const NORMALIZE_TOOL = {
  name: 'save_appointments',
  description: 'Structured version of every calendar event listed',
  input_schema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: {
        i: { type: 'integer', description: 'The event number from the list' },
        kind: { type: 'string', enum: ['appointment', 'block', 'skip'], description: 'appointment = a client booking; block = time the business is unavailable (lunch, break, blocked, time off, vacation, closed, personal errand, holiday); skip = not relevant to the schedule (birthday, reminder, note, someone else\'s event)' },
        client_name: { type: 'string', description: 'Client\'s name as written, title case. Empty string if the event does not name a client. Never the owner or a staff member.' },
        client_phone: { type: 'string', description: 'E.164 if a phone appears in the event, else empty' },
        client_email: { type: 'string', description: 'If an email appears, else empty' },
        service_id: { type: 'string', description: 'id from the SERVICES list when the event clearly refers to one of them (same service, allowing spelling/abbreviation), else empty' },
        service_name: { type: 'string', description: 'Service as written in the event (cleaned), or the matched service name. Empty if the event has no service at all.' },
        staff_name: { type: 'string', description: 'Name from the STAFF list if the event clearly belongs to one of them, else empty' },
        reason: { type: 'string', description: 'For block/skip: short reason label, e.g. "Lunch", "Vacation"' }
      }, required: ['i', 'kind'] } }
    },
    required: ['items']
  }
}

function eventLine(e, n, tz) {
  const s = utcToZoned(e.start, tz), en = utcToZoned(e.end, tz)
  const when = e.allDay ? `${s.date} (all day)` : `${s.date} ${s.time}-${en.time}`
  const att = e.attendees.filter(a => a.name || a.email).map(a => [a.name, a.email].filter(Boolean).join(' ')).join('; ')
  return `#${n} | ${when} | title: ${e.summary || '(none)'}${e.location ? ` | location: ${e.location}` : ''}${att ? ` | attendees: ${att}` : ''}${e.description ? ` | notes: ${e.description.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`
}

async function normalizeEvents(events, biz, services, staffNames) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const tz = biz.timezone || 'America/Los_Angeles'
  const svcList = services.map(s => `${s.id} | ${s.name}${s.duration_mins ? ` | ${s.duration_mins} min` : ''}`).join('\n') || '(none yet)'
  const out = new Map()
  for (let off = 0; off < events.length; off += MODEL_BATCH) {
    const batch = events.slice(off, off + MODEL_BATCH)
    const lines = batch.map((e, k) => eventLine(e, off + k + 1, tz)).join('\n')
    const content = `BUSINESS: ${biz.business_name} (owner: ${biz.owner_name || 'unknown'})\nSTAFF: ${staffNames.join(', ') || '(just the owner)'}\n\nSERVICES (id | name | duration):\n${svcList}\n\nCALENDAR EVENTS (exported from their previous booking app or Google/Apple Calendar):\n${lines}\n\nReturn one item per event number.`
    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 6000,
        system: `You convert a salon / barbershop / spa owner's exported calendar events into structured appointments for their new booking system.
Titles come in many shapes: "Balayage - Jess Smith", "Jess Smith - Balayage", "Jess: Gel Manicure", "Haircut with Marco", "Jess Smith (Color)", "Appt: Jess", or just a name, or just a service. Attendee names are usually the client. The owner and staff are never the client.
kind rules: a client booking is an appointment even if only a name or only a service is known. Lunch, break, blocked, busy, hold, off, time off, PTO, vacation, closed, holiday, personal, doctor, school pickup and similar are block. Birthdays, reminders, bills, notes, events clearly belonging to someone else's calendar are skip. When unsure between appointment and block, an event that names a person is an appointment.
service matching: pick a service_id only when the event clearly means that service (abbreviations and typos allowed: "bal" = Balayage, "cut" = Haircut, "full set" = Full Set). Otherwise leave service_id empty and keep service_name as written. Never guess a client name from a service word. Keep names title case and drop trailing punctuation.`,
        tools: [NORMALIZE_TOOL], tool_choice: { type: 'tool', name: 'save_appointments' },
        messages: [{ role: 'user', content }]
      })
      const call = resp.content.find(c => c.type === 'tool_use')
      for (const it of (call?.input?.items || [])) if (Number.isInteger(it.i)) out.set(it.i, it)
    } catch (e) {
      console.error('[CalImport] normalize batch failed:', e.message)
    }
  }
  const svcById = new Map(services.map(s => [String(s.id), s]))
  return events.map((e, k) => {
    const n = k + 1, it = out.get(n) || {}
    const svc = it.service_id && svcById.get(String(it.service_id)) ? svcById.get(String(it.service_id)) : null
    // Fallbacks the model may have missed: phone/email from the raw text.
    const rawText = `${e.description} ${e.attendees.map(a => a.email || '').join(' ')}`
    const kind = it.kind || (e.allDay && /off|vacation|closed|holiday|pto/i.test(e.summary) ? 'block' : 'appointment')
    return {
      ...e, kind,
      clientName: String(it.client_name || (!it.kind && e.attendees.find(a => a.name)?.name) || '').trim().replace(/[.,;:!]+$/, '').slice(0, 80),
      clientPhone: it.client_phone && /^\+\d{10,15}$/.test(it.client_phone) ? it.client_phone : phoneFrom(rawText),
      clientEmail: it.client_email || emailFrom(rawText),
      serviceId: svc ? svc.id : null,
      serviceName: (svc ? svc.name : String(it.service_name || '').trim()).slice(0, 120) || null,
      staffName: staffNames.find(s => s.toLowerCase() === String(it.staff_name || '').trim().toLowerCase()) || null,
      // The calendar's own end time is the truth; the service's default only fills a gap.
      durationMins: svc?.duration_mins && !e.allDay && !e.hasDuration ? svc.duration_mins : e.durationMins,
      reason: String(it.reason || e.summary || '').slice(0, 80)
    }
  })
}

// ── Phone matching against the client list ───────────────────────────────────
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
async function loadCustomers(businessId) {
  const { data } = await supabase.from('customers').select('name, phone, email').eq('business_id', businessId).not('phone', 'is', null).limit(5000)
  return (data || []).filter(c => c.name && !isPlaceholder(c.phone))
}
function phoneLookup(customers) {
  const full = new Map(), first = new Map()
  for (const c of customers) {
    const n = normName(c.name); if (!n) continue
    if (!full.has(n)) full.set(n, c)
    const f = n.split(' ')[0]
    first.set(f, first.has(f) ? null : c) // null = ambiguous
  }
  return (name) => {
    const n = normName(name); if (!n) return null
    if (full.has(n)) return full.get(n)
    if (!n.includes(' ') && first.get(n)) return first.get(n)
    return null
  }
}

// ── Apply ─────────────────────────────────────────────────────────────────────
// Does the DB have appointments.source / source_uid yet? Checked lazily and
// re-checked every 10 minutes so the migration takes effect without a deploy.
let uidSupport = { ok: null, at: 0 }
async function hasUidColumns() {
  if (uidSupport.ok !== null && Date.now() - uidSupport.at < 10 * 60 * 1000) return uidSupport.ok
  const { error } = await supabase.from('appointments').select('source_uid').limit(1)
  uidSupport = { ok: !error, at: Date.now() }
  if (error) console.log('[CalImport] appointments.source_uid not present yet; using date|time|name de-dup. Run src/db/calendar-import-migration.sql.')
  return uidSupport.ok
}

const placeholderPhone = (name) => 'nophone-' + crypto.createHash('md5').update(normName(name) || Math.random().toString()).digest('hex').replace(/[0-9]/g, 'x').slice(0, 12)
const isPlaceholder = (p) => !p || String(p).startsWith('nophone-') || String(p).replace(/\D/g, '').length < 10
const dedupKey = (date, time, name, service) => `${date}|${String(time).slice(0, 5)}|${normName(name) || normName(service)}`

async function loadExisting(businessId, fromDate, withUid) {
  const cols = 'id, appointment_date, appointment_time, duration_mins, customer_name, customer_phone, service_name, status, notes' + (withUid ? ', source, source_uid' : '')
  const { data, error } = await supabase.from('appointments').select(cols).eq('business_id', businessId).gte('appointment_date', fromDate).neq('status', 'cancelled').limit(3000)
  if (error) throw error
  return data || []
}

// items: normalised events. source: 'calendar' | 'screenshot'. snap: {uid: 'date|time|dur'} from a previous sync (feed only).
async function applyEvents(biz, items, { source, snap = null, announceNew = false } = {}) {
  const tz = biz.timezone || 'America/Los_Angeles'
  const today = utcToZoned(new Date(), tz).date
  const withUid = await hasUidColumns()
  const existing = await loadExisting(biz.id, today, withUid)
  const byUid = new Map(), byKey = new Map()
  for (const a of existing) {
    if (withUid && a.source_uid) byUid.set(a.source_uid, a)
    byKey.set(dedupKey(a.appointment_date, a.appointment_time, a.customer_name, a.service_name), a)
  }
  const customers = await loadCustomers(biz.id)
  const lookup = phoneLookup(customers)
  const result = { added: [], updated: [], cancelled: [], blocks: 0, skipped: 0, alreadyHere: 0, noPhone: [], matchedService: 0, newSnap: {}, seenUids: new Set() }
  const inserts = [], blockRows = [], customerUpserts = []

  for (const e of items) {
    const s = utcToZoned(e.start, tz)
    if (s.date < today) { result.skipped++; continue }
    // Non-appointments are remembered in the snapshot so a feed re-read never
    // sends them back to the model.
    if (e.kind === 'skip') { result.skipped++; result.newSnap[`${source}:${e.uid}`] = 'skip'; continue }
    if (e.kind === 'block') {
      result.newSnap[`${source}:${e.uid}`] = 'block'
      if (e.cancelled) continue
      const en = utcToZoned(e.end, tz)
      // all-day blocks → full day(s); timed → window. Multi-day all-day → each day.
      if (e.allDay) {
        const days = Math.max(1, Math.round(e.durationMins / 1440))
        for (let k = 0; k < days; k++) {
          const d = new Date(e.start.getTime() + k * 86400000)
          blockRows.push({ business_id: biz.id, blocked_date: utcToZoned(d, 'UTC').date, start_time: null, end_time: null, reason: (e.reason || 'Imported').slice(0, 80) })
        }
      } else blockRows.push({ business_id: biz.id, blocked_date: s.date, start_time: s.time, end_time: en.time === '00:00' ? '23:59' : en.time, reason: (e.reason || 'Imported').slice(0, 80) })
      continue
    }
    // appointment
    const uid = `${source}:${e.uid}`
    result.seenUids.add(uid)
    const name = e.clientName || e.serviceName || e.summary || 'Appointment'
    let phone = e.clientPhone
    if (!phone) { const c = lookup(e.clientName); if (c) phone = c.phone }
    const time = e.allDay ? '09:00' : s.time
    const dur = e.allDay ? 60 : Math.min(Math.max(e.durationMins || 60, 5), 12 * 60)
    const snapVal = `${s.date}|${time}|${dur}`
    const prior = (withUid && byUid.get(uid)) || byKey.get(dedupKey(s.date, time, name, e.serviceName))
    if (prior) {
      if (prior.id) result.alreadyHere++
      // Already here. Mirror a move only if Wexly still holds the value we last
      // wrote from this feed (owner hasn't touched it in Wexly).
      if (withUid && prior.id && prior.source_uid === uid) {
        const dbVal = `${prior.appointment_date}|${String(prior.appointment_time).slice(0, 5)}|${prior.duration_mins}`
        const lastWritten = snap ? snap[uid] : null
        if (e.cancelled) {
          if (prior.status === 'confirmed' && (!lastWritten || lastWritten === dbVal)) {
            await supabase.from('appointments').update({ status: 'cancelled', notes: `${prior.notes || IMPORT_NOTE}. Cancelled on the previous calendar.` }).eq('id', prior.id)
            result.cancelled.push(prior)
          }
          continue
        }
        if (dbVal !== snapVal && (!lastWritten || lastWritten === dbVal)) {
          await supabase.from('appointments').update({ appointment_date: s.date, appointment_time: time, duration_mins: dur, updated_at: new Date().toISOString() }).eq('id', prior.id)
          result.updated.push({ ...prior, appointment_date: s.date, appointment_time: time })
        }
        // A phone that turned up later (client list uploaded) gets attached.
        if (isPlaceholder(prior.customer_phone) && phone) await supabase.from('appointments').update({ customer_phone: phone }).eq('id', prior.id)
      }
      result.newSnap[uid] = snapVal
      continue
    }
    // Known from an earlier sync but no longer in Wexly: the owner deleted it
    // here. Respect that; don't resurrect it from the feed.
    if (e.knownOnly) { result.newSnap[uid] = snap?.[uid] || snapVal; continue }
    if (e.cancelled) continue
    const row = {
      business_id: biz.id,
      customer_name: name.slice(0, 120),
      customer_phone: phone || placeholderPhone(name),
      service_id: e.serviceId || null,
      service_name: e.serviceName || e.summary || 'Appointment',
      appointment_date: s.date, appointment_time: time, duration_mins: dur,
      status: 'confirmed',
      staff_name: e.staffName || null,
      notes: [IMPORT_NOTE, e.description && e.description !== e.summary ? e.description.replace(/\s+/g, ' ').slice(0, 400) : null].filter(Boolean).join('. ')
    }
    if (withUid) { row.source = source; row.source_uid = uid; byUid.set(uid, row) }
    inserts.push(row)
    byKey.set(dedupKey(s.date, time, name, e.serviceName), row)  // guards duplicates inside the same feed
    result.newSnap[uid] = snapVal
    if (e.serviceId) result.matchedService++
    if (!phone && e.clientName) result.noPhone.push(e.clientName)
    if (phone && e.clientName) customerUpserts.push({ business_id: biz.id, name: e.clientName.slice(0, 120), phone, email: e.clientEmail || null, source: 'calendar' })
  }

  for (let i = 0; i < inserts.length; i += 50) {
    const batch = inserts.slice(i, i + 50)
    let { data, error } = await supabase.from('appointments').insert(batch).select('id, customer_name, customer_phone, service_name, appointment_date, appointment_time')
    if (error && /source_uid|source\b|column/i.test(error.message || '')) {
      uidSupport = { ok: false, at: Date.now() }
      const stripped = batch.map(({ source: _s, source_uid: _u, ...rest }) => rest)
      ;({ data, error } = await supabase.from('appointments').insert(stripped).select('id, customer_name, customer_phone, service_name, appointment_date, appointment_time'))
    }
    if (error) { console.error('[CalImport] insert failed:', error.message); continue }
    result.added.push(...(data || []))
  }
  if (blockRows.length) {
    // Full-day blocks win over partial ones on the same date; dedupe within the
    // batch, then insert only dates not already blocked (no unique constraint
    // is assumed on blocked_dates, see ownerCommands block_dates).
    const seen = new Map(); for (const b of blockRows) { const k = b.blocked_date; if (!seen.has(k) || !b.start_time) seen.set(k, b) }
    const rows = [...seen.values()]
    const { data: have } = await supabase.from('blocked_dates').select('blocked_date').eq('business_id', biz.id).in('blocked_date', rows.map(r => r.blocked_date))
    const haveSet = new Set((have || []).map(h => h.blocked_date))
    const fresh = rows.filter(r => !haveSet.has(r.blocked_date))
    if (fresh.length) {
      const { error } = await supabase.from('blocked_dates').insert(fresh)
      if (error) console.error('[CalImport] blocks failed:', error.message); else result.blocks = fresh.length
    }
  }
  if (customerUpserts.length) {
    const seen = new Set(); const rows = customerUpserts.filter(c => { if (seen.has(c.phone)) return false; seen.add(c.phone); return true })
    for (let i = 0; i < rows.length; i += 50) await supabase.from('customers').upsert(rows.slice(i, i + 50), { onConflict: 'business_id,phone', ignoreDuplicates: true }).then(({ error }) => { if (error) console.error('[CalImport] customers upsert failed:', error.message) })
  }
  result.noPhone = [...new Set(result.noPhone)]
  return result
}

// ── Owner-facing summary ─────────────────────────────────────────────────────
function fmtDate(iso) { return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) }
function fmtTime(t) { const [h, m] = String(t).split(':').map(Number); const hr = ((h + 11) % 12) + 1; return `${hr}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}` }

function importSummary(result, { source, syncing } = {}) {
  const n = result.added.length
  const parts = []
  if (!n && !result.updated.length && !result.blocks) {
    if (result.alreadyHere) parts.push(`Those ${result.alreadyHere === 1 ? 'is' : 'are'} already in Wexly, nothing new to add.`)
    else parts.push(source === 'screenshot' ? `I couldn't find any upcoming appointments in that screenshot. Try one that shows the week with the client names, or text me your calendar link instead.` : `I read your calendar but found no upcoming appointments in it. If your old app's sync is on, give it a few minutes and send the link again, or text me screenshots of your calendar.`)
    if (result.noPhone.length === 0 && result.alreadyHere && syncing) parts.push(`I'll keep watching that calendar for the next ${SYNC_DAYS} days.`)
    return parts.join(' ')
  }
  if (n) {
    const dates = result.added.map(a => a.appointment_date).sort()
    const range = dates.length > 1 ? ` from ${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}` : ` on ${fmtDate(dates[0])}`
    parts.push(`Done. I added ${n} appointment${n === 1 ? '' : 's'}${range}${source === 'screenshot' ? ' from your screenshot' : ' from your calendar'}.`)
    if (result.matchedService && result.matchedService < n) parts.push(`${result.matchedService} matched your service list; the rest I saved with the service as written.`)
  } else if (result.updated.length) parts.push(`Your calendar is already here. I updated ${result.updated.length} that moved.`)
  if (result.blocks) parts.push(`I also blocked ${result.blocks} day${result.blocks === 1 ? '' : 's'} or time${result.blocks === 1 ? '' : 's'} you had marked off.`)
  if (result.noPhone.length) {
    const names = result.noPhone.slice(0, 6).join(', ') + (result.noPhone.length > 6 ? ` and ${result.noPhone.length - 6} more` : '')
    parts.push(`${result.noPhone.length} client${result.noPhone.length === 1 ? ' has' : 's have'} no phone number yet (${names}). Reply like "Jess 310-555-1234" and I'll attach it, or upload your client list in the app under Customers and I'll match them.`)
  } else if (n) parts.push(`They'll get your normal reminders before each visit.`)
  if (syncing) parts.push(`I'll keep an eye on that calendar for the next ${SYNC_DAYS} days, so anything booked on your old app shows up here too. Text "stop syncing" any time.`)
  return parts.join(' ')
}

// ── Entry points ──────────────────────────────────────────────────────────────
async function loadContext(businessId) {
  const [{ data: biz }, { data: services }] = await Promise.all([
    supabase.from('businesses').select('id, business_name, owner_name, owner_phone, sms_number, timezone, staff_members, onboarding, status').eq('id', businessId).maybeSingle(),
    supabase.from('services').select('id, name, duration_mins').eq('business_id', businessId).neq('active', false)
  ])
  const staffNames = Array.isArray(biz?.staff_members) ? biz.staff_members.map(s => s && s.name).filter(Boolean) : []
  return { biz, services: services || [], staffNames }
}

async function saveFeedState(businessId, patch) {
  const { data } = await supabase.from('businesses').select('onboarding').eq('id', businessId).maybeSingle()
  const ob = data?.onboarding || {}
  const feed = { ...(ob.calendar_feed || {}), ...patch }
  await supabase.from('businesses').update({ onboarding: { ...ob, calendar_feed: feed } }).eq('id', businessId)
  return feed
}

// Owner texted a calendar link. Returns { ok, message, result } and leaves the
// feed registered for ongoing sync. Never throws.
async function importFromCalendarLink(businessId, rawUrl) {
  const url = normalizeCalendarUrl(rawUrl)
  if (!url) return { ok: false, message: `That doesn't look like a calendar link. It should end in .ics or come from Google Calendar's "Secret address in iCal format".` }
  const { biz, services, staffNames } = await loadContext(businessId)
  if (!biz) return { ok: false, message: 'Account not found.' }
  let text
  try { text = await fetchIcs(url) }
  catch (e) {
    console.error(`[CalImport] fetch failed for ${biz.business_name}: ${e.message}`)
    const why = /web page/.test(e.message) ? `That link opens a web page, not a calendar feed. In Google Calendar it's the "Secret address in iCal format" under Integrate calendar; on Apple it's the Public Calendar link.` : /HTTP 4/.test(e.message) ? `That calendar link isn't public. In Google Calendar use the "Secret address in iCal format" (not the public URL); on Apple turn on Public Calendar first.` : `I couldn't open that calendar link (${e.message}). Check it and send it again, or text me screenshots instead.`
    return { ok: false, message: why }
  }
  const events = parseIcs(text, biz.timezone)
  const normalised = events.length ? await normalizeEvents(events, biz, services, staffNames) : []
  const result = await applyEvents(biz, normalised, { source: 'calendar' })
  const until = new Date(Date.now() + SYNC_DAYS * 86400000).toISOString()
  await saveFeedState(biz.id, { url, platform: platformFromUrl(url) || null, active: true, added_at: new Date().toISOString(), until, last_sync_at: new Date().toISOString(), fails: 0, snap: result.newSnap, events_seen: events.length })
  console.log(`[CalImport] ${biz.business_name}: ${events.length} events → +${result.added.length} appts, ${result.blocks} blocks, ${result.noPhone.length} without phone`)
  return { ok: true, result, message: importSummary(result, { source: 'calendar', syncing: true }) }
}

// ── Screenshots (MMS) ────────────────────────────────────────────────────────
async function fetchImage(url) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN
  const auth = sid && tok && /twilio\.com/.test(url) ? { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') } : {}
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), FETCH_MS)
  try {
    let r = await fetch(url, { headers: auth, redirect: 'manual', signal: ctl.signal })
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) r = await fetch(r.headers.get('location'), { redirect: 'follow', signal: ctl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
    if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) throw new Error(`unsupported media ${type}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 5 * 1024 * 1024) throw new Error('image too large')
    return { type, data: buf.toString('base64') }
  } finally { clearTimeout(t) }
}

const SHOT_TOOL = {
  name: 'save_appointments',
  description: 'Every appointment and blocked time visible in the calendar screenshots',
  input_schema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: {
        kind: { type: 'string', enum: ['appointment', 'block'] },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM 24h start time' },
        duration_mins: { type: 'integer', description: 'From the block height / end time; 60 if unclear' },
        client_name: { type: 'string', description: 'As shown, title case; empty if not shown' },
        client_phone: { type: 'string', description: 'E.164 if visible, else empty' },
        service_id: { type: 'string', description: 'id from SERVICES when the shown service clearly matches, else empty' },
        service_name: { type: 'string', description: 'Service text as shown, or matched name; empty if none' },
        staff_name: { type: 'string', description: 'From STAFF if the column/colour/label makes it clear, else empty' },
        reason: { type: 'string', description: 'For block: label shown (Lunch, Blocked, Off)' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'low when text is cut off or the date is inferred' }
      }, required: ['kind', 'date', 'time'] } },
      notes: { type: 'string', description: 'Anything the owner should double-check (dates inferred, cut-off names, unreadable blocks)' }
    },
    required: ['items']
  }
}

async function importFromScreenshots(businessId, mediaUrls, ownerText = '') {
  const { biz, services, staffNames } = await loadContext(businessId)
  if (!biz) return { ok: false, message: 'Account not found.' }
  const tz = biz.timezone || 'America/Los_Angeles'
  const images = []
  for (const u of (mediaUrls || []).slice(0, 8)) {
    try { images.push(await fetchImage(u)) } catch (e) { console.error('[CalImport] image fetch failed:', e.message) }
  }
  if (!images.length) return { ok: false, message: `I couldn't open those images. Try sending them again as photos.` }
  const nowLocal = new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const svcList = services.map(s => `${s.id} | ${s.name}${s.duration_mins ? ` | ${s.duration_mins} min` : ''}`).join('\n') || '(none yet)'
  let items = [], notes = ''
  try {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 6000,
      system: `You read screenshots of a salon / barbershop / spa owner's booking calendar (GlossGenius, Booksy, Vagaro, Square, Fresha, StyleSeat, Apple or Google Calendar, paper) and list every appointment on them.
Dates: the screenshot shows a day or week; use the visible month/day headers. If the year is missing, pick the nearest date on or after today. If only weekday names are visible, assume the week being shown is the current or next one, whichever is on/after today, and say so in notes. Times from the grid position and any printed time; end time or block height gives duration.
Names: the client's name as printed. Service text as printed. Never invent a name or service that is not visible; cut-off text gets confidence low. The owner and staff are never the client. Lunch/break/blocked/off/personal/busy are kind=block.`,
      tools: [SHOT_TOOL], tool_choice: { type: 'tool', name: 'save_appointments' },
      messages: [{ role: 'user', content: [
        ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } })),
        { type: 'text', text: `BUSINESS: ${biz.business_name} (owner: ${biz.owner_name || 'unknown'}). Timezone ${tz}. Right now it is ${nowLocal}.\nSTAFF: ${staffNames.join(', ') || '(just the owner)'}\nSERVICES (id | name | duration):\n${svcList}\n${ownerText ? `\nOwner's note with the screenshots: "${String(ownerText).slice(0, 300)}"\n` : ''}\nList every appointment and blocked time you can see, today or later.` }
      ] }]
    })
    const call = resp.content.find(c => c.type === 'tool_use')
    items = call?.input?.items || []; notes = call?.input?.notes || ''
  } catch (e) {
    console.error('[CalImport] screenshot read failed:', e.message)
    return { ok: false, message: `I couldn't read those screenshots just now. Try again in a minute, or text me your calendar link.` }
  }
  const svcById = new Map(services.map(s => [String(s.id), s]))
  const today = utcToZoned(new Date(), tz).date
  const events = []
  for (const it of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '') || !/^\d{1,2}:\d{2}$/.test(it.time || '')) continue
    if (it.date < today) continue
    const [hh, mm] = it.time.split(':').map(Number)
    const [y, mo, d] = it.date.split('-').map(Number)
    const start = zonedToUtc(y, mo, d, hh, mm, 0, tz)
    const svc = it.service_id && svcById.get(String(it.service_id)) ? svcById.get(String(it.service_id)) : null
    const dur = Math.min(Math.max(parseInt(it.duration_mins, 10) || svc?.duration_mins || 60, 10), 12 * 60)
    const clientName = String(it.client_name || '').trim().slice(0, 80)
    const uidBase = `${it.date}|${it.time}|${normName(clientName) || normName(it.service_name)}`
    events.push({
      uid: crypto.createHash('md5').update(uidBase).digest('hex'),
      kind: it.kind === 'block' ? 'block' : 'appointment',
      start, end: new Date(start.getTime() + dur * 60000), allDay: false, durationMins: dur, cancelled: false,
      summary: [clientName, it.service_name].filter(Boolean).join(' - '), description: it.confidence === 'low' ? 'Read from a screenshot; please double-check' : '', location: '', attendees: [],
      clientName, clientPhone: /^\+\d{10,15}$/.test(it.client_phone || '') ? it.client_phone : null, clientEmail: null,
      serviceId: svc ? svc.id : null, serviceName: (svc ? svc.name : String(it.service_name || '').trim()).slice(0, 120) || null,
      staffName: staffNames.find(s => s.toLowerCase() === String(it.staff_name || '').trim().toLowerCase()) || null,
      reason: String(it.reason || 'Blocked').slice(0, 80)
    })
  }
  const result = await applyEvents(biz, events, { source: 'screenshot' })
  let message = importSummary(result, { source: 'screenshot' })
  if (notes && result.added.length) message += ` One thing to check: ${String(notes).slice(0, 200)}`
  if (result.added.length) message += ` Send more weeks any time and I'll add them too.`
  console.log(`[CalImport] ${biz.business_name}: ${images.length} screenshot(s) → +${result.added.length} appts, ${result.blocks} blocks`)
  return { ok: true, result, message }
}

// ── Attach a phone to an imported client ("Jess 310-555-1234") ───────────────
// Parses one or more "Name phone" pairs. Returns {attached:[names], unknown:[names], pairs}
function parseNamePhonePairs(text) {
  const pairs = []
  const re = /([A-Za-z][A-Za-z' .-]{0,40}?)\s*[:\-]?\s*(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/g
  let m
  while ((m = re.exec(String(text || '')))) {
    const name = m[1].replace(/\b(is|at|number|phone|cell|and|,)\b/gi, ' ').replace(/\s+/g, ' ').trim()
    let d = m[2].replace(/\D/g, ''); if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
    if (name && d.length === 10) pairs.push({ name, phone: '+1' + d })
  }
  return pairs
}
async function attachClientPhone(businessId, name, phone) {
  const tz = 'UTC'
  const today = new Date().toISOString().slice(0, 10)
  const { data: appts } = await supabase.from('appointments').select('id, customer_name, customer_phone').eq('business_id', businessId).gte('appointment_date', today).neq('status', 'cancelled').limit(2000)
  const n = normName(name)
  const hits = (appts || []).filter(a => isPlaceholder(a.customer_phone) && (normName(a.customer_name) === n || normName(a.customer_name).split(' ')[0] === n))
  if (!hits.length) return { ok: false, name }
  await supabase.from('appointments').update({ customer_phone: phone }).in('id', hits.map(h => h.id))
  const fullName = hits.find(h => normName(h.customer_name).includes(' '))?.customer_name || hits[0].customer_name
  await supabase.from('customers').upsert({ business_id: businessId, name: fullName, phone, source: 'calendar' }, { onConflict: 'business_id,phone', ignoreDuplicates: true })
  return { ok: true, name: fullName, count: hits.length }
}
async function listNoPhone(businessId) {
  const today = new Date().toISOString().slice(0, 10)
  const { data: appts } = await supabase.from('appointments').select('customer_name, customer_phone').eq('business_id', businessId).gte('appointment_date', today).neq('status', 'cancelled').limit(2000)
  return [...new Set((appts || []).filter(a => isPlaceholder(a.customer_phone) && a.customer_name).map(a => a.customer_name))]
}

// ── Placeholder phone matching (scheduler, every 30 min) ─────────────────────
// Imported appointments without a phone get one as soon as a matching client
// shows up in customers (CSV upload in the dashboard, a booking by text, a
// later calendar read). Exact full-name match, or a first name that is unique
// in their client list. Owner is told once per batch.
async function matchPlaceholderPhones() {
  const today = new Date().toISOString().slice(0, 10)
  const { data: rows, error } = await supabase.from('appointments').select('id, business_id, customer_name, customer_phone').like('customer_phone', 'nophone-%').gte('appointment_date', today).neq('status', 'cancelled').limit(2000)
  if (error || !rows?.length) return
  const byBiz = new Map(); for (const r of rows) { if (!byBiz.has(r.business_id)) byBiz.set(r.business_id, []); byBiz.get(r.business_id).push(r) }
  const { sendSMS } = require('./sms')
  for (const [bizId, appts] of byBiz) {
    try {
      const customers = await loadCustomers(bizId)
      if (!customers.length) continue
      const lookup = phoneLookup(customers)
      const matched = []
      for (const a of appts) {
        const c = lookup(a.customer_name); if (!c) continue
        const { error: e2 } = await supabase.from('appointments').update({ customer_phone: c.phone }).eq('id', a.id)
        if (!e2) matched.push(a.customer_name)
      }
      if (!matched.length) continue
      const names = [...new Set(matched)]
      const left = await listNoPhone(bizId)
      const { data: biz } = await supabase.from('businesses').select('sms_number, owner_phone').eq('id', bizId).maybeSingle()
      if (biz?.sms_number && biz?.owner_phone) {
        await sendSMS(biz.sms_number, biz.owner_phone, `Matched phone numbers from your client list for ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}, so they'll get reminders.${left.length ? ` Still missing: ${left.slice(0, 6).join(', ')}${left.length > 6 ? ` and ${left.length - 6} more` : ''}.` : ''}`).catch(() => {})
      }
      console.log(`[CalImport] matched ${names.length} placeholder phone(s) for business ${bizId}`)
    } catch (e) { console.error('[CalImport] placeholder match failed:', e.message) }
  }
}

// ── Feed sync (scheduler, every 15 min) ──────────────────────────────────────
async function syncCalendarFeeds() {
  const { data: rows, error } = await supabase.from('businesses').select('id, business_name, owner_phone, sms_number, timezone, onboarding, status').eq('onboarding->calendar_feed->>active', 'true').in('status', ['trial', 'active'])
  if (error) { console.error('[CalSync] query failed:', error.message); return }
  const { sendSMS } = require('./sms')
  let synced = 0
  for (const b of rows || []) {
    const feed = b.onboarding?.calendar_feed || {}
    if (!feed.url) continue
    try {
      if (feed.until && new Date(feed.until) < new Date()) {
        await saveFeedState(b.id, { active: false, ended: 'expired', ended_at: new Date().toISOString() })
        if (b.sms_number && b.owner_phone) await sendSMS(b.sms_number, b.owner_phone, `Heads up: I've stopped mirroring your old calendar now that ${SYNC_DAYS} days have passed. Everything is in Wexly. If you still use the old app, text "sync my calendar" and I'll keep watching it.`).catch(() => {})
        continue
      }
      const { biz, services, staffNames } = await loadContext(b.id)
      const text = await fetchIcs(feed.url)
      const events = parseIcs(text, biz.timezone)
      // Only events we haven't seen before need the model; known UIDs reuse the snapshot path.
      const known = new Set(Object.keys(feed.snap || {}))
      const fresh = events.filter(e => !known.has(`calendar:${e.uid}`))
      const normalisedFresh = fresh.length ? await normalizeEvents(fresh, biz, services, staffNames) : []
      const knownEvents = events.filter(e => known.has(`calendar:${e.uid}`)).map(e => {
        const mark = feed.snap[`calendar:${e.uid}`]
        return { ...e, kind: mark === 'skip' || mark === 'block' ? mark : 'appointment', knownOnly: true, clientName: '', clientPhone: null, serviceId: null, serviceName: null, staffName: null }
      })
      const result = await applyEvents(biz, [...normalisedFresh, ...knownEvents], { source: 'calendar', snap: feed.snap || {} })
      // Cancel appointments we created from this feed that no longer appear in it
      // (the old app cancelled them). Only when the feed still has content, so an
      // empty/broken response never wipes a schedule.
      if (events.length && (await hasUidColumns())) {
        const today = utcToZoned(new Date(), biz.timezone || 'America/Los_Angeles').date
        const gone = Object.keys(feed.snap || {}).filter(uid => !result.seenUids.has(uid))
        if (gone.length) {
          const { data: toCancel } = await supabase.from('appointments').select('id, source_uid, appointment_date, appointment_time, duration_mins, customer_name').eq('business_id', b.id).in('source_uid', gone.slice(0, 200)).eq('status', 'confirmed').gte('appointment_date', today)
          for (const a of toCancel || []) {
            const dbVal = `${a.appointment_date}|${String(a.appointment_time).slice(0, 5)}|${a.duration_mins}`
            if (feed.snap[a.source_uid] !== dbVal) continue   // owner changed it in Wexly; leave it
            await supabase.from('appointments').update({ status: 'cancelled', notes: `${IMPORT_NOTE}. Removed from the previous calendar.` }).eq('id', a.id)
            result.cancelled.push(a)
          }
        }
      }
      const snap = { ...result.newSnap }
      await saveFeedState(b.id, { last_sync_at: new Date().toISOString(), fails: 0, snap, events_seen: events.length, last_error: null })
      synced++
      if (result.added.length && b.sms_number && b.owner_phone) {
        const lines = result.added.slice(0, 4).map(a => `${[...new Set([a.customer_name, a.service_name].filter(Boolean))].join(', ')}, ${fmtDate(a.appointment_date)} ${fmtTime(a.appointment_time)}`).join('; ')
        const more = result.added.length > 4 ? ` and ${result.added.length - 4} more` : ''
        await sendSMS(b.sms_number, b.owner_phone, `New on your old calendar, now in Wexly too: ${lines}${more}.`).catch(() => {})
      }
      if (result.added.length || result.updated.length || result.cancelled.length) console.log(`[CalSync] ${b.business_name}: +${result.added.length} ~${result.updated.length} -${result.cancelled.length}`)
    } catch (e) {
      const fails = (feed.fails || 0) + 1
      console.error(`[CalSync] ${b.business_name} failed (${fails}): ${e.message}`)
      const patch = { fails, last_error: String(e.message).slice(0, 200) }
      if (fails >= SYNC_FAILS_BEFORE_OFF) {
        patch.active = false; patch.ended = 'errors'; patch.ended_at = new Date().toISOString()
        if (b.sms_number && b.owner_phone) await sendSMS(b.sms_number, b.owner_phone, `I can't reach your old calendar link any more, so I've stopped mirroring it. Your appointments in Wexly are untouched. If you want it back on, text me the calendar link again.`).catch(() => {})
      }
      await saveFeedState(b.id, patch)
    }
  }
  if (synced) console.log(`[CalSync] checked ${synced} linked calendar(s)`)
}

async function setFeedActive(businessId, active) {
  const { data } = await supabase.from('businesses').select('onboarding').eq('id', businessId).maybeSingle()
  const feed = data?.onboarding?.calendar_feed
  if (!feed?.url) return null
  await saveFeedState(businessId, active ? { active: true, until: new Date(Date.now() + SYNC_DAYS * 86400000).toISOString(), fails: 0, ended: null } : { active: false, ended: 'owner', ended_at: new Date().toISOString() })
  return feed
}

module.exports = {
  extractCalendarUrl, platformFromUrl, PLATFORM, bookingsQuestion,
  importFromCalendarLink, importFromScreenshots, syncCalendarFeeds, setFeedActive, matchPlaceholderPhones,
  parseNamePhonePairs, attachClientPhone, listNoPhone, importSummary,
  // exported for tests
  parseIcs, normalizeCalendarUrl, SYNC_DAYS, IMPORT_NOTE, _resetUidCache: () => { uidSupport = { ok: null, at: 0 } }
}
