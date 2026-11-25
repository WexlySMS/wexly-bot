// "Wexly now starts at $39" email for people whose trial ended or who cancelled.
// Table layout and inline styles only, so it holds up in Gmail, Apple Mail and Outlook.

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const SUBJECT = 'Wexly now starts at $39 a month'
const LINK = 'https://getwexly.com/login.html?plan=desk&utm_source=email&utm_medium=email&utm_campaign=winback39'
const UNSUB = 'mailto:hello@getwexly.com?subject=Unsubscribe'

function bubble(side, text) {
  const mine = side === 'r'
  return `<tr><td align="${mine ? 'right' : 'left'}" style="padding:4px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:${mine ? '#1A6B4A' : '#F0EFEA'};color:${mine ? '#FFFFFF' : '#1C1C1A'};font:15px/1.4 Helvetica,Arial,sans-serif;padding:10px 14px;border-radius:${mine ? '18px 18px 5px 18px' : '18px 18px 18px 5px'};max-width:300px;">${text}</td>
    </tr></table></td></tr>`
}

function row(title, body) {
  return `<tr><td style="padding:14px 0;border-top:1px solid #E7E5DD;">
    <div style="font:bold 16px/1.3 Helvetica,Arial,sans-serif;color:#0F0F0E;">${title}</div>
    <div style="font:15px/1.5 Helvetica,Arial,sans-serif;color:#5C5B55;padding-top:3px;">${body}</div></td></tr>`
}

function winbackHtml({ firstName, businessName, postalAddress } = {}) {
  const name = esc(firstName || 'there')
  const biz = businessName ? esc(businessName) : 'your business'
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${SUBJECT}</title></head>
<body style="margin:0;padding:0;background:#EFEDE6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Run your day by text for $39 a month. Your account is still here.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EFEDE6;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:20px;overflow:hidden;">

  <tr><td style="background:#0F0F0E;padding:30px 34px 36px;">
    <div style="font:22px Georgia,'Times New Roman',serif;color:#FAF9F6;letter-spacing:-0.5px;">Wex<em style="color:#4ADE80;">ly</em></div>
    <div style="font:13px/1 Helvetica,Arial,sans-serif;color:#4ADE80;padding-top:34px;font-weight:bold;">New plan</div>
    <div style="font:40px/1.08 Georgia,'Times New Roman',serif;color:#FFFFFF;letter-spacing:-1px;padding-top:10px;">Wexly now starts at $39&nbsp;a&nbsp;month.</div>
    <div style="font:17px/1.55 Helvetica,Arial,sans-serif;color:#C9C7BE;padding-top:16px;">Hi ${name}, since you tried Wexly we added a smaller plan called Solo Desk. You text one number and your day gets handled.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="padding-top:26px;"><tr>
      <td style="background:#4ADE80;border-radius:12px;"><a href="${LINK}" style="display:inline-block;padding:15px 26px;font:bold 16px Helvetica,Arial,sans-serif;color:#0F0F0E;text-decoration:none;">Come back for $39</a></td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:30px 34px 6px;">
    <div style="font:bold 13px Helvetica,Arial,sans-serif;color:#1A6B4A;">What it looks like</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;border:1px solid #E7E5DD;border-radius:18px;"><tr><td style="padding:16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${bubble('r', 'Sick tomorrow')}
        ${bubble('l', 'Got it. I texted your 6 clients for tomorrow and offered each one a new time.')}
        ${bubble('r', 'Block Friday after 2')}
        ${bubble('l', 'Done. Friday is blocked from 2:00 PM.')}
      </table>
    </td></tr></table>
  </td></tr>

  <tr><td style="padding:22px 34px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${row('Move a whole day with one text', 'Out sick or running late? One text and your clients are told and offered new times.')}
      ${row('Run the calendar from your phone', 'Block time, move an appointment, or ask who is coming in today.')}
      ${row('Reminders go out on their own', 'Clients get a reminder before every appointment, so fewer no-shows.')}
      ${row('We move you in for free', 'Send us your current services and bookings and we set them up for you.')}
    </table>
  </td></tr>

  <tr><td style="padding:18px 34px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="50%" valign="top" style="padding-right:7px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0F0F0E;border-radius:16px;"><tr><td style="padding:20px 18px;">
          <div style="font:bold 14px Helvetica,Arial,sans-serif;color:#4ADE80;">Solo Desk</div>
          <div style="font:38px/1 Georgia,serif;color:#FFFFFF;padding-top:8px;">$39</div>
          <div style="font:13px Helvetica,Arial,sans-serif;color:#C9C7BE;padding-top:4px;">a month</div>
          <div style="font:14px/1.45 Helvetica,Arial,sans-serif;color:#C9C7BE;padding-top:10px;">You text it. It runs your day and keeps your clients in the loop.</div>
        </td></tr></table>
      </td>
      <td width="50%" valign="top" style="padding-left:7px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6F5F0;border-radius:16px;"><tr><td style="padding:20px 18px;">
          <div style="font:bold 14px Helvetica,Arial,sans-serif;color:#1A6B4A;">Solo</div>
          <div style="font:38px/1 Georgia,serif;color:#0F0F0E;padding-top:8px;">$79</div>
          <div style="font:13px Helvetica,Arial,sans-serif;color:#5C5B55;padding-top:4px;">a month</div>
          <div style="font:14px/1.45 Helvetica,Arial,sans-serif;color:#5C5B55;padding-top:10px;">Everything in Solo Desk, and it answers and books your clients by text too.</div>
        </td></tr></table>
      </td>
    </tr></table>
  </td></tr>

  <tr><td align="center" style="padding:22px 34px 34px;">
    <div style="font:16px/1.55 Helvetica,Arial,sans-serif;color:#3A3A36;">Your account for ${biz} is still here. Month to month, cancel any time.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;"><tr>
      <td style="background:#1A6B4A;border-radius:12px;"><a href="${LINK}" style="display:inline-block;padding:16px 34px;font:bold 17px Helvetica,Arial,sans-serif;color:#FFFFFF;text-decoration:none;">Come back for $39</a></td>
    </tr></table>
    <div style="font:14px/1.5 Helvetica,Arial,sans-serif;color:#8A887F;padding-top:14px;">Questions? Just reply to this email.</div>
  </td></tr>

  <tr><td style="background:#F6F5F0;padding:18px 34px;text-align:center;font:12px/1.6 Helvetica,Arial,sans-serif;color:#8A887F;">
    You're getting this because you had a Wexly account. <a href="${UNSUB}" style="color:#8A887F;">Unsubscribe</a>${postalAddress ? `<br>Wexly, ${esc(postalAddress)}` : ''}
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

module.exports = { winbackHtml, SUBJECT, UNSUB }
