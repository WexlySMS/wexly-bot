const db = require('../db/client')
const { sendSMS } = require('../utils/sms')
const { formatDate, formatTime } = require('../utils/dateHelpers')
require('dotenv').config()

// ── Send appointment reminders (run daily ~8am) ───────────────────────────────
async function sendReminders() {
  console.log('[Scheduler] Running reminders...')
  const appointments = await db.getAppointmentsNeedingReminders()
  const { createClient } = require('@supabase/supabase-js')
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

  let processed = 0
  for (const appt of appointments) {
    try {
      const bizNumber = appt.businesses?.sms_number
      const bizName   = appt.businesses?.business_name
      if (!bizNumber) continue

      // Only send reminders between 5 PM and 9 PM in the business timezone
      const tz = appt.businesses?.timezone || 'America/New_York'
      const localHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()))
      if (localHour < 17 || localHour >= 21) {
        continue // Skip — will pick up on the next hourly run when it's the right time
      }

      // Check if customer has fully opted out — skip reminders but NOT marketing opt-out
      const { data: customer } = await sb.from('customers')
        .select('fully_opted_out, opted_out')
        .eq('business_id', appt.business_id)
        .eq('phone', appt.customer_phone)
        .maybeSingle()
      if (customer?.fully_opted_out || customer?.opted_out) {
        console.log(`[Reminder] Skipping ${appt.customer_phone} — fully opted out`)
        await db.updateAppointment(appt.id, { reminder_sent: true }) // mark sent to avoid retry
        continue
      }

      const tz2 = appt.businesses?.timezone || 'America/New_York'
      const apptDate = new Date(appt.appointment_date + 'T12:00:00')
      const dayName = apptDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz2 })
      let msg = `Hi ${appt.customer_name}! 👋 Just a reminder about your appointment at ${bizName} tomorrow (${dayName}) at ${formatTime(appt.appointment_time)}. Reply YES to confirm or NO to cancel.`

      // For virtual businesses, include the meeting link right in the reminder
      // so the customer has it handy. Same link logic as booking confirmations.
      if (appt.businesses?.location_type === 'virtual' && appt.businesses?.meeting_link) {
        msg += `\n\n🎥 Join via video: ${appt.businesses.meeting_link}`
      }

      await sendSMS(bizNumber, appt.customer_phone, msg)
      await db.updateAppointment(appt.id, { reminder_sent: true })
      processed++
      console.log(`[Reminder] Sent to ${appt.customer_phone} for ${bizName} — appt ${appt.appointment_date}`)
    } catch (err) {
      console.error(`[Reminder] Failed for appointment ${appt.id}:`, err.message)
    }
  }

  console.log(`[Scheduler] Reminders done — ${processed} sent of ${appointments.length} candidates`)
}

// ── Send post-visit follow-ups via EMAIL (run hourly) ───────────────────────
// Switched from SMS to email for cost reasons — Twilio was charging us per
// follow-up per completed appointment, adding up to hundreds of dollars/month
// at scale. Email is free at our volume and arguably handles the review-link
// CTA BETTER than SMS (clickable button, room for proper framing).
//
// Per-business toggle: businesses.followup_enabled (default true). Owners who
// don't want post-visit emails sent at all can flip it off in the dashboard.
async function sendFollowUps() {
  console.log('[Scheduler] Running post-visit follow-ups (email)...')
  const appointments = await db.getAppointmentsNeedingFollowup()
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendPostVisitEmail } = require('../utils/emailService')

  let sent = 0, skipped = 0

  for (const appt of appointments) {
    try {
      const bizName = appt.businesses?.business_name
      // Fetch the fields we need from businesses in one shot
      const { data: biz } = await sb
        .from('businesses')
        .select('google_review_link, postvisit_review_enabled, profile_slug')
        .eq('id', appt.business_id)
        .maybeSingle()

      // Owner opted out at business level — mark sent so we don't reconsider,
      // then move on. (postvisit_review_enabled defaults to TRUE on existing
      // rows because the column was added with that default. If the column
      // doesn't exist on a particular business, the value is undefined and
      // we treat that as enabled — preserves backwards compat.)
      if (biz?.postvisit_review_enabled === false) {
        await db.updateAppointment(appt.id, { followup_sent: true })
        skipped++
        continue
      }

      // Find the customer's email. The appointments table doesn't include
      // customer_email at booking time (it's only set retroactively in a few
      // flows). The customers table — written via upsert on every booking —
      // is the reliable source. Check appt first as a cheap shortcut anyway.
      let customerEmail = appt.customer_email
      if (!customerEmail) {
        const { data: customer } = await sb
          .from('customers')
          .select('email')
          .eq('business_id', appt.business_id)
          .eq('phone', appt.customer_phone)
          .maybeSingle()
        customerEmail = customer?.email
      }

      // No email on file → skip entirely. We do NOT fall back to SMS — that
      // would defeat the cost-save purpose. Mark sent to prevent retry next
      // hour. Log so the owner can see in Render logs that they're missing
      // emails on their customers (drives them to start collecting it).
      if (!customerEmail) {
        await db.updateAppointment(appt.id, { followup_sent: true })
        console.log(`[Follow-up] Skipped ${appt.customer_phone} — no email on file for customer (${bizName})`)
        skipped++
        continue
      }

      await sendPostVisitEmail({
        customerEmail,
        customerName: appt.customer_name,
        businessName: bizName,
        businessSlug: biz?.profile_slug,
        reviewLink: biz?.google_review_link?.trim()
      })
      await db.updateAppointment(appt.id, { followup_sent: true })
      sent++
      console.log(`[Follow-up] Emailed ${customerEmail} for ${bizName}${biz?.google_review_link ? ' (with review CTA)' : ''}`)
    } catch (err) {
      console.error(`[Follow-up] Failed for appointment ${appt.id}:`, err.message)
    }
  }

  console.log(`[Scheduler] Follow-ups done — ${sent} emailed, ${skipped} skipped, ${appointments.length} total candidates`)
}

// ── Schedule both (simple interval-based, no cron needed) ────────────────────
function startScheduler() {
  // Run reminders immediately on startup
  sendReminders().catch(console.error)
  checkDepositReminders().catch(console.error)
  sendSetupCallReminders().catch(console.error)

  // Reminders — check every hour around the clock
  setInterval(() => sendReminders().catch(console.error), 60 * 60 * 1000)

  // Deposit reminders — check every 30 minutes around the clock
  setInterval(() => checkDepositReminders().catch(console.error), 30 * 60 * 1000)

  // Setup call reminders — check every 15 minutes
  setInterval(() => sendSetupCallReminders().catch(console.error), 15 * 60 * 1000)

  // Abandoned booking recovery — every 2 hours
  sendAbandonedBookingReminders().catch(console.error)
  setInterval(() => sendAbandonedBookingReminders().catch(console.error), 2 * 60 * 60 * 1000)

  // Quote follow-up reminders — every 2 hours
  sendQuoteReminders().catch(console.error)
  setInterval(() => sendQuoteReminders().catch(console.error), 2 * 60 * 60 * 1000)

  // Abandoned signup cart recovery — every hour
  sendAbandonedCartEmails().catch(console.error)
  setInterval(() => sendAbandonedCartEmails().catch(console.error), 60 * 60 * 1000)

  // Abandoned checkout recovery (signed up but never paid) — every hour
  sendAbandonedCheckoutEmails().catch(console.error)
  setInterval(() => sendAbandonedCheckoutEmails().catch(console.error), 5 * 60 * 1000)

  // SMS tip prompts — restart-safe fallback (🔒 Entry 56). The 10-min setTimeout
  // in tipFlow handles the normal case; this sweep catches prompts orphaned by a
  // process restart and sends the payment link with no tip. Every 5 min.
  {
    const { sweepExpiredTipPrompts } = require('./tipFlow')
    sweepExpiredTipPrompts().catch(console.error)
    setInterval(() => sweepExpiredTipPrompts().catch(console.error), 5 * 60 * 1000)
  }

  // Follow-ups — check every hour
  setInterval(() => sendFollowUps().catch(console.error), 60 * 60 * 1000)

  // Daily digest — check every 10 minutes for accuracy
  setInterval(() => sendDailyDigests().catch(console.error), 10 * 60 * 1000)

  // 🔒 v190 Instant-trial drip — services nudge, interview offer, bio nudge,
  // first-booking note, day-7/13 card asks, expiry, dead-number recycling.
  // Every 10 min; the module is idempotent (one send per step per business).
  const { runTrialOnboardingDrip } = require('./trialOnboarding')
  setTimeout(() => runTrialOnboardingDrip().catch(console.error), 45 * 1000)
  setInterval(() => runTrialOnboardingDrip().catch(console.error), 10 * 60 * 1000)

  // 🔒 v191 Owner reminders ("remind me tomorrow at 9...") — every 2 min
  setInterval(() => sendOwnerReminders().catch(console.error), 60 * 1000)

  // Daily automations — check every hour at 8am PT
  setInterval(() => {
    const ptHour = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false
    }).format(new Date()))
    if (ptHour === 8) {
      runCustomAutomations().catch(console.error)
      sendRebookingReminders().catch(console.error)
      sendSmartRebookingReminders().catch(console.error)
      sendCancellationRebooking().catch(console.error)
      sendBirthdayMessages().catch(console.error)
    }
  }, 60 * 60 * 1000)

  console.log('[Scheduler] Started — all automations running')
}

// ── Setup call reminders ──────────────────────────────────────────────────────
// Fires 1 hour before each call — emails owner, texts + emails customer
async function sendSetupCallReminders() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendEmail } = require('../utils/emailService')

  const now = new Date()
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000)
  const oneHourPlus15 = new Date(now.getTime() + 75 * 60 * 1000)

  // Find calls happening in ~1 hour that haven't been reminded yet
  const { data: calls } = await sb.from('setup_calls')
    .select('*')
    .eq('status', 'scheduled')
    .gte('scheduled_at', oneHourFromNow.toISOString())
    .lte('scheduled_at', oneHourPlus15.toISOString())
    .eq('reminder_sent', false)

  if (!calls?.length) return

  const { data: settingsRow } = await sb.from('admin_settings').select('value').eq('key', 'call_settings').maybeSingle()
  const settings = settingsRow?.value || {}
  const zoomLink = settings.zoom_link || ''
  const ownerEmail = process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'

  for (const call of calls) {
    try {
      const dt = new Date(call.scheduled_at)
      const dateStr = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

      // Email customer reminder
      if (call.email) {
        await sendEmail({
          to: call.email,
          subject: `⏰ Reminder — your Wexly setup call is in 1 hour`,
          html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:40px auto;">
            <h2 style="font-size:20px;color:#0F0F0E;">Your setup call is in 1 hour, ${call.name.split(' ')[0]}!</h2>
            <p style="font-size:14px;color:#7A7972;">${dateStr} at ${timeStr}</p>
            ${zoomLink ? `<a href="${zoomLink}" style="display:inline-block;margin-top:12px;background:#1A6B4A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">Join Zoom call →</a>` : ''}
            <p style="font-size:13px;color:#7A7972;margin-top:16px;">See you in a bit!</p>
          </div>`
        }).catch(() => {})
      }

      // Email owner reminder
      await sendEmail({
        to: ownerEmail,
        subject: `⏰ Setup call in 1 hour — ${call.name} · ${timeStr}`,
        html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:480px;margin:40px auto;">
          <h2 style="font-size:20px;color:#0F0F0E;">Setup call in 1 hour</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
            <tr><td style="padding:6px 0;color:#7A7972;width:100px;">Name</td><td style="font-weight:500;">${call.name}</td></tr>
            <tr><td style="padding:6px 0;color:#7A7972;">Business</td><td>${call.business_name || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#7A7972;">Email</td><td>${call.email}</td></tr>
            <tr><td style="padding:6px 0;color:#7A7972;">Phone</td><td>${call.phone || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#7A7972;">Time</td><td style="font-weight:500;color:#1A6B4A;">${timeStr}</td></tr>
          </table>
          ${zoomLink ? `<a href="${zoomLink}" style="display:inline-block;background:#1A6B4A;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px;">Join Zoom →</a>` : ''}
        </div>`
      }).catch(() => {})

      // Mark reminder sent
      await sb.from('setup_calls').update({ reminder_sent: true }).eq('id', call.id)
      console.log(`[SetupCalls] Reminder sent for ${call.name} at ${timeStr}`)
    } catch (err) {
      console.error(`[SetupCalls] Reminder failed for ${call.id}:`, err.message)
    }
  }
}

module.exports = { sendReminders, sendFollowUps, sendDailyDigests, checkNoShows, runCustomAutomations, sendRebookingReminders, sendSmartRebookingReminders, sendCancellationRebooking, sendBirthdayMessages, sendNoShowRecovery, checkDepositReminders, sendSetupCallReminders, sendAbandonedBookingReminders, sendQuoteReminders, sendAbandonedCartEmails, sendAbandonedCheckoutEmails, startScheduler }

// ── Daily digest — sent to Pro plan owners every morning ──────────────────────
async function sendDailyDigests() {
  console.log('[Scheduler] Running daily digests...')
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { data: businesses } = await sb
    .from('businesses')
    .select('*')
    .in('status', ['trial', 'active']) // include trial accounts

  if (!businesses?.length) return

  const now = new Date()
  const { sendDailyDigestEmail } = require('../utils/emailService')

  for (const biz of businesses) {
    const proSettings = biz.pro_settings || {}
    const notifs = proSettings.notifications || {}
    // Daily digest only for Standard and Pro (not Solo)
    if (biz.plan === 'solo') continue
    if (notifs.daily_digest === false) continue

    const digestTime = parseInt(notifs.digest_time || '8') // default 8am
    const tz = biz.timezone || 'America/Los_Angeles'

    try {
      // Get current hour and date in business's local timezone — that's it
      const localNow = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(now)

      const localHour = parseInt(localNow.find(p => p.type === 'hour')?.value || '0')
      const localMonth = localNow.find(p => p.type === 'month')?.value
      const localDay = localNow.find(p => p.type === 'day')?.value
      const localYear = localNow.find(p => p.type === 'year')?.value
      const today = `${localYear}-${localMonth}-${localDay}`

      // Only fire at the exact target hour
      console.log(`[Digest] ${biz.business_name} — local hour: ${localHour}, target: ${digestTime}, today: ${today}`)
      if (localHour !== digestTime) continue

      // Check if already sent today
      const { data: sentToday } = await sb.from('digest_log')
        .select('id').eq('business_id', biz.id).eq('date', today).maybeSingle()
      if (sentToday) continue

      const { data: todayAppts } = await sb.from('appointments')
        .select('*').eq('business_id', biz.id).eq('appointment_date', today).eq('status', 'confirmed')
      const { data: todayCancelled } = await sb.from('appointments')
        .select('*').eq('business_id', biz.id).eq('appointment_date', today).eq('status', 'cancelled')
      const { data: todayNoShows } = await sb.from('appointments')
        .select('*').eq('business_id', biz.id).eq('appointment_date', today).eq('status', 'no_show')
      const { data: flagged } = await sb.from('conversation_sessions')
        .select('*').eq('business_id', biz.id).eq('needs_attention', true)

      await sendDailyDigestEmail({
        email: biz.email,
        firstName: biz.owner_name?.split(' ')[0] || 'there',
        businessName: biz.business_name,
        todayBookings: todayAppts?.length || 0,
        todayCancellations: todayCancelled?.length || 0,
        todayNoShows: todayNoShows?.length || 0,
        flaggedConversations: flagged?.length || 0,
        appointments: todayAppts || []
      })

      // Auto-send schedule to staff — Standard and Pro only.
      // CHANNEL LOGIC (cost-optimized): we prefer email over SMS to keep Twilio
      // costs down. Per-staff `notify_via` field controls the channel:
      //   'email'      — send email only (default for new staff)
      //   'sms'        — legacy SMS-only
      //   'both'       — both channels (most expensive, only if owner picks it)
      //   'off' / null on auto_schedule=false — skip
      // If notify_via is undefined on existing records (pre-migration), pick the
      // best available channel: email if they have one, otherwise SMS.
      const staffMembers = biz.plan !== 'solo'
        ? (biz.staff_members || []).filter(s => s.auto_schedule)
        : []

      if (staffMembers.length) {
        const { sendStaffScheduleEmail } = require('../utils/emailService')
        const { sendSMS } = require('../utils/sms')
        const dt = new Date(today + 'T12:00:00')
        const dateLabel = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

        for (const staff of staffMembers) {
          // Filter to only THIS staff member's appointments
          const staffAppts = (todayAppts || [])
            .filter(a => a.staff_name === staff.name || a.staff_id === staff.name)
            .sort((a,b) => (a.appointment_time||'').localeCompare(b.appointment_time||''))

          // Pick channel. Explicit notify_via wins; otherwise default to email
          // when an email is available (cost-saver), SMS otherwise.
          let channel = staff.notify_via
          if (!channel) channel = staff.email ? 'email' : 'sms'

          const wantsEmail = (channel === 'email' || channel === 'both')
          const wantsSMS   = (channel === 'sms'   || channel === 'both')

          // Email path — free at our volume, preferred
          if (wantsEmail) {
            if (staff.email) {
              try {
                await sendStaffScheduleEmail({
                  staffEmail: staff.email,
                  staffName: staff.name,
                  businessName: biz.business_name,
                  dateLabel,
                  appointments: staffAppts
                })
              } catch (e) {
                console.error(`[Staff Schedule] Email failed to ${staff.email}:`, e.message)
              }
            } else {
              // Owner wanted email but didn't fill it in. Dashboard banner warns
              // them, but log here too so it's visible in Render logs.
              console.warn(`[Staff Schedule] ${staff.name} set to email-only but no email on file — skipped`)
            }
          }

          // SMS path — still supported for staff explicitly set to 'sms' or 'both'
          if (wantsSMS && staff.phone && biz.sms_number) {
            const scheduleText = staffAppts.length
              ? `📅 ${staff.name} — ${biz.business_name}\n${dateLabel}\n\n` +
                staffAppts.map(a =>
                  `${a.appointment_time?.slice(0,5)} — ${a.customer_name} · ${a.service_name}${a.notes ? '\n   📝 ' + a.notes : ''}`
                ).join('\n\n') +
                `\n\n${staffAppts.length} appointment${staffAppts.length !== 1 ? 's' : ''} today.`
              : `📅 ${staff.name} — ${biz.business_name}\n${dateLabel}\n\nNo appointments assigned to you today.`

            await sendSMS(biz.sms_number, staff.phone, scheduleText).catch(e =>
              console.error(`[Staff Schedule] SMS failed to ${staff.phone}:`, e.message)
            )
          }
        }
        console.log(`[Staff Schedule] Sent to ${staffMembers.length} staff for ${biz.business_name}`)
      }

      // Log that digest was sent today
      await sb.from('digest_log').insert({ business_id: biz.id, date: today })
      console.log(`[Digest] Sent to ${biz.business_name}`)
    } catch (err) {
      console.error(`[Digest] Failed for ${biz.business_name}:`, err.message)
    }
  }
}

// ── Custom automations — runs daily ──────────────────────────────────────────
async function runCustomAutomations() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  console.log('[Scheduler] Running custom automations...')

  // Get all active Pro businesses with their sequences
  const { data: sequences } = await sb
    .from('followup_sequences')
    .select('*, businesses(*)')
    .eq('active', true)

  if (!sequences?.length) return

  const today = new Date()
  let fired = 0

  for (const seq of sequences) {
    const biz = seq.businesses
    if (!biz || biz.plan !== 'pro' || !['trial','active'].includes(biz.status)) continue
    if (!biz.sms_number) continue

    try {
      if (seq.trigger_type === 'after_appointment') {
        // Fire X hours after confirmed appointments that haven't had a followup
        const hoursAgo = new Date(today - seq.delay_hours * 60 * 60 * 1000)
        const { data: appts } = await sb.from('appointments')
          .select('*')
          .eq('business_id', biz.id)
          .eq('status', 'confirmed')
          .eq('followup_sent', false)
          .lte('created_at', hoursAgo.toISOString())
          .gte('appointment_date', new Date(today - 7 * 86400000).toISOString().split('T')[0])

        for (const appt of (appts || [])) {
          const msg = buildAutomationMessage(seq.message, appt.customer_name, biz.business_name)
          if (!msg) continue
          await sendSMS(biz.sms_number, appt.customer_phone, msg)
          await sb.from('appointments').update({ followup_sent: true }).eq('id', appt.id)
          fired++
        }

      } else if (seq.trigger_type === 'no_show') {
        // Fire X hours after a no_show appointment
        const hoursAgo = new Date(today - seq.delay_hours * 60 * 60 * 1000)
        const { data: appts } = await sb.from('appointments')
          .select('*')
          .eq('business_id', biz.id)
          .eq('status', 'no_show')
          .lte('updated_at', hoursAgo.toISOString())
          .gte('appointment_date', new Date(today - 7 * 86400000).toISOString().split('T')[0])

        for (const appt of (appts || [])) {
          const msg = buildAutomationMessage(seq.message, appt.customer_name, biz.business_name)
          if (!msg) continue
          await sendSMS(biz.sms_number, appt.customer_phone, msg)
          fired++
        }

      } else if (seq.trigger_type === 'no_booking_days') {
        // Fire when a customer hasn't booked in X days
        const daysAgo = new Date(today - seq.delay_hours * 24 * 60 * 60 * 1000)
        // Find customers with a last appointment older than X days and no recent booking
        const { data: appts } = await sb.from('appointments')
          .select('customer_phone, customer_name, appointment_date')
          .eq('business_id', biz.id)
          .eq('status', 'confirmed')
          .lte('appointment_date', daysAgo.toISOString().split('T')[0])
          .order('appointment_date', { ascending: false })

        // Dedupe by phone — only send to each customer once
        const seen = new Set()
        for (const appt of (appts || [])) {
          if (seen.has(appt.customer_phone)) continue
          seen.add(appt.customer_phone)
          const msg = buildAutomationMessage(seq.message, appt.customer_name, biz.business_name)
          if (!msg) continue
          await sendSMS(biz.sms_number, appt.customer_phone, msg)
          fired++
        }

      } else if (seq.trigger_type === 'months_since_last') {
        // Fire X months after last visit
        const monthsAgo = new Date(today)
        monthsAgo.setMonth(monthsAgo.getMonth() - Math.floor(seq.delay_hours / 30))
        const targetDate = monthsAgo.toISOString().split('T')[0]

        const { data: appts } = await sb.from('appointments')
          .select('customer_phone, customer_name, appointment_date')
          .eq('business_id', biz.id)
          .eq('status', 'confirmed')
          .eq('appointment_date', targetDate)
          .order('appointment_date', { ascending: false })

        for (const appt of (appts || [])) {
          const msg = buildAutomationMessage(seq.message, appt.customer_name, biz.business_name)
          if (!msg) continue
          await sendSMS(biz.sms_number, appt.customer_phone, msg)
          fired++
        }
      }

    } catch (err) {
      console.error(`[Automations] Failed for seq ${seq.id}:`, err.message)
    }
  }

  console.log(`[Scheduler] Custom automations done — ${fired} messages sent`)
}

function buildAutomationMessage(template, customerName, businessName) {
  if (!template?.trim()) return null
  return template
    .replace(/\{name\}/gi, customerName || 'there')
    .replace(/\{business\}/gi, businessName || 'us')
}

// ── Standard rebooking reminders (all plans) ──────────────────────────────────
// Fires X weeks after last completed appointment — simple fixed interval
async function sendRebookingReminders() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  console.log('[Scheduler] Running rebooking reminders...')

  // Get all active businesses
  const { data: businesses } = await sb.from('businesses')
    .select('*')
    .in('status', ['trial', 'active'])
    .not('sms_number', 'is', null)

  if (!businesses?.length) return
  let sent = 0

  for (const biz of businesses) {
    try {
      const rebookWeeks = biz.rebook_interval_weeks || 6 // default 6 weeks
      if (!biz.rebook_enabled) continue

      const targetDate = new Date()
      targetDate.setDate(targetDate.getDate() - (rebookWeeks * 7))
      const targetStr = targetDate.toISOString().split('T')[0]

      // Find customers whose last appointment was exactly X weeks ago
      const { data: appts } = await sb.from('appointments')
        .select('customer_phone, customer_name, service_name, appointment_date')
        .eq('business_id', biz.id)
        .eq('status', 'confirmed')
        .eq('appointment_date', targetStr)
        .eq('rebook_sent', false)

      const seen = new Set()
      for (const appt of (appts || [])) {
        if (seen.has(appt.customer_phone)) continue
        seen.add(appt.customer_phone)

        const firstName = appt.customer_name?.split(' ')[0] || 'there'
        const service = appt.service_name || 'appointment'
        const msg = `Hey ${firstName}! 👋 It's been ${rebookWeeks} weeks since your last ${service} at ${biz.business_name}. Want to get back on the books? Just text back with a day that works!`

        await sendSMS(biz.sms_number, appt.customer_phone, msg)
        await sb.from('appointments').update({ rebook_sent: true }).eq('id', appt.id)
        sent++
        await new Promise(r => setTimeout(r, 200))
      }
    } catch (err) {
      console.error(`[Rebook] Failed for ${biz.business_name}:`, err.message)
    }
  }

  console.log(`[Scheduler] Rebooking reminders done — ${sent} sent`)
}

// ── Pro: smart per-service rebooking ─────────────────────────────────────────
// Uses service-specific intervals set by the owner
async function sendSmartRebookingReminders() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  console.log('[Scheduler] Running smart rebooking reminders...')

  const { data: businesses } = await sb.from('businesses')
    .select('*')
    .eq('plan', 'pro')
    .in('status', ['trial', 'active'])
    .not('sms_number', 'is', null)

  if (!businesses?.length) return
  let sent = 0

  for (const biz of businesses) {
    try {
      const serviceIntervals = biz.service_rebook_intervals || {} // { "Haircut": 6, "Color": 8, "Cleaning": 26 }
      if (!Object.keys(serviceIntervals).length) continue

      for (const [serviceName, weeks] of Object.entries(serviceIntervals)) {
        const targetDate = new Date()
        targetDate.setDate(targetDate.getDate() - (weeks * 7))
        const targetStr = targetDate.toISOString().split('T')[0]

        const { data: appts } = await sb.from('appointments')
          .select('customer_phone, customer_name, service_name, appointment_date')
          .eq('business_id', biz.id)
          .eq('status', 'confirmed')
          .ilike('service_name', `%${serviceName}%`)
          .eq('appointment_date', targetStr)
          .eq('smart_rebook_sent', false)

        const seen = new Set()
        for (const appt of (appts || [])) {
          if (seen.has(appt.customer_phone)) continue
          seen.add(appt.customer_phone)

          const firstName = appt.customer_name?.split(' ')[0] || 'there'
          const msg = `Hey ${firstName}! It's been ${weeks} weeks since your ${serviceName} at ${biz.business_name} — time to book your next one! 😊 Just text back with a day that works.`

          await sendSMS(biz.sms_number, appt.customer_phone, msg)
          await sb.from('appointments').update({ smart_rebook_sent: true }).eq('id', appt.id)
          sent++
          await new Promise(r => setTimeout(r, 200))
        }
      }
    } catch (err) {
      console.error(`[SmartRebook] Failed for ${biz.business_name}:`, err.message)
    }
  }

  console.log(`[Scheduler] Smart rebooking done — ${sent} sent`)
}

// ── Smart rebooking after cancellation ───────────────────────────────────────
// When an appointment is cancelled, bot texts 24hrs later offering to rebook
async function sendCancellationRebooking() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  console.log('[Scheduler] Running cancellation rebooking...')

  const oneDayAgo = new Date()
  oneDayAgo.setHours(oneDayAgo.getHours() - 24)

  const { data: appts } = await sb.from('appointments')
    .select('*, businesses(*)')
    .eq('status', 'cancelled')
    .gte('updated_at', oneDayAgo.toISOString())
    .lte('updated_at', new Date().toISOString())
    .eq('cancel_rebook_sent', false)

  if (!appts?.length) return
  let sent = 0

  for (const appt of appts) {
    const biz = appt.businesses
    if (!biz || !['trial', 'active'].includes(biz.status)) continue
    if (!biz.sms_number) continue
    if (!biz.cancel_rebook_enabled) continue

    try {
      const firstName = appt.customer_name?.split(' ')[0] || 'there'
      const service = appt.service_name || 'appointment'
      const botName = biz.bot_name || biz.business_name

      const msg = `Hey ${firstName}! We noticed you cancelled your ${service} at ${biz.business_name}. No worries — whenever you're ready to rebook just text back and we'll get you set up! 😊`

      await sendSMS(biz.sms_number, appt.customer_phone, msg)
      await sb.from('appointments').update({ cancel_rebook_sent: true }).eq('id', appt.id)
      sent++
      await new Promise(r => setTimeout(r, 200))
    } catch (err) {
      console.error(`[CancelRebook] Failed for ${appt.customer_name}:`, err.message)
    }
  }

  console.log(`[Scheduler] Cancellation rebooking done — ${sent} sent`)
}

// ── Birthday messages ─────────────────────────────────────────────────────────
async function sendBirthdayMessages() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const today = new Date()
  const month = today.getMonth() + 1
  const day = today.getDate()
  console.log('[Scheduler] Running birthday messages...')

  const { data: businesses } = await sb.from('businesses')
    .select('*').in('status', ['trial', 'active']).eq('birthday_enabled', true).not('sms_number', 'is', null)

  if (!businesses?.length) return
  let sent = 0

  for (const biz of businesses) {
    try {
      const { data: customers } = await sb.from('customers')
        .select('*').eq('business_id', biz.id).not('birthday', 'is', null)

      for (const customer of (customers || [])) {
        if (!customer.birthday) continue
        const bday = new Date(customer.birthday)
        if (bday.getMonth() + 1 !== month || bday.getDate() !== day) continue

        const firstName = customer.name?.split(' ')[0] || 'there'
        const offer = biz.birthday_offer ? ` ${biz.birthday_offer}` : ''
        const msg = biz.birthday_message
          ? biz.birthday_message.replace('{name}', firstName).replace('{offer}', offer)
          : `Happy Birthday ${firstName}! 🎂 The whole team at ${biz.business_name} is wishing you an amazing day!${offer ? ` As a birthday gift, ${offer} — just mention this text when you book! 🎁` : ''}`

        await sendSMS(biz.sms_number, customer.phone, msg)
        sent++
        await new Promise(r => setTimeout(r, 200))
      }
    } catch (err) {
      console.error(`[Birthday] Failed for ${biz.business_name}:`, err.message)
    }
  }
  console.log(`[Scheduler] Birthday messages done — ${sent} sent`)
}

// ── No-show recovery texts ────────────────────────────────────────────────────
// ── DEPOSIT REMINDERS & AUTO-CANCEL ─────────────────────────────────────────
// Runs every 30 minutes.
// At 2 hours: sends customer a reminder with the deposit link
// At 3 hours: alerts owner — manually confirm or let it auto-cancel in 1 hour
// At 4 hours: cancels the appointment and notifies the customer
async function checkDepositReminders() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendSMS } = require('../utils/sms')
  const now = new Date()

  // Find all appointments still in deposit_pending status
  const { data: appts } = await sb.from('appointments')
    .select('*, businesses(sms_number, business_name, owner_phone)')
    .eq('status', 'deposit_pending')
    .eq('deposit_status', 'pending')
    .not('deposit_expires_at', 'is', null)

  if (!appts?.length) return

  for (const appt of appts) {
    const biz = appt.businesses
    if (!biz?.sms_number) continue

    const expiresAt = new Date(appt.deposit_expires_at)
    const createdAt = new Date(appt.created_at)
    const msRemaining = expiresAt - now
    const msSinceCreated = now - createdAt

    const customerPhone = appt.customer_phone
    const firstName = appt.customer_name?.split(' ')[0] || 'there'
    const fullName = appt.customer_name || 'A customer'
    const service = appt.service_name || 'appointment'

    // Format appointment date/time nicely for owner messages
    const apptDate = appt.appointment_date || ''
    const apptTime = appt.appointment_time ? (() => {
      const [h, m] = appt.appointment_time.split(':')
      const hr = parseInt(h)
      return `${hr > 12 ? hr - 12 : hr || 12}:${m}${hr >= 12 ? 'pm' : 'am'}`
    })() : ''

    // ── Already expired → cancel ──────────────────────────────────────────
    if (msRemaining <= 0) {
      try {
        await sb.from('appointments')
          .update({ status: 'cancelled', deposit_status: 'expired' })
          .eq('id', appt.id)

        await sendSMS(biz.sms_number, customerPhone,
          `Hey ${firstName}! Unfortunately we had to release your ${service} slot at ${biz.business_name} since the deposit window closed. Totally understand life gets busy — whenever you're ready to rebook just text us back and we'll get you sorted right away! 😊`
        )

        console.log(`[Deposit] Auto-cancelled appt ${appt.id} — deposit not received in time`)
      } catch (err) {
        console.error('[Deposit] Auto-cancel error:', err.message)
      }
      continue
    }

    // ── 2-hour reminder — send once, between 1h45m and 2h15m after booking ──
    const twoHourWindow = msSinceCreated >= 1.75 * 60 * 60 * 1000 && msSinceCreated <= 2.25 * 60 * 60 * 1000
    if (twoHourWindow && !appt.deposit_reminder_sent) {
      try {
        const depositLink = appt.deposit_link
        if (depositLink) {
          // Shorten before SMS — saves segments. Falls back to long URL on failure.
          const { shortenUrl } = require('../utils/shortener')
          const payUrl = await shortenUrl(depositLink, {
            appointmentId: appt.id,
            businessId: biz.id
          })
          await sendSMS(biz.sms_number, customerPhone,
            `Hey ${firstName}! Just a quick heads up — we're still holding your ${service} at ${biz.business_name}, but we do need the deposit to officially lock it in. You've got a couple hours left before the slot opens back up.\n\nPay here whenever you're ready: ${payUrl} 🙏`
          )
          await sb.from('appointments').update({ deposit_reminder_sent: true }).eq('id', appt.id)
          console.log(`[Deposit] 2hr reminder sent — appt ${appt.id}`)
        }
      } catch (err) {
        console.error('[Deposit] 2hr reminder error:', err.message)
      }
    }

    // ── 3-hour owner alert — send once, between 2h45m and 3h15m after booking ──
    const threeHourWindow = msSinceCreated >= 2.75 * 60 * 60 * 1000 && msSinceCreated <= 3.25 * 60 * 60 * 1000
    if (threeHourWindow && !appt.deposit_owner_alerted && biz.owner_phone) {
      try {
        await sendSMS(biz.sms_number, biz.owner_phone,
          `⚠️ Deposit alert: ${fullName} booked a ${service} on ${apptDate} at ${apptTime} but hasn't paid the deposit yet.\n\nThe slot will auto-cancel in 1 hour unless you step in.\n\nReply:\n"Confirm ${firstName}" — to approve them without a deposit\n"Cancel ${firstName}" — to cancel now`
        )
        await sb.from('appointments').update({ deposit_owner_alerted: true }).eq('id', appt.id)
        console.log(`[Deposit] 3hr owner alert sent — appt ${appt.id}`)
      } catch (err) {
        console.error('[Deposit] 3hr owner alert error:', err.message)
      }
    }
  }
}

// No-show recovery is intentionally NOT automated.
// It only fires when the admin manually marks an appointment as no-show
// from the dashboard or via owner SMS command ("mark X as no-show").
// This prevents false positives for walk-ins, Zoom calls, etc.
async function sendNoShowRecovery() {
  // Intentionally empty — do not add auto-detection here
}

async function checkNoShows() {
  // Intentionally empty — do not add auto-detection here
}

// ── ABANDONED BOOKING RECOVERY ───────────────────────────────────────────────
async function sendAbandonedBookingReminders() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendSMS } = require('../utils/sms')

  // Find conversations that had activity 2-24 hours ago
  const now = new Date()
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const { data: sessions, error: sessErr } = await sb.from('conversation_sessions')
    .select('*')
    .lt('last_activity', twoHoursAgo)
    .gt('last_activity', twentyFourHoursAgo)
    .eq('abandoned_reminder_sent', false)

  if (sessErr) {
    // Column might not exist yet — silently skip
    if (sessErr.message?.includes('abandoned_reminder_sent')) return
    console.error('[Abandoned] Query error:', sessErr.message)
    return
  }
  if (!sessions?.length) return
  let sent = 0

  for (const session of sessions) {
    try {
      // Look up business separately (no FK dependency)
      const { data: biz } = await sb.from('businesses')
        .select('sms_number, business_name, timezone, plan, bot_name')
        .eq('id', session.business_id)
        .maybeSingle()
      if (!biz?.sms_number) continue
      if (biz.plan !== 'pro') continue

      // Only send between 10 AM and 8 PM in business timezone
      const tz = biz.timezone || 'America/New_York'
      const localHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now))
      if (localHour < 10 || localHour >= 20) continue

      // Check if customer is opted out
      const { data: cust } = await sb.from('customers')
        .select('fully_opted_out, marketing_opted_out')
        .eq('business_id', session.business_id)
        .eq('phone', session.customer_phone)
        .maybeSingle()
      if (cust?.fully_opted_out || cust?.marketing_opted_out) {
        await sb.from('conversation_sessions').update({ abandoned_reminder_sent: true }).eq('id', session.id)
        continue
      }

      // Check if they actually booked — if so, no reminder needed
      const { data: appts } = await sb.from('appointments')
        .select('id')
        .eq('business_id', session.business_id)
        .eq('customer_phone', session.customer_phone)
        .in('status', ['confirmed', 'pending_approval', 'quote_sent'])
        .limit(1)

      if (appts?.length > 0) {
        await sb.from('conversation_sessions').update({ abandoned_reminder_sent: true }).eq('id', session.id)
        continue
      }

      // Check conversation has enough messages (not just a STOP/HELP)
      const msgs = session.messages || []
      if (msgs.length < 3) {
        await sb.from('conversation_sessions').update({ abandoned_reminder_sent: true }).eq('id', session.id)
        continue
      }

      const botName = biz.bot_name || biz.business_name
      const msg = `Hey! It's ${botName} 😊 Looks like we were chatting about booking — just wanted to follow up! If you're still interested, text us back and I'll get you on the schedule. No rush! Reply STOP to opt out.`

      await sendSMS(biz.sms_number, session.customer_phone, msg)
      await sb.from('conversation_sessions').update({ abandoned_reminder_sent: true }).eq('id', session.id)
      sent++
      console.log(`[Abandoned] Sent recovery to ${session.customer_phone} for ${biz.business_name}`)
    } catch(err) {
      console.error(`[Abandoned] Error:`, err.message)
    }
  }
  if (sent > 0) console.log(`[Scheduler] Abandoned booking reminders — ${sent} sent`)
}

// ── UNANSWERED QUOTE REMINDERS ──────────────────────────────────────────────
async function sendQuoteReminders() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendSMS } = require('../utils/sms')
  const now = new Date()

  // Find quote_sent appointments created 4-72 hours ago with no response
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString()
  const seventyTwoHoursAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString()

  const { data: appts, error: qErr } = await sb.from('appointments')
    .select('*')
    .eq('status', 'quote_sent')
    .eq('quote_reminder_sent', false)
    .lt('created_at', fourHoursAgo)
    .gt('created_at', seventyTwoHoursAgo)

  if (qErr) {
    if (qErr.message?.includes('quote_reminder_sent')) return
    console.error('[QuoteReminder] Query error:', qErr.message)
    return
  }
  if (!appts?.length) return
  let sent = 0

  for (const appt of appts) {
    try {
      // Look up business separately
      const { data: biz } = await sb.from('businesses')
        .select('sms_number, business_name, timezone, plan')
        .eq('id', appt.business_id)
        .maybeSingle()
      if (!biz?.sms_number) continue
      if (biz.plan !== 'pro') continue

      const tz = biz.timezone || 'America/New_York'
      const localHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now))
      if (localHour < 10 || localHour >= 20) continue

      // Check opt-out
      const { data: cust } = await sb.from('customers')
        .select('fully_opted_out')
        .eq('business_id', appt.business_id)
        .eq('phone', appt.customer_phone)
        .maybeSingle()
      if (cust?.fully_opted_out) {
        await sb.from('appointments').update({ quote_reminder_sent: true }).eq('id', appt.id)
        continue
      }

      const firstName = appt.customer_name?.split(' ')[0] || 'there'
      const quoteAmount = (appt.notes || '').match(/Quote: (\$[\d,.]+)/)?.[1] || ''
      const msg = `Hey ${firstName}! Just following up on your ${appt.service_name || 'appointment'} quote${quoteAmount ? ' of ' + quoteAmount : ''}. Would you like to go ahead and book? Just reply YES to confirm or text us with any questions. Reply STOP to opt out.`

      await sendSMS(biz.sms_number, appt.customer_phone, msg)
      await sb.from('appointments').update({ quote_reminder_sent: true }).eq('id', appt.id)
      sent++
      console.log(`[QuoteReminder] Sent to ${appt.customer_phone} for ${biz.business_name}`)
    } catch(err) {
      console.error(`[QuoteReminder] Error:`, err.message)
    }
  }
  if (sent > 0) console.log(`[Scheduler] Quote reminders — ${sent} sent`)
}

// ── ABANDONED SIGNUP CART RECOVERY ──────────────────────────────────────────
async function sendAbandonedCartEmails() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendEmail } = require('../utils/emailService')
  const now = new Date()

  // Get all unconverted pending signups
  const { data: leads, error } = await sb.from('pending_signups')
    .select('*')
    .eq('converted', false)
    .lt('captured_at', new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString()) // At least 1hr old

  if (error || !leads?.length) return
  let sent = 0

  for (const lead of leads) {
    try {
      // Check if they signed up since capture
      const { data: biz } = await sb.from('businesses').select('id').eq('email', lead.email).maybeSingle()
      if (biz) {
        await sb.from('pending_signups').update({ converted: true }).eq('id', lead.id)
        continue
      }

      const hoursSince = (now - new Date(lead.captured_at)) / (1000 * 60 * 60)
      const emailsSent = lead.emails_sent || 0
      const firstName = (lead.name || '').split(' ')[0] || 'there'

      // Email 1: 1-2 hours after (if 0 emails sent)
      if (hoursSince >= 1 && hoursSince < 24 && emailsSent === 0) {
        await sendEmail({
          to: lead.email,
          from: 'hello@getwexly.com',
          subject: `${firstName}, your Wexly account is almost ready!`,
          html: buildCartEmail(firstName, lead, 1)
        })
        await sb.from('pending_signups').update({ emails_sent: 1, last_email_at: now.toISOString() }).eq('id', lead.id)
        sent++
        console.log(`[Cart] Email 1 sent to ${lead.email}`)
      }

      // Email 2: 24-48 hours after (if 1 email sent)
      else if (hoursSince >= 24 && hoursSince < 72 && emailsSent === 1) {
        await sendEmail({
          to: lead.email,
          from: 'hello@getwexly.com',
          subject: `Still thinking about it, ${firstName}?`,
          html: buildCartEmail(firstName, lead, 2)
        })
        await sb.from('pending_signups').update({ emails_sent: 2, last_email_at: now.toISOString() }).eq('id', lead.id)
        sent++
        console.log(`[Cart] Email 2 sent to ${lead.email}`)
      }

      // Email 3: 72+ hours after (if 2 emails sent) — final
      else if (hoursSince >= 72 && emailsSent === 2) {
        await sendEmail({
          to: lead.email,
          from: 'hello@getwexly.com',
          subject: `Last chance — your 14-day trial is waiting, ${firstName}`,
          html: buildCartEmail(firstName, lead, 3)
        })
        await sb.from('pending_signups').update({ emails_sent: 3, last_email_at: now.toISOString() }).eq('id', lead.id)
        sent++
        console.log(`[Cart] Email 3 (final) sent to ${lead.email}`)
      }
    } catch(err) {
      console.error(`[Cart] Error for ${lead.email}:`, err.message)
    }
  }
  if (sent > 0) console.log(`[Scheduler] Abandoned cart emails — ${sent} sent`)
}

function buildCartEmail(firstName, lead, emailNum) {
  const signupUrl = 'https://getwexly.com/signup.html'

  const subjects = {
    1: {
      headline: 'You were so close!',
      body: `You started setting up your booking receptionist — and we saved your spot. Your 14-day free trial is ready to go. No credit card charged until your trial ends.`,
      cta: 'Finish setting up →'
    },
    2: {
      headline: 'Your customers are still calling...',
      body: `While you're thinking about it, your competitors are booking clients 24/7 automatically. Wexly answers every text, books every appointment, and never takes a day off. Most businesses set up in under 10 minutes.`,
      cta: 'Start your free trial →'
    },
    3: {
      headline: 'Final nudge — then we\'ll leave you alone 😊',
      body: `We won't keep bugging you. But before we go: businesses using Wexly book 3x more appointments because they never miss a text. If now's not the right time, no worries — we'll be here when you're ready.`,
      cta: 'Try Wexly free for 14 days →'
    }
  }

  const s = subjects[emailNum]

  return `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;font-family:Arial,sans-serif;">
      <tr><td style="background:#0D9488;padding:24px 30px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;color:#fff;">Wexly</h1>
      </td></tr>
      <tr><td style="padding:30px;background:#ffffff;">
        <h2 style="margin:0 0 12px;font-size:22px;color:#111;">${s.headline}</h2>
        <p style="margin:0 0 20px;font-size:15px;color:#555;line-height:1.6;">Hey ${firstName}! ${s.body}</p>
        ${lead.business_name ? `<p style="margin:0 0 20px;font-size:14px;color:#888;">We had <strong>${lead.business_name}</strong> saved for you.</p>` : ''}
        <p style="margin:0;">
          <a href="${signupUrl}" style="display:inline-block;padding:14px 28px;background:#0D9488;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">${s.cta}</a>
        </p>
      </td></tr>
      <tr><td style="padding:20px 30px;background:#F3F2EE;border-radius:0 0 8px 8px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#999;">You're receiving this because you started signing up at getwexly.com.<br>We'll only send ${emailNum === 3 ? 'this last email' : 'a couple more'} — no spam, ever.</p>
        <p style="margin:8px 0 0;font-size:11px;"><a href="mailto:hello@getwexly.com?subject=Unsubscribe" style="color:#999;">Unsubscribe</a></p>
      </td></tr>
    </table>`
}

// ── ABANDONED CHECKOUT RECOVERY (signed up but never paid) ──────────────────
async function sendAbandonedCheckoutEmails() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendEmail } = require('../utils/emailService')
  const now = new Date()

  // Find businesses stuck in pending_checkout for 10+ minutes
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString()

  const { data: stuck, error } = await sb.from('businesses')
    .select('*')
    .eq('status', 'pending_checkout')
    .lt('created_at', tenMinAgo)

  if (error || !stuck?.length) return
  let sent = 0
  // Replies should come straight to Brandon's inbox.
  const REPLY_TO = 'info@getwexly.com'
  const FROM = { email: 'noreply@mail.getwexly.com', name: 'Brandon at Wexly' }

  for (const biz of stuck) {
    try {
      const emailsSent = biz.checkout_emails_sent || 0
      const minsSince = (now - new Date(biz.created_at)) / (1000 * 60)
      const hoursSince = minsSince / 60
      const firstName = (biz.owner_name || '').split(' ')[0] || 'there'
      // 🔒 Entry 58: accounts created inside the native app carry utm_source '<platform>_app'.
      // They're exploring the dashboard right now, so the first nudge waits 60 min instead of 10.
      const isApp = isAppSignup(biz)

      // Email 0: ~10 minutes after signup (fast nudge); 60 min for app signups
      if (minsSince >= (isApp ? 60 : 10) && emailsSent === 0) {
        await sendEmail({
          to: biz.email, from: FROM, replyTo: REPLY_TO,
          subject: `${firstName}, you can run ${biz.business_name || 'your business'} by text`,
          html: buildCheckoutEmail(firstName, biz, 0)
        })
        await sb.from('businesses').update({ checkout_emails_sent: 1 }).eq('id', biz.id)
        sent++
        console.log(`[Checkout Recovery] Email 0 (10-min) sent to ${biz.email}`)
      }
      // Email 1: 2-24 hours after signup
      else if (hoursSince >= 2 && hoursSince < 24 && emailsSent === 1) {
        await sendEmail({
          to: biz.email, from: FROM, replyTo: REPLY_TO,
          subject: `${firstName}, your front desk that runs by text is ready`,
          html: buildCheckoutEmail(firstName, biz, 1)
        })
        await sb.from('businesses').update({ checkout_emails_sent: 2 }).eq('id', biz.id)
        sent++
        console.log(`[Checkout Recovery] Email 1 sent to ${biz.email}`)
      }
      // Email 2: 24-72 hours
      else if (hoursSince >= 24 && hoursSince < 72 && emailsSent === 2) {
        await sendEmail({
          to: biz.email, from: FROM, replyTo: REPLY_TO,
          subject: `${firstName}, imagine texting your business instead of managing it`,
          html: buildCheckoutEmail(firstName, biz, 2)
        })
        await sb.from('businesses').update({ checkout_emails_sent: 3 }).eq('id', biz.id)
        sent++
        console.log(`[Checkout Recovery] Email 2 sent to ${biz.email}`)
      }
      // Email 3: 72+ hours — final
      else if (hoursSince >= 72 && emailsSent === 3) {
        await sendEmail({
          to: biz.email, from: FROM, replyTo: REPLY_TO,
          subject: `Last call, ${firstName} — your spot is still open`,
          html: buildCheckoutEmail(firstName, biz, 3)
        })
        await sb.from('businesses').update({ checkout_emails_sent: 4 }).eq('id', biz.id)
        sent++
        console.log(`[Checkout Recovery] Email 3 (final) sent to ${biz.email}`)
      }
    } catch(err) {
      console.error(`[Checkout Recovery] Error for ${biz.email}:`, err.message)
    }
  }
  if (sent > 0) console.log(`[Scheduler] Checkout recovery emails — ${sent} sent`)
}

function isAppSignup(biz) { return /_app$/i.test(String(biz?.utm_source || '')) }

// ── 🔒 v191 Reminders ────────────────────────────────────────────────────────
// Two kinds, one queue:
//   kind 'owner'    — "remind me tomorrow at 9 to call the supplier" (owner cell)
//   kind 'customer' — "remind me in 5 mins to book" (the client's own phone)
// Due rows are claimed (sent_at stamped) BEFORE sending so a slow Twilio call
// or an overlapping sweep can never text the same reminder twice.
async function sendOwnerReminders() {
  const sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { sendSMS } = require('../utils/sms')
  const { data: due, error } = await sb.from('owner_reminders')
    .select('id, message, business_id, kind, to_phone, created_at, businesses(sms_number, owner_phone, business_name, status, active, demo_mode)')
    .is('sent_at', null).is('cancelled_at', null)
    .lte('remind_at', new Date().toISOString())
    .order('remind_at').limit(50)
  if (error) { if (!/does not exist/i.test(error.message)) console.error('[Reminders] query failed:', error.message); return }
  if (!due?.length) return

  for (const r of due) {
    try {
      const biz = r.businesses
      const isCustomer = r.kind === 'customer' && r.to_phone
      const dest = isCustomer ? r.to_phone : biz?.owner_phone

      // Claim first — a reminder must never be able to send twice.
      const { data: claimed } = await sb.from('owner_reminders')
        .update({ sent_at: new Date().toISOString() }).eq('id', r.id).is('sent_at', null).select('id')
      if (!claimed?.length) continue
      if (!biz?.sms_number || !dest || biz.status === 'cancelled') continue

      if (isCustomer) {
        // The bot is silent for clients when paused or when billing has lapsed
        // (demo number excepted, same as the webhook). A reminder is still the
        // bot talking to a client, so it obeys the same rule. Owner reminders
        // are the owner's own tool and are not gated here.
        const silenced = biz.active === false ||
          (['past_due', 'pending_checkout', 'trial_expired'].includes(biz.status) && !biz.demo_mode)
        if (silenced) {
          console.log(`[Reminders] Skipped ${r.to_phone} — ${biz.business_name} bot is ${biz.active === false ? 'paused' : biz.status}`)
          continue
        }
        // Never text a customer who opted out since asking for the reminder.
        const { data: cust } = await sb.from('customers')
          .select('name, opted_out, fully_opted_out')
          .eq('business_id', r.business_id).eq('phone', r.to_phone).maybeSingle()
        if (cust?.opted_out || cust?.fully_opted_out) {
          console.log(`[Reminders] Skipped ${r.to_phone} — opted out`)
          continue
        }
        // If they already booked after setting it, the reminder is now noise.
        const { data: booked } = await sb.from('appointments')
          .select('id').eq('business_id', r.business_id).eq('customer_phone', r.to_phone)
          .in('status', ['confirmed', 'pending', 'pending_approval'])
          .gt('created_at', r.created_at).limit(1)
        if (booked?.length) {
          console.log(`[Reminders] Skipped ${r.to_phone} — already booked since setting it`)
          continue
        }
        const first = (cust?.name || '').split(' ')[0]
        const aboutBooking = /\b(book|appoint|schedul|resched|slot|time|visit|session|come in)/i.test(r.message)
        await sendSMS(biz.sms_number, r.to_phone,
          `Hi${first ? ' ' + first : ''}! You asked me to remind you to ${r.message}.${aboutBooking ? ' Want me to find you a time?' : ''}`)
        console.log(`[Reminders] Customer reminder sent to ${r.to_phone} (${biz.business_name})`)
      } else {
        await sendSMS(biz.sms_number, dest, `⏰ Reminder: ${r.message}`)
        console.log(`[Reminders] Owner reminder sent to ${biz.business_name}: "${r.message}"`)
      }
    } catch (err) {
      console.error('[Reminders] send failed:', err.message)
    }
  }
}

function buildCheckoutEmail(firstName, biz, emailNum) {
  const isApp = isAppSignup(biz)
  // App signups already have an account: send them to sign in, where the pending view
  // starts checkout directly. Web signups keep the original signup link.
  const checkoutUrl = isApp ? 'https://getwexly.com/login.html?activate=1' : 'https://getwexly.com/signup.html'
  const bizName = biz.business_name || 'your business'

  const content = {
    // Email 0 — ~10 min after signup. Lead with the differentiator: run your business by text.
    0: {
      headline: "Run your entire business from a text message",
      body: isApp
        ? `You created a Wexly account for ${bizName} in the app, nice. Your dashboard is yours to explore, and when you're ready, activating the free 14-day trial gives ${bizName} its own booking phone number (no charge today, cancel anytime). But here's the part most people don't realize they're about to get.`
        : `You just set up Wexly for ${bizName} — nice. One step left: add a card to start your free 14-day trial (no charge today, cancel anytime). But here's the part most people don't realize they're about to get.`,
      scenario: `Most booking tools just answer your customers. Wexly does that too — but it also lets <strong>you</strong> run the whole business by text. Text your Wexly number "I'm sick today, reschedule everyone to next week" and it texts all of today's clients, offers them new times, and rebooks them — done. Text "how'd we do today?" and it replies "9 bookings, $1,480 booked, 2 deposits collected." No app to dig through, no dashboard to learn. Just text, like you'd text a really good front-desk manager.`,
      cta: 'Start my free trial →'
    },
    1: {
      headline: "Your front desk, run entirely by text",
      body: isApp
        ? `Your Wexly account for ${bizName} is waiting in the app. Activate the free 14-day trial and your number goes live the same minute. No charge until the trial ends, cancel anytime.`
        : `Your Wexly account for ${bizName} is ready — just add your card to start the free 14-day trial. No charge until it ends, cancel anytime.`,
      scenario: `Here's what sets Wexly apart from every other booking tool: you manage everything by text. "Block off Friday." "Text my VIPs about the cancellation special." "Who's coming in tomorrow?" "Mark Sarah as a no-show." It all happens by sending a text — while you're between clients, on the couch, wherever. And on the customer side, it's answering booking texts and taking deposits 24/7. It's like hiring a front-desk manager who works around the clock and never needs training.`,
      cta: 'Complete checkout →'
    },
    2: {
      headline: "Imagine texting your business instead of managing it",
      body: `While ${bizName} sits in setup, the version of your business running on Wexly is already booking clients — and waiting for you to put it to work. Adding your card takes about 30 seconds.`,
      scenario: `Think about everything that eats your day: rescheduling when you're slammed, confirming appointments, chasing no-shows, blocking time off, texting clients about a last-minute opening. With Wexly, all of that is one text away — you tell it what you want in plain English and it handles it. That's the part no other booking tool does: it's not just a bot for your customers, it's a manager you run by text.`,
      cta: 'Start your free trial →'
    },
    3: {
      headline: "Last call — your text-run front desk is still ready",
      body: `We built ${bizName}'s account and it's ready to go. After this we'll set it aside, but you can always come back. If now's not the time, no hard feelings.`,
      scenario: `If you're on the fence, here's the one thing worth trying free for 14 days: running your business by text. Reschedule your whole day, check your numbers, block time off, message clients — all by sending a text, no dashboard required. Most owners don't believe how much time it saves until they feel it. The trial is free specifically so you can.`,
      cta: 'Activate my trial →'
    }
  }

  const c = content[emailNum] || content[1]
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;font-family:Arial,sans-serif;">
      <tr><td style="background:#0D9488;padding:24px 30px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;color:#fff;">Wexly</h1>
      </td></tr>
      <tr><td style="padding:30px;background:#ffffff;">
        <h2 style="margin:0 0 12px;font-size:22px;color:#111;">${c.headline}</h2>
        <p style="margin:0 0 18px;font-size:15px;color:#555;line-height:1.6;">Hey ${firstName} — ${c.body}</p>
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 20px;">
          <tr><td style="background:#F0FBF7;border-left:3px solid #10B981;padding:14px 16px;border-radius:6px;">
            <p style="margin:0;font-size:14px;color:#2D5F4A;line-height:1.6;">${c.scenario}</p>
          </td></tr>
        </table>
        <p style="margin:0 0 20px;font-size:13px;color:#888;">✓ $0 due today &nbsp; ✓ Cancel anytime &nbsp; ✓ Full access to every feature</p>
        <p style="margin:0 0 18px;">
          <a href="${checkoutUrl}" style="display:inline-block;padding:14px 28px;background:#0D9488;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">${c.cta}</a>
        </p>
        <p style="margin:0;font-size:13px;color:#777;line-height:1.6;">Questions, or want a hand getting set up? Just reply to this email — it comes straight to me.</p>
      </td></tr>
      <tr><td style="padding:20px 30px;background:#F3F2EE;border-radius:0 0 8px 8px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#999;">${isApp ? "You created a Wexly account in the app but haven't activated your trial yet." : "You signed up for Wexly but haven't finished setting up yet."}<br>${emailNum === 3 ? "This is our last email, we won't bug you again." : "Just a friendly nudge."}</p>
        <p style="margin:8px 0 0;font-size:11px;"><a href="mailto:info@getwexly.com?subject=Unsubscribe" style="color:#999;">Unsubscribe</a></p>
      </td></tr>
    </table>`
}
