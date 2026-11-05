const Anthropic = require('@anthropic-ai/sdk')
const { sendBookingNotification, sendEscalationNotification, sendCustomerConfirmationEmail } = require('../utils/emailService')
const { runQualificationFlow, runIntakeFlow, shouldSendNotification } = require('./proFeatures')
const { getAvailableSlots, findAvailableStaff, formatDate, formatTime } = require('../utils/dateHelpers')
const { sendSMS } = require('../utils/sms')

// ── Plan helpers ─────────────────────────────────────────────────────────────
function planAtLeast(business, tier) {
  const order = { solo: 1, standard: 2, pro: 3 }
  const biz = order[business.plan] || 2 // default standard
  const req = order[tier] || 1
  return biz >= req
}

function maxStaff(business) {
  if (business.plan === 'pro') return Infinity
  if (business.plan === 'solo') return 1
  return 10 // standard
}

// ── Booking lock — prevents race conditions when two customers text simultaneously ──
const bookingLocks = new Map()

async function withBookingLock(businessId, date, fn) {
  const key = `${businessId}:${date}`
  // Wait up to 8 seconds if another booking for same business+date is in progress
  let waited = 0
  while (bookingLocks.get(key) && waited < 8000) {
    await new Promise(r => setTimeout(r, 100))
    waited += 100
  }
  bookingLocks.set(key, true)
  try {
    return await fn()
  } finally {
    bookingLocks.delete(key)
  }
}
const db = require('../db/client')
require('dotenv').config()

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Business type personas ────────────────────────────────────────────────────
const personas = {
  dental:     'a professional dental office receptionist',
  restaurant: 'a warm and welcoming restaurant host',
  salon:      'a friendly hair salon receptionist',
  barbershop: 'a laid-back barbershop receptionist',
  nails:      'a friendly nail salon receptionist',
  spa:        'a calm and soothing spa receptionist',
  gym:        'an energetic fitness studio receptionist',
  trainer:    'a motivating personal trainer assistant',
  yoga:       'a calm yoga studio receptionist',
  medical:    'a professional medical office receptionist',
  chiro:      'a professional chiropractic office receptionist',
  medspa:     'a polished med spa receptionist',
  therapy:    'a warm therapy practice receptionist',
  law:        'a professional law firm receptionist',
  realestate: 'a friendly real estate assistant',
  accounting: 'a professional accounting firm receptionist',
  consulting: 'a professional consulting firm receptionist',
  autorepair: 'a helpful auto repair shop assistant',
  cleaning:   'a friendly cleaning service coordinator',
  contractor: 'a helpful contractor scheduling assistant',
  other:      'a friendly professional business receptionist'
}

const toneInstructions = {
  friendly:     'Be warm, conversational, and use occasional friendly emojis (1-2 max per message).',
  professional: 'Be formal and polished. No emojis. Use proper grammar at all times.',
  casual:       'Be super relaxed and conversational. Short sentences. Very chill vibe.'
}

// ── Dynamic system prompt builder ─────────────────────────────────────────────
// Convert "YYYY-MM-DDTHH:MM" in an IANA timezone to a UTC Date (two-pass offset
// correction, DST-safe, no date library). Mirrors the helper in ownerCommands.js.
function localToUtcTZ(local, tz) {
  try {
    const [d, t] = local.split('T')
    const [y, m, day] = d.split('-').map(Number)
    const [hh, mm] = t.split(':').map(Number)
    const asUtc = Date.UTC(y, m - 1, day, hh, mm)
    const offsetAt = (ms) => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))
      const g = (k) => Number(parts.find(p => p.type === k).value)
      return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - ms
    }
    let guess = asUtc - offsetAt(asUtc)
    guess = asUtc - offsetAt(guess)
    return new Date(guess)
  } catch (e) { return null }
}

function buildSystemPrompt(business, profile, today, returningCustomer = null) {
  const persona = personas[business.business_type] || personas.other
  const tone = toneInstructions[business.bot_tone] || toneInstructions.friendly
  const greeting = business.bot_greeting ||
    `Hi! Thanks for reaching out to ${business.business_name}. How can I help you today?`
  const botName = business.bot_name || 'Assistant'
  const proSettings = business.pro_settings || {}

  // Format business hours
  const hours = Array.isArray(business.hours) ? business.hours : []
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  let hoursText = 'Hours not specified — tell customers to call for hours.'
  if (hours.length > 0) {
    if (hours[0] && !hours[0].day) {
      // Indexed format: [{open,from,to}, ...] where index 0=Sunday
      hoursText = hours.map((h, i) => `${dayNames[i]}: ${h && h.open ? `${h.from} – ${h.to}` : 'Closed'}`).join('\n')
    } else {
      // Named format: [{day:'Mon', open:'09:00', close:'17:00'}, ...]
      hoursText = hours.map(h => `${h.day}: ${h.closed ? 'Closed' : `${h.open || h.from} – ${h.close || h.to}`}`).join('\n')
    }
  }

  // Format services
  const servicesText = profile.services.length > 0
    ? profile.services.map(s => {
        let line = `- ${s.name} (${s.duration_mins} min${s.price ? `, ${s.price}` : ''})`
        if (s.booking_mode === 'request') line += ` [REQUIRES APPROVAL — collect their date/time preference and ask if they have reference photos. Then you MUST call the create_appointment tool to submit the request (this creates the pending request AND alerts the owner). Only AFTER the tool succeeds, tell them their request has been sent and they'll get a confirmation once reviewed. Do NOT say it was sent unless you actually called create_appointment.]`
        if (s.booking_mode === 'quote') line += ` [QUOTE REQUIRED — collect details and photos. Then you MUST call the create_appointment tool to submit the quote request (this creates the record AND alerts the owner). Only AFTER the tool succeeds, tell them you've passed it along for a custom quote. Do NOT say you passed it along unless you actually called create_appointment.]`
        if (s.booking_mode === 'class') line += ` [GROUP CLASS — multiple customers can book the same slot up to capacity of ${s.class_capacity || 10} spots. Check availability normally but mention spots remaining.]`
        if (s.post_booking_instructions) line += ` [POST-BOOKING NOTE TO SEND: "${s.post_booking_instructions}"]`
        return line
      }).join('\n')
    : 'Services not specified.'

  // Format bundles
  const bundlesText = profile.bundles?.length > 0
    ? '\n\n## SERVICE BUNDLES\nThese are pre-packaged combinations of services customers can book as a single appointment:\n' +
      profile.bundles.map(b => {
        const totalDuration = b.services.reduce((sum, svcName) => {
          const svc = profile.services.find(s => s.name === svcName)
          return sum + (svc?.duration_mins || 0)
        }, 0)
        return `- ${b.name}: includes ${b.services.join(' + ')} (${totalDuration} min total${b.bundle_price ? `, ${b.bundle_price}` : ''})${b.description ? ` — ${b.description}` : ''}`
      }).join('\n') +
      '\nWhen a customer asks about or books a bundle, use create_appointment with the bundle name as service_name and the total duration as total_duration_mins.'
    : ''

  // Format FAQs
  const faqsText = profile.faqs.length > 0
    ? profile.faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : ''

  // Format blocked dates
  const blockedText = profile.blockedDates.length > 0
    ? 'BLOCKED/UNAVAILABLE DATES (do not offer these):\n' +
      profile.blockedDates.map(b =>
        b.start_time ? `${b.blocked_date} ${b.start_time}–${b.end_time}` : `${b.blocked_date} (full day)`
      ).join('\n')
    : ''

  const locationType = business.location_type || 'physical'
  const locationContext = locationType === 'virtual'
    ? `This is a VIRTUAL/ONLINE business. Appointments are conducted remotely — by video, phone, or online. NEVER tell customers to "come in" or ask them to visit a physical location. ${business.meeting_link ? `A meeting link will be included in booking confirmations.` : `When customers ask how to connect, tell them you will send them details upon booking.`}`
    : locationType === 'mobile'
    ? `This is a MOBILE business — the business travels to the customer. When booking, always confirm the customer's address or location. Never direct customers to a business address.`
    : `This is a PHYSICAL LOCATION business. Customers come to: ${business.address || 'our location'}.`

  return `You are ${botName}, ${persona} for ${business.business_name}.
Your name is ${botName}. If a customer asks your name, tell them you're ${botName}.
Today's date is ${today}. The local time right now is ${new Date().toLocaleTimeString('en-US', { timeZone: business.timezone || 'America/New_York', hour: 'numeric', minute: '2-digit' })}. Timezone: ${business.timezone}.

## YOUR LOCATION
${locationContext}

## YOUR ROLE
Help customers via SMS to:
1. Book an appointment
2. Check or cancel an existing appointment  
3. Join the waitlist when fully booked
4. Answer questions about the business
5. Set a reminder so you text them back later (use set_reminder — you CAN do this, never say you can't)

## BUSINESS HOURS
${hoursText}

## SERVICES OFFERED
${servicesText}${bundlesText}
${business.profile_enabled && business.profile_slug ? `\n## PUBLIC PROFILE\nYour business has a public booking page at https://getwexly.com/book/${business.profile_slug}\nIf a customer asks to see your services, prices, hours, or wants a link — share this URL. Say something like "Here's our full info: getwexly.com/book/${business.profile_slug}"` : ''}

## BOOKING RULES
- Buffer between appointments: ${business.buffer_mins} minutes
- How far ahead customers can book: ${business.advance_booking_days} days
- Minimum notice required: ${Math.round(business.min_notice_mins / 60)} hours

${blockedText}

${faqsText ? `## FREQUENTLY ASKED QUESTIONS\nAnswer these accurately when asked:\n\n${faqsText}` : ''}

${business.bot_restrictions ? `## IMPORTANT RULES — NEVER BREAK THESE\n${business.bot_restrictions}` : ''}

${business.bot_instructions ? `## CUSTOM INSTRUCTIONS FROM THE BUSINESS OWNER\nFollow these instructions carefully — they are specific to how this business operates:\n${business.bot_instructions}` : ''}

${profile.activePromotions?.length > 0 ? `## 🏷️ ACTIVE PROMOTIONS — MENTION THESE NATURALLY
The following promotions are currently running:
${profile.activePromotions.map((p, i) => `${i + 1}. "${p.message}"`).join('\n')}

- Mention these naturally and early in booking conversations — but only once total, don't repeat
- Weave them in conversationally e.g. "By the way, we're currently running [promotion]!"
- If a customer asks about prices or services, always mention the relevant promotion
- Do NOT mention them if the customer is asking about something unrelated like cancelling or checking hours
- If multiple promotions are running, pick the most relevant one for the conversation` : ''}

${business.website ? `## BUSINESS WEBSITE
Website: ${business.website}
If a customer asks for the website or more info about the business, share this link.` : ''}

${business.meeting_link ? `## VIDEO MEETING
This business conducts appointments via video call.
Meeting link: ${business.meeting_link}
DO NOT include the meeting link in your booking confirmation reply — the server automatically appends it after every booking. The customer WILL receive the link, you just don't need to type it yourself. Your confirmation should mention "we'll send the video link" implicitly by simply confirming the booking. If a customer explicitly asks for the link mid-conversation (not as part of booking), you may share it directly.` : ''}

## SMS CONVERSATION RULES
- Keep ALL messages SHORT — this is SMS, not email. Max 3 sentences per reply.
- ${tone}
- BOOKING REQUIRES ALL THREE: Before calling create_appointment, you MUST have collected from the customer:
  1. First name AND last name (NOT just one — ask for both)
  2. Email address
  3. The service, date, and time they want
  If ANY of these is missing, ask for it FIRST. Never call create_appointment without first_name, last_name, AND email.
- HOW TO COLLECT NATURALLY: Don't ask for everything in one giant question. Flow: figure out service → confirm date/time → "Awesome! Can I grab your full name and email to send the confirmation?" → THEN book.
- IF CUSTOMER REFUSES EMAIL: That's their choice. Pass the literal string "declined" as customer_email so we know it was offered. Never use a fake email or your own placeholder.
- IF CUSTOMER ONLY GIVES ONE NAME: Politely ask "and last name?" — don't assume or make one up. Last name is required for legal/billing records.
- RETURNING CUSTOMERS: If the system tells you this is a returning customer with a name on file, use what's on file — don't re-ask. But if they have no email on file, ask for it.
- Always confirm key details before finalizing a booking: name, service, date, and time.
- NEVER MAKE THINGS UP: Only mention services, prices, staff, and availability that are in this system prompt or returned by tools. If you don't know something, say "I'm not sure about that — let me have the team get back to you" and flag the conversation for attention.
- SERVICE NOT FOUND: If a customer asks for a service you don't offer, tell them what you DO offer. Never book a different service than what they asked for. Say something like "We don't offer that, but here's what we have: [list services]."
- LISTING SERVICES: When a customer asks what services are available, ALWAYS list ALL services — including ones that require approval or quotes. Never skip or hide a service. Every service listed in this prompt must be mentioned.
- RESCHEDULE REQUESTS: When a customer says "reschedule", "move my appointment", "change my time", or similar — first look up their existing appointment, then check availability for their preferred new date/time. Cancel the old one and create the new one. When you call create_appointment for the new time, set is_reschedule: true so the owner is notified it's a reschedule, not a brand-new booking. Walk them through it step by step.
- SWITCHING SERVICES: If a customer says "I want to change to a different service", "switch my appointment to X", or "can I do X instead" — this means cancel their existing appointment and book the new service. Don't tell them the slot is unavailable because of their own booking. Cancel first, then book the new one.
- If a customer already has a booking and tries to book the same time slot with a different service, their existing appointment is what's blocking availability. Cancel it first, then rebook.
- MULTIPLE APPOINTMENTS: A customer may have multiple appointments (confirmed, pending, quote_sent). When they text, use conversation context to determine which appointment they're referring to. If they were just asked to rebook (due to owner reschedule), they're picking a new date — treat it as a fresh booking. Don't confuse it with other pending appointments.
- REBOOKING AFTER RESCHEDULE: If the customer received a message saying their appointment needs to be rescheduled, their next reply about dates/times is about rebooking that cancelled appointment. Ask what date works, check availability, and book it. Don't reference unrelated quote or pending appointments.
- AFTER HOURS: You can still respond to messages sent outside business hours. Book appointments for future dates normally. Don't tell customers "we're closed right now" — just help them book.
- RUDE/ABUSIVE CUSTOMERS: Stay professional and calm. Don't argue. If a customer is being abusive, say "I understand your frustration. Let me get someone who can help" and flag the conversation for attention by including "NEEDS_ATTENTION" in your response.
- NON-ENGLISH MESSAGES: If a customer texts in another language, respond in that same language if you can. If you can't, say "I'm sorry, I can only help in English right now. Please call us for assistance."
- AMBIGUOUS TIMES: If a customer says "3 o'clock" without AM/PM, assume PM for most businesses. If the business closes before 3 PM, assume AM. Always confirm: "Just to confirm — 3:00 PM?"
- VAGUE REQUESTS: If a customer says "sometime next week" or "whatever works", suggest 2-3 specific options. Don't ask them to pick a date — give them choices.
- SINGLE-WORD REPLIES: If a customer replies with just "yes", "no", "ok", "sure", "yeah", understand it in the context of your last message. "Yes" after you asked "Does 9 AM work?" means they want 9 AM.

## MULTI-SERVICE BOOKING
- If a customer wants multiple services (e.g. "haircut and color", "massage and facial"), book them ALL in a single appointment.
- Call create_appointment ONCE with service_name listing all services comma-separated (e.g. "Haircut, Color").
- Add up the durations of all requested services to get the total duration — pass this as total_duration_mins.
- Add up the prices to show the customer the total.
- Confirm all services, total time, and total price before finalizing.
- Example: "Haircut (45 min, $40) + Color (90 min, $120) = 2hr 15min, $160 total. Does that work?"
- If the business has birthday messages enabled, after collecting name/email casually ask: "One more — do you have a birthday on file with us? We love sending a little surprise! 🎂" If they share it, save it. If not, no problem.
- Never make up availability — use tools to check real slots.
- If a customer asks something outside your scope, say "I'm not sure about that — let me have the team get back to you" and flag the conversation for attention.${business.phone ? ` If they insist, give them the business phone number: ${business.phone}` : ''}
- Once confirmed, always end with a clear confirmation summary including name, service, date, and time.
- MULTI-DATE BOOKING: When booking multiple appointments across different dates, track which dates are already confirmed. Once a date is confirmed, do NOT re-check that date. If you ask "what time works for May 8th?" and the customer replies with just a time like "9:30", that time is for May 8th — the date you just asked about. Never go back to a previously confirmed date. Always call check_availability and create_appointment with the CORRECT date that is currently being discussed.
- CONTEXT TRACKING: Pay close attention to the conversation flow. If your last message asked about a specific date, the customer's next reply is about THAT date. Do not confuse it with earlier dates in the conversation.
- COMPLETED BOOKINGS: Once you have called create_appointment and it returned success, that booking is DONE. Do not ask to confirm it again, do not re-check its availability, do not mention it needs confirming. Move on to the next request or wrap up the conversation.
- DEPOSIT INFO IS HANDLED AUTOMATICALLY: When a customer books a service that requires a deposit, the server automatically appends the formal deposit-payment instructions to the end of your reply. You should NOT mention the deposit amount, payment link, "Pay here", "secure your spot", "hold your slot", or any payment instructions in your own reply — the server handles all of that. Your confirmation should still include the service, date, time, and staff (if applicable) — just leave out the deposit-payment lines AND any video meeting link (also handled automatically). Same applies to deposit refunds on cancellation.
- POST-BOOKING EMAIL CONFUSION: You should have already collected the email BEFORE booking, so this shouldn't happen. But if a customer sends an email address after the booking is already confirmed (e.g. they forgot they gave it already, or are confirming a typo), simply acknowledge: "Got it, thanks!" — do NOT check availability or try to book again.
- QUOTE INQUIRIES: If a customer asks "what's my quote?", "how much was it?", "can you remind me of the price?" — look up their existing appointment and tell them the quote amount from the notes. Do NOT confirm or cancel the appointment. Just provide the information.
- CAMPAIGN RESPONSES: If you see a message in the conversation history tagged with [CAMPAIGN], that was a marketing/promotional message the business sent. If the customer replies referencing it (e.g. "I want that deal", "tell me more about the special"), acknowledge the promotion and help them book. Use the campaign details to inform your response.
- SMART CANCELLATION: If a customer wants to cancel, NEVER cancel immediately. First check available slots and offer 1-2 alternatives: "Before I cancel that — we have [day] at [time] open, would that work instead?" If they still want to cancel (or there are no slots), you MUST call the cancel_appointment tool — that tool call is the ONLY thing that actually cancels it. Do NOT tell the customer it's cancelled until the tool has run and succeeded. Never reply "your appointment has been cancelled" without having just called cancel_appointment.
- APPOINTMENT NOTES: When creating an appointment, always include any relevant context from the conversation in the notes field. This includes: special requests ("keep it natural", "sensitive scalp"), preferences ("I prefer the back room"), health info ("allergic to X"), style references ("like last time"), specific instructions, or anything the customer mentioned that the staff should know. Combine with staff preference if applicable. Format: "Special requests: [details] | Staff preference: [name]" — only include sections that apply.
${business.referral_tracking_enabled ? `- REFERRAL TRACKING: After confirming a NEW customer's first booking (not returning customers), casually ask: "${business.referral_ask_message || 'Quick question — did someone refer you to us, or how did you hear about us? 😊'}" Save their answer in the appointment notes.` : ''}
${proSettings.recurring_enabled && business.plan === 'pro' ? `- RECURRING APPOINTMENTS: This business supports recurring bookings. If a customer says "every week", "every 6 weeks", "every month", or "book me regularly", set recurring_interval_weeks (e.g. 1=weekly, 2=biweekly, 4=monthly, 6=every 6 weeks) and recurring_count (default 6, max 12) when calling create_appointment. Confirm with them first: "I'll book you every X weeks — how many sessions ahead would you like me to schedule? I can book up to 12."` : ''}

## HANDLING MULTIPLE STAFF MEMBERS
${(business.staff_members||[]).filter(s=>s.name).length ? `This business has the following staff members: ${(business.staff_members||[]).filter(s=>s.name).map(s=>s.name).join(', ')}` : business.bot_staff ? `This business has the following staff members:\n${business.bot_staff}` : ''}

If the customer mentions a specific staff member by name:
- Acknowledge their preference warmly
- Pass their name in the staff_member field when creating the appointment
- The system will auto-assign them and block their calendar

If the customer does NOT specify a staff member:
- DO NOT ask upfront "do you have a preferred stylist?" — this adds friction
- Simply book with "our next available" — the system auto-assigns the first available staff member
- Only ask if the customer specifically asks who is available

If the customer asks "who is available?" or "who do you have?":
- List the named staff members above
- Let them pick, then pass that name in the staff_member field

If a requested staff member is NOT available at the chosen time, say so and offer alternatives — either a different time with that person, or the same time with someone else available.

For multiple services (e.g. cut + color): the same staff member handles both back to back — their total time is blocked for the full combined duration.

## OPENING GREETING (use for brand new conversations only)
"${greeting}"

${returningCustomer ? `## RETURNING CUSTOMER — IMPORTANT
You already know this customer:
- Name: ${returningCustomer.customer_name}
${returningCustomer.deposit_credit > 0 ? `- 💳 DEPOSIT CREDIT: This customer has a $${(returningCustomer.deposit_credit/100).toFixed(2)} deposit credit from a previous cancelled booking. Mention this warmly when they book: "Good news — you have a deposit credit from your last booking that will be applied automatically!" Do NOT ask them to pay a deposit.` : ''}
${returningCustomer.is_vip ? `- ⭐ VIP CUSTOMER: This is one of the business's most valued customers. Greet them extra warmly and make them feel special: "Hey ${returningCustomer.customer_name}! Always so great to hear from you 😊 You're one of our favourites — what can I book for you today?"${returningCustomer.vip_note ? ` Note about this VIP: ${returningCustomer.vip_note}` : ''}` :
returningCustomer.fromImport ? `- They are an existing client imported from the business's records. This is their first time texting.
- Greet them warmly by name as an existing client: "Hey ${returningCustomer.customer_name}! Great to have you texting us 😊 How can I help you today?"` : `- Last booked: ${returningCustomer.service_name} on ${formatDate(returningCustomer.appointment_date)}
- Greet them warmly by name: "Hey ${returningCustomer.customer_name}! Great to hear from you again 😊 What can I book for you?"`}
When creating their appointment, automatically use "${returningCustomer.customer_name}" as the customer_name.
Do NOT ask for their name — you already know it.${returningCustomer.customer_email && returningCustomer.customer_email !== 'declined' ? `
Their email is already on file: ${returningCustomer.customer_email}. Use this email automatically for customer_email when booking. Do NOT ask for their email — you already have it.` : ''}` : ''}${business.demo_mode ? require('./demoMode').demoPromptBlock(business) : ''}`
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const tools = [
  {
    name: 'check_availability',
    description: 'Check available appointment slots for a given date. Always call this before confirming.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        service_name: { type: 'string', description: 'The service they want to book, or comma-separated list for multiple' },
        total_duration_mins: { type: 'number', description: 'Total duration in minutes for multi-service bookings' }
      },
      required: ['date']
    }
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 🔒 PROTECTED — DO NOT MODIFY WITHOUT EXPLICIT BRANDON APPROVAL
  // 🔒 See PROTECTED_DECISIONS.md → Entry 1 (Booking flow requires first name,
  //    last name, AND email BEFORE create_appointment)
  // 🔒 The required: [...] list below has been deliberately tightened. It was
  //    loosened in a previous session and caused the rebook-on-email bug.
  //    Re-fixed 2026-05-29. If you remove customer_email or split it back to
  //    a single customer_name, customers get double-booked.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'create_appointment',
    description: 'Create a confirmed appointment after customer has provided ALL of: first name, last name, email, service, date, time, AND confirmed everything. NEVER call this without all customer contact fields collected. For multiple services, list all in service_name comma-separated and pass total_duration_mins as the sum of all service durations.',
    input_schema: {
      type: 'object',
      properties: {
        customer_first_name: { type: 'string', description: 'Customer first name — MUST be collected before booking' },
        customer_last_name: { type: 'string', description: 'Customer last name — MUST be collected before booking' },
        customer_email: { type: 'string', description: 'Customer email address — MUST be collected before booking. If customer explicitly declines after being asked, pass the string "declined" so we know it was offered.' },
        customer_birthday: { type: 'string', description: 'Customer birthday in YYYY-MM-DD format if provided' },
        service_name: { type: 'string', description: 'Service name, or comma-separated list for multiple services e.g. "Haircut, Color"' },
        total_duration_mins: { type: 'number', description: 'Total duration in minutes — sum of all service durations. If omitted, looked up from service list.' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM in 24hr format' },
        staff_member: { type: 'string', description: 'Preferred staff member name if specified, otherwise omit' },
        notes: { type: 'string' },
        recurring_interval_weeks: { type: 'number', description: 'If customer wants recurring bookings, number of weeks between appointments (e.g. 4 for every 4 weeks, 6 for every 6 weeks). Only set if customer explicitly asks for recurring/repeat bookings.' },
        recurring_count: { type: 'number', description: 'How many total appointments to book including the first one. Default 6 if recurring. Max 12.' },
        is_reschedule: { type: 'boolean', description: 'Set true ONLY when this booking is replacing an appointment the customer just rescheduled (i.e. you cancelled their old appointment and are creating the new time). This changes the owner notification to say "Rescheduled" instead of "New booking". Leave unset for normal new bookings.' }
      },
      // 🔒 PROTECTED — required must include all three of customer_first_name,
      // 🔒 customer_last_name, AND customer_email. Do not loosen.
      required: ['customer_first_name', 'customer_last_name', 'customer_email', 'date', 'time']
    }
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // 🔒 END PROTECTED — create_appointment tool
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'get_existing_appointment',
    description: "Look up the customer's existing upcoming appointment.",
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment. RETENTION: before cancelling, try ONCE to save the booking by offering 1-2 alternative times. If the customer still wants to cancel (or already confirmed), you MUST call this tool to actually cancel it — calling this tool is the ONLY thing that cancels the appointment in the system. NEVER tell the customer their appointment is cancelled unless you have called this tool and it returned success. Saying "cancelled" without calling the tool leaves the appointment active and misleads both the customer and the business.',
    input_schema: {
      type: 'object',
      properties: { appointment_id: { type: 'string' } },
      required: ['appointment_id']
    }
  },
  {
    name: 'set_reminder',
    description: 'Schedule a text back to THIS customer at a later time, when they ask to be reminded or nudged. Use for "remind me in 5 minutes", "text me tomorrow about booking", "can you remind me next week", "ping me after work". ALWAYS use this instead of saying you cannot set reminders — you can. For anything under about 6 hours use minutes_from_now. For a specific day or clock time use remind_at_local. Confirm naturally once it succeeds.',
    input_schema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: "What to remind them about as a VERB PHRASE that completes the sentence 'remind you to ___'. Good: 'book your next appointment', 'pick a time for your facial'. Bad: 'appointment', 'booking'." },
        minutes_from_now: { type: 'number', description: 'Minutes from now. Use for short relative delays like "in 5 minutes" or "in 2 hours".' },
        remind_at_local: { type: 'string', description: 'Local date and time in the business timezone as YYYY-MM-DDTHH:MM (24h). Use for "tomorrow at 9", "next Monday". If they give a day but no time, use 10:00.' }
      },
      required: ['what']
    }
  },
  {
    name: 'add_to_waitlist',
    description: 'Add customer to waitlist when no slots are available.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string' },
        service_name: { type: 'string' },
        preferred_date: { type: 'string', description: 'YYYY-MM-DD' },
        preferred_time: { type: 'string', description: 'HH:MM' }
      },
      required: ['preferred_date']
    }
  },
  {
    name: 'save_customer_email',
    description: 'Save or update a customer\'s email address. Use when a customer provides their email after booking, or anytime they share an email address. Also sends a confirmation email for their most recent appointment if one exists.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Customer email address' }
      },
      required: ['email']
    }
  }
]

// ═══════════════════════════════════════════════════════════════════════════
// 🔒 PROTECTED — Shared deposit-creation helper. See PROTECTED_DECISIONS.md
// 🔒 Entry 13 (Deposit creation for quote acceptance + regular bookings).
// 🔒 Used by BOTH create_appointment AND quote acceptance flows. Do not
// 🔒 duplicate this logic — call this function. If you change deposit
// 🔒 behavior (amount calculation, expiry window, status flow), change it
// 🔒 ONCE here so both flows stay in sync.
// ═══════════════════════════════════════════════════════════════════════════
//
// Returns:
//   { depositText: string, requiresDeposit: boolean, depositCreated: boolean,
//     creditApplied: boolean, creditAmountCents: number }
//
// - depositText: text to append to the customer's SMS reply (deposit link
//   instructions, or credit-applied confirmation, or empty string)
// - requiresDeposit: did the service require a deposit at all?
// - depositCreated: did we successfully create a Stripe checkout session?
// - creditApplied: did we apply a previous-cancellation deposit credit?
//
// Side effects (already done by this function before it returns):
// - If deposit created: appointment row updated to status='deposit_pending',
//   deposit_status='pending', deposit_expires_at=+4h
// - If credit applied: customers.deposit_credit cleared
// - URL shortened via shortener helper for SMS readability
//
// Never throws — errors are logged and an empty depositText is returned.
async function tryCreateDepositForAppointment({ business, appointment, service, customerPhone, customerName, returningCustomer }) {
  const result = {
    depositText: '',
    requiresDeposit: false,
    depositCreated: false,
    creditApplied: false,
    creditAmountCents: 0
  }

  // Loud diagnostic prefix so we can grep Render logs easily.
  const tag = `[Deposit-Helper appt=${appointment?.id || '?'}]`

  try {
    // Diagnostic: log everything we received
    console.log(`${tag} called. business.stripe_connected=${!!business?.stripe_account_connected} stripe_acct=${!!business?.stripe_account_id} service=${service?.name || '(none)'} service.price=${JSON.stringify(service?.price)} service.deposit_amount=${JSON.stringify(service?.deposit_amount)}`)

    if (!business?.stripe_account_connected || !business?.stripe_account_id) {
      console.log(`${tag} skip — Stripe not connected on business`)
      return result
    }
    if (!service) {
      console.log(`${tag} skip — service object is null (lookup failed). Appointment service_name="${appointment?.service_name}"`)
      return result
    }
    if (!service.deposit_amount || String(service.deposit_amount).trim() === '') {
      console.log(`${tag} skip — service.deposit_amount empty. service=${service.name} deposit_amount=${JSON.stringify(service.deposit_amount)}`)
      return result
    }

    result.requiresDeposit = true

    if (returningCustomer?.deposit_waived) {
      console.log(`${tag} skip — customer ${customerPhone} has deposit_waived flag`)
      return result
    }

    // Check for previous-cancellation credit
    const { createClient } = require('@supabase/supabase-js')
    const sbDirect = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

    const { data: customerRecord } = await sbDirect.from('customers')
      .select('deposit_credit').eq('business_id', business.id).eq('phone', customerPhone).maybeSingle()
    const customerDepositCredit = customerRecord?.deposit_credit || 0

    if (customerDepositCredit > 0) {
      await sbDirect.from('customers').update({ deposit_credit: 0 })
        .eq('business_id', business.id).eq('phone', customerPhone)
      const creditFormatted = `$${(customerDepositCredit / 100).toFixed(2)}`
      result.depositText = `\n\n✅ Your ${creditFormatted} deposit credit from your previous booking has been applied — your slot is confirmed!`
      result.creditApplied = true
      result.creditAmountCents = customerDepositCredit
      console.log(`${tag} applied existing credit ${creditFormatted}`)
      return result
    }

    // Parse deposit_amount — supports "50%" or "25" or "$25"
    const depositRaw = String(service.deposit_amount).trim()
    const servicePrice = parseFloat(String(service.price || '0').replace(/[^0-9.]/g, '')) || 0
    let depositCents = 0
    if (depositRaw.endsWith('%')) {
      const pct = parseFloat(depositRaw) / 100
      depositCents = Math.round(servicePrice * pct * 100)
      console.log(`${tag} percentage deposit: raw="${depositRaw}" pct=${pct} servicePrice=${servicePrice} → ${depositCents}¢`)
    } else {
      depositCents = Math.round(parseFloat(depositRaw.replace(/[^0-9.]/g, '')) * 100)
      console.log(`${tag} flat deposit: raw="${depositRaw}" → ${depositCents}¢`)
    }
    if (depositCents <= 0) {
      console.log(`${tag} skip — computed depositCents=${depositCents} (≤0). Likely service.price is blank/zero for percentage deposit.`)
      return result
    }

    // Create the Stripe checkout session via internal endpoint
    const BOT_URL = process.env.BOT_URL || 'https://wexly-bot.onrender.com'
    console.log(`${tag} calling ${BOT_URL}/stripe-connect/create-deposit with ${depositCents}¢`)
    const depRes = await fetch(`${BOT_URL}/stripe-connect/create-deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.ADMIN_SECRET || 'internal-bot-call'
      },
      body: JSON.stringify({
        businessId: business.id,
        appointmentId: appointment.id,
        amount: depositCents,
        description: `Deposit — ${service.name || 'appointment'}`
      })
    })
    const depData = await depRes.json().catch(() => ({}))
    console.log(`${tag} create-deposit response: status=${depRes.status} hasUrl=${!!depData.url} body=${JSON.stringify(depData).slice(0, 300)}`)

    if (!depData.url) {
      console.error(`${tag} Stripe checkout creation returned no URL — see body above`)
      return result
    }

    // Mark appointment deposit_pending
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()

    // Shorten URL for SMS
    const { shortenUrl } = require('../utils/shortener')
    const payUrl = await shortenUrl(depData.url, {
      appointmentId: appointment.id,
      businessId: business.id
    })

    const firstName = (customerName || appointment.customer_name || 'there').split(' ')[0] || 'there'
    result.depositText = `\n\nTo secure your spot, a $${(depositCents/100).toFixed(2)} deposit is due within the next 4 hours. Pay here: ${payUrl}\n\nWe'll hold your slot for you, ${firstName}! 🙌`
    result.depositCreated = true

    // Critical status update first (always works on existing schema).
    await sbDirect.from('appointments').update({
      status: 'deposit_pending',
      deposit_status: 'pending',
      deposit_expires_at: expiresAt
    }).eq('id', appointment.id)

    // Best-effort: persist deposit text/URL for the deferred-deposit fallback.
    // If these columns don't exist yet (migration not run), ignore the error.
    try {
      const { error: depColErr } = await sbDirect.from('appointments').update({
        deposit_pay_url: payUrl,
        deposit_text: result.depositText
      }).eq('id', appointment.id)
      if (depColErr && /column/i.test(depColErr.message || '')) {
        console.warn(`${tag} deposit_text/deposit_pay_url columns missing — run add-session-state-column.sql for the deferred-deposit fallback.`)
      }
    } catch (e) { /* non-fatal */ }

    console.log(`${tag} SUCCESS — deposit link created and appointment marked deposit_pending`)
    return result

  } catch (err) {
    console.error(`${tag} threw exception:`, err.message, err.stack)
    return result
  }
}

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(toolName, input, context) {
  const { business, profile, customerPhone, session, returningCustomer, mediaUrls = [] } = context

  switch (toolName) {
    case 'check_availability': {
      // ── Guard: no hours configured ────────────────────────────────────────
      const hours = Array.isArray(business.hours) ? business.hours : []
      if (hours.length === 0) {
        return { available: false, message: `We haven't finished setting up our schedule yet — please check back soon or we'll reach out to confirm a time with you directly!` }
      }
      // ── Enforce advance booking limit ─────────────────────────────────────
      const tz = business.timezone || 'America/New_York'
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz })
      const today = new Date(todayStr + 'T00:00:00')
      const requestedDate = new Date(input.date + 'T12:00:00')
      const maxDays = business.advance_booking_days || 30
      const diffDays = Math.round((requestedDate - today) / (1000 * 60 * 60 * 24))

      if (diffDays < 0) {
        return { available: false, message: 'That date is in the past.' }
      }
      if (diffDays > maxDays) {
        return { available: false, message: `Bookings can only be made up to ${maxDays} days in advance. The furthest available date is ${formatDate(new Date(Date.now() + maxDays * 86400000).toISOString().split('T')[0])}.` }
      }

      const existing = await db.getAppointmentsByDate(business.id, input.date)
      const blocked = profile.blockedDates.find(b => b.blocked_date === input.date && !b.start_time)
      if (blocked) return { available: false, message: 'This date is fully blocked.' }

      const serviceName = input.service_name || ''
      const service = profile.services.find(s =>
        s.name.toLowerCase().includes(serviceName.toLowerCase())
      ) || profile.services[0]
      const duration = input.total_duration_mins || service?.duration_mins || 60
      const capacity = service?.capacity || 1

      // For class/group services — check remaining capacity
      if (service?.booking_mode === 'class') {
        const classCapacity = service.class_capacity || 10
        const classBookings = existing.filter(a =>
          a.appointment_time === input.time &&
          (a.service_name?.toLowerCase().includes(serviceName.toLowerCase())) &&
          a.status !== 'cancelled'
        ).length
        if (input.time && classBookings >= classCapacity) {
          return { available: false, message: `That class is full (${classCapacity}/${classCapacity} spots taken). Would you like to join the waitlist or pick another time?` }
        }
        const slots = getAvailableSlots(business, input.date, [], duration, profile.blockedDates, classCapacity, serviceName)
        return { available: true, slots, preview: slots.slice(0, 6), date: input.date, spots_remaining: classCapacity - classBookings, is_class: true }
      }

      const slots = getAvailableSlots(business, input.date, existing, duration, profile.blockedDates, capacity, serviceName)
      if (slots.length === 0) return { available: false, message: 'No availability on this date.' }
      // Return ALL slots so Claude can accurately check if a specific requested
      // time (like "2pm") is actually available. Previously this was sliced to
      // the first 6, which made the bot incorrectly say afternoon times weren't
      // available when they were. 'preview' gives Claude a short list to show
      // the customer when introducing options.
      return { available: true, slots, preview: slots.slice(0, 6), date: input.date }
    }

    case 'create_appointment': {
      // 🔒 v191 DEMO MODE — the public demo number confirms the booking for real
      // in conversation but writes nothing: no appointment row, no deposit, no
      // owner notification, and therefore no reminder or follow-up texts to a
      // prospect who never had an appointment. Availability above was real.
      if (business.demo_mode) {
        const demoName = [input.customer_first_name, input.customer_last_name].filter(Boolean).join(' ').trim()
          || input.customer_name || returningCustomer?.customer_name || 'Customer'
        console.log(`[Demo] Simulated booking for ${demoName} — ${input.date} ${input.time} (${customerPhone})`)
        return require('./demoMode').demoBookingResult({
          customerName: demoName,
          dateLabel: formatDate(input.date),
          timeLabel: formatTime(input.time),
          serviceName: input.service_name || 'Appointment',
          staffNote: input.staff_member ? ` · with ${input.staff_member}` : ''
        })
      }

      // Wrap in booking lock to prevent race conditions
      return await withBookingLock(business.id, input.date, async () => {

      // ── Compose customer's full name from first + last (new schema) ──────
      // Tool now requires customer_first_name + customer_last_name + customer_email
      // before booking. We compose a single "customerName" here for all
      // downstream uses. Legacy fallback for older paths/clients.
      let customerName = 'Customer'
      if (input.customer_first_name || input.customer_last_name) {
        customerName = [input.customer_first_name, input.customer_last_name]
          .filter(Boolean).map(s => String(s).trim()).join(' ').trim() || 'Customer'
      } else if (input.customer_name) {
        customerName = input.customer_name
      } else if (returningCustomer?.customer_name) {
        customerName = returningCustomer.customer_name
      }

      // ── Hard enforce advance booking limit at creation time too ──────────
      const tz = business.timezone || 'America/New_York'
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz })
      const today = new Date(todayStr + 'T00:00:00')
      const requestedDate = new Date(input.date + 'T12:00:00')
      const maxDays = business.advance_booking_days || 30
      const diffDays = Math.round((requestedDate - today) / (1000 * 60 * 60 * 24))

      if (diffDays < 0) return { success: false, error: 'Cannot book appointments in the past.' }
      if (diffDays > maxDays) return { success: false, error: `Cannot book more than ${maxDays} days in advance.` }

      // ═══════════════════════════════════════════════════════════════════════
      // 🔒 PROTECTED — Same-day past-time guard. See PROTECTED_DECISIONS.md Entry 3.
      // 🔒 This is the SECOND layer of past-time defense. The first layer is in
      // 🔒 dateHelpers.js (slot generation). Both are needed because a customer
      // 🔒 can type a time directly without seeing the slot list. Do NOT remove
      // 🔒 this "because slot generation already filters" — that's the trap.
      // ═══════════════════════════════════════════════════════════════════════
      // ── Same-day past-time guard ──────────────────────────────────────────
      if (diffDays === 0 && input.time) {
        const [reqH, reqM] = input.time.split(':').map(Number)
        const requestedMins = reqH * 60 + reqM
        const nowParts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(new Date())
        const nowMinutes = parseInt(nowParts.find(p => p.type === 'hour').value, 10) * 60
          + parseInt(nowParts.find(p => p.type === 'minute').value, 10)
        const minNotice = business.min_notice_mins || 0
        if (requestedMins < nowMinutes + minNotice) {
          if (requestedMins < nowMinutes) {
            return { success: false, error: 'That time has already passed today. Please pick a future time.' }
          }
          const hoursNotice = Math.round(minNotice / 60 * 10) / 10
          return { success: false, error: `We need at least ${hoursNotice} hours of notice for same-day bookings. Please pick a later time.` }
        }
      }
      // 🔒 END PROTECTED — same-day past-time guard

      // ── Get existing appointments ───────────────────────────────────────
      const existing = await db.getAppointmentsByDate(business.id, input.date)

      // Find the service to get its capacity
      const serviceForCap = profile.services.find(s =>
        s.name.toLowerCase().includes((input.service_name || '').toLowerCase())
      ) || profile.services[0]
      const capacity = serviceForCap?.capacity || 1

      // Check if this specific slot is still available given staff capacity
      if (input.time && serviceForCap?.booking_mode !== 'class') {
        const slots = getAvailableSlots(business, input.date, existing, serviceForCap?.duration_mins || 60, profile.blockedDates, capacity, input.service_name)
        if (!slots.includes(input.time)) return { success: false, error: 'That slot is no longer available — all staff are booked at that time.' }
      } else if (input.time && serviceForCap?.booking_mode === 'class') {
        // For classes — check capacity not slot blocking
        const classCapacity = serviceForCap.class_capacity || 10
        const classCount = existing.filter(a =>
          a.appointment_time === input.time &&
          a.service_name?.toLowerCase().includes((input.service_name || '').toLowerCase()) &&
          a.status !== 'cancelled'
        ).length
        if (classCount >= classCapacity) return { success: false, error: `That class is now full (${classCapacity}/${classCapacity} spots). Would you like to join the waitlist?` }
      }

      var service = profile.services.find(s =>
        s.name.toLowerCase().includes((input.service_name || '').toLowerCase())
      )
      if (!service && input.service_name) {
        var available = profile.services.map(s => s.name).join(', ')
        return { success: false, error: `We don't offer "${input.service_name}". Our services: ${available}` }
      }
      if (!service) service = profile.services[0]

      // Clear STALE completed intake state. session.intake.complete persists in
      // session_state; a leftover 'complete' from a PRIOR booking would make this
      // new booking skip intake. If intake is marked complete but there's no
      // active held booking (pendingBooking) and we're not mid-re-invocation
      // (intakeAlreadyRun), it's stale — reset it so this booking runs intake fresh.
      if (session.intake?.complete && !session.pendingBooking && !session.intakeAlreadyRun) {
        console.log('[Intake-Gate] clearing stale completed intake from a previous booking')
        session.intake = null
        if (session.pendingIntake?.beforeBooking) session.pendingIntake = null
      }

      // ═══════════════════════════════════════════════════════════════════════
      // 🔒 PROTECTED — Intake-BEFORE-booking gate. See PROTECTED_DECISIONS.md
      // 🔒 Entry 18/19/26. Intake questions must be asked and answered BEFORE the
      // 🔒 appointment is created. When the LLM tries to book but this service has
      // 🔒 applicable intake forms that aren't yet complete, we DON'T book. We
      // 🔒 stash the booking details on session.pendingBooking, start the intake
      // 🔒 flow, and return the first question. The booking is created only after
      // 🔒 all intake answers are collected (see intake-completion handler).
      // ═══════════════════════════════════════════════════════════════════════
      // Skip the gate only when: we're re-invoking after intake just completed
      // (intakeAlreadyRun), OR this is a request/quote service.
      if (!session.intakeAlreadyRun && service?.booking_mode !== 'request' && service?.booking_mode !== 'quote') {
        const proSettings = business.pro_settings || {}
        console.log(`[Intake-Gate] eval: plan=${business.plan} intake_forms=${!!proSettings.intake_forms} intakeComplete=${!!session.intake?.complete} alreadyRun=${!!session.intakeAlreadyRun}`)
        if (business.plan === 'pro' && proSettings.intake_forms && !session.intakeAlreadyRun) {
          try {
            const { getApplicableIntakeForms } = require('./proFeatures')
            const applicableForms = await getApplicableIntakeForms(business.id, service?.id || null, !!returningCustomer)
            console.log(`[Intake-Gate] resolved ${applicableForms?.length || 0} applicable form(s) for service ${service?.id}`)
            const flat = []
            for (const { questions } of (applicableForms || [])) {
              for (const q of questions) flat.push({ label: q.label, field_type: q.field_type, options: q.options, required: q.required })
            }
            if (flat.length) {
              // Hold the booking until intake is done.
              session.pendingBooking = { input: { ...input }, serviceId: service?.id || null, isReturning: !!returningCustomer }
              const introText = applicableForms[0].form.intro_text || 'Before I book that, just a couple quick questions:'
              const q0 = flat[0]
              session.intake = { step: 1, responses: {}, complete: false, questionList: flat, introText }
              session.pendingIntake = { appointmentId: null, serviceId: service?.id || null, isReturning: !!returningCustomer, beforeBooking: true }
              console.log(`[Intake-Gate] Holding booking for ${customerName} — asking ${flat.length} intake question(s) FIRST`)
              return {
                success: false,
                intake_required_first: true,
                ask_customer: `${introText}\n\n${q0.label}${q0.options ? `\nOptions: ${q0.options}` : ''}`,
                instruction: 'Do not book yet. Ask the customer the question in ask_customer verbatim. Their answers will be collected, then the booking will be created automatically.'
              }
            }
          } catch (err) {
            console.error('[Intake-Gate] error resolving forms (proceeding to book):', err.message)
          }
        }
      }

      // Multi-service: sum durations if total_duration_mins not provided
      let totalDuration = input.total_duration_mins || null
      if (!totalDuration) {
        if (input.service_name && input.service_name.includes(',')) {
          const serviceNames = input.service_name.split(',').map(s => s.trim().toLowerCase())
          totalDuration = serviceNames.reduce((sum, sName) => {
            const match = profile.services.find(s => s.name.toLowerCase().includes(sName))
            return sum + (match?.duration_mins || 60)
          }, 0)
        } else {
          totalDuration = service?.duration_mins || 60
        }
      }

      let notes = input.notes || null

      // Auto-assign staff member
      let assignedStaff = null
      const staffMembers = (business.staff_members || []).filter(s => s.name)

      if (input.staff_member && staffMembers.length) {
        // Customer requested specific staff
        assignedStaff = staffMembers.find(s =>
          s.name.toLowerCase().includes(input.staff_member.toLowerCase())
        ) || null
        notes = `Staff preference: ${input.staff_member}${notes ? ' | ' + notes : ''}`
      } else if (staffMembers.length) {
        // Auto-assign first available staff member for this service/time
        const existing = await db.getAppointmentsByDate(business.id, input.date)
        assignedStaff = findAvailableStaff(business, input.date, input.time, totalDuration, existing, input.service_name)
      }

      // Collect photos only from AFTER the last completed booking
      var allPhotos = [...(mediaUrls || [])]
      var lastBookingIdx = session.lastBookingMsgIndex || 0
      for (var mi = lastBookingIdx; mi < session.messages.length; mi++) {
        var msg = session.messages[mi]
        if (msg.media && msg.media.length) {
          msg.media.forEach(function(p) { if (!allPhotos.includes(p)) allPhotos.push(p) })
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // 🔒 PROTECTED — Duplicate-booking guard. See PROTECTED_DECISIONS.md Entry 25.
      // 🔒 If this customer already has an active appointment at the same date+time,
      // 🔒 do NOT create a second one. Returns the existing appt as success so the
      // 🔒 bot acknowledges without double-booking. Defends against loops/retries
      // 🔒 re-invoking create_appointment (observed 2026-06-08: duplicate rows for
      // 🔒 the same slot). Do NOT remove — session persistence reduces the loop
      // 🔒 risk but this is the last line of defense at the DB-write boundary.
      // ═══════════════════════════════════════════════════════════════════════
      {
        const sbDup = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
        const { data: existingDup } = await sbDup.from('appointments')
          .select('id, status')
          .eq('business_id', business.id)
          .eq('customer_phone', customerPhone)
          .eq('appointment_date', input.date)
          .eq('appointment_time', input.time)
          .in('status', ['confirmed', 'deposit_pending', 'pending_approval', 'pending'])
          .limit(1)
          .maybeSingle()
        if (existingDup) {
          console.log(`[Booking] Duplicate prevented — ${customerName} already has appt ${existingDup.id} at ${input.date} ${input.time} (status ${existingDup.status}). Returning existing.`)
          session.lastAppointmentId = existingDup.id
          return {
            success: true,
            already_booked: true,
            appointment_id: existingDup.id,
            message: `You're already booked for that time — no need to book again! Is there anything else I can help with?`
          }
        }
      }

      const appt = await db.createAppointment({
        business_id: business.id,
        customer_phone: customerPhone,
        customer_name: customerName,
        service_id: service?.id || null,
        service_name: input.service_name || service?.name || 'Appointment',
        appointment_date: input.date,
        appointment_time: input.time,
        duration_mins: totalDuration,
        notes,
        staff_name: assignedStaff?.name || null,
        staff_id: assignedStaff?.name || null,
        status: service?.booking_mode === 'request' || service?.booking_mode === 'quote' ? 'pending_approval' : 'confirmed',
        request_photos: allPhotos.length ? JSON.stringify(allPhotos) : null
      })
      session.lastAppointmentId = appt.id

      // ── Resolve intake forms NOW and append the first question to the ──────
      // booking confirmation (Pro feature). See PROTECTED_DECISIONS.md Entry 18.
      // We resolve applicable forms immediately (not on a later message) because
      // a customer may never text again after booking. The intro + first
      // question are stashed into pendingAppends so they ride along on the
      // confirmation, and the intake session is set to step 1 so the customer's
      // next reply is treated as the answer to question 1.
      let intakeAppend = ''
      const intakeTag = `[Intake-Debug appt=${appt.id}]`
      // Intake now runs BEFORE booking (see intake-gate above). If intake is
      // already complete (the held booking is now executing) or already run this
      // turn, do NOT re-append questions. This block only remains as a safety
      // no-op for the new flow. (Entry 26)
      if (session.intake?.complete || session.intakeAlreadyRun) {
        console.log(`${intakeTag} skip — intake already handled before booking`)
      } else if (service?.booking_mode === 'request' || service?.booking_mode === 'quote') {
        console.log(`${intakeTag} skip — booking_mode is ${service?.booking_mode} (intake only fires on confirmed bookings)`)
      } else {
        const proSettings = business.pro_settings || {}
        console.log(`${intakeTag} plan=${business.plan} intake_forms_enabled=${!!proSettings.intake_forms}`)
        if (business.plan !== 'pro') {
          console.log(`${intakeTag} skip — business plan is "${business.plan}", not "pro"`)
        } else if (!proSettings.intake_forms) {
          console.log(`${intakeTag} skip — pro_settings.intake_forms master toggle is OFF`)
        } else {
          try {
            const { getApplicableIntakeForms } = require('./proFeatures')
            const applicableForms = await getApplicableIntakeForms(business.id, service?.id || null, !!returningCustomer)
            console.log(`${intakeTag} serviceId=${service?.id || 'none'} isReturning=${!!returningCustomer} → ${applicableForms.length} applicable form(s)`)
            if (applicableForms.length) {
              // Flatten all questions across applicable forms
              const flat = []
              for (const { questions } of applicableForms) {
                for (const q of questions) {
                  flat.push({ label: q.label, field_type: q.field_type, options: q.options, required: q.required })
                }
              }
              console.log(`${intakeTag} ${flat.length} total question(s) across applicable forms`)
              if (flat.length) {
                const introText = applicableForms[0].form.intro_text || 'Quick — just a couple questions before your visit:'
                const q0 = flat[0]
                intakeAppend = `\n\n${introText}\n\n${q0.label}${q0.options ? `\nOptions: ${q0.options}` : ''}`
                session.intake = { step: 1, responses: {}, complete: false, questionList: flat, introText }
                session.pendingIntake = {
                  appointmentId: appt.id,
                  serviceId: service?.id || null,
                  isReturning: !!returningCustomer
                }
                console.log(`${intakeTag} SUCCESS — appending intro + Q1 to confirmation`)
              }
            }
          } catch (err) {
            console.error(`${intakeTag} threw:`, err.message)
          }
        }
      }

      console.log(`[Booking] Created appointment for ${customerName} — service: ${service?.name}, booking_mode: ${service?.booking_mode || 'NOT SET'}, status: ${service?.booking_mode === 'request' || service?.booking_mode === 'quote' ? 'pending_approval' : 'confirmed'}`)

      // If this is a request/quote service — notify owner and return early with pending message
      if (service?.booking_mode === 'request' || service?.booking_mode === 'quote') {
        console.log(`[Approval] ${service.name} requires approval (mode: ${service.booking_mode})`)

        // Notify owner — wrapped in try-catch so it never crashes the booking
        const isQuote = service?.booking_mode === 'quote'
        try {
          var ownerPhone = business.owner_phone
          if (ownerPhone) {
            ownerPhone = ownerPhone.replace(/\D/g, '')
            if (!ownerPhone.startsWith('1') && ownerPhone.length === 10) ownerPhone = '1' + ownerPhone
            ownerPhone = '+' + ownerPhone

            const firstName = customerName.split(' ')[0]
            const replyOptions = isQuote
              ? `"Quote ${firstName} $200" — to send them a price\n"Deny ${firstName}" — to decline`
              : `"Approve ${firstName}" — to confirm\n"Quote ${firstName} $X" — to send a price instead\n"Deny ${firstName}" — to decline`
            const notifyMsg = `📋 New ${isQuote ? 'quote' : 'booking'} request!\n\nCustomer: ${customerName}\nPhone: ${customerPhone}\nService: ${input.service_name || service?.name}\nDate: ${input.date}\nTime: ${input.time || 'TBD'}${notes ? '\nNotes: ' + notes : ''}${allPhotos.length ? '\n📸 ' + allPhotos.length + ' photo(s) — view in dashboard' : ''}\n\nReply:\n${replyOptions}`

            // Send as regular SMS (MMS is unreliable with Twilio media URLs)
            await sendSMS(business.sms_number, ownerPhone, notifyMsg)

            // If photos exist, send them as a separate MMS
            if (allPhotos.length) {
              try {
                await sendSMS(business.sms_number, ownerPhone, '📸 Reference photos from ' + firstName + ':', allPhotos)
              } catch(mmsErr) {
                console.warn('[Approval] MMS failed, photos available in dashboard:', mmsErr.message)
              }
            }
            console.log(`[Approval] Notified owner at ${ownerPhone}${allPhotos.length ? ' + ' + allPhotos.length + ' photos' : ''}`)
          } else {
            console.warn(`[Approval] No owner phone set for ${business.business_name}`)
          }

          // Send email notification to owner for approval requests
          if (business.email) {
            sendBookingNotification({
              ownerEmail: business.email,
              ownerPhone: null,
              businessName: business.business_name,
              smsNumber: business.sms_number,
              customerName: customerName,
              customerPhone,
              serviceName: input.service_name || service?.name || 'Appointment',
              appointmentDate: input.date,
              appointmentTime: input.time,
              notes: (notes || '') + (isQuote ? ' [QUOTE REQUEST]' : ' [PENDING APPROVAL]'),
              depositPending: false
            }).catch(err => console.error('[Approval] Email notification failed:', err.message))
          }
        } catch (notifyErr) {
          console.error(`[Approval] Failed to notify owner:`, notifyErr.message)
        }

        // Save all collected photos to session
        if (allPhotos.length) session.requestPhotos = allPhotos

        // Mark this booking boundary so next booking only collects new photos
        session.lastBookingMsgIndex = session.messages.length

        const pendingReply = isQuote
          ? `Got it! I've sent your request to ${business.business_name}. They'll review your info and get back to you with a custom quote shortly. 😊`
          : `Got it! Your request has been sent to ${business.business_name}. You'll receive a confirmation once it's been reviewed. 😊`
        console.log(`[Approval] Returning pending response to customer (isQuote: ${isQuote})`)
        return pendingReply
      }

      // Email — 'declined' is a sentinel meaning the customer was asked and refused.
      // Save it as NULL in the DB (but the LLM had to acknowledge collection).
      const emailRaw = (input.customer_email || '').trim().toLowerCase()
      const customerEmailToSave = (emailRaw && emailRaw !== 'declined' && emailRaw.includes('@'))
        ? input.customer_email
        : null

      // Save/update customer record with name and email
      const { createClient } = require('@supabase/supabase-js')
      const sbDirect = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      sbDirect.from('customers').upsert({
        business_id: business.id,
        phone: customerPhone,
        name: customerName,
        email: customerEmailToSave,
        birthday: input.customer_birthday || null,
        source: 'booking'
      }, { onConflict: 'business_id,phone' }).then(() => {}).catch(() => {})

      // ── Deposit — use shared helper (also used by quote acceptance) ─────
      // 🔒 Both flows MUST use this helper. See PROTECTED_DECISIONS Entry 13.
      const depositResult = await tryCreateDepositForAppointment({
        business,
        appointment: appt,
        service,
        customerPhone,
        customerName,
        returningCustomer
      })
      const requiresDeposit = depositResult.requiresDeposit && !depositResult.creditApplied
      let depositText = depositResult.depositText

      // Notify business owner — fire and forget
      sendBookingNotification({
        ownerEmail: shouldSendNotification(business, 'new_booking_email') ? business.email : null,
        ownerPhone: shouldSendNotification(business, 'new_booking_sms') ? business.owner_phone : null,
        businessName: business.business_name,
        smsNumber: business.sms_number,
        customerName,
        customerPhone,
        serviceName: input.service_name || service?.name || 'Appointment',
        appointmentDate: input.date,
        appointmentTime: input.time,
        notes,
        depositPending: requiresDeposit && !!depositText,
        isReschedule: input.is_reschedule === true
      }).catch(err => console.error('[Notify] Booking notification failed:', err.message))
      // Native app push (additive; no-op until Firebase is configured — src/utils/push.js)
      try { require('../utils/push').pushNewBooking(business, { customerName, customerPhone, serviceName: input.service_name || service?.name || 'Appointment', appointmentDate: input.date, appointmentTime: input.time, isReschedule: input.is_reschedule === true }).catch(() => {}) } catch (e) {}

      // Mark this booking boundary so next booking only collects new photos
      session.lastBookingMsgIndex = session.messages.length

      // Send confirmation email to customer (only if we have a real email — not the declined sentinel)
      if (customerEmailToSave) {
        sendCustomerConfirmationEmail({
          customerEmail: customerEmailToSave,
          customerName: customerName || customerPhone,
          businessName: business.business_name,
          serviceName: input.service_name || service?.name || 'Appointment',
          appointmentDate: input.date,
          appointmentTime: input.time,
          smsNumber: business.sms_number
        }).catch(err => console.error('[Email] Customer confirmation failed:', err.message))
      }

      // ── Recurring appointments (Pro) ────────────────────────────────────────
      let recurringText = ''
      const proSettings = business.pro_settings || {}
      if (input.recurring_interval_weeks && proSettings.recurring_enabled && business.plan === 'pro') {
        try {
          const intervalWeeks = Math.min(Math.max(parseInt(input.recurring_interval_weeks), 1), 52)
          const count = Math.min(parseInt(input.recurring_count || 6), 12)
          const sbRecur = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
          const recurDates = []
          let baseDate = new Date(input.date + 'T12:00:00')

          for (let i = 1; i < count; i++) {
            baseDate = new Date(baseDate.getTime() + intervalWeeks * 7 * 24 * 60 * 60 * 1000)
            const dateStr = baseDate.toISOString().split('T')[0]
            recurDates.push(dateStr)
            await sbRecur.from('appointments').insert({
              business_id: business.id,
              customer_phone: customerPhone,
              customer_name: customerName,
              service_name: input.service_name || service?.name || 'Appointment',
              service_id: service?.id || null,
              appointment_date: dateStr,
              appointment_time: input.time,
              duration_mins: totalDuration,
              notes: (notes ? notes + ' | ' : '') + `Recurring — every ${intervalWeeks} week${intervalWeeks > 1 ? 's' : ''}`,
              staff_name: assignedStaff?.name || null,
              staff_id: assignedStaff?.name || null,
              status: 'confirmed',
              is_recurring: true,
              recurring_interval_weeks: intervalWeeks
            })
          }

          const lastDate = recurDates[recurDates.length - 1]
          recurringText = `\n\n🔁 I've booked all ${count} recurring appointments every ${intervalWeeks} week${intervalWeeks > 1 ? 's' : ''} through ${formatDate(lastDate)}. Reply "cancel recurring" anytime to stop future bookings.`
          console.log(`[Recurring] Booked ${count - 1} future appointments for ${customerPhone}`)
        } catch (err) {
          console.error('[Recurring] Failed to create recurring appointments:', err.message)
        }
      }

      // ── Post-booking instructions (per service) ─────────────────────────────
      let instructionsText = ''
      if (service?.post_booking_instructions && service.booking_mode !== 'request' && service.booking_mode !== 'quote') {
        instructionsText = `\n\n📋 ${service.post_booking_instructions}`
      }

      const staffNote = input.staff_member ? ` with ${input.staff_member}` : (assignedStaff ? ` with ${assignedStaff.name}` : '')

      // ═══════════════════════════════════════════════════════════════════════
      // 🔒 PROTECTED — Stacked confirmation sequencing. See PROTECTED_DECISIONS.md
      // 🔒 Entry 19. When a booking combines virtual + deposit + intake, the order
      // 🔒 of operations is: intake questions first → deposit link after intake →
      // 🔒 Zoom link only after deposit is paid (sent by the stripe-connect webhook).
      // 🔒 This avoids a single overwhelming message with three competing actions.
      // ═══════════════════════════════════════════════════════════════════════
      const hasDeposit = !!depositText
      const hasIntake = !!intakeAppend

      // 1. ZOOM LINK — only append to the confirmation if there's NO deposit.
      //    If a deposit is required, the Zoom link is withheld until payment and
      //    delivered by the deposit-paid webhook (Entry 19). See index.js.
      console.log(`[Zoom-Debug appt=${appt.id}] location_type=${business.location_type} meeting_link=${business.meeting_link ? 'SET' : 'EMPTY'} hasDeposit=${hasDeposit}`)
      if (business.location_type === 'virtual' && business.meeting_link && !hasDeposit) {
        const meetingText = `\n\n🎥 Join via video: ${business.meeting_link}`
        session.pendingAppends = (session.pendingAppends || '') + meetingText
        console.log(`[Zoom-Debug appt=${appt.id}] zoom link APPENDED to confirmation`)
      } else if (business.location_type === 'virtual' && business.meeting_link && hasDeposit) {
        console.log(`[Zoom-Debug appt=${appt.id}] zoom link withheld — deposit required, will send after payment`)
      }

      // 2. INTAKE QUESTION — append the first question if intake applies.
      if (hasIntake) {
        session.pendingAppends = (session.pendingAppends || '') + intakeAppend
      }

      // 3. DEPOSIT LINK — placement depends on whether intake is running.
      //    - If intake is running: DON'T stack the deposit now. Stash it so the
      //      intake-completion handler sends it after the last answer. This keeps
      //      "answer the question" and "pay here" as separate, sequential actions.
      //    - If no intake: append the deposit now (the closing CTA), as before.
      if (hasDeposit) {
        if (hasIntake && session.pendingIntake) {
          session.pendingIntake.depositTextAfterIntake = depositText
        } else {
          session.pendingAppends = (session.pendingAppends || '') + depositText
        }
      }

      return {
        success: true,
        appointment_id: appt.id,
        recurring_text: recurringText,
        instructions_text: instructionsText,
        confirmation: `${customerName} · ${formatDate(input.date)} · ${formatTime(input.time)} · ${input.service_name || 'Appointment'}${staffNote}`
      }

      }) // end withBookingLock
    }

    case 'get_existing_appointment': {
      const appts = await db.getAppointmentByCustomer(business.id, customerPhone)
      if (!appts.length) return { found: false, message: 'No upcoming appointments found.' }
      return {
        found: true,
        count: appts.length,
        appointments: appts.map(a => ({
          appointment_id: a.id,
          customer_name: a.customer_name,
          service: a.service_name,
          date: a.appointment_date,
          time: a.appointment_time?.slice(0, 5),
          status: a.status,
          notes: a.notes || null
        }))
      }
    }

    case 'cancel_appointment': {
      const sbCancel = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      let { data: apptToCancel } = await sbCancel
        .from('appointments').select('*').eq('id', input.appointment_id).maybeSingle()

      // Guard: if the ID didn't resolve to a real appointment, do NOT claim
      // success — the LLM may have guessed or fabricated an ID. Fall back to the
      // customer's actual soonest upcoming appointment.
      if (!apptToCancel) {
        const tzC = business.timezone || 'America/New_York'
        const todayC = new Date().toLocaleDateString('en-CA', { timeZone: tzC })
        const { data: fallbackAppt } = await sbCancel.from('appointments')
          .select('*')
          .eq('business_id', business.id)
          .eq('customer_phone', customerPhone)
          .in('status', ['confirmed', 'deposit_pending', 'pending_approval'])
          .gte('appointment_date', todayC)
          .order('appointment_date', { ascending: true })
          .limit(1)
          .maybeSingle()
        if (!fallbackAppt) {
          return { error: 'No upcoming appointment found to cancel. Ask the customer which appointment they mean.' }
        }
        apptToCancel = fallbackAppt
        input.appointment_id = fallbackAppt.id
      }

      await db.updateAppointment(input.appointment_id, { status: 'cancelled' })

      // Native app push: customer cancelled by text (additive, never blocks the reply)
      try { require('../utils/push').pushCancellation(business, { customerName: apptToCancel?.customer_name || '', customerPhone, serviceName: apptToCancel?.service_name || 'Appointment', appointmentDate: apptToCancel?.appointment_date, appointmentTime: apptToCancel?.appointment_time }).catch(() => {}) } catch (e) {}

      // ── Deposit policy handling on cancellation ───────────────────────────
      let depositMsg = ''
      if (apptToCancel?.deposit_status === 'paid') {
        const policy = business.deposit_policy || 'non_refundable' // non_refundable | transferable | refundable
        const transferDays = business.deposit_transfer_days || 48

        if (policy === 'non_refundable') {
          depositMsg = ` Please note that per our deposit policy, deposits are non-refundable.`
        } else if (policy === 'transferable') {
          // Check if within transfer window
          const apptDate = new Date(apptToCancel.appointment_date)
          const now = new Date()
          const hoursUntilAppt = (apptDate - now) / (1000 * 60 * 60)
          if (hoursUntilAppt >= 0 && hoursUntilAppt <= transferDays * 24) {
            depositMsg = ` Your deposit is on file and can be applied to a future booking — just rebook within ${transferDays} hours and it'll transfer automatically.`
            // Store deposit credit on customer
            await sbCancel.from('customers').update({ deposit_credit: apptToCancel.deposit_amount || 0 })
              .eq('business_id', business.id).eq('phone', customerPhone)
          } else {
            depositMsg = ` Your deposit is on file and can be transferred to a future booking — just rebook with us anytime and mention your deposit credit.`
          }
        } else if (policy === 'refundable') {
          depositMsg = ` Your deposit refund request has been sent to ${business.business_name} — they'll process it within 2-3 business days.`
          // Flag for dashboard priority refund action
          await sbCancel.from('appointments').update({
            refund_requested: true,
            refund_requested_at: new Date().toISOString()
          }).eq('id', apptToCancel.id)
        }
      }

      // Notify waitlist if someone is waiting for this slot
      if (apptToCancel) {
        const waiters = await db.getWaitlistForSlot(business.id, apptToCancel.appointment_date, apptToCancel.appointment_time)
        if (waiters.length > 0) {
          const waiter = waiters[0]
          // Lock the slot for 30 minutes for the waiter
          const holdExpires = new Date(Date.now() + 30 * 60 * 1000).toISOString()
          const sbWait = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
          await sbWait.from('waitlist').update({ slot_held_until: holdExpires }).eq('id', waiter.id)
          await sendSMS(business.sms_number, waiter.customer_phone,
            `Great news! A spot just opened up at ${business.business_name} on ${formatDate(apptToCancel.appointment_date)} at ${formatTime(apptToCancel.appointment_time)}. We're holding it for you for 30 minutes — just text back to claim it! 🎉`
          )
          console.log(`[Waitlist] Notified ${waiter.customer_phone} — slot held 30min`)
        }
      }
      // Stash any deposit refund/credit message for server-side append.
      // Same reasoning as create_appointment — don't expose to LLM where it
      // could end up duplicated in the reply.
      if (depositMsg) {
        session.pendingAppends = (session.pendingAppends || '') + depositMsg
      }
      return { success: true }
    }

    // 🔒 v191: customer-facing reminders. "Remind me in 5 mins to book" used to
    // get "I can't set reminders" — the bot now owns this. Stored in the shared
    // reminders table with kind='customer' and texted by the scheduler sweep.
    case 'set_reminder': {
      const what = String(input.what || '').trim().slice(0, 300) || 'what we talked about'
      const tz = business.timezone || 'America/New_York'
      let when = null

      if (input.minutes_from_now !== undefined && input.minutes_from_now !== null && !isNaN(Number(input.minutes_from_now))) {
        const mins = Math.min(Math.max(Number(input.minutes_from_now), 1), 60 * 24 * 90)
        when = new Date(Date.now() + mins * 60 * 1000)
      } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(input.remind_at_local || '').trim())) {
        when = localToUtcTZ(String(input.remind_at_local).trim(), tz)
      }

      if (!when || isNaN(when.getTime())) {
        return { success: false, error: 'Could not work out that time. Ask them when they would like the reminder.' }
      }
      if (when.getTime() < Date.now() - 60 * 1000) {
        return { success: false, error: 'That time is in the past. Ask them for a future time.' }
      }
      if (when.getTime() > Date.now() + 90 * 24 * 3600 * 1000) {
        return { success: false, error: 'Reminders can only be set up to 90 days out.' }
      }

      const sbRem = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

      // Cap pending reminders per customer so nobody can queue up a flood.
      const { count: pending } = await sbRem.from('owner_reminders')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business.id).eq('to_phone', customerPhone)
        .is('sent_at', null).is('cancelled_at', null)
      if ((pending || 0) >= 3) {
        return { success: false, error: 'They already have 3 reminders pending. Tell them that warmly and offer to just book now instead.' }
      }

      const { error } = await sbRem.from('owner_reminders').insert({
        business_id: business.id,
        kind: 'customer',
        to_phone: customerPhone,
        message: what,
        remind_at: when.toISOString()
      })
      if (error) {
        console.error('[Reminder] insert failed:', error.message)
        return { success: false, error: 'Could not save the reminder. Offer to book them now instead.' }
      }

      const label = when.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })
      console.log(`[Reminder] Customer reminder for ${customerPhone} at ${when.toISOString()} — "${what}"`)
      return { success: true, remind_at_label: label, what, confirmation: `Reminder set for ${label}` }
    }

    case 'add_to_waitlist': {
      // 🔒 v191 DEMO MODE — same rule as create_appointment: nothing written.
      if (business.demo_mode) {
        console.log(`[Demo] Simulated waitlist add for ${customerPhone}`)
        return { success: true, demo: true }
      }
      await db.addToWaitlist({
        business_id: business.id,
        customer_phone: customerPhone,
        customer_name: input.customer_name || null,
        service_name: input.service_name || null,
        preferred_date: input.preferred_date,
        preferred_time: input.preferred_time || null
      })
      return { success: true }
    }

    case 'save_customer_email': {
      const email = input.email?.trim()
      if (!email) return { error: 'No email provided' }

      // Update customer record
      const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      await sb.from('customers').update({ email }).eq('business_id', business.id).eq('phone', customerPhone)

      // Also update the most recent appointment with this email
      const { data: recentAppt } = await sb.from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .eq('customer_phone', customerPhone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (recentAppt) {
        await sb.from('appointments').update({ customer_email: email }).eq('id', recentAppt.id)

        // Send confirmation email
        sendCustomerConfirmationEmail({
          customerEmail: email,
          customerName: recentAppt.customer_name || 'there',
          businessName: business.business_name,
          serviceName: recentAppt.service_name || 'Appointment',
          appointmentDate: recentAppt.appointment_date,
          appointmentTime: recentAppt.appointment_time,
          smsNumber: business.sms_number
        }).catch(err => console.error('[Email] Post-booking confirmation failed:', err.message))
      }

      return { success: true, message: `Email saved and confirmation sent to ${email}` }
    }

    default:
      return { error: 'Unknown tool' }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
// ── Escalation detection ──────────────────────────────────────────────────────
const ESCALATION_TRIGGERS = [
  'speak to someone', 'speak with someone', 'talk to someone', 'talk to a person',
  'real person', 'human', 'manager', 'owner', 'supervisor',
  'urgent', 'emergency', 'asap', 'right away', 'immediately',
  'complaint', 'complain', 'unhappy', 'not happy', 'frustrated', 'angry', 'upset',
  'refund', 'charge', 'billing', 'overcharged', 'wrong charge',
  'sue', 'lawyer', 'legal', 'report you',
  'this is ridiculous', 'unacceptable', 'terrible', 'horrible', 'worst'
]

function detectEscalation(text) {
  const lower = text.toLowerCase()
  return ESCALATION_TRIGGERS.find(trigger => lower.includes(trigger)) || null
}

// Detect whether the customer is actually trying to book (vs. just saying hi or
// asking a general question). Used to gate the pre-qualification flow so it
// doesn't fire screening questions on a bare greeting. Intent is present if the
// message has booking-related signals OR the conversation already has history
// (i.e. they've been greeted and are continuing toward a booking).
function detectBookingIntent(text, session) {
  const lower = (text || '').toLowerCase()
  // Intent is determined SOLELY by the customer's current message. We do NOT
  // scan conversation history:
  //   - total message count fails for returning customers (history pre-loaded)
  //   - scanning the last assistant message fails too, because booking
  //     confirmations and the screening prompt itself contain words like
  //     "booking"/"check availability", creating a feedback loop where every
  //     later "Hi" re-triggers screening. (Entry 20.)
  // A customer who is mid-screening is handled separately: once the flow has
  // started, runQualificationFlow continues it via qState.step >= 1 regardless
  // of this function. So a bare greeting simply has no booking intent.
  const bookingSignals = [
    'book', 'appointment', 'appt', 'schedule', 'availab', 'opening', 'slot',
    'reserve', 'come in', 'get in', 'haircut', 'fade', 'trim',
    'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
    'saturday', 'sunday', 'next week', 'this week',
    'consult', 'how much', 'price', 'cost', 'do you have',
    'when can', 'what time', 'available', 'wanna come', 'want to come',
    'get an appointment', 'set up', 'sign up'
  ]
  return bookingSignals.some(s => lower.includes(s))
}

// Capture ALL transient flow state in one place so no save can drop a field.
// Every upsertSession call passes sessionStateOf(session). See Entry 23/26.
function sessionStateOf(session) {
  return {
    intake: session.intake || null,
    qualification: session.qualification || null,
    pendingIntake: session.pendingIntake || null,
    pendingBooking: session.pendingBooking || null,
    lastAppointmentId: session.lastAppointmentId || null
  }
}

async function handleIncomingMessage({ business, customerPhone, incomingText, mediaUrls = [] }) {
  // Get today in the business's timezone (not server UTC)
  const tz = business.timezone || 'America/New_York'
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }) // en-CA gives YYYY-MM-DD format

  // Load full business profile (services, FAQs, blocked dates)
  const profile = await db.getBusinessProfile(business.id)

  // ── No services configured yet — capture as pending lead ─────────────────
  if (profile.services.length === 0) {
    const sbLead = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    // Save pending lead
    await sbLead.from('pending_leads').upsert({
      business_id: business.id,
      customer_phone: customerPhone,
      message: incomingText,
      created_at: new Date().toISOString()
    }, { onConflict: 'business_id,customer_phone' })
    console.log(`[PendingLead] Saved ${customerPhone} for ${business.business_name}`)
    return `Hey! We'd love to help you book — we're just finishing up our setup. Leave your name and what you're looking for and we'll reach out to you as soon as we're ready! 😊`
  }

  // Check if this is a returning customer — look up their name from previous bookings
  const returningCustomer = await db.getCustomerByPhone(business.id, customerPhone)
  if (returningCustomer) {
    console.log(`[Bot] Returning customer: ${returningCustomer.customer_name} (${customerPhone})`)
  }

  // Load or init conversation session
  let session = await db.getSession(business.id, customerPhone) || {
    messages: [],
    lastAppointmentId: null
  }

  // ── Check if customer is responding to a quote ────────────────────────────
  const sbQuote = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { data: quotedAppt } = await sbQuote.from('appointments')
    .select('*').eq('business_id', business.id).eq('customer_phone', customerPhone)
    .eq('status', 'quote_sent').order('created_at', { ascending: false }).limit(1)
    .maybeSingle()

  if (quotedAppt) {
    const lower = incomingText.toLowerCase()

    // Don't auto-accept if the customer is asking a question about the quote
    const isQuestion = lower.includes('?') || lower.includes('what') || lower.includes('how much') || lower.includes('price') || lower.includes('quote') || lower.includes('cost') || lower.includes('detail') || lower.includes('tell me') || lower.includes('remind me')

    // Don't auto-accept if customer is talking about dates/scheduling (likely rebooking)
    const isScheduling = lower.includes('monday') || lower.includes('tuesday') || lower.includes('wednesday') || lower.includes('thursday') || lower.includes('friday') || lower.includes('saturday') || lower.includes('sunday') || lower.includes('next week') || lower.includes('tomorrow') || lower.includes('reschedule') || lower.includes('different day') || lower.includes('new date') || lower.includes('let\'s do')

    const isYes = !isQuestion && !isScheduling && ['yes','yeah','yep','yeap','yea','yup','sure','ok','okay','sounds good','let\'s do it','book it','confirm','absolutely','definitely','yes please','deal','perfect','go ahead','do it','i\'m in','im in','let\'s go','lets go'].some(w => lower.includes(w))
    const isNo = !isQuestion && !isScheduling && ['no','nope','nah','not right now','too much','cancel','nevermind','never mind','pass'].some(w => lower.includes(w))

    if (isYes) {
      // 🔒 PROTECTED — Quote acceptance must trigger deposit if service requires one.
      // 🔒 See PROTECTED_DECISIONS.md Entry 13. Without this, quote-accepted bookings
      // 🔒 skip the deposit flow entirely (bug pre-2026-05-29).

      // Look up the service to know if it requires a deposit.
      // Use multiple matching strategies because service name in the appointment row
      // may have minor differences from the canonical service.name (extra spaces,
      // apostrophe normalization, case, etc). Log the result so a future lookup miss
      // shows clearly in Render logs.
      const apptServiceName = (quotedAppt.service_name || '').trim().toLowerCase()
      const norm = s => String(s || '').trim().toLowerCase().replace(/['\u2019]/g, "'").replace(/\s+/g, ' ')
      const apptNorm = norm(apptServiceName)
      let matchedService = (profile.services || []).find(s => norm(s.name) === apptNorm) || null
      if (!matchedService) {
        // Try a relaxed match — appointment name contains service name or vice versa
        matchedService = (profile.services || []).find(s => {
          const sn = norm(s.name)
          return sn && (apptNorm.includes(sn) || sn.includes(apptNorm))
        }) || null
        if (matchedService) console.log(`[QuoteAccept] Service matched via relaxed lookup: appt="${apptServiceName}" matched="${matchedService.name}"`)
      }
      if (!matchedService) {
        console.log(`[QuoteAccept] No service match for appt service_name="${apptServiceName}". Available: ${(profile.services || []).map(s => s.name).join(' | ')}`)
      }

      // Try to create a deposit (helper handles all the edge cases:
      // no Stripe = skip, no deposit_amount = skip, customer credit = apply, etc.)
      const depositResult = await tryCreateDepositForAppointment({
        business,
        appointment: quotedAppt,
        service: matchedService,
        customerPhone,
        customerName: quotedAppt.customer_name,
        returningCustomer
      })

      // If deposit was required and successfully created, the helper has
      // already set status to deposit_pending. Otherwise we mark confirmed.
      if (!depositResult.depositCreated) {
        await sbQuote.from('appointments').update({ status: 'confirmed' }).eq('id', quotedAppt.id)
      }

      const firstName = quotedAppt.customer_name?.split(' ')[0] || 'there'
      const baseReply = depositResult.depositCreated
        ? `Great news, ${firstName}! Just need to lock in your ${quotedAppt.service_name} on ${quotedAppt.appointment_date}${quotedAppt.appointment_time ? ' at ' + quotedAppt.appointment_time : ''} with a deposit.`
        : `Amazing! You're all booked for ${quotedAppt.service_name} on ${quotedAppt.appointment_date}${quotedAppt.appointment_time ? ' at ' + quotedAppt.appointment_time : ''}. We can't wait to see you! 😊`

      // 🔒 PROTECTED — Append meeting link for virtual businesses (see Entry 15).
      // Same guarantee as the create_appointment flow: server-controlled append
      // so the LLM can never forget.
      let meetingText = ''
      if (business.location_type === 'virtual' && business.meeting_link) {
        meetingText = `\n\n🎥 Join via video: ${business.meeting_link}`
      }

      // depositResult.depositText is either:
      //   - the "$X deposit due, pay here: [link]" instructions (deposit created)
      //   - the "Your $X credit has been applied" message (credit was applied)
      //   - empty string (no deposit required)
      const reply = baseReply + meetingText + (depositResult.depositText || '')

      session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
      session.messages.push({ role: 'assistant', content: reply })
      await db.upsertSession(business.id, customerPhone, session.messages, quotedAppt.id)
      return reply
    }

    if (isNo) {
      await sbQuote.from('appointments').update({ status: 'cancelled' }).eq('id', quotedAppt.id)
      const reply = `No problem at all! Feel free to reach out anytime if you change your mind or have any questions. 😊`
      session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
      session.messages.push({ role: 'assistant', content: reply })
      await db.upsertSession(business.id, customerPhone, session.messages, session.lastAppointmentId, sessionStateOf(session))
      return reply
    }
  }

  // ── Check if customer is responding to an appointment REMINDER ────────────
  // 🔒 PROTECTED — See PROTECTED_DECISIONS.md Entry 17. Reminders say "Reply YES
  // 🔒 to confirm or NO to cancel." Without this block, a bare "YES" reaches the
  // 🔒 LLM with no context and it guesses the customer wants to BOOK something,
  // 🔒 running check_availability and offering slots — very confusing. This
  // 🔒 intercepts short YES/NO replies when the customer has a recently-reminded
  // 🔒 upcoming appointment and treats them as confirm/cancel, not booking.
  {
    const lowerRaw = incomingText.trim().toLowerCase()
    // Only treat as a reminder reply if the WHOLE message is essentially just
    // yes/no — not "yes I'd like to book another". Keep this strict to avoid
    // hijacking real booking intent.
    const isShortYes = ['yes','y','yeah','yep','yea','yup','sure','ok','okay','confirm','confirmed','yes please','sounds good','👍','✅'].includes(lowerRaw)
    const isShortNo  = ['no','n','nope','nah','cancel','cancel it','no thanks'].includes(lowerRaw)

    if (isShortYes || isShortNo) {
      // Look for an upcoming confirmed appointment for this customer. We do NOT
      // require reminder_sent=true: a customer may reply YES/NO to a booking
      // confirmation, not just a reminder. Any soonest upcoming confirmed appt
      // is the one they're responding about.
      const sbRem = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      const { data: remindedAppt } = await sbRem.from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .eq('customer_phone', customerPhone)
        .in('status', ['confirmed', 'deposit_pending'])
        .gte('appointment_date', today)
        .order('appointment_date', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (remindedAppt) {
        if (isShortYes) {
          // Confirm — no booking action needed, the appointment is already confirmed.
          let reply = `Perfect, you're all set! See you ${formatDate(remindedAppt.appointment_date)} at ${formatTime(remindedAppt.appointment_time)}. 😊`
          if (business.location_type === 'virtual' && business.meeting_link) {
            reply += `\n\n🎥 Join via video: ${business.meeting_link}`
          }
          session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
          session.messages.push({ role: 'assistant', content: reply })
          await db.upsertSession(business.id, customerPhone, session.messages, remindedAppt.id)
          console.log(`[Reminder-Confirm] ${customerPhone} confirmed appt ${remindedAppt.id}`)
          return reply
        } else {
          // Cancel the appointment — and VERIFY it actually changed. Previously
          // we told the customer "cancelled" without checking the update landed,
          // so a silently-failed update produced a false confirmation.
          const { data: cancelledRows, error: cancelErr } = await sbRem.from('appointments')
            .update({ status: 'cancelled' })
            .eq('id', remindedAppt.id)
            .select()

          if (cancelErr || !cancelledRows || cancelledRows.length === 0) {
            console.error(`[Reminder-Confirm] CANCEL FAILED for appt ${remindedAppt.id}:`, cancelErr?.message || 'no rows updated')
            const failReply = `I'm having trouble cancelling that right now. I've flagged it for ${business.business_name} so they can take care of it — sorry about that!`
            // Flag for owner so it doesn't fall through the cracks
            await db.flagSession(business.id, customerPhone, `Cancellation FAILED via reminder reply — appt ${remindedAppt.id} on ${remindedAppt.appointment_date}. Needs manual cancel.`).catch(() => {})
            session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
            session.messages.push({ role: 'assistant', content: failReply })
            await db.upsertSession(business.id, customerPhone, session.messages, session.lastAppointmentId, sessionStateOf(session))
            return failReply
          }

          console.log(`[Reminder-Confirm] ${customerPhone} cancelled appt ${remindedAppt.id} (verified)`)

          // Notify owner of the cancellation
          if (shouldSendNotification(business, 'cancellation_sms') || shouldSendNotification(business, 'cancellation_email')) {
            sendEscalationNotification({
              ownerEmail: shouldSendNotification(business, 'cancellation_email') ? business.email : null,
              ownerPhone: shouldSendNotification(business, 'cancellation_sms') ? business.owner_phone : null,
              businessName: business.business_name,
              smsNumber: business.sms_number,
              customerPhone,
              customerMessage: `Cancelled via reminder reply: ${remindedAppt.service_name || 'appointment'} on ${remindedAppt.appointment_date}`,
              trigger: 'cancellation'
            }).catch(err => console.error('[Notify] Cancellation notification failed:', err.message))
          }
          const reply = `No problem — I've cancelled your appointment on ${formatDate(remindedAppt.appointment_date)}. If you'd like to rebook, just let me know! 😊`
          session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
          session.messages.push({ role: 'assistant', content: reply })
          await db.upsertSession(business.id, customerPhone, session.messages, session.lastAppointmentId, sessionStateOf(session))
          return reply
        }
      }
    }
  }

  // ── Check for escalation triggers ─────────────────────────────────────────
  const escalationTrigger = detectEscalation(incomingText)
  if (escalationTrigger) {
    console.log(`[Escalation] Triggered by "${escalationTrigger}" from ${customerPhone}`)
    await db.flagSession(business.id, customerPhone, `Customer said: "${incomingText}"`)
    if (shouldSendNotification(business, 'escalation_email') || shouldSendNotification(business, 'escalation_sms')) {
      sendEscalationNotification({
        ownerEmail: shouldSendNotification(business, 'escalation_email') ? business.email : null,
        ownerPhone: shouldSendNotification(business, 'escalation_sms') ? business.owner_phone : null,
        businessName: business.business_name,
        smsNumber: business.sms_number,
        customerPhone,
        customerMessage: incomingText,
        trigger: escalationTrigger
      }).catch(err => console.error('[Notify] Escalation notification failed:', err.message))
    }
    // Native app push (additive; no-op until Firebase is configured)
    try { require('../utils/push').pushEscalation(business, { customerPhone, customerMessage: incomingText, trigger: escalationTrigger }).catch(() => {}) } catch (e) {}
    const reply = `I completely understand, and I want to make sure you get the help you need. I've flagged this for ${business.business_name} and someone will reach out to you directly as soon as possible. We appreciate your patience. 🙏`
    session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
    session.messages.push({ role: 'assistant', content: reply })
    await db.upsertSession(business.id, customerPhone, session.messages, session.lastAppointmentId, sessionStateOf(session))
    return reply
  }

  // ── Pro: Intake forms flow (runs after a booking flagged pendingIntake) ────
  // 🔒 PROTECTED — See PROTECTED_DECISIONS.md Entry 18. This is the call that
  // 🔒 was previously MISSING — runIntakeFlow existed but nothing invoked it,
  // 🔒 so intake forms never reached customers. Fires after a confirmed booking.
  if (session.pendingIntake) {
    const { appointmentId, serviceId, isReturning } = session.pendingIntake
    console.log(`[Intake-Flow] pendingIntake PRESENT appt=${appointmentId} step=${session.intake?.step}/${session.intake?.questionList?.length || '?'} beforeBooking=${!!session.pendingIntake.beforeBooking} hasPendingBooking=${!!session.pendingBooking} msg="${incomingText}"`)
    const intakeReply = await runIntakeFlow(
      business, customerPhone, appointmentId, incomingText, session, serviceId, isReturning
    )
    console.log(`[Intake-Flow] runIntakeFlow returned ${intakeReply === null ? 'NULL (complete or no-forms)' : 'a question'} | intake.complete=${session.intake?.complete}`)
    if (intakeReply !== null) {
      // Still asking questions
      session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
      session.messages.push({ role: 'assistant', content: intakeReply })
      await db.upsertSession(business.id, customerPhone, session.messages, session.lastAppointmentId, sessionStateOf(session))
      return intakeReply
    }
    // intakeReply === null means either no forms applied OR the flow just
    // completed. If the flow completed (session.intake.complete), clear the
    // pendingIntake flag and the intake state so it doesn't re-trigger.
    if (session.intake?.complete) {
      // ── Case A: a booking was HELD pending intake (intake-before-booking) ──
      // Now that all questions are answered, actually create the appointment.
      if (session.pendingBooking) {
        const heldInput = session.pendingBooking.input
        const intakeResponses = { ...(session.intake?.responses || {}) }
        console.log(`[Intake-Gate] Intake complete — now creating the held booking for ${customerPhone}`)
        // Mark so the gate is skipped on this re-invocation, and clear the hold.
        session.intakeAlreadyRun = true
        session.pendingBooking = null
        // Keep intake.complete = true so the gate's `!session.intake?.complete`
        // check short-circuits. Execute the actual booking.
        const bookResult = await executeTool('create_appointment', heldInput, {
          business, profile, customerPhone, session, returningCustomer, mediaUrls
        })
        // Save the intake responses against the newly created appointment.
        if (bookResult?.appointment_id) {
          try {
            const sbIR = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
            await sbIR.from('intake_responses').insert({
              business_id: business.id, customer_phone: customerPhone,
              appointment_id: bookResult.appointment_id, responses: intakeResponses
            })
          } catch (e) { console.error('[Intake-Gate] saving responses failed:', e.message) }
        }
        // Clear intake state now that we're done.
        session.intake = null
        delete session.pendingIntake
        session.intakeAlreadyRun = false
        // Build the confirmation reply. create_appointment stashed deposit/zoom on
        // pendingAppends; flush it here.
        let reply = `Perfect, thank you! 🎉 You're all booked for your ${heldInput.service_name || 'appointment'} on ${heldInput.date}${heldInput.time ? ' at ' + formatTime(heldInput.time) : ''}.`
        if (session.pendingAppends) { reply += session.pendingAppends; session.pendingAppends = '' }
        session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
        session.messages.push({ role: 'assistant', content: reply })
        await db.upsertSession(business.id, customerPhone, session.messages, session.lastAppointmentId, { intake: null, qualification: session.qualification || null, pendingIntake: null, lastAppointmentId: session.lastAppointmentId || null })
        return reply
      }

      // ── Case B: legacy book-first flow (deposit deferred until after intake) ──
      let deferredDeposit = session.pendingIntake?.depositTextAfterIntake || ''
      const completedApptId = session.pendingIntake?.appointmentId || appointmentId
      if (!deferredDeposit && completedApptId) {
        try {
          const sbDep = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
          const { data: apptDep } = await sbDep.from('appointments')
            .select('deposit_text, deposit_status').eq('id', completedApptId).maybeSingle()
          if (apptDep?.deposit_status === 'pending' && apptDep?.deposit_text) {
            deferredDeposit = apptDep.deposit_text
            console.log(`[Intake-Flow] recovered deferred deposit from appointment row`)
          }
        } catch (e) { console.error('[Intake-Flow] deposit fallback lookup failed:', e.message) }
      }
      delete session.pendingIntake
      session.intake = null
      const thanksReply = `Perfect, thank you! You're all set.${deferredDeposit ? '' : ' See you soon! 😊'}${deferredDeposit}`
      session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })
      session.messages.push({ role: 'assistant', content: thanksReply })
      await db.upsertSession(business.id, customerPhone, session.messages, session.lastAppointmentId, sessionStateOf(session))
      return thanksReply
    }
    // No forms applied at all — clear the flag and fall through to normal flow.
    delete session.pendingIntake
  }

  // Pre-qualification flow REMOVED (2026-06-08) — intake forms serve this purpose.
  // See PROTECTED_DECISIONS.md Entry 30.

  // Add customer message
  session.messages.push({ role: 'user', content: incomingText, media: mediaUrls.length ? mediaUrls : undefined })

  // Keep history bounded
  if (session.messages.length > 30) {
    session.messages = session.messages.slice(-30)
  }

  const systemPrompt = buildSystemPrompt(business, profile, today, returningCustomer)
  const messagesForAPI = session.messages.map(m => ({ role: m.role, content: m.content }))
  let finalResponse = null
  let loopCount = 0

  while (loopCount < 5) {
    loopCount++

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      tools,
      messages: messagesForAPI
    })

    if (response.stop_reason === 'tool_use') {
      messagesForAPI.push({ role: 'assistant', content: response.content })

      const toolResults = []
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[Tool] ${business.business_name} · ${block.name}`, JSON.stringify(block.input))
          const result = await executeTool(block.name, block.input, {
            business, profile, customerPhone, session, returningCustomer, mediaUrls
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          })
        }
      }
      messagesForAPI.push({ role: 'user', content: toolResults })
      continue
    }

    const textBlock = response.content.find(b => b.type === 'text')
    finalResponse = textBlock?.text || "Sorry, I didn't catch that. Could you try again?"

    // 🔒 PROTECTED — Deposit info auto-append. See PROTECTED_DECISIONS.md Entry 4.
    // Server-controlled append: any tool that needs to add exact text (deposit
    // instructions, refund confirmations) stashes it on session.pendingAppends
    // during execution. We append it here, then clear so it doesn't leak into
    // a future turn. The LLM never sees this text in its tool result, so it
    // cannot duplicate it in its own reply — which is what was causing the
    // deposit info to show up twice. DO NOT move deposit_text into tool
    // results "for clarity" — that re-introduces the duplicate-deposit bug.
    if (session.pendingAppends) {
      finalResponse += session.pendingAppends
      session.pendingAppends = ''
    }

    session.messages.push({ role: 'assistant', content: finalResponse })
    break
  }

  // Save session
  await db.upsertSession(business.id, customerPhone, session.messages, session.lastAppointmentId, sessionStateOf(session))

  return finalResponse
}

module.exports = { handleIncomingMessage }
