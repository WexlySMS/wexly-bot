const express = require('express')
const router = express.Router()
const twilio = require('twilio')
const db = require('../db/client')
const { handleIncomingMessage } = require('../bot/conversationEngine')

// ── Webhook deduplication — prevent Twilio retries from double-processing ─────
const processedSids = new Map()
const SID_TTL = 5 * 60 * 1000 // 5 minutes

function isDuplicate(sid) {
  if (!sid) return false
  const now = Date.now()
  for (const [key, ts] of processedSids.entries()) {
    if (now - ts > SID_TTL) processedSids.delete(key)
  }
  if (processedSids.has(sid)) return true
  processedSids.set(sid, now)
  return false
}

// ── Message debouncer ────────────────────────────────────────────────────────
// Many customers send multiple short texts in a row instead of one long one:
//   "Hi"
//   "I want to book"
//   "A haircut tomorrow"
//   "At 2pm"
// Without debouncing, each text triggers its own LLM call, the bot replies 4
// times, race conditions can scramble the order of responses, and we pay 4x
// the Anthropic API + Twilio costs. With debouncing, we wait briefly after
// EACH text — if more arrive within the window, we reset the timer. Only when
// the customer pauses do we combine everything into ONE message and process it.
//
// Tuning (Brandon's call: "rather wait 10s than have race conditions"):
//   DEBOUNCE_MS — how long to wait after each text before processing
//   DEBOUNCE_MAX_MS — hard cap so we don't wait forever if someone keeps typing
const DEBOUNCE_MS = 5000      // 5s — long enough to catch rapid texters
const DEBOUNCE_MAX_MS = 15000 // 15s — cap so chatty customers eventually get a reply
const pendingMessages = new Map() // key: `${business_id}|${customer_phone}` → {texts, mediaUrls, timer, firstQueuedAt, toNumber}

function debouncedProcess(business, customerPhone, toNumber, incomingText, mediaUrls) {
  const key = `${business.id}|${customerPhone}`
  const existing = pendingMessages.get(key)
  const now = Date.now()

  if (existing) {
    // Append to existing queue
    existing.texts.push(incomingText)
    if (mediaUrls?.length) existing.mediaUrls.push(...mediaUrls)
    clearTimeout(existing.timer)

    // If we've been waiting near the max cap, process now instead of resetting
    const elapsed = now - existing.firstQueuedAt
    const remaining = DEBOUNCE_MAX_MS - elapsed
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, remaining))
    console.log(`[Debounce] ${customerPhone} — queued text #${existing.texts.length}, waiting ${delay}ms (elapsed: ${elapsed}ms)`)
    existing.timer = setTimeout(() => flushDebounced(key), delay)
  } else {
    // Start a new queue
    const entry = {
      texts: [incomingText],
      mediaUrls: mediaUrls?.length ? [...mediaUrls] : [],
      firstQueuedAt: now,
      toNumber,
      business,
      customerPhone,
      timer: null
    }
    entry.timer = setTimeout(() => flushDebounced(key), DEBOUNCE_MS)
    pendingMessages.set(key, entry)
    console.log(`[Debounce] ${customerPhone} — started queue, waiting ${DEBOUNCE_MS}ms`)
  }
}

// Cancel any pending debounced messages for this customer. Called when the
// regular bot reply would be wrong (STOP opt-out, check-in already handled,
// owner override, manual mode just activated, etc).
function cancelDebounced(businessId, customerPhone) {
  const key = `${businessId}|${customerPhone}`
  const entry = pendingMessages.get(key)
  if (entry) {
    clearTimeout(entry.timer)
    pendingMessages.delete(key)
    console.log(`[Debounce] Cancelled ${entry.texts.length} queued text(s) for ${customerPhone}`)
  }
}

async function flushDebounced(key) {
  const entry = pendingMessages.get(key)
  if (!entry) return
  pendingMessages.delete(key) // remove first so new texts arriving DURING processing start a fresh queue

  const { business, customerPhone, toNumber, texts, mediaUrls } = entry
  // Combine all queued texts into one message. Use a newline so the LLM sees
  // them as the customer's sequenced thoughts rather than one run-on sentence.
  const combinedText = texts.join('\n')
  console.log(`[Debounce] ${customerPhone} — flushing ${texts.length} text(s) for ${business.business_name}: "${combinedText.slice(0, 120)}${combinedText.length > 120 ? '...' : ''}"`)

  try {
    // Re-check bot state at processing time — could have changed during the
    // debounce window (owner paused the bot, customer opted out, etc.)
    const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

    // Fresh business row in case active/status changed mid-debounce
    const { data: freshBiz } = await sb.from('businesses').select('active, status').eq('id', business.id).maybeSingle()
    const blockedStatus = ['cancelled', 'past_due', 'pending_checkout', 'trial_expired'].includes(freshBiz?.status)
    // 🔒 v191: the public demo number ignores billing status — ads point at it,
    // it can never go quiet because a test account lapsed.
    if (!freshBiz || (blockedStatus && !business.demo_mode) || freshBiz.active === false) {
      console.log(`[Debounce] ${customerPhone} — bot inactive (status: ${freshBiz?.status || 'missing'}) for ${business.business_name}, dropping queued messages`)
      return
    }

    // Re-check manual mode in case owner took over during the window
    const { data: session } = await sb
      .from('conversation_sessions')
      .select('manual_mode, manual_mode_until')
      .eq('business_id', business.id)
      .eq('customer_phone', customerPhone)
      .maybeSingle()
    if (session?.manual_mode && (!session.manual_mode_until || new Date() < new Date(session.manual_mode_until))) {
      console.log(`[Debounce] ${customerPhone} — manual mode active, saving message but NOT auto-replying`)
      // Still persist the customer's message so the owner sees it in the thread.
      try {
        const { data: full } = await sb.from('conversation_sessions')
          .select('messages').eq('business_id', business.id).eq('customer_phone', customerPhone).maybeSingle()
        const msgs = Array.isArray(full?.messages) ? full.messages : []
        msgs.push({ role: 'user', content: combinedText, media: mediaUrls.length ? mediaUrls : undefined, timestamp: new Date().toISOString() })
        await sb.from('conversation_sessions').upsert({
          business_id: business.id,
          customer_phone: customerPhone,
          messages: msgs,
          last_activity: new Date().toISOString()
        }, { onConflict: 'business_id,customer_phone' })
      } catch (saveErr) {
        console.error('[Debounce] manual-mode message save failed:', saveErr.message)
      }
      return
    }

    const reply = await handleIncomingMessage({
      business,
      customerPhone,
      incomingText: combinedText,
      mediaUrls
    })

    if (reply) {
      await sendSMS(toNumber, customerPhone, reply)
      console.log(`[SMS] ${toNumber} → ${customerPhone} (debounced ${texts.length} msgs): "${reply?.slice(0, 80)}..."`)
    }
  } catch (err) {
    console.error('[Debounce] Error processing queued messages:', err)
    try {
      await sendSMS(toNumber, customerPhone,
        `Sorry, I'm having a moment! Please try again in a few seconds or call us directly.`
      )
    } catch (sendErr) {
      console.error('[Debounce] Failed to send error message:', sendErr)
    }
  }
}
const { handleInterviewMessage } = require('../bot/setupInterview')
const { handleOwnerMessage, getOwnerWelcome } = require('../bot/ownerCommands')
const { sendSMS } = require('../utils/sms')
require('dotenv').config()

// ── Twilio signature validation ────────────────────────────────────────────────
function validateTwilio(req, res, next) {
  if (process.env.NODE_ENV === 'development') return next()

  const signature = req.headers['x-twilio-signature']
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  )
  if (!valid) {
    console.warn('[Webhook] Invalid Twilio signature — rejected')
    return res.status(403).send('Forbidden')
  }
  next()
}

// ── Incoming SMS ───────────────────────────────────────────────────────────────
router.post('/sms', validateTwilio, async (req, res) => {
  // Always respond to Twilio immediately with empty TwiML
  // (we'll send the reply via API, not TwiML response)
  res.set('Content-Type', 'text/xml')
  res.send('<Response></Response>')

  // Deduplicate — Twilio retries webhooks on slow responses
  const messageSid = req.body.MessageSid || req.body.SmsSid
  if (isDuplicate(messageSid)) {
    console.log(`[SMS] Duplicate webhook ignored — SID: ${messageSid}`)
    return
  }

  const customerPhone = req.body.From
  const incomingText  = req.body.Body?.trim() || ''
  const toNumber      = req.body.To   // which Wexly number was texted
  const numMedia      = parseInt(req.body.NumMedia || '0')
  const mediaUrls     = []
  for (let i = 0; i < numMedia; i++) {
    const url = req.body[`MediaUrl${i}`]
    if (url) mediaUrls.push(url)
  }

  if (!customerPhone || !toNumber) return
  if (!incomingText && mediaUrls.length === 0) return

  console.log(`[SMS] ${toNumber} ← ${customerPhone}: "${incomingText}"`)

  // ── STOP / START handling ───────────────────────────────────────────────
  const upperText = incomingText.trim().toUpperCase()
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(upperText)) {
    const biz = await db.getBusinessBySmsNumber(toNumber)
    if (biz) {
      // Drop any queued texts from this customer — they just opted out, don't
      // let the debounce fire a normal bot reply 5 seconds from now.
      cancelDebounced(biz.id, customerPhone)
      const sbStop = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      await sbStop.from('customers')
        .update({ fully_opted_out: true, opted_out: true })
        .eq('business_id', biz.id).eq('phone', customerPhone)
      console.log(`[STOP] ${customerPhone} fully opted out from ${biz.business_name}`)
    }
    return // Twilio sends the STOP reply automatically
  }

  if (['START', 'UNSTOP'].includes(upperText) || (upperText === 'YES' && !customerPhone)) {
    const biz = await db.getBusinessBySmsNumber(toNumber)
    if (biz) {
      const sbStart = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      // Only re-subscribe if customer is actually opted out
      const { data: cust } = await sbStart.from('customers')
        .select('opted_out, fully_opted_out')
        .eq('business_id', biz.id).eq('phone', customerPhone)
        .maybeSingle()
      if (cust?.opted_out || cust?.fully_opted_out) {
        await sbStart.from('customers')
          .update({ fully_opted_out: false, opted_out: false, marketing_opted_out: false })
          .eq('business_id', biz.id).eq('phone', customerPhone)
        console.log(`[START] ${customerPhone} re-subscribed for ${biz.business_name}`)
        await sendSMS(toNumber, customerPhone,
          `Welcome back! You're all set to receive messages from ${biz.business_name} again. How can we help you? 😊`
        )
        return
      }
      // If not opted out, fall through to normal conversation handling
    }
  }

  if (upperText === 'HELP') {
    const biz = await db.getBusinessBySmsNumber(toNumber)
    if (biz) {
      await sendSMS(toNumber, customerPhone,
        `${biz.business_name} powered by Wexly. Text us to book, reschedule, or ask questions. Reply STOP to unsubscribe. For help: hello@getwexly.com`
      )
    }
    return
  }

  try {
    // Look up which business owns this Twilio number (paused ones too: the
    // owner must always be able to text it, and customers get silence below)
    const business = await db.getBusinessBySmsNumber(toNumber, { includePaused: true })

    if (!business) {
      console.error(`[SMS] No business found for number ${toNumber}`)
      await sendSMS(toNumber, customerPhone,
        "Hi! We received your message but are having some technical difficulties. Please try again in a moment."
      )
      return
    }

    // Check if customer is fully opted out
    if (business.status !== 'cancelled') {
      const sbOptCheck = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      const { data: optedOutCustomer } = await sbOptCheck.from('customers')
        .select('fully_opted_out, opted_out')
        .eq('business_id', business.id)
        .eq('phone', customerPhone)
        .maybeSingle()

      if (optedOutCustomer?.fully_opted_out || optedOutCustomer?.opted_out) {
        await sendSMS(toNumber, customerPhone,
          `Hi! You previously unsubscribed from ${business.business_name} texts. Reply YES to re-enable messages and we'll be happy to help you book. 😊`
        )
        console.log(`[OptOut] ${customerPhone} texted in while opted out — sent re-consent prompt`)
        return
      }
    }

    // 🔒 v190: instant trial ran out with no card. Clients get silence (the
    // owner chose not to continue; we don't speak for them), the owner gets the
    // add-card link no matter what they text. Owner detection is repeated here
    // because the full owner check runs further down.
    if (business.status === 'trial_expired' && !business.demo_mode) {
      const { expiredOwnerReply } = require('../bot/trialOnboarding')
      const senderD = customerPhone?.replace(/\D/g, '')
      const ownerD = (business.owner_phone || '').replace(/\D/g, '')
      const extraOwners = (business.additional_owner_phones || []).map(p => String(p || '').replace(/\D/g, ''))
      const same = (a, b) => a && b && (a === b || a === b.replace(/^1/, '') || ('1' + a) === b)
      const fromOwner = same(ownerD, senderD) || extraOwners.some(p => same(p, senderD))
      if (fromOwner) {
        await sendSMS(toNumber, customerPhone, expiredOwnerReply(business)).catch(() => {})
      } else {
        console.log(`[SMS] ${business.business_name} trial expired — client message from ${customerPhone} dropped`)
      }
      return
    }

    // Check if subscription is still active
    if (business.status === 'cancelled') {
      console.log(`[SMS] Business ${business.business_name} subscription cancelled — notifying customer`)
      await sendSMS(toNumber, customerPhone,
        `Hi! This number is no longer active. Please contact ${business.business_name} directly for assistance.`
      ).catch(() => {})
      return
    }

    // Check if this text is from the business owner during setup interview
    const allOwnerPhones = [business.owner_phone, ...(business.additional_owner_phones || [])].filter(Boolean)
    const senderDigits = customerPhone?.replace(/\D/g, '')
    const isOwnerPhone = allOwnerPhones.some(p => {
      const storedDigits = p?.replace(/\D/g, '')
      return storedDigits && senderDigits && (
        storedDigits === senderDigits ||
        storedDigits === senderDigits.replace(/^1/, '') ||
        ('1' + storedDigits) === senderDigits
      )
    })
    if (isOwnerPhone && ['waiting_start', 'in_progress'].includes(business.interview_state)) {
      const handled = await handleInterviewMessage(business, incomingText)
      if (handled) return
    }

    // ── CHECK-IN DETECTION — customer says they've arrived ──────────────────
    // Run owner detection first so owner texts don't trigger check-in
    const ownerPhone = business.owner_phone?.replace(/\D/g, '')
    const senderPhone = customerPhone?.replace(/\D/g, '')
    const additionalPhones = (business.additional_owner_phones || []).map(p => p?.replace(/\D/g, '')).filter(Boolean)

    const matchesPhone = (stored, incoming) => stored && incoming && (
      stored === incoming ||
      stored === incoming.replace(/^1/, '') ||
      ('1' + stored) === incoming
    )

    const isOwner = matchesPhone(ownerPhone, senderPhone) ||
      additionalPhones.some(p => matchesPhone(p, senderPhone))

    if (!isOwner) {
      const checkInPhrases = ['here', "i'm here", 'im here', 'i am here', 'arrived', 'outside', "i'm outside", 'im outside', 'just arrived', 'just got here', 'parking lot', 'in the parking', 'checked in', 'checking in']
      const lowerMsg = incomingText.toLowerCase().trim()
      const isCheckIn = checkInPhrases.some(p => lowerMsg === p || lowerMsg.startsWith(p + ' ') || lowerMsg.endsWith(' ' + p))

      if (isCheckIn && business.checkin_enabled !== false) {
        const tz = business.timezone || 'America/New_York'
        const today = new Date().toLocaleDateString('en-CA', { timeZone: tz })
        const sb2 = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
        const { data: appt } = await sb2.from('appointments')
          .select('*').eq('business_id', business.id)
          .eq('customer_phone', customerPhone)
          .eq('appointment_date', today)
          .eq('status', 'confirmed')
          .order('appointment_time').limit(1).maybeSingle()

        if (appt) {
          const customerName = appt.customer_name || customerPhone
          const [h, m] = (appt.appointment_time || '00:00').split(':')
          const hr = parseInt(h)
          const timeStr = `${hr > 12 ? hr - 12 : hr || 12}:${m}${hr >= 12 ? 'pm' : 'am'}`

          if (business.owner_phone) {
            await sendSMS(toNumber, business.owner_phone,
              `📍 ${customerName} has arrived for their ${timeStr} ${appt.service_name || 'appointment'}!`
            ).catch(() => {})
          }

          // Cancel any pending debounced texts — they already got the check-in
          // ack, no need for a bot reply 5 seconds from now to whatever else
          // they may have texted before "here".
          cancelDebounced(business.id, customerPhone)

          await sendSMS(toNumber, customerPhone,
            `Thanks ${customerName?.split(' ')[0] || ''}! We know you're here — someone will be right with you 😊`
          )
          console.log(`[Check-in] ${customerName} checked in for ${business.business_name}`)
          return
        }
      }
    }

    // ── OWNER MODE — text from owner's personal cell ────────────────────────

    if (isOwner) {
      // Check if first time owner is texting — send welcome
      const lowerText = incomingText.toLowerCase()
      const isFirstContact = ['hi', 'hey', 'hello', 'help', '?'].includes(lowerText)

      // 🔒 v199: SETUP = free done-for-you setup. Replaces the v190 owner DEMO
      // walkthrough, which was removed (Brandon: "remove demo, I think it's dumb").
      // Owner replies SETUP → asked for their booking link / menu photo → the
      // next owner message carrying a link or photo is captured and forwarded.
      // v207: SETUP (or CONTINUE) with the checklist already started resumes at
      // the open question instead of asking for the link again.
      if (/^\s*(setup|set up|free setup|setup call|continue|resume|finish setup|continue setup)\s*[.!?]?\s*$/i.test(incomingText)) {
        const { setupOfferReply, recordSetupRequest, resumeSetup } = require('../bot/trialOnboarding')
        const resumed = await resumeSetup(business).catch(e => { console.error('[Owner] resume failed:', e.message); return false })
        if (resumed) return
        if (/^\s*(continue|resume|finish setup|continue setup)/i.test(incomingText)) { await sendSMS(toNumber, customerPhone, `Nothing to pick up yet. Reply SETUP and I'll walk you through it.`); return }
        await sendSMS(toNumber, customerPhone, setupOfferReply(business))
        recordSetupRequest(business).catch(e => console.error('[Owner] setup request record failed:', e.message))
        return
      }
      // v206: a calendar link (Google secret address, Apple public calendar,
      // any .ics) is an appointments import, whatever else is going on. Checked
      // before the booking-page import below so it never lands in the site
      // importer as "could not read services from that page".
      try {
        const Cal = require('../utils/calendarImporter')
        const calUrl = Cal.extractCalendarUrl(incomingText)
        if (calUrl) {
          const { handleCalendarInput } = require('../bot/trialOnboarding')
          await handleCalendarInput(business, { url: calUrl, text: incomingText })
          console.log(`[Owner] calendar link from ${business.business_name}`)
          return
        }
      } catch (e) { console.error('[Owner] calendar link check failed:', e.message) }

      // v204/v206: is the bot waiting on an answer from this owner (e.g. "book all
      // imported services instantly?", "text me your calendar link")? A bare
      // yes/no, a link, or screenshots resolve it here instead of reaching the
      // model with no idea what was being agreed to. Runs before the booking-page
      // import so screenshots sent for the bookings step go to the right place.
      try {
        const { handlePendingOwnerReply } = require('../bot/trialOnboarding')
        const pendingReply = await handlePendingOwnerReply(business, incomingText, mediaUrls)
        if (pendingReply) { if (pendingReply !== '__sent__') await sendSMS(toNumber, customerPhone, pendingReply); console.log(`[Owner] Pending question answered for ${business.business_name}`); return }
      } catch (e) { console.error('[Owner] pending reply check failed:', e.message) }

      // v206: screenshots of a calendar outside the setup step ("here's next
      // week", "add these appointments"). Photos with no words and no open
      // question still go to the setup-source path below (menu photo).
      if (mediaUrls && mediaUrls.length && /\b(calendar|schedule|appointments?|bookings?|booked|clients?|week|import|add these|here'?s)\b/i.test(incomingText)) {
        const { handleCalendarInput } = require('../bot/trialOnboarding')
        await handleCalendarInput(business, { mediaUrls, text: incomingText })
        console.log(`[Owner] calendar screenshots from ${business.business_name}`)
        return
      }

      {
        const ob = business.onboarding || {}
        const looksLikeSource = /https?:\/\/|\.(com|net|co|io|app|biz|salon|beauty)\b/i.test(incomingText) || (mediaUrls && mediaUrls.length)
        const urlMatch = (incomingText.match(/https?:\/\/\S+|\b[a-z0-9.-]+\.(?:com|net|co|io|app|biz|salon|beauty)\b\S*/i) || [])[0]
        // v204: a link on its own ("here's my page: glossgenius.com/emily") is an
        // import request whether or not they typed SETUP first. The welcome text
        // invites exactly that, so it can't land on the model as a shrug.
        const bareLink = !!urlMatch && !/getwexly\.com/i.test(urlMatch) && incomingText.replace(urlMatch, '').replace(/[^a-z0-9]/gi, '').length <= 30
        const inSetupFlow = ob.setup_requested_at && !ob.setup_source_at && looksLikeSource
        if (inSetupFlow || bareLink) {
          const { recordSetupSource, setupSourceAck, runAutoImport } = require('../bot/trialOnboarding')
          const { normalizeUrl } = require('../utils/siteImporter')
          const srcUrl = normalizeUrl(urlMatch)
          const fallback = inSetupFlow
            ? () => sendSMS(toNumber, customerPhone, setupSourceAck(business))
            : () => sendSMS(toNumber, customerPhone, `I could not read services from that page. Reply SETUP and we will set it up for you, or text me your services and prices and I will add them.`)
          await sendSMS(toNumber, customerPhone, srcUrl ? `Got it, reading your page now. Give me a minute.` : setupSourceAck(business))
          if (inSetupFlow) recordSetupSource(business, incomingText, mediaUrls).catch(e => console.error('[Owner] setup source record failed:', e.message))
          // v203: a link gets imported on the spot; if nothing usable comes back, fall back.
          if (srcUrl) runAutoImport(business, srcUrl).then(r => { if (!r) return fallback() }).catch(e => { console.error('[Owner] auto-import failed:', e.message); fallback().catch(() => {}) })
          return
        }
      }

      let ownerReply
      if (isFirstContact) {
        ownerReply = getOwnerWelcome(business)
      } else {
        ownerReply = await handleOwnerMessage(business, incomingText, mediaUrls)
      }

      if (ownerReply) {   // null = a tool already texted the owner directly (v206 calendar import)
        // v207: a setup question is still open and this text didn't answer it.
        // Answer what they said, then bring the question back so the checklist
        // never silently stalls (the gap that stranded the deposits step).
        try {
          const sbQ = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
          const { data: ob } = await sbQ.from('businesses').select('onboarding').eq('id', business.id).maybeSingle()
          const pq = ob?.onboarding?.pending_question
          if (pq?.kind && !isFirstContact) {
            const { shortQuestion } = require('../bot/trialOnboarding')
            const short = shortQuestion({ ...business, onboarding: ob.onboarding }, pq.kind)
            if (short && !/still on setup|still need/i.test(ownerReply)) ownerReply = `${ownerReply}\n\n${short}`
          }
        } catch (e) { console.error('[Owner] re-ask check failed:', e.message) }
        await sendSMS(toNumber, customerPhone, ownerReply)
        console.log(`[Owner] Replied to ${business.business_name} owner`)
      }
      return
    }

    // 🔒 v191: public demo number — log the prospect so they can be followed up
    // on, and ping Brandon the first time each new number texts in. The
    // conversation itself runs through the normal bot (demo_mode only changes
    // the system prompt and makes bookings non-destructive).
    if (business.demo_mode) {
      const { logDemoLead } = require('../bot/demoMode')
      await logDemoLead(business, customerPhone, incomingText)
    }

    // ── Manual deposit "PAID" (v204) ─────────────────────────────────────────
    // The client paid at the owner's link and says so. Hold the slot, tell the
    // owner, and let them confirm with "confirm <name>". Deterministic, no model.
    if (/\b(paid|payed|sent (it|the deposit|the money)|just (sent|paid)|venmo'?d|zelle'?d|done)\b/i.test(incomingText) && incomingText.length < 80) {
      try {
        const sbDep = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
        const { data: dep } = await sbDep.from('appointments').select('id, customer_name, service_name, appointment_date, appointment_time, deposit_amount')
          .eq('business_id', business.id).eq('customer_phone', customerPhone).eq('status', 'deposit_pending').eq('deposit_status', 'pending').eq('deposit_payment_mode', 'manual')
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (dep) {
          await sbDep.from('appointments').update({ deposit_status: 'reported', deposit_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }).eq('id', dep.id)
          const first = (dep.customer_name || 'The client').split(' ')[0]
          const amt = dep.deposit_amount ? ` $${(dep.deposit_amount / 100).toFixed(0)}` : ''
          await sendSMS(toNumber, customerPhone, `Thanks ${first}! I've let ${business.business_name} know. You'll get a confirmation text as soon as they see the${amt} deposit.`)
          if (business.owner_phone) await sendSMS(toNumber, business.owner_phone, `${dep.customer_name || customerPhone} says they sent the${amt} deposit for ${dep.service_name || 'their appointment'} on ${dep.appointment_date}${dep.appointment_time ? ' at ' + String(dep.appointment_time).slice(0, 5) : ''}. Check your payments, then reply "confirm ${first}" to lock it in or "cancel ${first}" if it never came.`).catch(() => {})
          console.log(`[Deposit] manual deposit reported by ${customerPhone} for appt ${dep.id}`)
          return
        }
      } catch (e) { console.error('[Deposit] manual PAID check failed:', e.message) }
    }

    // ── Client review reply (v205) ───────────────────────────────────────────
    // "4" / "5 stars" / a few words after we asked. Deterministic, before the model.
    try {
      if (await require('../bot/reviews').handleCustomerReply(business, customerPhone, incomingText)) { console.log(`[Reviews] reply from ${customerPhone} recorded for ${business.business_name}`); return }
    } catch (e) { console.error('[Reviews] reply check failed:', e.message) }

    // ── SMS tip prompt reply (🔒 Entry 56) ──────────────────────────────────
    // If the owner just checked this customer out and we're waiting on a tip
    // answer, handle it here — BEFORE the paused/manual-mode gates, because the
    // owner initiated this and the customer must still get their payment link.
    // No live prompt (or table missing) → falls straight through, untouched.
    try {
      const { checkPendingTipReply } = require('../bot/tipFlow')
      const tipResult = await checkPendingTipReply(business, customerPhone, incomingText)
      if (tipResult.handled) {
        console.log(`[Tip] Reply from ${customerPhone} handled (consumed=${tipResult.consumed})`)
        if (tipResult.consumed) return   // it was a tip answer; link sent; don't send it to the AI
        // Not a tip answer: link went out with no tip; message continues normally.
      }
    } catch (tipErr) {
      console.error('[Tip] reply check failed — continuing normal flow:', tipErr.message)
    }

    // Check if bot is paused — don't respond to customers
    if (business.active === false) {
      console.log(`[SMS] Bot paused for ${business.business_name} — customer message ignored`)
      // Check if auto-resume time has passed
      if (business.resume_at && new Date() > new Date(business.resume_at)) {
        const sb4 = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
        await sb4.from('businesses').update({ active: true, resume_at: null }).eq('id', business.id)
        console.log(`[SMS] Bot auto-resumed for ${business.business_name}`)
      } else {
        return
      }
    }

    // Check if conversation is in manual mode — if so bot stays silent
    const sb3 = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    const { data: session } = await sb3
      .from('conversation_sessions')
      .select('manual_mode, manual_mode_until')
      .eq('business_id', business.id)
      .eq('customer_phone', customerPhone)
      .maybeSingle()

    if (session?.manual_mode) {
      if (session.manual_mode_until && new Date() > new Date(session.manual_mode_until)) {
        await sb3.from('conversation_sessions')
          .update({ manual_mode: false, manual_mode_until: null })
          .eq('business_id', business.id)
          .eq('customer_phone', customerPhone)
      } else {
        console.log(`[SMS] Manual mode active for ${customerPhone} — bot silent, saving customer message`)
        // CRITICAL: save the customer's incoming message so the owner sees it in
        // the conversation thread. The bot stays silent (no auto-reply) but the
        // message must be recorded. This gate runs BEFORE the debounce queue, so
        // without saving here the message is lost entirely.
        try {
          const { data: full } = await sb3.from('conversation_sessions')
            .select('messages').eq('business_id', business.id).eq('customer_phone', customerPhone).maybeSingle()
          const msgs = Array.isArray(full?.messages) ? full.messages : []
          msgs.push({ role: 'user', content: incomingText, media: (mediaUrls && mediaUrls.length) ? mediaUrls : undefined, timestamp: new Date().toISOString() })
          await sb3.from('conversation_sessions').upsert({
            business_id: business.id,
            customer_phone: customerPhone,
            messages: msgs,
            last_activity: new Date().toISOString()
          }, { onConflict: 'business_id,customer_phone' })
          console.log(`[SMS] Saved manual-mode customer message for ${customerPhone} (${msgs.length} total)`)
        } catch (saveErr) {
          console.error('[SMS] Failed to save manual-mode customer message:', saveErr.message)
        }
        return
      }
    }

    // Queue this text for debounced processing. If more texts arrive within
    // ~5s, they'll be combined into a single LLM call. Reduces noisy replies,
    // race conditions, and per-message API/Twilio costs. The debouncer handles
    // its own sendSMS and error reporting after the timer fires.
    debouncedProcess(business, customerPhone, toNumber, incomingText, mediaUrls)
  } catch (err) {
    console.error('[SMS] Error handling message:', err)
    try {
      await sendSMS(toNumber, customerPhone,
        `Sorry, I'm having a moment! Please try again in a few seconds or call us directly.`
      )
    } catch (sendErr) {
      console.error('[SMS] Failed to send error message:', sendErr)
    }
  }
})

// ── Incoming voice call — missed call to text ──────────────────────────────
router.post('/voice', validateTwilio, async (req, res) => {
  const fromNum       = req.body.From
  const toNumber      = req.body.To            // the Wexly number the call landed on
  const forwarded     = req.body.ForwardedFrom // set when the call was forwarded

  res.set('Content-Type', 'text/xml')

  try {
    const business = await db.getBusinessBySmsNumber(toNumber)

    if (!business || business.status === 'cancelled') {
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this number is not available.</Say><Hangup/></Response>`)
      return
    }

    if (!business.missed_call_enabled) {
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`)
      return
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 🔒 PROTECTED — Carrier-agnostic caller resolution. See PROTECTED_DECISIONS.md
    // 🔒 Entry 22. Different forwarding setups put the real caller in different
    // 🔒 Twilio fields:
    // 🔒   • Direct call:            From = customer
    // 🔒   • Carrier forwarding:     From = customer, ForwardedFrom = office line
    // 🔒   • VoIP/PBX relay:         From = office line, ForwardedFrom = customer
    // 🔒 So we can't trust a single field. Instead, we pick whichever candidate
    // 🔒 is NOT one of the business's own numbers — the customer is by definition
    // 🔒 the external party. Compare on normalized digits (strip +, leading 1).
    // ═══════════════════════════════════════════════════════════════════════
    const normPhone = (p) => {
      if (!p) return ''
      let d = p.replace(/\D/g, '')
      if (d.length === 11 && d.startsWith('1')) d = d.slice(1) // drop US country code
      return d
    }

    // All numbers that belong to the business (never text these).
    const businessNumbers = new Set(
      [
        business.sms_number,
        toNumber,
        business.owner_phone,
        business.existing_phone,          // the office line they forward from (if configured)
        ...(business.additional_owner_phones || [])
      ].map(normPhone).filter(Boolean)
    )

    const fromNorm = normPhone(fromNum)
    const fwdNorm  = normPhone(forwarded)

    // Candidate caller numbers, in priority order. Pick the first that is a real
    // external number (not blank, not a business number).
    let customerPhone = null
    for (const candidate of [fromNum, forwarded]) {
      const norm = normPhone(candidate)
      if (norm && !businessNumbers.has(norm)) { customerPhone = candidate; break }
    }
    // Fallback: if both candidates were business numbers or blank, use From as-is.
    if (!customerPhone) customerPhone = fromNum

    console.log('[Voice-Raw]', JSON.stringify({
      From: fromNum, To: toNumber, ForwardedFrom: forwarded,
      Caller: req.body.Caller, Called: req.body.Called,
      resolvedCustomer: customerPhone
    }))
    console.log(`[Voice] ${toNumber} ← ${customerPhone}${forwarded ? ` (forwarded from ${forwarded})` : ''}`)

    // Don't text the owner calling their own number
    const ownerClean  = business.owner_phone?.replace(/\D/g, '')
    const callerClean = customerPhone?.replace(/\D/g, '')
    const additionalClean = (business.additional_owner_phones || []).map(p => p?.replace(/\D/g, '')).filter(Boolean)

    const matchPhone = (stored, incoming) => stored && incoming && (
      stored === incoming ||
      stored === incoming.replace(/^1/, '') ||
      ('1' + stored) === incoming
    )

    const isOwner = matchPhone(ownerClean, callerClean) ||
      additionalClean.some(p => matchPhone(p, callerClean))

    const voiceMsg = business.missed_call_message ||
      `Thanks for calling ${business.business_name}! We're unavailable right now — we'll text you right back in just a moment.`

    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${voiceMsg}</Say><Hangup/></Response>`)

    if (!isOwner) {
      const botName = business.bot_name || 'your assistant'
      const textMsg = `Hi! Sorry we missed your call 📞 I'm ${botName} from ${business.business_name}. I can help you book an appointment or answer questions — just text back here!`
      sendSMS(toNumber, customerPhone, textMsg)
        .then(() => console.log(`[Voice] Texted ${customerPhone} for ${business.business_name}`))
        .catch(err => console.error('[Voice] SMS failed:', err.message))
    } else {
      console.log(`[Voice] Caller ${callerClean} is the owner of ${business.business_name} — text-back suppressed (owner calling own number).`)
    }

  } catch (err) {
    console.error('[Voice] Error:', err.message)
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`)
  }
})

// ── Status callback (delivery receipts) ──────────────────────────────────────
router.post('/status', (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body
  console.log(`[Status] ${MessageSid} → ${To}: ${MessageStatus}${ErrorCode ? ' (error ' + ErrorCode + ')' : ''}`)
  res.sendStatus(200)
  // v199: one automatic re-send for 30034 (10DLC propagation) and 30003
  // (unreachable handset). See utils/sms.js for the delays.
  if (MessageStatus === 'undelivered' && ['30034', '30003'].includes(String(ErrorCode))) {
    require('../utils/sms').retryUnregistered(MessageSid)
  }
})

module.exports = router
