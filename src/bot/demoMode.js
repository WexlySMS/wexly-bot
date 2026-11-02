// ── Public demo number (v191) ────────────────────────────────────────────────
// One business is flagged `demo_mode` and its number becomes the "text this
// number" CTA on the site and in ads. A prospect texts it, has a real booking
// conversation with the real bot, and gets one Wexly line plus a signup link at
// the end. Nothing is written to that business's calendar, so no reminders,
// no follow-ups and no junk appointments.
//
// The owner texting their own demo number still gets owner mode: demo handling
// only ever applies to non-owner senders.

const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const SITE_URL = (process.env.SITE_URL || 'https://getwexly.com').replace(/\/$/, '')
// Netlify redirect → /signup.html?src=sms_demo (short enough to read in a text)
const DEMO_SIGNUP_URL = `${SITE_URL}/demo-start`

function isDemoBusiness(business) {
  return business?.demo_mode === true
}

// Appended to the normal client system prompt. Deliberately short: the point of
// the demo is that the bot behaves exactly as it would for a real client.
function demoPromptBlock(business) {
  return `

## DEMO MODE — READ THIS
This number is Wexly's public demo line. The person texting you is almost certainly a business owner trying Wexly out, not a real client of ${business.business_name}.

Behave EXACTLY as you would for a real client: answer naturally, check real availability, take their name, book the appointment. That realism IS the demo. ${business.business_name} is a sample business.

The ONE difference: right after you confirm a booking, add a short closing paragraph in your own words that covers:
- that they just used Wexly, and their own clients would book the same way
- that they can get their own number free for 14 days, no card, at ${DEMO_SIGNUP_URL}

If their first message is just "DEMO", "demo", "start" or similar (they tapped a link on the Wexly site), do not explain anything yet. Greet them as ${business.business_name} and invite them to book, with one concrete example of what to say, like: "Hi! You've reached ${business.business_name}. Ask me for an appointment the way a client would, something like 'any openings Friday afternoon?' and I'll book it."

If they ask whether you are a real person, a bot, or what this is: say plainly that you are not a person, you are Wexly, an automated assistant that answers and books by text for salons, barbers and med spas, that ${business.business_name} is a sample business, and give them ${DEMO_SIGNUP_URL}. Then offer to keep going so they can see the booking flow.

If they ask about price: $79 to $199 a month depending on staff size, 14 days free with no card. Do not invent other details about Wexly. Never claim to be a human, and never deny being automated if you are asked directly.`
}

// Stand-in for the real create_appointment result: same shape the model expects,
// zero database writes.
function demoBookingResult({ customerName, dateLabel, timeLabel, serviceName, staffNote = '' }) {
  return {
    success: true,
    appointment_id: 'demo',
    demo: true,
    confirmation: `${customerName} · ${dateLabel} · ${timeLabel} · ${serviceName}${staffNote}`,
    note: 'DEMO booking — confirm it warmly as usual, then add the closing Wexly paragraph described in DEMO MODE.'
  }
}

// Upsert the texter so Brandon can follow up, and tell him about a brand-new one.
// Never throws: a logging failure must not break the demo conversation.
async function logDemoLead(business, phone, text) {
  try {
    const { data: existing } = await supabase.from('demo_leads')
      .select('id, message_count').eq('phone', phone).maybeSingle()

    if (existing) {
      await supabase.from('demo_leads').update({
        message_count: (existing.message_count || 0) + 1,
        last_message_at: new Date().toISOString(),
        last_message: String(text || '').slice(0, 300)
      }).eq('id', existing.id)
      return { isNew: false }
    }

    await supabase.from('demo_leads').insert({
      phone,
      business_id: business.id,
      first_message: String(text || '').slice(0, 300),
      last_message: String(text || '').slice(0, 300),
      message_count: 1,
      last_message_at: new Date().toISOString()
    })
    console.log(`[Demo] New demo lead ${phone}`)

    // Tell Brandon a live prospect is in the demo right now.
    const ownerPhone = process.env.OWNER_NOTIFICATION_PHONE
    if (ownerPhone && process.env.TWILIO_PHONE_NUMBER) {
      const { sendSMS } = require('../utils/sms')
      sendSMS(process.env.TWILIO_PHONE_NUMBER, ownerPhone,
        `🔥 New demo texter ${phone}: "${String(text || '').slice(0, 120)}"`).catch(() => {})
    }
    return { isNew: true }
  } catch (err) {
    if (!/does not exist/i.test(err.message || '')) console.error('[Demo] lead log failed:', err.message)
    return { isNew: false }
  }
}

module.exports = { isDemoBusiness, demoPromptBlock, demoBookingResult, logDemoLead, DEMO_SIGNUP_URL }
