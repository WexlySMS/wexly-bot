const db = require('../db/client')
const { sendSMS } = require('../utils/sms')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const SKIP_PHRASES = ['not sure', 'idk', 'skip', 'n/a', 'na', 'none', 'no', 'nope', 'unsure', "don't know", 'dont know', 'pass', '-', '.']
function wantsToSkip(text) {
  const t = text.trim().toLowerCase()
  return SKIP_PHRASES.some(p => t === p || t === p + '.' || t.startsWith(p + ' '))
}

const QUESTIONS = [
  {
    key: 'q_description',
    ask: `1️⃣ Describe your business in a sentence or two — what do you do and who do you serve?`
  },
  {
    key: 'q_vibe',
    ask: `2️⃣ How would you describe your vibe? (e.g. "upscale and professional", "fun and casual", "warm and personal") Reply SKIP if not sure.`
  },
  {
    key: 'q_unique',
    ask: `3️⃣ What makes you stand out from others like you? What do customers love most? Reply SKIP if not sure.`
  },
  {
    key: 'q_access',
    ask: `4️⃣ Where do you serve customers? Are you a physical location, fully online, or do you travel to them? If physical, anything they should know about finding you — parking, floor, entrance? Reply SKIP if not applicable.`
  },
  {
    key: 'q_busy_times',
    ask: `5️⃣ When do you tend to fill up fastest? (e.g. "Fridays", "weekend mornings", "end of month") Reply SKIP if not sure.`
  },
  {
    key: 'q_restrictions',
    ask: `6️⃣ Anything I should NEVER say or do as your assistant? (e.g. "Never quote prices over text", "Always refer complaints directly to me") Reply SKIP if none.`
  },
  {
    key: 'q_common_questions',
    ask: `7️⃣ Last one — what do customers ask you most that I should know the answer to? (e.g. "Do you take walk-ins?", "Is parking free?") Reply SKIP if none.`
  }
]

async function startSetupInterview(business) {
  const ownerPhone = business.owner_phone
  const smsNumber = business.sms_number

  if (!ownerPhone || !smsNumber) {
    console.log(`[Interview] Skipping — no owner phone for ${business.business_name}`)
    return
  }

  const intro = `Hi ${business.owner_name?.split(' ')[0] || 'there'}! 👋 I'm your Wexly assistant for ${business.business_name}.\n\nBefore I start answering your customers, I have 7 quick questions so I can represent your business perfectly. Takes about 2 minutes.\n\nReply YES to start or SKIP to do it later from your dashboard.`

  await sendSMS(smsNumber, ownerPhone, intro)
  await supabase.from('businesses').update({
    interview_state: 'waiting_start',
    interview_step: 0,
    interview_answers: {}
  }).eq('id', business.id)

  console.log(`[Interview] Started for ${business.business_name} → ${ownerPhone}`)
}

async function handleInterviewMessage(business, incomingText) {
  const state = business.interview_state
  const step = business.interview_step || 0
  const answers = business.interview_answers || {}
  const smsNumber = business.sms_number
  const ownerPhone = business.owner_phone
  const text = incomingText.trim().toLowerCase()

  if (state === 'waiting_start') {
    // 🔒 v190: the offer goes stale after 24h so a later "yes" (to a bot
    // confirmation question, say) can never start the interview by accident.
    const offeredAt = business.onboarding?.interview_offered_at
    if (offeredAt && Date.now() - new Date(offeredAt).getTime() > 24 * 60 * 60 * 1000) {
      await supabase.from('businesses').update({ interview_state: 'skipped' }).eq('id', business.id)
      return false
    }
    if (text === 'skip') {
      await supabase.from('businesses').update({ interview_state: 'skipped' }).eq('id', business.id)
      await sendSMS(smsNumber, ownerPhone, `No problem! You can run the setup interview anytime from your dashboard under Bot Settings. 🚀`)
      return true
    }
    if (['yes', 'y', 'yeah', 'yep', 'sure', 'ok', 'okay', "let's go", 'lets go', 'ready'].includes(text)) {
      await supabase.from('businesses').update({ interview_state: 'in_progress', interview_step: 0 }).eq('id', business.id)
      await sendSMS(smsNumber, ownerPhone, QUESTIONS[0].ask)
      return true
    }
    // Anything else is a real owner command ("today", "block friday", DEMO).
    // Let it through instead of nagging; the offer stays open for YES/SKIP.
    return false
  }

  if (state === 'in_progress') {
    const currentQ = QUESTIONS[step]
    if (!wantsToSkip(incomingText)) {
      answers[currentQ.key] = incomingText.trim()
    }

    const nextStep = step + 1

    if (nextStep >= QUESTIONS.length) {
      await saveInterviewAnswers(business, answers)
      await supabase.from('businesses').update({
        interview_state: 'complete',
        interview_step: nextStep,
        interview_answers: answers
      }).eq('id', business.id)

      await sendSMS(smsNumber, ownerPhone,
        `✅ Perfect — I've got everything I need!\n\nI'm fully briefed on ${business.business_name} and ready to handle your customers. 🎉\n\nFinish your setup in the dashboard:\n\n📋 Complete the Get Started checklist\n🕐 Set your business hours\n📅 Add your appointment types\n🏷️ Add any active promotions\n📣 Share your SMS number with customers\n\nGo to your dashboard to go live! 🚀`
      )

      await new Promise(r => setTimeout(r, 2500))
      await sendSMS(smsNumber, ownerPhone,
        `💡 Two quick tips:\n\n1️⃣ Give your bot a name! Go to Bot Settings → General → "Bot name" (e.g. Aria, Max, Luna).\n\n2️⃣ You can manage your business by texting THIS number:\n• "What's my schedule tomorrow?"\n• "Block out Friday — vacation"\n• "I'm sick, reschedule all clients tomorrow"\n• "Pause the bot"\n\nYour assistant is always on call 🤖`
      )
      return true
    }

    await supabase.from('businesses').update({
      interview_state: 'in_progress',
      interview_step: nextStep,
      interview_answers: answers
    }).eq('id', business.id)

    await sendSMS(smsNumber, ownerPhone, QUESTIONS[nextStep].ask)
    return true
  }

  return false
}

async function saveInterviewAnswers(business, answers) {
  const faqs = []

  if (answers.q_description) faqs.push({ business_id: business.id, question: 'About this business', answer: answers.q_description, sort_order: 0 })
  if (answers.q_unique) faqs.push({ business_id: business.id, question: 'What makes us stand out', answer: answers.q_unique, sort_order: 1 })
  if (answers.q_access) faqs.push({ business_id: business.id, question: 'Location, access & parking', answer: answers.q_access, sort_order: 2 })
  if (answers.q_busy_times) faqs.push({ business_id: business.id, question: 'When we fill up fastest', answer: answers.q_busy_times, sort_order: 3 })
  if (answers.q_common_questions) faqs.push({ business_id: business.id, question: 'Common customer questions', answer: answers.q_common_questions, sort_order: 4 })

  if (faqs.length > 0) await supabase.from('faqs').insert(faqs)

  if (answers.q_vibe && !business.bot_tone) {
    await supabase.from('businesses').update({ bot_tone: answers.q_vibe }).eq('id', business.id)
  }

  if (answers.q_restrictions) {
    const existing = business.bot_restrictions || ''
    const updated = existing ? `${existing}\n${answers.q_restrictions}` : answers.q_restrictions
    await supabase.from('businesses').update({ bot_restrictions: updated }).eq('id', business.id)
  }

  console.log(`[Interview] Saved ${faqs.length} FAQs for ${business.business_name}`)
}

module.exports = { startSetupInterview, handleInterviewMessage }
