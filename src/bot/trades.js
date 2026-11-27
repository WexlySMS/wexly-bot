// Trades mode: scheduling rules for businesses that travel to the customer
// (plumbing, HVAC, electrical, roofing and similar).
//
// Everything here is OFF unless the business row has pro_settings.trades set,
// so businesses without it behave exactly as before. No schema change needed.
//
// pro_settings.trades = {
//   service_area: 'Mesa, Gilbert, Chandler, Tempe (zips 85201-85215)',  // free text
//   arrival_window_mins: 120,        // 0 or missing = quote exact times
//   emergency_alert: true,           // text the owner at once on an emergency
//   estimate_service: 'Estimate visit' // service to book when job size is unknown
// }

const { formatTime } = require('../utils/dateHelpers')

function tradesSettings(business) {
  const t = business?.pro_settings?.trades
  if (!t || typeof t !== 'object') return null
  const win = Number(t.arrival_window_mins)
  return {
    serviceArea: String(t.service_area || '').trim().slice(0, 600),
    arrivalWindowMins: Number.isFinite(win) && win >= 30 && win <= 480 ? Math.round(win) : 0,
    emergencyAlert: t.emergency_alert !== false,
    estimateService: String(t.estimate_service || '').trim().slice(0, 80)
  }
}

// "08:00" + 120 -> "between 8:00 AM and 10:00 AM"
function arrivalWindowText(time, windowMins) {
  const m = String(time || '').match(/^(\d{1,2}):(\d{2})/)
  if (!m || !windowMins) return ''
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Math.min(start + windowMins, 23 * 60 + 59)
  const hhmm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
  return `between ${formatTime(hhmm(start))} and ${formatTime(hhmm(end))}`
}

// What to tell a customer about when we'll show up: a window in trades mode
// with windows on, otherwise the exact time ("at 8:00 AM").
function arrivalPhrase(business, time) {
  const t = tradesSettings(business)
  const w = t && t.arrivalWindowMins ? arrivalWindowText(time, t.arrivalWindowMins) : ''
  return w || `at ${formatTime(time)}`
}

// How long to hold on the calendar. With arrival windows on, the tech may show
// up any time in the window, so the whole window is reserved: a 60-minute call
// in an 8-to-10 window must not let another job start at 9:10.
function slotMins(business, durationMins) {
  const t = tradesSettings(business)
  return t && t.arrivalWindowMins ? Math.max(durationMins, t.arrivalWindowMins) : durationMins
}

function tradesPromptBlock(business) {
  const t = tradesSettings(business)
  if (!t) return ''
  const lines = [
    '## FIELD SERVICE RULES (this business goes to the customer)',
    '- Before offering any time, find out (1) what the problem is in the customer\'s own words and (2) the full street address of the job, including city. Do not book without both.',
    '- When you call create_appointment, put the address and a one-line description of the problem in notes, formatted exactly as "Address: <address> | Problem: <problem>". The tech reads this on the way to the job.'
  ]
  if (t.serviceArea) {
    lines.push(`- SERVICE AREA: ${t.serviceArea}. If the job address is clearly outside this area, do NOT book. Tell them plainly that ${business.business_name} doesn't cover that area. If you can't tell whether the address is inside the area, book nothing yet: say you'll have ${business.business_name} confirm they cover that address, and include "NEEDS_ATTENTION" in your response.`)
  }
  if (t.arrivalWindowMins) {
    const hrs = t.arrivalWindowMins % 60 === 0 ? `${t.arrivalWindowMins / 60}-hour` : `${t.arrivalWindowMins}-minute`
    lines.push(`- ARRIVAL WINDOWS: customers are given a ${hrs} arrival window, never an exact time. Each open start time from check_availability is the START of a window: 08:00 means "between 8:00 AM and ${formatTime(addMins('08:00', t.arrivalWindowMins))}". Offer and confirm times to the customer ONLY as windows. When you call create_appointment or reschedule_appointment, pass the window's start time as the time. If they ask for an exact time, say the tech will text when they're on the way.`)
  }
  lines.push(
    `- JOB SIZE UNKNOWN: you cannot see the job, so never promise how long a repair will take or what it will cost beyond the listed prices. For anything bigger than a standard visit (replacements, installs, remodels, a whole roof, repiping, panel upgrades)${t.estimateService ? ` book "${t.estimateService}"` : ' book the estimate or inspection service if one is listed'} so the owner can see it in person and schedule the full job after.`,
    '- PHOTOS: if they offer to send a photo of the problem, say yes. It helps the tech come prepared.',
    `- UPDATE REQUESTS ("where's the tech", "are you still coming", "any update", "is my part in", "when will it be done", "did you get my payment"): first answer whatever the calendar above shows for them, such as the day and time of their visit. For anything you cannot see (where the tech is right now, how late they are, parts, how a job in progress is going, quotes you were not given, invoices or payments), never guess and never reassure with made-up details. Say you're checking with ${business.business_name} and they'll get an answer shortly, and include "NEEDS_ATTENTION" in your response so the owner is alerted with their question.`,
    '- SAME-DAY REQUESTS: check today first, then the next open day. If nothing is open soon enough for them, offer the waitlist and include "NEEDS_ATTENTION" in your response so the owner can try to squeeze them in.'
  )
  if (t.emergencyAlert) {
    lines.push(`- EMERGENCIES: if the conversation shows you already told them ${business.business_name} has been alerted and will call, do not repeat it. Get the address if you don't have it, then offer the earliest open visit in case they want it locked in. Never tell a customer to wait when there is a gas smell, smoke, sparking, or water near electrical: tell them to get to safety and call 911 or the utility first.`)
  }
  return lines.join('\n')
}

function addMins(time, mins) {
  const [h, m] = time.split(':').map(Number)
  const n = Math.min(h * 60 + m + mins, 23 * 60 + 59)
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}

// Things that can't wait for the next open slot. Kept specific on purpose:
// "leak" alone is routine, "burst pipe" is not.
const DANGER_RE = /\b(smell(s|ing)?\s+(of\s+)?gas|gas\s+(leak|smell)|carbon monoxide|co (alarm|detector)|smell(s|ing)?\s+(of\s+)?smoke|smoke (is )?coming|on fire|sparks?|sparking|burning smell|electrical fire|water (near|on|in) (the )?(outlet|panel|breaker|electrical))\b/i
const URGENT_RE = /\b(emergency|urgent(ly)?|burst (pipe|line)|pipe (burst|broke)|flood(ed|ing)?|water (is )?(everywhere|pouring|gushing|coming through)|sewage|sewer (is )?back(ed|ing)? up|no (heat|hot water|ac|a\/c|air|power|water)|furnace (is )?(out|dead|not working)|ac (is )?(out|dead|not working)|ceiling (is )?(leaking|caving|collapsed)|roof (is )?(leaking|caved)|tree (fell|on))\b/i

function detectTradesEmergency(business, text) {
  const t = tradesSettings(business)
  if (!t || !t.emergencyAlert) return null
  const s = String(text || '')
  const d = s.match(DANGER_RE)
  if (d) return { kind: 'danger', trigger: d[0] }
  const u = s.match(URGENT_RE)
  if (u) return { kind: 'urgent', trigger: u[0] }
  return null
}

function emergencyReply(business, hit) {
  const safety = hit.kind === 'danger'
    ? 'If there is any gas smell, smoke or sparking, get everyone out and call 911 or your utility first. '
    : ''
  return `${safety}That sounds urgent. I've alerted ${business.business_name} right now and they'll call you at this number. What's the address so they have it ready?`
}

// Texts the owner straight away. Emergencies ignore the owner's escalation
// notification preference: a burst pipe is the one alert nobody wants muted.
async function alertOwnerEmergency(business, { customerPhone, customerName, customerMessage, hit }) {
  if (!business.owner_phone || !business.sms_number) return false
  let to = String(business.owner_phone).replace(/\D/g, '')
  if (to.length === 10) to = '1' + to
  to = '+' + to
  const who = customerName ? `${customerName} (${customerPhone})` : customerPhone
  const body = `🚨 URGENT${hit.kind === 'danger' ? ' (possible safety issue)' : ''}: ${who} says "${String(customerMessage || '').slice(0, 160)}"\n\nCall them now. I told them you'd call and I'm getting the address.`
  const { sendSMS } = require('../utils/sms')
  await sendSMS(business.sms_number, to, body)
  return true
}

module.exports = { slotMins, tradesSettings, tradesPromptBlock, arrivalWindowText, arrivalPhrase, detectTradesEmergency, emergencyReply, alertOwnerEmergency }
