// v216: accounts an agency set up (signup link carries ?utm_source=<partner>,
// stored as businesses.signup_source) get a status email to the Wexly owner
// whenever billing state changes, so a bundled website can be taken down or
// restored on the right day. Partners are matched by PARTNER_SOURCES
// (comma-separated, default "reckless"). attribution_partner is NOT used here:
// that column drives commission payouts.
const PARTNERS = String(process.env.PARTNER_SOURCES || 'reckless').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
function isPartnerAccount(biz) { return !!biz && PARTNERS.includes(String(biz.signup_source || '').toLowerCase()) }

async function partnerStatusNotice(biz, status, extra = '') {
  try {
    if (!isPartnerAccount(biz)) return
    const { sendEmail } = require('./emailService')
    const to = process.env.PARTNER_STATUS_EMAIL || process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
    const label = { trial_expired: 'Trial ended without a card', past_due: 'Card payment failed', cancelled: 'Subscription cancelled', active: 'Subscription active again', trial: 'Trial started' }[status] || status
    await sendEmail({
      to,
      subject: `[${biz.signup_source}] ${biz.business_name}: ${label}`,
      html: `<p><strong>${biz.business_name}</strong> (${biz.owner_name || ''} · ${biz.email || ''} · ${biz.owner_phone || ''})</p><p>Status is now <strong>${status}</strong>. ${extra}</p><p>Plan: ${biz.plan || ''}. Booking page: https://getwexly.com/book/${biz.profile_slug || ''}</p><p>If this account came with a bundled website, this is the signal to pause or restore it.</p>`
    })
    console.log(`[Partner] ${biz.signup_source} notice: ${biz.business_name} → ${status}`)
  } catch (e) { console.error('[Partner] notice failed:', e.message) }
}
module.exports = { isPartnerAccount, partnerStatusNotice }
