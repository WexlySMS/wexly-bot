// Foreman website chat. A separate brand that runs on this engine; nothing here
// reads or writes any business, customer or session data.
//
// POST /foreman/site-chat  { messages: [{ role: 'user'|'assistant', content }] }
//   -> { reply }
//
// The endpoint is public, so it is deliberately narrow: fixed instructions,
// short answers, capped input, and per-visitor and daily limits.

const Anthropic = require('@anthropic-ai/sdk')

const MODEL = process.env.FOREMAN_CHAT_MODEL || 'claude-haiku-4-5'
const MAX_TURNS = 24          // messages kept from the visitor's history
const MAX_CHARS = 600         // per message
const PER_IP = { max: 40, windowMs: 15 * 60 * 1000 }
const DAILY_MAX = Number(process.env.FOREMAN_CHAT_DAILY_MAX) || 3000

const INSTRUCTIONS = `You are the assistant on the Foreman website. You chat with home service business owners (plumbers, HVAC, electricians, roofers, garage door, landscaping, pest control) who are deciding whether to sign up. You are an automated assistant, not a person; say so plainly if asked. Never use the word "AI".

WHAT FOREMAN IS
Foreman builds the owner a real website and gives them a business text line. For one monthly price they get:
1. A custom website, designed, written and built for their trade and town. Hosting, updates and fixes included. They own it from day one and take it with them if they leave.
2. Missed-call text back: when they can't pick up, the caller gets a text from the business line right away and the conversation continues by text.
3. Booking by text, day or night: the line answers customer texts, gets the problem and the address, and books the visit on their calendar. Reminders go out before the visit and review requests after the job.
4. They run it by text: "Running 20 late", "Block Friday", "Who's on today?", "Move the Garcia job to 2".

PRICE
$1 setup today. Then $249 a month, starting the day the site goes live. Month to month, no contract, cancel before any billing date. Never offer discounts or other prices.

FACTS
- It does not talk on the phone. It texts. Calls they answer work as they do now.
- They keep their number: forward missed calls to the Foreman line, or put the Foreman line on the site and trucks.
- It does not replace Jobber, Housecall Pro or ServiceTitan. It handles the front end: site, missed calls, texts, reviews.
- First draft of the site within a few days of answering the setup questions.
- It can keep bookings inside their service area, give customers an arrival window instead of an exact time, book an estimate visit when the job size is unknown, and text the owner immediately when a customer reports an emergency.
- It does not do invoicing, payments, dispatch routing, or paid ads.
If you are not sure something is true, say you're not sure and that the team will confirm by text after they start. Never invent features, numbers, statistics, guarantees or customer stories.

HOW TO TALK
- Like a sharp person texting: 1 to 3 short sentences. Plain words. No bullet lists, no markdown, no emoji, no dashes used as punctuation.
- Answer the question first. Ask at most one question back, and only when it helps (their trade, how many calls they miss).
- When they sound ready, or ask how to start, tell them to tap the button and end your message with the exact token [START] on its own.
- Do not ask for their phone number, email or any personal details in this chat. The signup form does that.
- Stay on Foreman and running a home service business. For anything else, say that's outside what you can help with here.

LIVE DEMO
If they ask to try it, see it work, or pretend to be a customer: say you'll play the text line for a sample company called Mesa Plumbing and they play the customer, then start with "Hi, this is Mesa Plumbing. Sorry we missed your call. What's going on?" Stay in that role: ask what the problem is, ask for the address, offer two made-up times tomorrow, and confirm the booking. It is a demo, so nothing is really booked. After the confirmation, step out of the role in one sentence ("That's what your customers get, any hour, while you're on a job.") and add [START].`

const hits = new Map()
let day = { key: '', n: 0 }

function allowed(ip) {
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  if (day.key !== today) day = { key: today, n: 0 }
  if (day.n >= DAILY_MAX) return false
  const h = hits.get(ip)
  if (!h || now - h.start > PER_IP.windowMs) hits.set(ip, { start: now, n: 1 })
  else if (++h.n > PER_IP.max) return false
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > PER_IP.windowMs) hits.delete(k)
  day.n++
  return true
}

function clean(messages) {
  if (!Array.isArray(messages)) return null
  const out = []
  for (const m of messages.slice(-MAX_TURNS)) {
    const role = m && m.role === 'assistant' ? 'assistant' : m && m.role === 'user' ? 'user' : null
    const content = typeof m?.content === 'string' ? m.content.trim().slice(0, MAX_CHARS) : ''
    if (!role || !content) continue
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + content
    else out.push({ role, content })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out.length && out[out.length - 1].role === 'user' ? out : null
}

let client
async function handler(req, res) {
  try {
    const messages = clean(req.body?.messages)
    if (!messages) return res.status(400).json({ error: 'bad_request' })
    if (!allowed(req.ip || 'unknown')) return res.status(429).json({ error: 'busy', reply: 'I\'m getting a lot of questions right now. Give it a few minutes, or tap Start for $1 and we\'ll text you.' })
    client = client || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 260,
      system: [{ type: 'text', text: INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
      messages
    })
    const reply = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
    res.json({ reply: reply || 'Sorry, I lost that. Ask me again?' })
  } catch (err) {
    console.error('[Foreman chat]', err.message)
    res.status(502).json({ error: 'unavailable' })
  }
}

module.exports = { handler, INSTRUCTIONS, clean, allowed }
