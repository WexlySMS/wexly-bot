const sgMail = require('@sendgrid/mail')
require('dotenv').config()

if (!process.env.SENDGRID_API_KEY) {
  console.error('[Email] WARNING: SENDGRID_API_KEY is not set — emails will not send')
} else {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY)
}

const FROM_HELLO   = { email: 'hello@getwexly.com', name: 'Wexly' }
const FROM_BILLING = { email: 'billing@getwexly.com', name: 'Wexly Billing' }
const FROM_NOREPLY = { email: 'noreply@mail.getwexly.com', name: 'Wexly' }
const REPLY_TO     = 'hello@getwexly.com'
const SITE = 'https://getwexly.com'

async function sendEmail({ from, replyTo, to, subject, html }) {
  try {
    await sgMail.send({ from, replyTo: replyTo || REPLY_TO, to, subject, html })
    console.log(`[Email] Sent "${subject}" to ${to}`)
  } catch (err) {
    console.error(`[Email] Failed "${subject}" to ${to}:`, err.response?.body?.errors || err.message)
    throw err
  }
}

const EMAIL_HEADER = `
    <div style="background:#0F0F0E;padding:32px 40px;text-align:center;">
      <span style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:28px;font-weight:700;color:#FFFFFF;letter-spacing:-0.5px;">Wex<span style="font-style:italic;font-weight:400;color:#4ADE80;">ly</span></span>
    </div>`

const EMAIL_FOOTER = `
    <div style="padding:32px 40px;text-align:center;border-top:1px solid rgba(15,15,14,0.06);">
      <p style="font-size:12px;color:#B8B6AD;margin:0 0 8px;">Wexly &mdash; booking by text for your business</p>
      <p style="font-size:11px;color:#D4D2CA;margin:0;"><a href="${SITE}/privacy.html" style="color:#D4D2CA;text-decoration:underline;">Privacy</a> &nbsp;&middot;&nbsp; <a href="${SITE}/terms.html" style="color:#D4D2CA;text-decoration:underline;">Terms</a> &nbsp;&middot;&nbsp; <a href="${SITE}" style="color:#D4D2CA;text-decoration:underline;">getwexly.com</a></p>
    </div>`

async function sendWelcomeEmail({ email, firstName, businessName, smsNumber }) {
  await sendEmail({
    from: FROM_HELLO, to: email,
    subject: `Your Wexly bot is live, ${firstName}`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
${EMAIL_HEADER}
<div style="padding:40px;text-align:center;border-bottom:1px solid rgba(15,15,14,0.08);">
<div style="font-size:48px;margin-bottom:16px;">🎉</div>
<h1 style="font-family:Georgia,serif;font-size:32px;color:#0F0F0E;margin:0 0 12px;">You're live, ${firstName}!</h1>
<p style="font-size:16px;color:#7A7972;margin:0;">Your SMS receptionist for <strong style="color:#0F0F0E;">${businessName}</strong> is up and running.</p>
</div>
<div style="padding:32px 40px;text-align:center;background:#E8F4EE;border-bottom:1px solid rgba(15,15,14,0.08);">
<p style="font-size:12px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:#0D9488;margin:0 0 8px;">Your dedicated SMS number</p>
<div style="font-family:Georgia,serif;font-size:36px;color:#0F0F0E;">${smsNumber || 'Being assigned...'}</div>
</div>
<div style="padding:32px 40px;border-bottom:1px solid rgba(15,15,14,0.08);">
<h2 style="font-family:Georgia,serif;font-size:20px;color:#0F0F0E;margin:0 0 20px;">3 things to do right now</h2>
<div style="margin-bottom:14px;"><strong style="color:#0F0F0E;">1. Complete your bot setup interview</strong><br><span style="font-size:13px;color:#7A7972;">Reply YES to the text from your Wexly number — 3 minutes.</span></div>
<div style="margin-bottom:14px;"><strong style="color:#0F0F0E;">2. Add your number to Google Business</strong><br><span style="font-size:13px;color:#7A7972;">Customers can text you from search results.</span></div>
<div><strong style="color:#0F0F0E;">3. Share your number everywhere</strong><br><span style="font-size:13px;color:#7A7972;">QR code, widget, social — all in your dashboard.</span></div>
</div>
<div style="padding:24px 40px;background:#FEF9EE;border-bottom:1px solid rgba(15,15,14,0.08);">
<p style="font-size:14px;color:#92400E;margin:0;">⏰ <strong>14-day free trial started today.</strong> No charge until day 15.</p>
</div>
<div style="padding:32px 40px;text-align:center;">
<a href="${SITE}/dashboard.html" style="display:inline-block;background:#0D9488;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:500;">Go to your dashboard →</a>
</div>
<div style="padding:20px 40px;background:#F3F2EE;text-align:center;">
<p style="font-size:12px;color:#B8B6AD;margin:0;">Wexly Inc. · <a href="${SITE}/privacy.html" style="color:#B8B6AD;">Privacy</a></p>
</div>
${EMAIL_FOOTER}
</div></body></html>`
  })
}

async function sendTrialEndingEmail({ email, firstName, businessName, trialEndsAt, plan = 'standard' }) {
  const endDate = new Date(trialEndsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  const planPrice = plan === 'pro' ? '$199' : '$149'
  await sendEmail({
    from: FROM_BILLING, to: email,
    subject: `Your Wexly trial ends in 2 days`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
${EMAIL_HEADER}
<div style="padding:40px;">
<h1 style="font-family:Georgia,serif;font-size:28px;color:#0F0F0E;margin:0 0 16px;">Your trial ends ${endDate}</h1>
<p style="font-size:16px;color:#7A7972;line-height:1.7;margin:0 0 24px;">Hey ${firstName}, your trial for <strong style="color:#0F0F0E;">${businessName}</strong> ends on ${endDate}. Your card will be charged <strong>${planPrice}/mo</strong>.</p>
<div style="background:#FEF9EE;border-radius:10px;padding:16px;margin-bottom:24px;">
<p style="font-size:14px;color:#92400E;margin:0;">Want to cancel? Go to dashboard → Bot Settings → Billing before ${endDate}.</p>
</div>
<div style="text-align:center;">
<a href="${SITE}/dashboard.html" style="display:inline-block;background:#0D9488;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:500;">Go to dashboard →</a>
</div>
</div>
${EMAIL_FOOTER}
</div></body></html>`
  })
}

async function sendTrialConfirmationEmail({ email, firstName, businessName, trialEndsAt, plan = 'standard' }) {
  const endDate = new Date(trialEndsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const planLabel = plan === 'pro' ? 'Wexly Pro' : 'Wexly Standard'
  const planPrice = plan === 'pro' ? '$199' : '$149'
  await sendEmail({
    from: FROM_BILLING, replyTo: 'billing@getwexly.com', to: email,
    subject: `Your Wexly trial has started — here's what to expect`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
${EMAIL_HEADER}
<div style="padding:40px;">
<h1 style="font-family:Georgia,serif;font-size:28px;color:#0F0F0E;margin:0 0 16px;">Your trial is active ✓</h1>
<p style="font-size:16px;color:#7A7972;line-height:1.7;margin:0 0 28px;">Hey ${firstName}, your 14-day free trial for <strong style="color:#0F0F0E;">${businessName}</strong> is now active.</p>
<table style="width:100%;border-collapse:collapse;background:#F3F2EE;border-radius:10px;margin-bottom:24px;">
<tr style="border-bottom:1px solid rgba(15,15,14,0.08);"><td style="padding:12px 16px;font-size:14px;color:#3A3A36;">${planLabel}</td><td style="padding:12px 16px;font-size:14px;font-weight:500;color:#0F0F0E;text-align:right;">${planPrice}/mo</td></tr>
<tr style="border-bottom:1px solid rgba(15,15,14,0.08);"><td style="padding:12px 16px;font-size:14px;color:#3A3A36;">14-day free trial</td><td style="padding:12px 16px;font-size:14px;font-weight:500;color:#0D9488;text-align:right;">Included</td></tr>
<tr><td style="padding:12px 16px;font-size:15px;font-weight:500;color:#0F0F0E;">Due today</td><td style="padding:12px 16px;font-size:20px;font-weight:600;color:#0F0F0E;text-align:right;">$0.00</td></tr>
</table>
<div style="background:#FEF9EE;border-radius:8px;padding:14px;margin-bottom:24px;">
<p style="font-size:13px;color:#92400E;margin:0;">💳 On <strong>${endDate}</strong> your card will be charged <strong>${planPrice}</strong>. Cancel anytime before then.</p>
</div>
<div style="text-align:center;">
<a href="${SITE}/dashboard.html" style="display:inline-block;background:#0D9488;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:500;">Go to your dashboard →</a>
</div>
</div>
${EMAIL_FOOTER}
</div></body></html>`
  })
}

async function sendEscalationEmail({ ownerEmail, businessName, customerPhone, customerName, conversationSummary, smsNumber }) {
  await sendEmail({
    from: FROM_NOREPLY, replyTo: ownerEmail, to: ownerEmail,
    subject: `⚠️ Customer needs attention — ${customerName || customerPhone}`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
${EMAIL_HEADER}
<div style="padding:32px 40px;">
<div style="background:#FEE2E2;border-radius:10px;padding:16px;margin-bottom:20px;">
<p style="font-size:14px;font-weight:500;color:#991B1B;margin:0;">⚠️ A customer needs your immediate attention</p>
</div>
<table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
<tr><td style="padding:8px 0;font-size:13px;color:#7A7972;width:100px;">Customer</td><td style="padding:8px 0;font-size:13px;font-weight:500;color:#0F0F0E;">${customerName || 'Unknown'}</td></tr>
<tr><td style="padding:8px 0;font-size:13px;color:#7A7972;">Phone</td><td style="padding:8px 0;font-size:13px;font-weight:500;color:#0F0F0E;">${customerPhone}</td></tr>
<tr><td style="padding:8px 0;font-size:13px;color:#7A7972;">Business</td><td style="padding:8px 0;font-size:13px;font-weight:500;color:#0F0F0E;">${businessName}</td></tr>
</table>
${conversationSummary ? `<div style="background:#F3F2EE;border-radius:10px;padding:16px;margin-bottom:20px;"><p style="font-size:12px;font-weight:500;color:#7A7972;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 8px;">Summary</p><p style="font-size:14px;color:#3A3A36;margin:0;line-height:1.6;">${conversationSummary}</p></div>` : ''}
<div style="text-align:center;">
<a href="sms:${customerPhone}" style="display:inline-block;background:#0D9488;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">Text customer now →</a>
</div>
</div>
${EMAIL_FOOTER}
</div></body></html>`
  })
}

async function sendEscalationNotification({ ownerEmail, ownerPhone, businessName, smsNumber, customerPhone, customerMessage, trigger }) {
  // Send email
  if (ownerEmail) {
    await sendEscalationEmail({
      ownerEmail, businessName, customerPhone,
      customerName: null,
      conversationSummary: `Trigger: "${trigger}"\nMessage: "${customerMessage}"`,
      smsNumber
    }).catch(err => console.error('[Escalation] Email failed:', err.message))
  }

  // Send SMS to owner
  if (ownerPhone && smsNumber) {
    let normalizedPhone = ownerPhone.replace(/\D/g, '')
    if (!normalizedPhone.startsWith('1') && normalizedPhone.length === 10) normalizedPhone = '1' + normalizedPhone
    normalizedPhone = '+' + normalizedPhone

    const { sendSMS } = require('../utils/sms')
    await sendSMS(smsNumber, normalizedPhone,
      `⚠️ Customer needs attention!\nPhone: ${customerPhone}\nTrigger: "${trigger}"\nMessage: "${customerMessage?.slice(0, 100)}"\n\nText them or check your dashboard.`
    ).catch(err => console.error('[Escalation] SMS failed:', err.message))
  }
}

async function sendDailyDigestEmail({ email, firstName, businessName, todayBookings = 0, todayCancellations = 0, todayNoShows = 0, totalConversations = 0, flaggedConversations = 0, appointments = [] }) {
  await sendEmail({
    from: FROM_NOREPLY, replyTo: email, to: email,
    subject: `📊 ${businessName} — Daily digest`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
${EMAIL_HEADER}
<div style="padding:32px 40px;">
<h1 style="font-family:Georgia,serif;font-size:24px;color:#0F0F0E;margin:0 0 6px;">Good morning, ${firstName}!</h1>
<p style="font-size:14px;color:#7A7972;margin:0 0 24px;">Here's your ${businessName} summary for today.</p>
<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
<tr>
<td style="padding:16px;background:#E8F4EE;border-radius:10px;text-align:center;width:25%;">
<div style="font-size:28px;font-weight:600;color:#0D9488;">${todayBookings}</div>
<div style="font-size:11px;color:#2D8A62;margin-top:4px;">Confirmed</div>
</td>
<td style="width:6px;"></td>
<td style="padding:16px;background:${todayCancellations > 0 ? '#FEF3C7' : '#F3F2EE'};border-radius:10px;text-align:center;width:25%;">
<div style="font-size:28px;font-weight:600;color:${todayCancellations > 0 ? '#92400E' : '#0F0F0E'};">${todayCancellations}</div>
<div style="font-size:11px;color:${todayCancellations > 0 ? '#B45309' : '#7A7972'};margin-top:4px;">Cancelled</div>
</td>
<td style="width:6px;"></td>
<td style="padding:16px;background:${todayNoShows > 0 ? '#FEE2E2' : '#F3F2EE'};border-radius:10px;text-align:center;width:25%;">
<div style="font-size:28px;font-weight:600;color:${todayNoShows > 0 ? '#991B1B' : '#0F0F0E'};">${todayNoShows}</div>
<div style="font-size:11px;color:${todayNoShows > 0 ? '#B91C1C' : '#7A7972'};margin-top:4px;">No-shows</div>
</td>
<td style="width:6px;"></td>
<td style="padding:16px;background:#F3F2EE;border-radius:10px;text-align:center;width:25%;">
<div style="font-size:28px;font-weight:600;color:#0F0F0E;">${totalConversations}</div>
<div style="font-size:11px;color:#7A7972;margin-top:4px;">Conversations</div>
</td>
</tr>
</table>
${flaggedConversations > 0 ? `<div style="background:#FEE2E2;border-radius:10px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px;"><span style="font-size:18px;">⚠️</span><div><p style="font-size:13px;font-weight:500;color:#991B1B;margin:0;">${flaggedConversations} conversation${flaggedConversations > 1 ? 's' : ''} need${flaggedConversations === 1 ? 's' : ''} your attention</p><p style="font-size:12px;color:#B91C1C;margin:2px 0 0;">Check your dashboard to respond</p></div></div>` : ''}
${appointments.length > 0 ? `<div style="margin-bottom:20px;"><p style="font-size:12px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:#7A7972;margin:0 0 10px;">Today's bookings</p>${appointments.map(a => `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #EDECE9;font-size:13px;"><span style="color:#0F0F0E;font-weight:500;">${a.customer_name}</span><span style="color:#7A7972;">${a.service_name || 'Appointment'} · ${a.appointment_time || ''}</span></div>`).join('')}</div>` : ''}
<div style="text-align:center;">
<a href="${process.env.SITE_URL}/dashboard.html" style="display:inline-block;background:#0D9488;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">View full dashboard →</a>
</div>
</div>
${EMAIL_FOOTER}
</div></body></html>`
  })
}

async function sendDailyDigest({ ownerEmail, businessName, stats }) {
  return sendDailyDigestEmail({ email: ownerEmail, firstName: 'there', businessName, todayBookings: stats?.bookingsToday || 0 })
}

async function sendBookingNotification({ ownerEmail, ownerPhone, businessName, customerName, customerPhone, serviceName, appointmentDate, appointmentTime, smsNumber, isReschedule = false }) {
  console.log(`[Notify] ${isReschedule ? 'Reschedule' : 'Booking'} notification — email: ${ownerEmail ? 'yes' : 'no'}, SMS: ${ownerPhone ? 'yes' : 'no'}, business: ${businessName}`)
  const dateStr = appointmentDate ? new Date(appointmentDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : ''
  const timeStr = appointmentTime || ''
  const headingEmoji = isReschedule ? '🔄' : '📅'
  const headingText = isReschedule ? 'Rescheduled booking' : 'New booking'

  if (ownerEmail) {
    await sendEmail({
      from: FROM_NOREPLY, replyTo: ownerEmail, to: ownerEmail,
      subject: `${headingEmoji} ${headingText} — ${customerName} · ${serviceName}`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
${EMAIL_HEADER}
<div style="padding:32px 40px;">
<div style="background:#E8F4EE;border-radius:10px;padding:20px;margin-bottom:20px;">
<p style="font-size:12px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:#0D9488;margin:0 0 12px;">${headingText}</p>
<table style="width:100%;border-collapse:collapse;">
<tr><td style="padding:6px 0;font-size:13px;color:#7A7972;width:80px;">Customer</td><td style="padding:6px 0;font-size:13px;font-weight:500;color:#0F0F0E;">${customerName}</td></tr>
<tr><td style="padding:6px 0;font-size:13px;color:#7A7972;">Phone</td><td style="padding:6px 0;font-size:13px;font-weight:500;color:#0F0F0E;">${customerPhone}</td></tr>
<tr><td style="padding:6px 0;font-size:13px;color:#7A7972;">Service</td><td style="padding:6px 0;font-size:13px;font-weight:500;color:#0F0F0E;">${serviceName}</td></tr>
<tr><td style="padding:6px 0;font-size:13px;color:#7A7972;">Date</td><td style="padding:6px 0;font-size:13px;font-weight:500;color:#0F0F0E;">${dateStr}</td></tr>
<tr><td style="padding:6px 0;font-size:13px;color:#7A7972;">Time</td><td style="padding:6px 0;font-size:13px;font-weight:500;color:#0F0F0E;">${timeStr}</td></tr>
</table>
</div>
<div style="text-align:center;">
<a href="${SITE}/dashboard.html" style="display:inline-block;background:#0D9488;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">View in dashboard →</a>
</div>
</div>
${EMAIL_FOOTER}
</div></body></html>`
    })
  }

  if (ownerPhone && smsNumber) {
    // Normalize phone format
    let normalizedPhone = ownerPhone.replace(/\D/g, '')
    if (!normalizedPhone.startsWith('1') && normalizedPhone.length === 10) normalizedPhone = '1' + normalizedPhone
    normalizedPhone = '+' + normalizedPhone

    const { sendSMS } = require('../utils/sms')
    await sendSMS(smsNumber, normalizedPhone,
      `${headingEmoji} ${headingText}!\n${customerName} · ${serviceName}\n${dateStr} at ${timeStr}\nPhone: ${customerPhone}`
    ).catch(err => console.error('[Notify] Booking SMS failed:', err.message))
  }
}

async function sendOwnerNewSignupNotification({ businessName, ownerName, email, businessType }) {
  const OWNER_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
  await sendEmail({
    from: FROM_BILLING, to: OWNER_EMAIL,
    subject: `🎉 New signup — ${businessName}`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;">
<div style="background:#0F0F0E;padding:24px 32px;">
<div style="font-family:Georgia,serif;font-size:22px;color:#FAF9F6;">Wex<span style="color:#4ade80;font-style:italic;">ly</span></div>
</div>
<div style="padding:32px;">
<div style="font-size:32px;margin-bottom:12px;">🎉</div>
<h1 style="font-family:Georgia,serif;font-size:24px;color:#0F0F0E;margin:0 0 20px;">New trial signup!</h1>
<table style="width:100%;border-collapse:collapse;background:#F3F2EE;border-radius:10px;">
<tr><td style="padding:10px 16px;font-size:13px;color:#7A7972;">Business</td><td style="padding:10px 16px;font-size:13px;font-weight:500;color:#0F0F0E;">${businessName}</td></tr>
<tr><td style="padding:10px 16px;font-size:13px;color:#7A7972;">Owner</td><td style="padding:10px 16px;font-size:13px;font-weight:500;color:#0F0F0E;">${ownerName}</td></tr>
<tr><td style="padding:10px 16px;font-size:13px;color:#7A7972;">Email</td><td style="padding:10px 16px;font-size:13px;font-weight:500;color:#0F0F0E;">${email}</td></tr>
<tr><td style="padding:10px 16px;font-size:13px;color:#7A7972;">Type</td><td style="padding:10px 16px;font-size:13px;font-weight:500;color:#0F0F0E;">${businessType || 'Not specified'}</td></tr>
</table>
</div>
${EMAIL_FOOTER}
</div></body></html>`
  })
}

// ── Daily staff schedule (email) ─────────────────────────────────────────────
// Replaces the SMS staff-schedule send. Each staff member with auto_schedule=true
// and notify_via='email' (or no SMS phone) gets their day's appointments emailed
// to them at the business's configured digest hour. Cuts Twilio cost dramatically
// for businesses with multiple staff — email is essentially free at our volume.
async function sendStaffScheduleEmail({ staffEmail, staffName, businessName, dateLabel, appointments = [] }) {
  if (!staffEmail) return
  const apptRows = appointments.length
    ? appointments.map(a => `
        <div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #EDECE9;font-size:13px;">
          <div style="color:#0F0F0E;font-weight:500;">
            ${a.appointment_time?.slice(0,5) || ''} — ${a.customer_name || 'Client'}
          </div>
          <div style="color:#7A7972;text-align:right;">
            ${a.service_name || 'Appointment'}
          </div>
        </div>
        ${a.notes ? `<div style="font-size:12px;color:#7A7972;margin:-6px 0 4px;padding-left:8px;">📝 ${a.notes}</div>` : ''}
      `).join('')
    : '<div style="padding:20px;background:#F3F2EE;border-radius:10px;text-align:center;font-size:13px;color:#7A7972;">No appointments assigned to you today. Enjoy your day! 🌿</div>'

  await sendEmail({
    from: FROM_NOREPLY, replyTo: staffEmail, to: staffEmail,
    subject: `📅 Your schedule for today — ${businessName}`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
${EMAIL_HEADER}
<div style="padding:32px 40px;">
<h1 style="font-family:Georgia,serif;font-size:24px;color:#0F0F0E;margin:0 0 6px;">Good morning, ${staffName || 'there'}!</h1>
<p style="font-size:14px;color:#7A7972;margin:0 0 24px;">Here's your ${businessName} schedule for ${dateLabel}.</p>
${appointments.length ? `<p style="font-size:12px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:#7A7972;margin:0 0 8px;">${appointments.length} appointment${appointments.length !== 1 ? 's' : ''}</p>` : ''}
<div style="margin-bottom:20px;">${apptRows}</div>
<div style="background:#E8F4EE;border-radius:10px;padding:16px;font-size:12px;color:#2D8A62;text-align:center;">
Need to make a change? Just text the business number — it can update bookings for you.
</div>
</div>
${EMAIL_FOOTER}
</div></body></html>`
  })
}

// ── Post-visit follow-up email ───────────────────────────────────────────────
// Replaces the SMS post-visit follow-up. Sent the day after each completed
// appointment. Drives rebooking (always) and Google reviews (when link is set).
// Email is free at our volume; the SMS version was costing real money at scale.
async function sendPostVisitEmail({ customerEmail, customerName, businessName, businessSlug, reviewLink }) {
  if (!customerEmail) return
  const firstName = (customerName || 'there').split(' ')[0]
  const safeBizName = businessName || 'our team'  // belt-and-suspenders fallback — businessName should always be set
  const bookingUrl = businessSlug
    ? `${process.env.SITE_URL || 'https://getwexly.com'}/book/${encodeURIComponent(businessSlug)}`
    : null

  // Optional review section — only if the business has set a Google review link
  const reviewSection = reviewLink ? `
    <div style="background:#FEF7E6;border:1px solid #FCD34D;border-radius:10px;padding:20px;margin-bottom:20px;text-align:center;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:500;color:#92400E;">⭐ Loved your visit?</p>
      <p style="margin:0 0 14px;font-size:13px;color:#7A6128;">A quick review helps us so much — and only takes a moment.</p>
      <a href="${reviewLink}" style="display:inline-block;background:#F59E0B;color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">Leave a review →</a>
    </div>
  ` : ''

  const bookAgainSection = bookingUrl ? `
    <div style="text-align:center;margin-top:12px;">
      <a href="${bookingUrl}" style="display:inline-block;background:#2D8A62;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">Book your next visit →</a>
    </div>
  ` : `
    <p style="text-align:center;font-size:13px;color:#7A7972;margin:12px 0 0;">Text us anytime to book your next visit — we'd love to see you again!</p>
  `

  await sendEmail({
    from: FROM_NOREPLY, replyTo: customerEmail, to: customerEmail,
    subject: `Thanks for visiting ${safeBizName}! 💚`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F3F2EE;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:40px auto;background:#FAFAF8;border-radius:16px;overflow:hidden;border:1px solid rgba(15,15,14,0.08);">
${EMAIL_HEADER}
<div style="padding:32px 40px;">
<h1 style="font-family:Georgia,serif;font-size:24px;color:#0F0F0E;margin:0 0 8px;">Thanks for visiting, ${firstName}!</h1>
<p style="font-size:14px;color:#7A7972;line-height:1.6;margin:0 0 24px;">We hope your time at ${safeBizName} was great. It's always wonderful to see you 💚</p>
${reviewSection}
${bookAgainSection}
</div>
${EMAIL_FOOTER}
</div></body></html>`
  })
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendTrialEndingEmail,
  sendTrialConfirmationEmail,
  sendEscalationEmail,
  sendEscalationNotification,
  sendDailyDigest,
  sendDailyDigestEmail,
  sendBookingNotification,
  sendOwnerNewSignupNotification,
  sendCustomerConfirmationEmail,
  sendStaffScheduleEmail,
  sendPostVisitEmail
}

async function sendCustomerConfirmationEmail({ customerEmail, customerName, businessName, serviceName, appointmentDate, appointmentTime, smsNumber, depositUrl }) {
  if (!customerEmail) return
  const firstName = (customerName || 'there').split(' ')[0]
  const dateFormatted = new Date(appointmentDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  const depositSection = depositUrl ? `
    <tr><td style="padding:20px 30px;">
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        <tr><td style="background:#FEF3C7;border-radius:8px;padding:16px;">
          <p style="margin:0;font-size:14px;color:#92400E;font-weight:600;">⚠️ Deposit Required</p>
          <p style="margin:8px 0 0;font-size:13px;color:#92400E;">Please complete your deposit to secure your spot:</p>
          <p style="margin:12px 0 0;"><a href="${depositUrl}" style="display:inline-block;padding:10px 24px;background:#0D9488;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Pay Deposit →</a></p>
        </td></tr>
      </table>
    </td></tr>` : ''

  const html = `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;font-family:Arial,sans-serif;">
      <tr><td style="background:#0D9488;padding:24px 30px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;color:#fff;">${businessName}</h1>
      </td></tr>
      <tr><td style="padding:30px;background:#ffffff;">
        <h2 style="margin:0 0 8px;font-size:22px;color:#111;">Booking Confirmed ✅</h2>
        <p style="margin:0 0 20px;font-size:15px;color:#555;">Hi ${firstName}! Your appointment is all set.</p>
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#F9FAFB;border-radius:8px;padding:4px;">
          <tr><td style="padding:12px 16px;border-bottom:1px solid #eee;"><strong style="color:#333;">Service</strong></td><td style="padding:12px 16px;border-bottom:1px solid #eee;color:#555;">${serviceName}</td></tr>
          <tr><td style="padding:12px 16px;border-bottom:1px solid #eee;"><strong style="color:#333;">Date</strong></td><td style="padding:12px 16px;border-bottom:1px solid #eee;color:#555;">${dateFormatted}</td></tr>
          <tr><td style="padding:12px 16px;"><strong style="color:#333;">Time</strong></td><td style="padding:12px 16px;color:#555;">${appointmentTime}</td></tr>
        </table>
      </td></tr>
      ${depositSection}
      <tr><td style="padding:20px 30px;background:#ffffff;">
        <p style="margin:0;font-size:13px;color:#888;">Need to reschedule or cancel? Just text us at ${smsNumber || 'our number'}.</p>
      </td></tr>
      <tr><td style="padding:20px 30px;background:#F3F2EE;border-radius:0 0 8px 8px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#999;">Powered by Wexly — booking by text</p>
      </td></tr>
    </table>`

  await sendEmail({
    to: customerEmail,
    from: 'bookings@getwexly.com',
    subject: `Booking Confirmed — ${serviceName} on ${dateFormatted}`,
    html
  })
  console.log(`[Email] Sent booking confirmation to ${customerEmail}`)
}
