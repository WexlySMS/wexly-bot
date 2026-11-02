const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── Business lookup ───────────────────────────────────────────────────────────
// Called on every incoming SMS — finds which business owns that Twilio number
async function getBusinessBySmsNumber(smsNumber) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('sms_number', smsNumber)
    .eq('active', true)
    .single()
  if (error) return null
  return data
}

// Load full business profile including services and FAQs
async function getBusinessProfile(businessId) {
  const today = new Date().toISOString().split('T')[0]
  const [services, faqs, blocked, promos, bundles] = await Promise.all([
    supabase.from('services').select('*').eq('business_id', businessId).neq('active', false).order('sort_order'),
    supabase.from('faqs').select('*').eq('business_id', businessId).order('sort_order'),
    supabase.from('blocked_dates').select('*').eq('business_id', businessId).gte('blocked_date', today),
    supabase.from('promotions').select('*').eq('business_id', businessId)
      .lte('start_date', today)
      .or(`end_date.is.null,end_date.gte.${today}`),
    supabase.from('service_bundles').select('*').eq('business_id', businessId)
  ])
  return {
    services: services.data || [],
    faqs: faqs.data || [],
    blockedDates: blocked.data || [],
    activePromotions: promos.data || [],
    bundles: bundles.data || []
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────
async function getSession(businessId, customerPhone) {
  const { data } = await supabase
    .from('conversation_sessions')
    .select('*')
    .eq('business_id', businessId)
    .eq('customer_phone', customerPhone)
    .maybeSingle()
  if (data && data.session_state && typeof data.session_state === 'object') {
    // Restore transient flow state onto the session object.
    if (data.session_state.intake !== undefined) data.intake = data.session_state.intake
    if (data.session_state.qualification !== undefined) data.qualification = data.session_state.qualification
    if (data.session_state.pendingIntake !== undefined) data.pendingIntake = data.session_state.pendingIntake
    if (data.session_state.pendingBooking !== undefined) data.pendingBooking = data.session_state.pendingBooking
    if (data.session_state.lastAppointmentId !== undefined && !data.lastAppointmentId) data.lastAppointmentId = data.session_state.lastAppointmentId
  }
  return data
}

async function upsertSession(businessId, customerPhone, messages, lastAppointmentId = null, sessionState = null) {
  const base = {
    business_id: businessId,
    customer_phone: customerPhone,
    messages,
    last_appointment_id: lastAppointmentId,
    last_activity: new Date().toISOString(),
    abandoned_reminder_sent: false
  }
  // Persist transient flow state (intake/qualification/pendingIntake) so the bot
  // remembers it between messages. Without this the state evaporates each
  // request and the bot re-books on every message. See PROTECTED_DECISIONS Entry 23.
  if (sessionState !== null) {
    const { error } = await supabase
      .from('conversation_sessions')
      .upsert({ ...base, session_state: sessionState }, { onConflict: 'business_id,customer_phone' })
    if (error) {
      // If the session_state column doesn't exist yet (migration not run),
      // fall back to saving without it so conversations still work.
      if (/session_state|column/i.test(error.message || '')) {
        console.error('🔴🔴🔴 [Session] CRITICAL: session_state column MISSING. Intake/booking flows WILL NOT WORK until you run add-session-state-column.sql in Supabase. Falling back to no-persistence. 🔴🔴🔴')
        await supabase.from('conversation_sessions').upsert(base, { onConflict: 'business_id,customer_phone' })
      } else {
        console.error('[Session] upsert error:', error.message)
      }
    }
    return
  }
  await supabase.from('conversation_sessions').upsert(base, { onConflict: 'business_id,customer_phone' })
}

// ── Appointments ──────────────────────────────────────────────────────────────
async function getAppointmentsByDate(businessId, date) {
  const { data } = await supabase
    .from('appointments')
    .select('*')
    .eq('business_id', businessId)
    .eq('appointment_date', date)
    .in('status', ['pending', 'confirmed'])
  return data || []
}

async function createAppointment(appt) {
  const { data, error } = await supabase
    .from('appointments')
    .insert(appt)
    .select()
    .single()
  if (error) throw error
  return data
}

async function updateAppointment(id, updates) {
  const { data, error } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

async function getAppointmentByCustomer(businessId, customerPhone) {
  const today = new Date().toISOString().split('T')[0]
  // Get active upcoming appointments
  const { data: active } = await supabase
    .from('appointments')
    .select('*')
    .eq('business_id', businessId)
    .eq('customer_phone', customerPhone)
    .in('status', ['pending', 'confirmed', 'pending_approval', 'quote_sent'])
    .gte('appointment_date', today)
    .order('appointment_date', { ascending: true })
    .limit(5)

  // Also get recently cancelled/rescheduled (last 7 days) for reschedule context
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)
  const { data: recent } = await supabase
    .from('appointments')
    .select('*')
    .eq('business_id', businessId)
    .eq('customer_phone', customerPhone)
    .in('status', ['cancelled', 'rescheduled'])
    .gte('created_at', weekAgo.toISOString())
    .order('appointment_date', { ascending: false })
    .limit(3)

  return [...(active || []), ...(recent || [])]
}

// Get upcoming confirmed appointments that need reminders
async function getAppointmentsNeedingReminders() {
  // Fetch 3-day window to cover all timezone offsets (UTC may be ahead of business local time)
  const today = new Date()
  const day0 = today.toISOString().split('T')[0]
  const day1 = new Date(today); day1.setDate(day1.getDate() + 1)
  const day1Str = day1.toISOString().split('T')[0]
  const day2 = new Date(today); day2.setDate(day2.getDate() + 2)
  const day2Str = day2.toISOString().split('T')[0]

  const { data } = await supabase
    .from('appointments')
    .select('*, businesses(sms_number, business_name, timezone, location_type, meeting_link)')
    .in('appointment_date', [day0, day1Str, day2Str])
    .eq('status', 'confirmed')
    .eq('reminder_sent', false)

  // Filter: only include if appointment is actually tomorrow in the business's timezone
  return (data || []).filter(appt => {
    const tz = appt.businesses?.timezone || 'America/New_York'
    const bizTomorrow = new Date(new Date().getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: tz })
    return appt.appointment_date === bizTomorrow
  })
}

async function getAppointmentsNeedingFollowup() {
  const today = new Date()
  const day0 = today.toISOString().split('T')[0]
  const day1 = new Date(today); day1.setDate(day1.getDate() - 1)
  const day1Str = day1.toISOString().split('T')[0]
  const day2 = new Date(today); day2.setDate(day2.getDate() - 2)
  const day2Str = day2.toISOString().split('T')[0]

  const { data } = await supabase
    .from('appointments')
    .select('*, businesses(sms_number, business_name, timezone)')
    .in('appointment_date', [day0, day1Str, day2Str])
    .eq('status', 'confirmed')
    .eq('followup_sent', false)

  return (data || []).filter(appt => {
    const tz = appt.businesses?.timezone || 'America/New_York'
    const bizYesterday = new Date(new Date().getTime() - 86400000).toLocaleDateString('en-CA', { timeZone: tz })
    return appt.appointment_date === bizYesterday
  })
}

// ── Waitlist ──────────────────────────────────────────────────────────────────
async function addToWaitlist(entry) {
  await supabase.from('waitlist').insert(entry)
}

async function getWaitlistForSlot(businessId, date, time) {
  const { data } = await supabase
    .from('waitlist')
    .select('*')
    .eq('business_id', businessId)
    .eq('preferred_date', date)
    .eq('preferred_time', time)
    .eq('notified', false)
    .order('created_at')
  return data || []
}

async function flagSession(businessId, customerPhone, reason) {
  await supabase.from('conversation_sessions').upsert({
    business_id: businessId,
    customer_phone: customerPhone,
    needs_attention: true,
    attention_reason: reason,
    manual_mode: true,
    last_activity: new Date().toISOString()
  }, { onConflict: 'business_id,customer_phone' })
}

async function getCustomerByPhone(businessId, customerPhone) {
  // Check customers table first (imports), then fall back to appointments
  const { data: imported } = await supabase
    .from('customers')
    .select('name, phone, email, is_vip, vip_note, referred_by, deposit_waived, deposit_credit')
    .eq('business_id', businessId)
    .eq('phone', customerPhone)
    .maybeSingle()

  if (imported) return {
    customer_name: imported.name,
    customer_email: imported.email || null,
    service_name: null,
    appointment_date: null,
    fromImport: true,
    is_vip: imported.is_vip || false,
    vip_note: imported.vip_note || null,
    referred_by: imported.referred_by || null,
    deposit_waived: imported.deposit_waived || false,
    deposit_credit: imported.deposit_credit || 0
  }

  // Fall back to last appointment — check customers table for deposit_waived even if booking exists
  const { data } = await supabase
    .from('appointments')
    .select('customer_name, customer_email, service_name, appointment_date')
    .eq('business_id', businessId)
    .eq('customer_phone', customerPhone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (data) {
    // Also check customers table for deposit_waived flag
    const { data: cust } = await supabase
      .from('customers')
      .select('deposit_waived')
      .eq('business_id', businessId)
      .eq('phone', customerPhone)
      .maybeSingle()
    // If the most recent appointment had no email, look back for the latest one that did.
    let email = data.customer_email || null
    if (!email) {
      const { data: withEmail } = await supabase
        .from('appointments')
        .select('customer_email')
        .eq('business_id', businessId)
        .eq('customer_phone', customerPhone)
        .not('customer_email', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      email = withEmail?.customer_email || null
    }
    return { ...data, customer_email: email, deposit_waived: cust?.deposit_waived || false }
  }

  return null
}

module.exports = {
  getBusinessBySmsNumber,
  getBusinessProfile,
  getSession,
  upsertSession,
  flagSession,
  getCustomerByPhone,
  getAppointmentsByDate,
  createAppointment,
  updateAppointment,
  getAppointmentByCustomer,
  getAppointmentsNeedingReminders,
  getAppointmentsNeedingFollowup,
  addToWaitlist,
  getWaitlistForSlot
}
