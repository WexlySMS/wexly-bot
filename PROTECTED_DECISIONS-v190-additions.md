# PROTECTED_DECISIONS additions — v190 (instant trial)

Paste these entries at the end of the current PROTECTED_DECISIONS.md (after the latest numbered entry; renumber if 60 is taken). The bot zip and site zip were built against bot v189 / site v188.

---

## 🔒 Entry 60 — Instant trial: verified owner cell + live number at signup, card at day 14

**Files:** bot `src/bot/trialOnboarding.js` (new), `index.js` (`/auth/send-code`, `/auth/verify-code`, `/auth/create-business`), `src/routes/webhook.js` (DEMO intercept, `trial_expired` gate), `src/routes/stripe.js` (`create-checkout` trial shapes, `checkout.session.completed` keeps the clock), `src/bot/setupInterview.js` (waiting_start passthrough + 24h expiry), `src/bot/ownerCommands.js` (`add_services` tool), `src/bot/scheduler.js` (drip every 10 min). Site `signup.html` (cell field + code box, copy), `dashboard.html` (trial banner, `?add_card=1`, billing card, number poll). Migration: `add-instant-trial.sql` (REQUIRED before deploy).

**Why (Brandon, 2026-10-30):** Research showed no competitor lets the owner experience the product before a card. A trial costs about $1.50 to $5 (number + texts + LLM), nothing against $79/mo. "Better than not getting a sign up at all." The first thing a new owner should feel is the bot texting them from their own new business number, not a dashboard tour.

**Flow:**
1. Signup collects the owner's cell. One button: first press texts a 6-digit code from the shared Wexly number (`TWILIO_PHONE_NUMBER`), code box appears, 6 digits auto-verify. Codes are sha256-hashed (`ADMIN_SECRET`), 10 min TTL, 5 wrong tries, 3 codes per phone per 10 min, 12 requests per IP per 10 min.
2. `/auth/create-business` requires a cell verified in the last 30 min. One free trial per cell (another user_id on that cell in trial/trial_expired/cancelled/past_due → 409). Account is created as `status: 'trial'`, `trial_ends_at: now + 14d`, `owner_phone`, `owner_phone_verified_at`. **`owner_phone_verified_at` is the instant-flow marker**; legacy card-first accounts never have it.
3. Number is bought immediately (area code from the owner's cell), added to the messaging service as before. Signup waits up to 8s so the dashboard lands with the number; otherwise it finishes in the background and the drip retries for 3 days.
4. Welcome text goes out **from the new business number** to the owner's cell: intro, vCard link, "reply today / block friday 2-4". 25s later: "Reply DEMO...". Welcome email also moves to signup.
5. DEMO (owner thread) plays a scripted client booking using the business's own first service, then the Instagram-bio line.
6. Drip (scheduler, 10 min, idempotent per step in `businesses.onboarding` JSON): 10 min services-by-text nudge if no services; 30 min setup interview offer; 20h bio nudge; first real booking note; day 7 card ask; day 13 last-day ask; expiry → `status: 'trial_expired'` + owner text; 14 days after expiry the number is released.
7. `trial_expired`: client texts are dropped silently; the owner gets the add-card link whatever they text. Dashboard shows a red persistent banner; `?add_card=1` opens Checkout directly.
8. Card added (Checkout): Stripe `trial_end` = our `trial_ends_at` (min 49h out, Stripe rule) so the first charge lands on day 14, status stays `trial` with the SAME clock. Expired → pays today → `active`. Legacy parked signups keep `trial_period_days: 14`. Webhook reads the row BEFORE updating and never resets `trial_ends_at` for a live trial. Confirmation goes by text from the business number for instant-flow accounts; legacy accounts keep the emails.

**Supersedes:** the "trial clock starts at checkout, not signup" entry. That rule existed because pending_checkout accounts had no number to use. Instant-trial accounts have a live number from minute one, so the clock starts at signup. `pending_checkout` still exists for legacy callers that omit `ownerPhone` and for existing parked rows.

**Decisions:**
- No card to start. Card asked day 7 (text + dismissible banner becomes persistent), required day 14. Not 30 days: time-to-value is days, and every trial day costs real money.
- Everything after the verification code comes from the owner's own business number. One contact, one thread, every message is practice using the product.
- Owner SMS from the drip is not governed by `new_booking_sms` prefs; it is onboarding, not booking notifications.
- `create-checkout` must never set `pending_checkout` on a `trial`/`trial_expired` row (would switch the bot off mid-trial).
- `create-business` never touches status/trial/number fields on a row that already went live (re-running signup while logged in).
- Interview `waiting_start` no longer nags on unrelated texts; it lets owner commands through, and the offer goes stale after 24h so a later "yes" cannot start it by accident.

**Regression scenarios:**
- Removing the `owner_phone_verified_at` gate from the drip = legacy paying accounts get card nudges or get expired.
- Resetting `trial_ends_at` in `checkout.session.completed` = owner who adds a card on day 7 gets 14 more free days.
- Passing `trial_end` under 48h to Checkout = Stripe 400 on the add-card page.
- Gating the drip on `welcome_sent_at` instead of the verified marker = a trial whose welcome failed never expires (free forever).
- Letting `create-checkout` mark a live trial `pending_checkout` = bot off for clients the moment they click Add card.

**To verify:** New signup with your cell → code arrives from the Wexly number → verify → dashboard shows the new number within ~10s → welcome text from THAT number → reply "today" → schedule → reply DEMO → scripted booking → admin shows status trial, Trial Ends = +14d, no subscription. Dashboard → Settings → Billing → "Add a card →" → Stripe page says first charge on the trial end date → complete → text "Card added..." from the business number → status still trial, same end date, subscription id set. Set `trial_ends_at` to yesterday on a test row with no subscription → within 10 min status trial_expired + owner text; client text to the number gets no reply; owner text gets the link.

---

## 🔒 Entry 61 — Owner reminders by text + "never promise what you can't do"

**Files:** `src/bot/ownerCommands.js` (`set_reminder` / `list_reminders` / `cancel_reminder` tools, `localToUtc`, system-prompt rule), `src/bot/scheduler.js` (`sendOwnerReminders`, every 2 min, claim-before-send), migration `owner_reminders` table (in `add-instant-trial.sql`).

**Why (Brandon, 2026-10-30):** He told the Radiance bot "remind me tomorrow about booking" and nothing came. There was no reminder tool; the model agreed anyway. Two fixes: the tool now exists, and the owner prompt forbids agreeing to anything without a tool ("say you can't do that yet by text, point to the dashboard; only say I'll remind you after set_reminder has run").

**Decisions:** times resolve in the business timezone (Intl two-pass offset, DST-safe); default 9:00 AM when no time given; reminders go from the business number to the owner cell; rows are claimed (`sent_at`) before the Twilio call so nothing sends twice.

**Regression scenarios:** removing the claim-before-send = duplicate reminders on a slow sweep; removing the prompt rule = the bot goes back to promising things it cannot do.

**To verify:** text the owner number "remind me in 5 minutes to test reminders" → "Reminder set for ..." → within ~7 min a "⏰ Reminder: test reminders" text. "list reminders" / "cancel the test reminder" work.

## 🔒 Entry 62 — Public demo number: one real bot anybody can text

**Files:** `src/bot/demoMode.js` (new), `src/bot/conversationEngine.js` (prompt block + non-destructive `create_appointment`), `src/routes/webhook.js` (lead logging, demo immunity to billing gates). Site `index.html` (hero CTA + demo-section CTA + helper script), `lp/start.html` (hero CTA + helper), `_redirects` (`/demo-start`). Migration: `businesses.demo_mode`, `demo_leads` (in `add-instant-trial.sql`).

**Why (Brandon, 2026-10-30):** The research found nobody in the category uses "text this number" as the CTA, even though the product IS a text conversation. The ad can be the demo. One business (Radiance, (417) 538-3787) is flagged `demo_mode` and becomes that public line.

**How it works:** a prospect texts DEMO. The normal client bot answers as that sample business with its real services, hours and availability, because the realism is the demo. `demo_mode` changes exactly two things: a DEMO MODE block is appended to the system prompt (greet a bare "DEMO" with an example of what to say; after confirming a booking add one closing paragraph about Wexly and `getwexly.com/demo-start`; answer "are you real / how much" honestly; never claim to be human), and `create_appointment` short-circuits to a success-shaped result with **no database write**. No appointment row means no deposit request, no owner notification, and critically no reminder or follow-up text to a prospect who never had an appointment. Availability checks above it are real, so the conversation cannot offer a slot that does not exist. Every demo texter is upserted into `demo_leads` and Brandon gets one SMS the first time each new number texts in.

**Decisions:**
- Owner texts to the demo number still hit owner mode. Demo handling is for non-owner senders only.
- The demo number ignores billing status (`trial_expired`, `pending_checkout`, `past_due`): ads point at it, so it can never go quiet because a test account lapsed. `active: false` (bot paused) still silences it, deliberately.
- The button renders as a message draft (quoted text + green send button) and carries its own pre-written message in `data-sms-body`: hero "Hi! What services do you offer?", demo band "Hi! Do you have any openings this week?". Tapping opens Messages with that text already in the box, so the visitor only hits send. A bare "DEMO" typed from an ad still works (the prompt handles it).
- `sms:+1...?&body=<encoded message>` — the `?&` form is the one both iOS and Android prefill from. Desktop has no Messages app, so the click copies the number, the caption says what to do, and it restores itself after 6s.
- `/demo-start` → `/signup.html?src=sms_demo`, so demo-sourced signups are attributable.

**Regression scenarios:**
- Removing the `create_appointment` short-circuit = strangers' fake bookings land in a real calendar and they get reminder texts for appointments that do not exist.
- Letting `demo_mode` apply to owner senders = Brandon loses owner commands on that number.
- Flagging more than one business `demo_mode` = two public demo lines and split lead logging.
- Turning the demo business `active: false` = the website CTA goes to a silent number.

**To verify:** the demo business must have services and hours set, or the bot replies "we're just finishing up our setup". Text DEMO to (417) 538-3787 from a phone that is NOT an owner number → greeting with an example → "any openings Friday afternoon?" → real slots → book → confirmation plus the Wexly line with the link. Then check: no new row in `appointments` for that business, one row in `demo_leads`, and Brandon got the "new demo texter" SMS. Text the same number from the owner cell → owner mode, not demo.

## 🔒 Entry 63 — Reminders work on BOTH sides of the thread

**Files:** `src/bot/conversationEngine.js` (`set_reminder` client tool, `localToUtcTZ`, current local time in the prompt, role line 5), `src/bot/ownerCommands.js` (owner `set_reminder` now takes `minutes_from_now`; owner prompt carries the clock time), `src/bot/scheduler.js` (`sendOwnerReminders` handles both kinds, every 60s). Migration: `owner_reminders.kind` + `to_phone` (in `add-instant-trial.sql`).

**Why (Brandon, 2026-10-30):** Entry 61 added reminders to the OWNER path only. His actual test came from +1310… , which Radiance knows as a client, so it went down the customer path and the bot said "I wish I could set reminders, but unfortunately that's not something I'm able to". Both sides need it, and the customer side is the more valuable one: "text me next week about booking" is booking recovery, in the customer's own words, at the moment they ask for it.

**How it works:** one queue, two kinds. `kind='owner'` (to_phone null) texts the owner cell as before. `kind='customer'` texts `to_phone` with "Hi Brandon! You asked me to remind you to book your next appointment. Want me to find you a time?" and the live session carries straight on into booking. Both prompts now include the current local time, so "in 5 minutes" is resolvable, and both tools accept `minutes_from_now` for short delays or `remind_at_local` for a named day. Sweep runs every 60s so a 5-minute reminder lands on time.

**Guards on customer reminders:** opted-out customers are skipped at send time, not at set time; a reminder is skipped if the customer booked anything after setting it (so nobody gets "remember to book!" right after booking); max 3 pending per customer per business; 90 days out maximum; rows are still claimed before the Twilio call.

**Regression scenarios:**
- Dropping the current local time from either prompt = "in 5 minutes" silently becomes a wrong absolute time or a refusal.
- Skipping the opt-out re-check at send time = texting someone who sent STOP after setting a reminder.
- Removing the already-booked check = "remember to book" arriving minutes after they booked.
- Removing `required: ['message']` only (owner tool) and demanding `remind_at_local` again = "remind me in 10 minutes" fails.

**To verify:** from a NON-owner phone text the bot "remind me in 5 mins to schedule an appointment" → it confirms → ~5 min later "Hi …! You asked me to remind you to …". Book something immediately after setting one → the reminder never arrives. Reply STOP after setting one → it never arrives. From the owner cell: "remind me in 10 minutes to order color" → ⏰ Reminder at 10 min.

## 🔒 Entry 64 — Demo CTA: shared component, desktop QR panel, "text me first"

**Files:** site `sms-demo.js` (new, shared by every page), `qr/sms-services.svg` + `qr/sms-openings.svg` (static, pre-generated), `index.html`, `lp/start.html`, `lp/start-v1.html`. Bot `index.js` (`POST /demo/text-me`). Migration: `demo_leads.texted_first_at`.

**Why (Brandon, 2026-10-30):** the CTA needed to be on every landing page, and the desktop behaviour (copy the number to the clipboard) was weak. Desktop visitors have no Messages app, so the click now opens a small panel instead.

**Behaviour by device, deliberately different:**
- **Phone:** nothing changes and nothing is added. The `sms:` link opens Messages with the pre-written text in the box, one tap to send. **Never put a modal in front of this** — the one-tap path is the whole point.
- **Desktop:** the click opens a small "Try it now" panel: a QR code (scan, Messages opens with the text ready), then the pre-written message in an editable field, a phone field and one **Text me** button. Nothing else.

**Decisions:**
- One shared `/sms-demo.js` with `defer` rather than the same script inlined three times. Button styling stays in each page's CSS so there is no unstyled flash; only panel CSS is injected, and only on first open.
- QR codes are **static SVGs generated at build time** (the `sms:` URL never changes), so there is no CDN script and no runtime dependency for a primary CTA. Regenerate with the `qrcode` npm package if the number or the pre-written message changes.
- Each button carries `data-sms-body` and `data-sms-qr`, so a page can have its own message ("What services do you offer?" in heroes, "Any openings this week?" in the demo band and final CTA).
- **"Text me" runs their message through the real bot.** `/demo/text-me` calls `handleIncomingMessage` for the demo business exactly as if they had texted it in, then sends the bot's actual reply to their phone. They get the answer to their question, in a live thread, not a canned invitation. If the engine throws it falls back to a greeting, so the visitor is never left with nothing.
- `/demo/text-me` is public, so it is rate limited per IP and hard-limited to **one outbound per number per 24h** (`demo_leads.texted_first_at`).
- **No opt-out boilerplate on the demo path.** Nothing ever markets to a demo texter: `demo_leads` is written to and never read by any outbound sweep, and the only message they get is the bot answering them. Carrier-level STOP still works (Twilio handles it, and `webhook.js` honours it), so the wording is not needed and reads as a warning about spam that does not exist. The site says "One reply, no marketing, ever." instead. The business's OWN customer campaigns keep their required STOP language, untouched.

**Regression scenario:** adding any scheduled outbound to `demo_leads` would make this false, and the opt-out language would have to come back with it.
- Placements: index hero, index demo band, `lp/start.html` hero + final CTA, `lp/start-v1.html` hero. Not on `book.html` (a client's own booking page) or `ads.html` (internal creative gallery).

**Regression scenarios:**
- Showing the panel on phones = the one-tap prefilled text is replaced by a dialog, and the demo conversion drops.
- Swapping the static QR for a CDN-rendered one = a third-party outage breaks the main CTA.
- Removing the 24h per-number limit = a public endpoint that can text a stranger repeatedly.
- Changing the number or message without regenerating the QR SVGs = the QR silently sends the old text to the old number.

**To verify:** on a phone, tapping any CTA opens Messages with the text already written and no panel appears. On desktop, clicking opens the "Try it now" panel carrying that button's own message and QR; scanning the QR opens Messages with the same text; entering a number sends the bot's real answer to that phone within seconds and refuses a second send within 24h; Esc and the backdrop close the panel.

## 🔒 Entry 65 — No "AI" in customer-facing copy

**Files:** site `index.html`, `lp/start.html`, `lp/start-v1.html`, `signup.html`, `help.html`, `dashboard.html`, `sms-demo.js`. Bot `src/bot/demoMode.js`, `src/bot/scheduler.js`, `src/bot/setupInterview.js`, `src/utils/emailService.js`.

**Why (Brandon, 2026-10-30):** "remove any word of AI it looks bad use other words like receptionist etc". Every visitor-facing and owner-facing use of "AI" is gone, replaced with receptionist / assistant / Wexly / automatic depending on what reads best in that sentence.

**The vocabulary:** the thing that answers is a **receptionist** (marketing) or **assistant** (in-product and in the bot's own voice). Features that used to be "AI email builder" are now just Wexly doing it ("Wexly writes and designs it", "✨ Write it for me"). The model credit stays as "Powered by Claude" — a product name, not the word.

**What was deliberately kept:**
- The hidden `<meta name="keywords">` tag, which still carries "AI booking system / AI receptionist". Nobody sees it and that is genuinely how people search. Visible titles and descriptions no longer say it.
- Internal code comments and the `[AI Generate]` log tag. Not customer-facing.
- **The bot still admits it is not a person.** `demoMode.js` now says: if asked whether you are a real person or a bot, say plainly you are not a person, you are an automated assistant, and "never claim to be a human, and never deny being automated if you are asked directly". Dropping the marketing word must not turn into pretending to be human — that is a trust problem and, in some states, a legal one.

**Regression scenario:** rewording the honesty instruction in demoMode.js so the bot dodges "are you a real person" would make the demo deceptive.

**To verify:** `grep -riE '\bA\.?I\.?\b'` over the site returns only the keywords meta; over the bot, only comments and the log tag. Text the demo number "are you a real person?" and it should say it is not, without using the phrase.

## 🔒 Entry 66 — Hero cut to two CTAs, plus a timed demo nudge

**Files:** site `index.html` (hero, nav), `sms-demo.js` (nudge).

**Why (Brandon, 2026-10-30):** he asked whether "See it in action" should be the button that sends the text, and wanted a popup a few seconds into the visit pushing the demo.

**Hero:** "See it in action" is gone. The message-draft button already IS seeing it in action, and the ghost button pointed at the weaker in-page simulation, so three CTAs were competing. Hero is now **Start free 14-day trial** plus the draft. The simulated chat section is still reachable: "Live demo" was added to the top nav and the mobile menu.

**Nudge:** a dark card styled as an incoming message notification, bottom right on desktop, a bar across the bottom on phones. It carries the first CTA's own pre-written message. Clicking it opens the panel on desktop or Messages on a phone.

**When it is allowed to fire — all of these must hold:**
- 22 seconds elapsed, or 55% of the page scrolled, whichever comes first.
- Not shown to this visitor in the last **7 days** (`localStorage` `wx_nudge_seen`, set the moment it appears, so a reload never re-shows it).
- They have not already clicked a demo CTA this visit, and the panel is not open.
- The page actually has a demo CTA on it.
- On phones, the page does not already have a visible `.sticky-cta` — the landing pages ship their own bottom bar and two stacked bars is clutter. Verified: on `lp/start.html` at 390px the nudge stays suppressed.

**Decisions:** a slim notification card, never a full-screen interstitial. Google penalises intrusive mobile interstitials, and an overlay that covers a landing page a visitor just paid to reach is a conversion tax. Dismissal is honoured for a week, not a session.

**Regression scenarios:**
- Turning it into a centred modal = mobile SEO penalty and a worse landing-page experience.
- Setting the seen flag on dismiss only = it reappears on every page view for anyone who ignores it.
- Dropping the `.sticky-cta` check = two stacked bars on the landing pages on mobile.

**To verify:** load the homepage, scroll past the midpoint, the card slides in bottom right; clicking it opens the panel; reload and it stays away. On a phone at a landing page URL, it never appears over the existing sticky bar.

## 🔒 Entry 67 — Audit of v190–v196 (2026-11-01), five fixes

Brandon asked for a full audit of the work done after the model switch. Mechanical checks passed clean: every bot file parses, every inline script and all three homepage JSON-LD blocks parse, only the intended files changed against v188/v189, nothing was removed except deliberately replaced lines, and the "no AI" sweep left no grammar artifacts. Five real defects were found in logic review and fixed:

1. **Meta pixel pollution** (`sms-demo.js`): the nudge fired `fbq('track','Contact')` when it merely appeared or was dismissed, and the desktop panel fired it on open. "Contact" is a standard conversion event ad sets optimise on, so every visitor who scrolled past the midpoint would have registered as a conversion. Now: `Contact` fires only on a real mobile tap that opens Messages, `Lead` only when a text-me text was delivered; panel open and nudge shown/click/dismiss are `trackCustom` events (`DemoPanelOpen`, `DemoNudgeShown`, `DemoNudgeClick`, `DemoNudgeDismiss`). Verified in a browser: zero standard events without a text being sent.
2. **Customer reminders ignored the bot's own gates** (`scheduler.js`): a "remind me tomorrow to book" text would have gone out even if the owner had paused the bot or the trial had expired. Customer-kind reminders now skip when `active === false` or status is past_due / pending_checkout / trial_expired (demo number excepted, same rule as the webhook). Owner-kind reminders are the owner's own tool and are not gated.
3. **`/demo/text-me` ignored a prior STOP** (`index.js`): the website form could text a number that had opted out of the demo business. Now refuses with a clear message before sending (Twilio would also reject at the carrier, but the check belongs on our side).
4. **Nudge burned its once-a-week shot in background tabs** (`sms-demo.js`): the 22s timer fired while the tab was hidden. It now waits for `visibilitychange` and shows 1.5s after the tab is visible.
5. **Demo waitlist writes** (`conversationEngine.js`): `add_to_waitlist` now short-circuits in demo mode like `create_appointment`, so prospects cannot leave rows in the demo business's waitlist.

Also made the customer reminder tail ("Want me to find you a time?") conditional on the reminder being about booking.

Checked and left alone: `save_customer_email` in demo mode is a no-op (updates a customers row that demo never creates); `lastAppointmentId` is only set inside the real booking path so the demo result cannot leak a fake id into session state; phone formats are E.164 end to end (Twilio From, text-me normaliser, customers.phone, appointments.customer_phone); `/demo-start` redirect syntax is valid for Netlify; SQL is idempotent.
