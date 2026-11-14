// v215: ONE approval path for request-mode bookings. The owner's text command,
// the dashboard's Approve buttons and the API all call approveAppointment(), so
// every approval does the same four things:
//   1. confirms the appointment (and its multi-service siblings)
//   2. creates the deposit if the service has one (shared helper, Entry 13),
//      in which case the booking waits as deposit_pending instead of confirmed
//   3. texts the client in plain English (formatted day and time, deposit
//      instructions, meeting link for virtual businesses)
//   4. leaves a note in the client's thread so their next reply makes sense
// Before this, three copies of the logic texted raw "2026-11-20 at 14:00" and
// none of them ever collected the deposit on an approved request.
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const { formatDate, formatTime } = require('../utils/dateHelpers')
const { phoneVariants } = require('../utils/phone')
const db = require('../db/client')

const hasRealPhone = (p) => String(p || '').replace(/\D/g, '').length >= 10

async function noteThread(businessId, phone, text) {
  if (!hasRealPhone(phone)) return
  try {
    const { data: sess } = await supabase.from('conversation_sessions').select('messages, customer_phone').eq('business_id', businessId).in('customer_phone', phoneVariants(phone)).limit(1).maybeSingle()
    const msgs = Array.isArray(sess?.messages) ? sess.messages : []
    msgs.push({ role: 'assistant', content: text, timestamp: new Date().toISOString() })
    await supabase.from('conversation_sessions').upsert({ business_id: businessId, customer_phone: sess?.customer_phone || phone, messages: msgs.slice(-60), last_activity: new Date().toISOString() }, { onConflict: 'business_id,customer_phone' })
  } catch (e) { console.error('[Approval] thread note failed:', e.message) }
}

/**
 * @param {object} business  full businesses row
 * @param {object} appt      appointments row with status pending_approval
 * @returns {{ ok: boolean, status: string, texted: boolean, depositCreated: boolean, when: string, serviceDisplay: string, reason?: string }}
 */
async function approveAppointment(business, appt) {
  if (!appt) return { ok: false, reason: 'not_found' }
  if (appt.status !== 'pending_approval') return { ok: false, reason: 'not_pending', status: appt.status }

  // Multi-service bookings share a booking_group_id; approve the whole visit.
  let group = [appt]
  if (appt.booking_group_id) {
    const { data: sibs } = await supabase.from('appointments').select('*').eq('booking_group_id', appt.booking_group_id).order('created_at', { ascending: true })
    if (sibs?.length) group = sibs
  }
  const ids = group.map(a => a.id)
  const serviceDisplay = group.length > 1 ? group.map(a => a.service_name).filter(Boolean).join(' + ') : (appt.service_name || 'appointment')
  const when = `${formatDate(appt.appointment_date)}${appt.appointment_time ? ` at ${formatTime(appt.appointment_time)}` : ''}`

  await supabase.from('appointments').update({ status: 'confirmed', updated_at: new Date().toISOString() }).in('id', ids)

  // Deposit, if the service carries one. The helper flips the row to
  // deposit_pending itself and returns the pay instructions for the text.
  let depositResult = { depositCreated: false, depositText: '' }
  try {
    const profile = await db.getBusinessProfile(business.id)
    const norm = (s) => String(s || '').trim().toLowerCase()
    const service = (profile.services || []).find(s => appt.service_id && s.id === appt.service_id)
      || (profile.services || []).find(s => norm(s.name) === norm(appt.service_name))
      || (profile.services || []).find(s => norm(s.name) && (norm(appt.service_name).includes(norm(s.name)) || norm(s.name).includes(norm(appt.service_name))))
      || null
    if (service && hasRealPhone(appt.customer_phone)) {
      const returningCustomer = await db.getCustomerByPhone(business.id, appt.customer_phone).catch(() => null)
      const { tryCreateDepositForAppointment } = require('./conversationEngine')
      depositResult = await tryCreateDepositForAppointment({ business, appointment: { ...appt, status: 'confirmed' }, service, customerPhone: appt.customer_phone, customerName: appt.customer_name, returningCustomer })
    }
  } catch (e) { console.error('[Approval] deposit step failed:', e.message) }

  let texted = false
  if (hasRealPhone(appt.customer_phone) && business.sms_number) {
    const first = (appt.customer_name || '').split(' ')[0] || 'there'
    const meeting = business.location_type === 'virtual' && business.meeting_link && !depositResult.depositCreated ? `\n\n🎥 Join via video: ${business.meeting_link}` : ''
    const body = depositResult.depositCreated
      ? `Great news ${first}! ${business.business_name} approved your ${serviceDisplay} on ${when}. One last step to lock it in:${depositResult.depositText || ''}`
      : `Great news ${first}! Your ${serviceDisplay} at ${business.business_name} on ${when} is confirmed. ✅ We look forward to seeing you.${depositResult.depositText || ''}${meeting}`
    try {
      const { sendSMS } = require('../utils/sms')
      const r = await sendSMS(business.sms_number, appt.customer_phone, body)
      texted = !!r?.success
      if (texted) await noteThread(business.id, appt.customer_phone, `[Approved by the owner] ${serviceDisplay} on ${when} is ${depositResult.depositCreated ? 'approved and waiting on the deposit; the client was sent the deposit instructions' : 'confirmed'}. No booking action is needed unless the client asks to change it.`)
    } catch (e) { console.error('[Approval] text failed:', e.message) }
  }

  if (appt.customer_email) {
    try {
      const { sendCustomerConfirmationEmail } = require('../utils/emailService')
      await sendCustomerConfirmationEmail({ customerEmail: appt.customer_email, customerName: appt.customer_name, businessName: business.business_name, serviceName: serviceDisplay, appointmentDate: appt.appointment_date, appointmentTime: appt.appointment_time, smsNumber: business.sms_number })
    } catch (e) { console.error('[Approval] email failed:', e.message) }
  }

  return { ok: true, status: depositResult.depositCreated ? 'deposit_pending' : 'confirmed', texted, depositCreated: !!depositResult.depositCreated, when, serviceDisplay }
}

async function denyAppointment(business, appt, reason) {
  if (!appt) return { ok: false, reason: 'not_found' }
  if (appt.status !== 'pending_approval') return { ok: false, reason: 'not_pending', status: appt.status }
  let ids = [appt.id]
  if (appt.booking_group_id) {
    const { data: sibs } = await supabase.from('appointments').select('id').eq('booking_group_id', appt.booking_group_id)
    if (sibs?.length) ids = sibs.map(s => s.id)
  }
  await supabase.from('appointments').update({ status: 'cancelled', updated_at: new Date().toISOString() }).in('id', ids)
  let texted = false
  if (hasRealPhone(appt.customer_phone) && business.sms_number) {
    const first = (appt.customer_name || '').split(' ')[0] || 'there'
    const why = reason ? ` (${String(reason).trim().replace(/[.!]+$/, '')})` : ''
    try {
      const { sendSMS } = require('../utils/sms')
      const r = await sendSMS(business.sms_number, appt.customer_phone, `Hi ${first}, this is ${business.business_name}. Unfortunately we can't take your ${appt.service_name || 'appointment'} request for ${formatDate(appt.appointment_date)}${appt.appointment_time ? ` at ${formatTime(appt.appointment_time)}` : ''}${why}. Text us back any time and we'll find something that works. Reply STOP to opt out.`)
      texted = !!r?.success
      if (texted) await noteThread(business.id, appt.customer_phone, `[Declined by the owner] The ${appt.service_name || 'appointment'} request for ${formatDate(appt.appointment_date)} was declined${reason ? ` (${reason})` : ''}. Help them pick another time if they ask.`)
    } catch (e) { console.error('[Approval] deny text failed:', e.message) }
  }
  return { ok: true, texted }
}

module.exports = { approveAppointment, denyAppointment }
