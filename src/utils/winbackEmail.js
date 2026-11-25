// "Wexly now starts at $39" email for people whose trial ended or who cancelled.
//
// Built the way high-performing marketing email is built: one column, one main
// action shown before any scrolling, the old and new price side by side, body
// text at 16px or more, and buttons tall enough to tap. Tables and inline styles
// only, so it holds up in Gmail, Apple Mail and Outlook.

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const SUBJECT = 'Wexly now starts at $39 a month'
const PREHEADER = 'It was $79. Run your calendar from the app or by text. Your account is still here.'
const LINK = 'https://getwexly.com/login.html?plan=desk&utm_source=email&utm_medium=email&utm_campaign=winback39'
const APP_LINK = 'https://apps.apple.com/app/id6828181888'
const UNSUB = 'mailto:hello@getwexly.com?subject=Unsubscribe'
const ADDRESS = '22271 Bronc Ct, Canyon Lake, CA 92587'

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
const SERIF = "Georgia,'Times New Roman',serif"
const INK = '#0F0F0E', GREEN = '#1A6B4A', MINT = '#4ADE80', CREAM = '#FAFAF8', SAND = '#EFEDE6', GREY = '#6B6A63', LINE = '#E7E5DD'

function button(href, label, bg, color, width) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${width ? ' width="100%"' : ''}><tr>
    <td align="center" bgcolor="${bg}" style="background:${bg};border-radius:14px;"><a href="${href}" style="display:block;padding:17px 18px;font:bold 16px ${SANS};color:${color};text-decoration:none;">${label}</a></td>
  </tr></table>`
}

function bubble(mine, text) {
  return `<tr><td align="${mine ? 'right' : 'left'}" style="padding:3px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:${mine ? GREEN : '#EDECE6'};color:${mine ? '#FFFFFF' : INK};font:15px/1.4 ${SANS};padding:10px 14px;border-radius:${mine ? '19px 19px 5px 19px' : '19px 19px 19px 5px'};">${text}</td>
    </tr></table></td></tr>`
}

function point(title, body) {
  return `<tr>
    <td width="34" valign="top" style="padding:13px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="24" height="24" align="center" style="background:#E3F3EA;border-radius:12px;font:bold 14px ${SANS};color:${GREEN};line-height:24px;">&#10003;</td></tr></table></td>
    <td valign="top" style="padding:13px 0;">
      <div style="font:bold 17px/1.3 ${SANS};color:${INK};">${title}</div>
      <div style="font:16px/1.5 ${SANS};color:${GREY};padding-top:3px;">${body}</div>
    </td></tr>`
}

function winbackHtml({ firstName, businessName, postalAddress } = {}) {
  const name = esc(firstName || 'there')
  const biz = businessName ? esc(businessName) : 'your business'
  const address = esc(postalAddress || ADDRESS)
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>${SUBJECT}</title></head>
<body style="margin:0;padding:0;background:${SAND};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${PREHEADER}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${SAND}" style="background:${SAND};"><tr><td align="center" style="padding:24px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${CREAM};border-radius:24px;overflow:hidden;">

  <tr><td style="padding:26px 30px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font:24px ${SERIF};color:${INK};letter-spacing:-0.5px;">Wex<em style="color:${GREEN};">ly</em></td>
      <td align="right"><span style="display:inline-block;background:#E3F3EA;color:${GREEN};font:bold 12px ${SANS};padding:6px 12px;border-radius:20px;">New plan</span></td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:34px 30px 0;">
    <div style="font:17px/1.5 ${SANS};color:${GREY};">Hi ${name},</div>
    <div style="font:42px/1.06 ${SERIF};color:${INK};letter-spacing:-1.2px;padding-top:8px;">Run your day from your phone. Now for half the price.</div>
  </td></tr>

  <tr><td style="padding:26px 30px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${INK}" style="background:${INK};border-radius:20px;"><tr><td style="padding:26px 26px 28px;">
      <div style="font:bold 13px ${SANS};color:${MINT};">Solo Desk</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="padding-top:6px;"><tr>
        <td valign="bottom" style="font:92px/0.95 ${SERIF};color:#FFFFFF;letter-spacing:-4px;">$39</td>
        <td valign="bottom" style="padding:0 0 12px 12px;">
          <div style="font:19px ${SANS};color:#8F8D85;text-decoration:line-through;">$79</div>
          <div style="font:15px ${SANS};color:#C9C7BE;padding-top:2px;">a month</div>
        </td>
      </tr></table>
      <div style="font:16px/1.5 ${SANS};color:#C9C7BE;padding:14px 0 22px;">Wexly used to start at $79. Our new plan is $39. Tell it what you need, in the app or by text, and it runs your calendar. You still talk to your own clients.</div>
      ${button(LINK, 'Come back for $39', MINT, INK, true)}
      <div style="font:13px ${SANS};color:#8F8D85;text-align:center;padding-top:12px;">Month to month. Cancel any time.</div>
    </td></tr></table>
  </td></tr>

  <tr><td style="padding:38px 30px 0;">
    <div style="font:28px/1.15 ${SERIF};color:${INK};letter-spacing:-0.6px;">Tell it what you need.</div>
    <div style="font:16px/1.5 ${SANS};color:${GREY};padding-top:6px;">Tap it in the Wexly app or text your Wexly number. Either way your calendar is updated and your clients are told.</div>
    <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" bgcolor="${INK}" style="margin:22px auto 0;background:${INK};border-radius:38px;width:100%;max-width:340px;"><tr><td style="padding:10px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background:#FFFFFF;border-radius:29px;">
        <tr><td align="center" style="padding:16px 14px 10px;border-bottom:1px solid ${LINE};">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="36" height="36" align="center" style="background:${GREEN};border-radius:18px;font:bold 16px ${SERIF};color:#FFFFFF;line-height:36px;">W</td></tr></table>
          <div style="font:bold 12px ${SANS};color:${INK};padding-top:5px;">Wexly</div>
        </td></tr>
        <tr><td style="padding:14px 12px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${bubble(true, 'Sick tomorrow')}
            ${bubble(false, 'Done. Tomorrow is cleared and your 6 clients have been told.')}
            ${bubble(true, 'Block Friday after 2')}
            ${bubble(false, 'Done. Friday is blocked from 2:00 PM.')}
            ${bubble(true, 'Book Maria for a cut Tuesday at 10')}
            ${bubble(false, 'Booked. Maria gets a reminder the day before.')}
          </table>
        </td></tr>
      </table>
    </td></tr></table>
  </td></tr>

  <tr><td style="padding:30px 30px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#E3F3EA" style="background:#E3F3EA;border-radius:20px;"><tr><td style="padding:24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="64" valign="top"><img src="https://getwexly.com/icon-192.png" width="52" height="52" alt="Wexly app icon" style="display:block;border-radius:13px;border:0;"></td>
        <td valign="top">
          <div style="font:24px/1.15 ${SERIF};color:${INK};letter-spacing:-0.4px;">The easiest way to run it: the iPhone app.</div>
          <div style="font:16px/1.5 ${SANS};color:#3F5F50;padding-top:5px;">Your calendar, your clients and your commands, one tap away.</div>
        </td>
      </tr></table>
      <div style="padding-top:18px;">${button(APP_LINK, 'Download on the App Store', INK, '#FFFFFF', true)}</div>
    </td></tr></table>
  </td></tr>

  <tr><td style="padding:30px 30px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${point('Clear or change a day in seconds', 'Out sick or running late? Wexly updates your calendar and texts your clients to let them know.')}
      ${point('Reminders go out on their own', 'Every client gets one before their appointment, so fewer no-shows.')}
      ${point('We move you in for free', 'Send us your current services and bookings and we set them up for you.')}
    </table>
  </td></tr>

  <tr><td style="padding:22px 30px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:16px;">
      <tr><td style="padding:18px 18px 14px;">
        <div style="font:bold 13px ${SANS};color:${GREEN};">What Solo Desk does</div>
        <div style="font:16px/1.5 ${SANS};color:${INK};padding-top:5px;">You tell it to book, move, cancel and block time, in the app or by text. It sends your clients their reminders and updates. When a client texts your number, they get a quick note that you will reply, and the message is passed to you.</div>
      </td></tr>
      <tr><td style="padding:14px 18px 18px;border-top:1px solid ${LINE};">
        <div style="font:bold 13px ${SANS};color:#8A887F;">What it does not do</div>
        <div style="font:16px/1.5 ${SANS};color:${GREY};padding-top:5px;">It does not hold conversations with your clients or book them for you. If you want that, Solo does it for $79 a month.</div>
      </td></tr>
    </table>
  </td></tr>

  <tr><td align="center" style="padding:36px 30px 36px;">
    <div style="font:26px/1.2 ${SERIF};color:${INK};letter-spacing:-0.5px;">Your account for ${biz} is still here.</div>
    <div style="font:16px/1.5 ${SANS};color:${GREY};padding:8px 0 20px;">Sign in, pick Solo Desk, and you are back on in a minute.</div>
    ${button(LINK, 'Come back for $39', GREEN, '#FFFFFF', false)}
    <div style="font:15px/1.5 ${SANS};color:${GREY};padding-top:16px;">Questions? Reply to this email and a person answers.</div>
  </td></tr>

  <tr><td bgcolor="${SAND}" style="background:${SAND};padding:20px 30px 6px;text-align:center;font:12px/1.6 ${SANS};color:#8A887F;">
    You're getting this because you had a Wexly account. <a href="${UNSUB}" style="color:#8A887F;text-decoration:underline;">Unsubscribe</a>
    <div style="font:10px/1.5 ${SANS};color:#A8A69D;padding-top:8px;">Wexly &nbsp; ${address}</div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

module.exports = { winbackHtml, SUBJECT, UNSUB }
