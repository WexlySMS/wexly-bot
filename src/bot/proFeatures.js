const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ── PRE-QUALIFICATION ──────────────────────────────────────────────────────────
async function getQualificationQuestions(businessId) {
  const { data } = await supabase.from('qualification_questions').select('*').eq('business_id', businessId).order('sort_order')
  return data || []
}

async function hasExistingQualification(businessId, customerPhone) {
  const { data } = await supabase.from('conversation_sessions').select('qualification').eq('business_id', businessId).eq('customer_phone', customerPhone).maybeSingle()
  return data?.qualification?.complete === true && data?.qualification?.qualified === true
}

async function runQualificationFlow(business, customerPhone, incomingText, session, hasBookingIntent = true) {
  const questions = await getQualificationQuestions(business.id)
  if (!questions.length) return null

  const proSettings = business.pro_settings || {}
  if (!proSettings.qualification_enabled) return null

  // Skip entirely for returning qualified customers
  if (await hasExistingQualification(business.id, customerPhone)) return null

  const qState = session.qualification || { step: 0, answers: {}, complete: false, qualified: null }
  if (qState.complete) return null

  if (qState.step === 0) {
    // Don't ambush a bare greeting ("Hi") with screening questions. Only START
    // qualification once the customer has shown they actually want to book.
    // Once started (step >= 1), the flow continues regardless of content.
    if (!hasBookingIntent) return null

    session.qualification = { step: 1, answers: {}, complete: false, qualified: null }
    return `Before I check availability, I have a few quick questions to make sure we're the right fit.\n\n${questions[0].question}`
  }

  const currentQ = questions[qState.step - 1]
  qState.answers[currentQ.id] = incomingText

  if (currentQ.disqualify_if) {
    const disqualifyWords = currentQ.disqualify_if.toLowerCase().split(',').map(w => w.trim())
    const isDisqualified = disqualifyWords.some(w => incomingText.toLowerCase().includes(w))
    if (isDisqualified) {
      qState.complete = true; qState.qualified = false; session.qualification = qState
      const action = proSettings.qualification_action || 'decline'
      if (action === 'decline') {
        return `Thank you for sharing that! Based on what you've told us, we may not be the best fit right now. We appreciate your interest and wish you the best! 🙏`
      } else {
        await supabase.from('conversation_sessions').update({
          needs_attention: true, attention_reason: `Pre-qualification flag: ${currentQ.question} → "${incomingText}"`
        }).eq('business_id', business.id).eq('customer_phone', customerPhone)
        qState.qualified = true; qState.complete = true; session.qualification = qState
        return null
      }
    }
  }

  if (qState.step < questions.length) {
    qState.step++; session.qualification = qState
    return questions[qState.step - 1].question
  }

  qState.complete = true; qState.qualified = true; session.qualification = qState
  return null
}

// ── INTAKE FORMS (new multi-form model) ─────────────────────────────────────
// Reads intake_forms + intake_form_questions + intake_form_services.
// The OLD single-table intake_fields model is dead — the dashboard writes the
// new schema. See PROTECTED_DECISIONS.md Entry 18.

// Get all enabled intake forms that APPLY to a given appointment.
// - business_wide forms always apply
// - service-scoped forms apply only if the appointment's service is in the form's service list
// - first_time forms are skipped for returning customers (handled by caller via isReturning)
async function getApplicableIntakeForms(businessId, serviceId, isReturning) {
  const { data: forms } = await supabase.from('intake_forms')
    .select('*').eq('business_id', businessId).eq('enabled', true)
    .order('created_at', { ascending: true })
  if (!forms?.length) return []

  const formIds = forms.map(f => f.id)
  const [{ data: formSvcs }, { data: questions }] = await Promise.all([
    supabase.from('intake_form_services').select('form_id, service_id').in('form_id', formIds),
    supabase.from('intake_form_questions').select('*').in('form_id', formIds).order('sort_order')
  ])

  const applicable = []
  for (const form of forms) {
    // Frequency: first_time forms don't apply to returning customers
    if (form.frequency === 'first_time' && isReturning) continue

    // Scope: service-scoped forms only apply if this appointment's service matches
    if (form.scope === 'service') {
      const svcIds = (formSvcs || []).filter(fs => fs.form_id === form.id).map(fs => fs.service_id)
      if (!serviceId || !svcIds.includes(serviceId)) continue
    }

    const formQuestions = (questions || []).filter(q => q.form_id === form.id)
    if (!formQuestions.length) continue

    applicable.push({ form, questions: formQuestions })
  }
  return applicable
}

async function hasExistingIntake(businessId, customerPhone) {
  // Returns true if customer has filled out intake before — never ask again
  const { data } = await supabase.from('intake_responses').select('id').eq('business_id', businessId).eq('customer_phone', customerPhone).limit(1).maybeSingle()
  return !!data
}

async function runIntakeFlow(business, customerPhone, appointmentId, incomingText, session, serviceId = null, isReturning = false) {
  const proSettings = business.pro_settings || {}
  if (!proSettings.intake_forms) return null

  // Build the flat question list from all applicable forms (cached on the session
  // once we start, so we don't re-query mid-flow).
  let iState = session.intake || { step: 0, responses: {}, complete: false, questionList: null, introText: null }
  if (iState.complete) return null

  // First entry — figure out which forms/questions apply and cache them.
  if (iState.step === 0 || !iState.questionList) {
    const applicableForms = await getApplicableIntakeForms(business.id, serviceId, isReturning)
    if (!applicableForms.length) return null

    // Flatten all questions across applicable forms into one ordered list.
    const flat = []
    for (const { form, questions } of applicableForms) {
      for (const q of questions) {
        flat.push({ label: q.label, field_type: q.field_type, options: q.options, required: q.required })
      }
    }
    if (!flat.length) return null

    const introText = applicableForms[0].form.intro_text || 'Almost done! Just a few quick questions before your appointment:'
    iState = { step: 1, responses: {}, complete: false, questionList: flat, introText }
    session.intake = iState
    const q0 = flat[0]
    return `${introText}\n\n${q0.label}${q0.options ? `\nOptions: ${q0.options}` : ''}`
  }

  const questionList = iState.questionList
  const currentField = questionList[iState.step - 1]
  iState.responses[currentField.label] = incomingText

  if (iState.step < questionList.length) {
    const nextField = questionList[iState.step]
    iState.step++; session.intake = iState
    return `${nextField.label}${nextField.options ? `\nOptions: ${nextField.options}` : ''}`
  }

  iState.complete = true; session.intake = iState

  // Save permanently so we never ask again
  await supabase.from('intake_responses').insert({
    business_id: business.id,
    customer_phone: customerPhone,
    appointment_id: appointmentId,
    responses: iState.responses
  })

  return null
}

// ── NOTIFICATION CHECKS ───────────────────────────────────────────────────────
function shouldSendNotification(business, notifType) {
  const proSettings = business.pro_settings || {}
  const notifs = proSettings.notifications || {}
  const proOnly = ['daily_digest', 'weekly_report', 'low_availability', 'no_show_alert']
  if (proOnly.includes(notifType) && business.plan !== 'pro') return false
  // Defaults (2026-10-29): owner SMS is reserved for things that need action (escalations,
  // deposit step-ins). Bookings and cancellations go to email + app push by default; an
  // owner can switch booking/cancellation texts on in Settings → Notifications.
  const standardDefaults = { new_booking_email: true, new_booking_sms: false, escalation_email: true, escalation_sms: true, cancellation_email: true, cancellation_sms: false }
  if (notifType in notifs) return notifs[notifType]
  return standardDefaults[notifType] ?? true
}

// ── SMART SCHEDULING ──────────────────────────────────────────────────────────
function getSmartSchedulingRules(business) {
  const proSettings = business.pro_settings || {}
  if (!proSettings.smart_scheduling || business.plan !== 'pro') return null
  return {
    bufferPerService: proSettings.buffer_per_service || {},
    recurringEnabled: proSettings.recurring_enabled || false,
    vipPriority: proSettings.vip_priority || false
  }
}

module.exports = {
  runQualificationFlow,
  runIntakeFlow,
  shouldSendNotification,
  getSmartSchedulingRules,
  getQualificationQuestions,
  getApplicableIntakeForms
}
