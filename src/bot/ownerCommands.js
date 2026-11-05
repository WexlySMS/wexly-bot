const { createClient } = require('@supabase/supabase-js')
const Anthropic = require('@anthropic-ai/sdk')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const anthropic = new Anthropic()

// ── Owner command tools ─────────────────────────────────────────────────────
const OWNER_TOOLS = [
  {
    name: 'block_dates',
    description: 'Block out specific dates or date ranges so customers cannot book during those times.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (same as start_date if single day)' },
        start_time: { type: 'string', description: 'Start time HH:MM if blocking specific hours, omit for full day' },
        end_time: { type: 'string', description: 'End time HH:MM if blocking specific hours, omit for full day' },
        reason: { type: 'string', description: 'Optional reason e.g. vacation, personal, staff meeting' }
      },
      required: ['start_date', 'end_date']
    }
  },
  {
    name: 'get_schedule',
    description: 'Get upcoming appointments for today, tomorrow, or a specific date. Also shows any pending approval requests. Use when owner asks "what\'s on today", "do I have anything new", "any pending appointments", "what\'s going on".',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD or "today" or "tomorrow" or "this week"' }
      },
      required: ['date']
    }
  },
  {
    name: 'pause_bot',
    description: 'Pause the bot so it stops responding to customers.',
    input_schema: {
      type: 'object',
      properties: {
        duration_hours: { type: 'number', description: 'How many hours to pause (optional — omit for indefinite)' }
      },
      required: []
    }
  },
  {
    name: 'resume_bot',
    description: 'Resume the bot so it starts responding to customers again.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel a specific appointment by customer name or date.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Customer name to find the appointment' },
        date: { type: 'string', description: 'YYYY-MM-DD date of the appointment' }
      },
      required: []
    }
  },
  {
    name: 'reschedule_appointment',
    description: 'Reschedule a customer\'s appointment. Cancels the existing appointment and texts the customer asking them to pick a new date and time. Use when owner says "reschedule Brandon\'s appointment", "move the 3pm to another day", "have them pick a new time".',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Customer name to find the appointment' },
        date: { type: 'string', description: 'YYYY-MM-DD date of the appointment to reschedule' },
        reason: { type: 'string', description: 'Brief reason for rescheduling (optional)' }
      },
      required: ['customer_name']
    }
  },
  {
    name: 'send_group_message',
    description: 'Send a text message to all members of a specific SMS group.',
    input_schema: {
      type: 'object',
      properties: {
        group_name: { type: 'string', description: 'Name of the group to message' },
        message: { type: 'string', description: 'The message to send to the group' }
      },
      required: ['group_name', 'message']
    }
  },
  {
    name: 'running_late',
    description: 'Alert all customers with appointments today that the owner is running late. Bot texts each one automatically.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'How many minutes late' },
        message: { type: 'string', description: 'Optional custom message to include' }
      },
      required: ['minutes']
    }
  },
  {
    name: 'reschedule_all',
    description: 'Cancel all appointments on a date and automatically text each customer to reschedule. Use when owner is sick, has an emergency, or needs to clear a day.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD date to clear' },
        reason: { type: 'string', description: 'Brief reason to tell customers e.g. "an unexpected situation", "illness", "a family emergency" — keep it professional and vague' }
      },
      required: ['date']
    }
  },
  {
    name: 'get_blocked_dates',
    description: 'List all currently blocked dates.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'unblock_date',
    description: 'Remove a blocked date so customers can book again.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD date to unblock' }
      },
      required: ['date']
    }
  },
  {
    name: 'mark_no_show',
    description: 'Mark a customer as a no-show for their recent appointment (today or yesterday). Use when the owner says someone didn\'t show up, missed their appointment, was a no-show, etc. — including when they\'re reporting it the next morning for the prior day.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Name of the customer who did not show up' }
      },
      required: ['customer_name']
    }
  },
  {
    name: 'confirm_deposit_waiver',
    description: 'Manually confirm an appointment that is waiting for a deposit — waives the deposit requirement. Use when owner says "confirm [name]", "approve [name]", "let [name] through without deposit", etc.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Name of the customer whose deposit to waive' }
      },
      required: ['customer_name']
    }
  },
  {
    name: 'cancel_deposit_appointment',
    description: 'Cancel a deposit-pending appointment immediately. Use when owner says "cancel [name]" in response to a deposit alert.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Name of the customer to cancel' }
      },
      required: ['customer_name']
    }
  },
  {
    name: 'send_quote',
    description: 'Send a price quote to a customer who requested one. Use when owner says "quote [name] $X", "send [name] a quote for $X", "[name] quote is $X", etc.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'First name or full name of the customer to send quote to' },
        price: { type: 'string', description: 'The price to quote e.g. "$200", "150", "$150-200"' },
        message: { type: 'string', description: 'Optional custom message to include with the quote' }
      },
      required: ['customer_name', 'price']
    }
  },
  {
    name: 'approve_booking_request',
    description: 'Approve a pending booking request from a customer. Use when owner says "approve [name]", "confirm [name] request", "yes to [name]", etc.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'First name or full name of the customer whose request to approve' }
      },
      required: ['customer_name']
    }
  },
  {
    name: 'deny_booking_request',
    description: 'Deny a pending booking request from a customer. Use when owner says "deny [name]", "decline [name] request", "no to [name]", "reject [name]", etc.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'First name or full name of the customer whose request to deny' }
      },
      required: ['customer_name']
    }
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder the assistant will text the owner at a specific time. Use for "remind me tomorrow at 9 to call the supplier", "remind me Friday about booking the photographer", "ping me in 2 hours". Resolve relative phrases against today\'s date and the business timezone given in the system prompt. If no time is given, use 9:00 AM.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to remind them about, in their words' },
        minutes_from_now: { type: 'number', description: 'Minutes from now. Use for short relative delays like "in 10 minutes" or "in 2 hours".' },
        remind_at_local: { type: 'string', description: 'Local date and time in the business timezone, format YYYY-MM-DDTHH:MM (24h). Example: 2026-10-31T09:00. Use for a named day or clock time.' }
      },
      required: ['message']
    }
  },
  {
    name: 'list_reminders',
    description: 'List the owner\'s upcoming reminders. Use for "what reminders do I have", "any reminders set".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel an upcoming reminder by matching its text. Use for "cancel the supplier reminder", "forget that reminder".',
    input_schema: {
      type: 'object',
      properties: { match: { type: 'string', description: 'Words from the reminder to cancel' } },
      required: ['match']
    }
  },
  {
    name: 'add_services',
    description: 'Add one or more bookable services with duration and price. Use when the owner lists services, e.g. "Haircut 45 min $60, Color 2 hr $150", "add a service: Brow wax 15 min $20", "my services are...". Convert hours to minutes (2 hr = 120). If no duration is given use 60. Price is optional.',
    input_schema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          description: 'Services to add',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Service name, e.g. "Haircut"' },
              duration_mins: { type: 'number', description: 'Length in minutes (default 60)' },
              price: { type: 'number', description: 'Price in dollars, omit if not given' }
            },
            required: ['name']
          }
        }
      },
      required: ['services']
    }
  },
  {
    name: 'update_inventory',
    description: 'Update the stock quantity of a product. Use when owner says things like "added 10 Olaplex", "restocked shampoo 24 units", "we got 6 more nail polish in", "update inventory: Olaplex 15".',
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Name or partial name of the product to update' },
        quantity_change: { type: 'number', description: 'Number of units to ADD to current stock (positive number)' },
        set_quantity: { type: 'number', description: 'Set stock to this exact number (use instead of quantity_change if owner specifies exact total)' }
      },
      required: ['product_name']
    }
  },
  {
    name: 'staff_callout',
    description: 'Mark a staff member as out/unavailable for a period. Use when owner says "Sarah is out today", "John called out", "Mike is sick this week", "Sarah won\'t be in tomorrow". Auto-reassigns their appointments to available staff and notifies affected customers.',
    input_schema: {
      type: 'object',
      properties: {
        staff_name: { type: 'string', description: 'Name of the staff member who is out' },
        start_date: { type: 'string', description: 'First day out YYYY-MM-DD (default today)' },
        end_date: { type: 'string', description: 'Last day out YYYY-MM-DD (same as start if just one day)' },
        reason: { type: 'string', description: 'Brief reason — "sick", "personal", "emergency". Keep vague for customer messages.' }
      },
      required: ['staff_name']
    }
  },
  {
    name: 'remove_staff',
    description: 'Permanently remove a staff member from the business. Use when owner says "remove John", "John quit", "fire Sarah", "take Mike off staff". Removes from staff list and reassigns all their future appointments.',
    input_schema: {
      type: 'object',
      properties: {
        staff_name: { type: 'string', description: 'Name of the staff member to remove' }
      },
      required: ['staff_name']
    }
  },
  {
    name: 'reassign_appointments',
    description: 'Move one staff member\'s appointments to another staff member. Use when owner says "move Sarah\'s appointments to Mike", "give John\'s clients to Lisa today", "reassign Sarah to Mike".',
    input_schema: {
      type: 'object',
      properties: {
        from_staff: { type: 'string', description: 'Staff member whose appointments to move' },
        to_staff: { type: 'string', description: 'Staff member to receive the appointments' },
        date: { type: 'string', description: 'Specific date YYYY-MM-DD, or "today", "tomorrow", "this week". If omitted, moves all future appointments.' }
      },
      required: ['from_staff', 'to_staff']
    }
  }
]

// ── Handle owner tool calls ─────────────────────────────────────────────────
// Convert "YYYY-MM-DDTHH:MM" in an IANA timezone to a UTC Date. Two-pass
// offset correction handles DST edges without a date library.
function localToUtc(local, tz) {
  const [d, t] = local.split('T')
  const [y, m, day] = d.split('-').map(Number)
  const [hh, mm] = t.split(':').map(Number)
  const asUtc = Date.UTC(y, m - 1, day, hh, mm)
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))
    const g = (k) => Number(parts.find(p => p.type === k).value)
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - ms
  }
  let guess = asUtc - offsetAt(asUtc)
  guess = asUtc - offsetAt(guess)
  return new Date(guess)
}

async function executeOwnerTool(toolName, input, business) {
  const tz = business.timezone || 'America/New_York'
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz })

  switch (toolName) {

    case 'block_dates': {
      const startDate = input.start_date
      const endDate = input.end_date || input.start_date

      // Generate all dates in range
      const dates = []
      const current = new Date(startDate + 'T12:00:00')
      const end = new Date(endDate + 'T12:00:00')
      while (current <= end) {
        dates.push(current.toISOString().split('T')[0])
        current.setDate(current.getDate() + 1)
      }

      // Insert blocked dates
      const records = dates.map(date => ({
        business_id: business.id,
        blocked_date: date,
        start_time: input.start_time || null,
        end_time: input.end_time || null,
        reason: input.reason || null
      }))

      console.log(`[Owner] block_dates: ${dates.join(', ')} ${input.start_time || 'full'}-${input.end_time || 'day'}`)
      let { error } = await supabase.from('blocked_dates').upsert(records, { onConflict: 'business_id,blocked_date' })
      if (error) {
        console.error(`[Owner] block_dates upsert failed (${error.message}) — falling back to delete+insert`)
        try {
          await supabase.from('blocked_dates').delete()
            .eq('business_id', business.id).in('blocked_date', dates)
          const ins = await supabase.from('blocked_dates').insert(records)
          if (ins.error) {
            console.error(`[Owner] block_dates insert fallback failed: ${ins.error.message}`)
            return `I couldn't block those dates due to a system error. Please try again or block them from your dashboard.`
          }
        } catch (e) {
          console.error(`[Owner] block_dates fallback exception: ${e.message}`)
          return `I couldn't block those dates due to a system error. Please try again or block them from your dashboard.`
        }
      }

      const isPartialDay = input.start_time && input.end_time
      const dateRange = startDate === endDate ? startDate : `${startDate} to ${endDate}`
      const timeRange = isPartialDay ? ` from ${input.start_time} to ${input.end_time}` : ' (full day)'
      return `✅ Done! Blocked ${dateRange}${timeRange}. Customers won't be able to book during those times.`
    }

    case 'get_schedule': {
      let targetDate = today
      const input_date = input.date?.toLowerCase()

      if (input_date === 'today') {
        targetDate = today
      } else if (input_date === 'tomorrow') {
        const tz2 = business.timezone || 'America/New_York'
        targetDate = new Date(new Date().getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: tz2 })
      } else if (input_date?.match(/^\d{4}-\d{2}-\d{2}$/)) {
        targetDate = input_date
      }

      const { data: appts } = await supabase
        .from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .eq('appointment_date', targetDate)
        .neq('status', 'cancelled')
        .order('appointment_time')

      // Also get all pending approvals (any date)
      const { data: allPending } = await supabase
        .from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .eq('status', 'pending_approval')
        .order('appointment_date')

      if (!appts?.length && !allPending?.length) return `📅 No appointments on ${targetDate} and no pending requests.`

      var result = ''

      if (appts?.length) {
        const list = appts.map(a => {
          const time = a.appointment_time ? a.appointment_time.slice(0, 5) : '?'
          const [h, m] = time.split(':')
          const hr = parseInt(h)
          const ampm = hr >= 12 ? 'pm' : 'am'
          const displayHr = hr > 12 ? hr - 12 : hr || 12
          const status = a.status === 'pending_approval' ? ' ⏳ PENDING' : ''
          return `• ${displayHr}:${m}${ampm} — ${a.customer_name} (${a.service_name || 'Appointment'})${status}`
        }).join('\n')
        result += `📅 Schedule for ${targetDate}:\n${list}\nTotal: ${appts.length}`
      } else {
        result += `📅 No appointments on ${targetDate}.`
      }

      if (allPending?.length) {
        const pendList = allPending.map(a => {
          return `• ${a.appointment_date} — ${a.customer_name} (${a.service_name || 'Appointment'})`
        }).join('\n')
        result += `\n\n⏳ ${allPending.length} pending approval${allPending.length > 1 ? 's' : ''}:\n${pendList}\nReply "Approve [name]" or "Deny [name]"`
      }

      return result
    }

    case 'pause_bot': {
      const updates = { active: false }
      if (input.duration_hours) {
        const resumeAt = new Date()
        resumeAt.setHours(resumeAt.getHours() + input.duration_hours)
        updates.resume_at = resumeAt.toISOString()
      }
      await supabase.from('businesses').update(updates).eq('id', business.id)
      const duration = input.duration_hours ? ` for ${input.duration_hours} hour${input.duration_hours !== 1 ? 's' : ''}` : ''
      return `⏸️ Bot paused${duration}. Customers will not receive responses. Text "resume bot" to turn it back on.`
    }

    case 'resume_bot': {
      await supabase.from('businesses').update({ active: true, resume_at: null }).eq('id', business.id)
      return `🟢 Bot is back on! Responding to customers again.`
    }

    case 'cancel_appointment': {
      let query = supabase.from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .neq('status', 'cancelled')

      if (input.date) query = query.eq('appointment_date', input.date)
      if (input.customer_name) query = query.ilike('customer_name', `%${input.customer_name}%`)

      const { data: appts } = await query.order('appointment_date').limit(5)

      if (!appts?.length) return `Couldn't find that appointment. Try being more specific with the name or date.`

      if (appts.length > 1) {
        const list = appts.map(a => `• ${a.appointment_date} at ${a.appointment_time?.slice(0,5)} — ${a.customer_name}`).join('\n')
        return `Found ${appts.length} appointments. Which one?\n${list}\n\nReply with the exact date and name to cancel.`
      }

      const appt = appts[0]
      await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', appt.id)
      return `✅ Cancelled ${appt.customer_name}'s appointment on ${appt.appointment_date} at ${appt.appointment_time?.slice(0,5)}.`
    }

    case 'reschedule_appointment': {
      let query = supabase.from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .neq('status', 'cancelled')

      if (input.date) query = query.eq('appointment_date', input.date)
      if (input.customer_name) query = query.ilike('customer_name', `%${input.customer_name}%`)

      const { data: appts } = await query.order('appointment_date').limit(5)

      if (!appts?.length) return `Couldn't find that appointment. Try being more specific with the name or date.`

      if (appts.length > 1) {
        const list = appts.map(a => `• ${a.appointment_date} at ${a.appointment_time?.slice(0,5)} — ${a.customer_name}`).join('\n')
        return `Found ${appts.length} appointments. Which one?\n${list}\n\nReply with the exact date and name to reschedule.`
      }

      const appt = appts[0]

      // Cancel the old appointment
      await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', appt.id)

      // Text the customer to rebook
      if (appt.customer_phone && business.sms_number) {
        const { sendSMS } = require('../utils/sms')
        const firstName = (appt.customer_name || '').split(' ')[0] || 'there'
        const reason = input.reason ? ` due to ${input.reason}` : ''
        const msg = `Hi ${firstName}! We need to reschedule your ${appt.service_name || 'appointment'} on ${appt.appointment_date}${reason}. Text us back with a new date and time that works for you and we'll get you rebooked right away!`
        await sendSMS(business.sms_number, appt.customer_phone, msg)
      }

      return `✅ Rescheduled ${appt.customer_name}'s ${appt.service_name || 'appointment'} on ${appt.appointment_date} at ${appt.appointment_time?.slice(0,5)}.\n\nOld appointment cancelled. Customer has been texted to pick a new date and time.`
    }

    case 'send_group_message': {
      const { group_name, message } = input

      // Find the group
      const { data: groups } = await supabase
        .from('sms_groups')
        .select('*')
        .eq('business_id', business.id)
        .ilike('name', `%${group_name}%`)

      if (!groups?.length) {
        const { data: allGroups } = await supabase.from('sms_groups').select('name').eq('business_id', business.id)
        const list = allGroups?.map(g => `• ${g.name}`).join('\n') || 'No groups yet'
        return `Couldn't find a group called "${group_name}". Your groups:\n${list}`
      }

      const group = groups[0]

      // Get members
      const { data: members } = await supabase
        .from('sms_group_members')
        .select('customers(name, phone, opted_out)')
        .eq('group_id', group.id)

      if (!members?.length) return `The "${group.name}" group has no members yet.`

      const { sendSMS } = require('../utils/sms')
      let sent = 0

      for (const m of members) {
        const c = m.customers
        if (!c?.phone || c.opted_out) continue
        const firstName = c.name?.split(' ')[0] || 'there'
        const msg = message.replace(/{name}/gi, firstName) + (message.includes('STOP') ? '' : '\n\nReply STOP to unsubscribe.')
        try {
          await sendSMS(business.sms_number, c.phone, msg)
          sent++
          await new Promise(r => setTimeout(r, 100))
        } catch (err) {
          console.error(`[GroupMsg] Failed for ${c.phone}:`, err.message)
        }
      }

      return `✅ Sent to ${sent} member${sent !== 1 ? 's' : ''} in "${group.name}"!`
    }

    case 'running_late': {
      const minutes = input.minutes || 15
      const tz = business.timezone || 'America/New_York'
      const today = new Date().toLocaleDateString('en-CA', { timeZone: tz })

      // Get remaining appointments today
      const now = new Date()
      const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`

      const { data: appts } = await supabase
        .from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .eq('appointment_date', today)
        .eq('status', 'confirmed')
        .gte('appointment_time', currentTime)
        .order('appointment_time')

      if (!appts?.length) return `No upcoming appointments today to notify.`

      const { sendSMS } = require('../utils/sms')
      let notified = 0

      for (const appt of appts) {
        const firstName = appt.customer_name?.split(' ')[0] || 'there'
        const [h, m] = (appt.appointment_time || '00:00').split(':')
        const hr = parseInt(h)
        const ampm = hr >= 12 ? 'pm' : 'am'
        const displayHr = hr > 12 ? hr - 12 : hr || 12
        const timeStr = `${displayHr}:${m}${ampm}`

        const msg = input.message
          ? `Hey ${firstName}! Quick heads up — ${input.message} We'll see you soon!`
          : `Hey ${firstName}! Quick heads up — we're running about ${minutes} minutes behind today. Your ${timeStr} appointment is still on, just slightly delayed. Thank you for your patience! 🙏`

        try {
          await sendSMS(business.sms_number, appt.customer_phone, msg)
          notified++
          await new Promise(r => setTimeout(r, 300))
        } catch (err) {
          console.error(`[LateAlert] Failed for ${appt.customer_name}:`, err.message)
        }
      }

      return `✅ Done! Notified ${notified} customer${notified !== 1 ? 's' : ''} that you're running ${minutes} minutes late.`
    }

    case 'reschedule_all': {
      const targetDate = input.date
      const reason = input.reason || 'an unexpected situation'

      // 1. Get all appointments for that date
      const { data: appts } = await supabase
        .from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .eq('appointment_date', targetDate)
        .neq('status', 'cancelled')
        .order('appointment_time')

      if (!appts?.length) {
        return `No appointments found on ${targetDate} — nothing to reschedule.`
      }

      // 2. Block the date
      await supabase.from('blocked_dates').upsert({
        business_id: business.id,
        blocked_date: targetDate,
        reason: reason
      }, { onConflict: 'business_id,blocked_date' })

      // 3. Cancel all appointments and text each customer
      const { sendSMS } = require('../utils/sms')
      let notified = 0
      const failed = []

      for (const appt of appts) {
        // Cancel the appointment
        await supabase.from('appointments')
          .update({ status: 'cancelled' })
          .eq('id', appt.id)

        // Format their time nicely
        const [h, m] = (appt.appointment_time || '00:00').split(':')
        const hr = parseInt(h)
        const ampm = hr >= 12 ? 'pm' : 'am'
        const displayHr = hr > 12 ? hr - 12 : hr || 12
        const timeStr = `${displayHr}:${m}${ampm}`

        // Text the customer
        const msg = `Hi ${appt.customer_name?.split(' ')[0] || 'there'}! Unfortunately ${business.business_name} needs to reschedule your ${appt.service_name || 'appointment'} on ${targetDate} at ${timeStr} due to ${reason}. We're sorry for the inconvenience! Reply here anytime to pick a new time and we'll get you rebooked right away 😊`

        try {
          await sendSMS(business.sms_number, appt.customer_phone, msg)
          notified++
          // Small delay to avoid rate limits
          await new Promise(r => setTimeout(r, 300))
        } catch (err) {
          console.error(`[Owner] Failed to notify ${appt.customer_name}:`, err.message)
          failed.push(appt.customer_name)
        }
      }

      let reply = `✅ Done! Cancelled ${appts.length} appointment${appts.length !== 1 ? 's' : ''} and notified ${notified} customer${notified !== 1 ? 's' : ''} on ${targetDate}. They'll be rebooked automatically as they reply.`
      if (failed.length) reply += `\n\n⚠️ Could not reach: ${failed.join(', ')}`

      return reply
    }

    case 'get_blocked_dates': {
      const { data: blocked } = await supabase
        .from('blocked_dates')
        .select('*')
        .eq('business_id', business.id)
        .gte('blocked_date', today)
        .order('blocked_date')

      if (!blocked?.length) return `No blocked dates coming up. All clear! 🟢`

      const list = blocked.map(b => {
        const time = b.start_time ? ` (${b.start_time}–${b.end_time})` : ' (full day)'
        const reason = b.reason ? ` — ${b.reason}` : ''
        return `• ${b.blocked_date}${time}${reason}`
      }).join('\n')

      return `🚫 Blocked dates:\n${list}`
    }

    case 'unblock_date': {
      const { error } = await supabase
        .from('blocked_dates')
        .delete()
        .eq('business_id', business.id)
        .eq('blocked_date', input.date)

      if (error) return `Error unblocking date: ${error.message}`
      return `✅ ${input.date} is now open for bookings again.`
    }

    case 'mark_no_show': {
      const tz = business.timezone || 'America/New_York'
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz })
      // Owners usually mark no-shows the NEXT morning for the prior day, so we
      // search both today and yesterday rather than just today.
      const yesterdayDate = new Date()
      yesterdayDate.setDate(yesterdayDate.getDate() - 1)
      const yesterdayStr = yesterdayDate.toLocaleDateString('en-CA', { timeZone: tz })

      const nameSearch = input.customer_name?.toLowerCase()
      if (!nameSearch) return `Who should I mark as a no-show? Let me know their name.`

      // Find recent appointments matching this name (today or yesterday).
      const { data: allAppts } = await supabase
        .from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .in('appointment_date', [todayStr, yesterdayStr])

      // Exclude already-cancelled or already-no-show appointments (filter in JS
      // to avoid finicky .not('in') query syntax).
      const appts = (allAppts || []).filter(a => a.status !== 'cancelled' && a.status !== 'no_show')

      if (!appts.length) return `No appointments found for today or yesterday to mark.`

      const matches = appts.filter(a => a.customer_name?.toLowerCase().includes(nameSearch))
      if (!matches.length) {
        const names = [...new Set(appts.map(a => a.customer_name))].join(', ')
        return `Couldn't find "${input.customer_name}" in the last day's appointments. Recent appointments: ${names}`
      }

      // If multiple appointments match the name (e.g. same person twice), prefer
      // the most recent by date+time.
      const match = matches.sort((a, b) =>
        `${b.appointment_date} ${b.appointment_time || ''}`.localeCompare(`${a.appointment_date} ${a.appointment_time || ''}`)
      )[0]

      // Mark as no-show in DB
      await supabase.from('appointments').update({ status: 'no_show' }).eq('id', match.id)

      // Fire recovery text if enabled
      if (business.noshow_recovery_enabled) {
        const { sendSMS } = require('../utils/sms')
        const firstName = match.customer_name?.split(' ')[0] || 'there'
        const service = match.service_name || 'appointment'
        const defaultMsg = `Hey ${firstName}! We had you down for a ${service} at ${business.business_name} — did something come up? No worries, just text back whenever you're ready to reschedule 😊`
        let msg = business.noshow_recovery_message || defaultMsg
        msg = msg.replace(/{name}/gi, firstName).replace(/{service}/gi, service)
        if (match.customer_phone) {
          await sendSMS(business.sms_number, match.customer_phone, msg).catch(() => {})
          return `✅ Marked ${match.customer_name} as a no-show (${match.appointment_date}) — recovery text sent.`
        }
      }

      return `✅ Marked ${match.customer_name} as a no-show (${match.appointment_date}).`
    }

    case 'confirm_deposit_waiver': {
      const nameSearch = input.customer_name?.toLowerCase()
      const { data: appts } = await supabase
        .from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .eq('status', 'deposit_pending')
        .eq('deposit_status', 'pending')

      if (!appts?.length) return `No appointments currently waiting on a deposit.`

      const match = appts.find(a => a.customer_name?.toLowerCase().includes(nameSearch))
      if (!match) {
        const names = appts.map(a => a.customer_name).join(', ')
        return `Couldn't find "${input.customer_name}" waiting on a deposit. Pending deposits: ${names}`
      }

      await supabase.from('appointments')
        .update({ status: 'confirmed', deposit_status: 'waived', deposit_expires_at: null })
        .eq('id', match.id)

      // Text the customer they're confirmed
      const { sendSMS } = require('../utils/sms')
      const firstName = match.customer_name?.split(' ')[0] || 'there'
      const service = match.service_name || 'appointment'
      const apptDate = match.appointment_date || ''
      await sendSMS(business.sms_number, match.customer_phone,
        `Great news ${firstName}! Your ${service} at ${business.business_name} on ${apptDate} is confirmed — we've got you locked in. See you then! 😊`
      ).catch(() => {})

      return `✅ Confirmed! ${match.customer_name}'s ${service} is locked in and they've been notified. Deposit waived.`
    }

    case 'cancel_deposit_appointment': {
      const nameSearch = input.customer_name?.toLowerCase()
      const { data: appts } = await supabase
        .from('appointments')
        .select('*')
        .eq('business_id', business.id)
        .eq('status', 'deposit_pending')

      if (!appts?.length) return `No deposit-pending appointments found.`

      const match = appts.find(a => a.customer_name?.toLowerCase().includes(nameSearch))
      if (!match) return `Couldn't find "${input.customer_name}" with a pending deposit.`

      await supabase.from('appointments')
        .update({ status: 'cancelled', deposit_status: 'expired' })
        .eq('id', match.id)

      const { sendSMS } = require('../utils/sms')
      const firstName = match.customer_name?.split(' ')[0] || 'there'
      const service = match.service_name || 'appointment'
      await sendSMS(business.sms_number, match.customer_phone,
        `Hey ${firstName}! We've gone ahead and released your ${service} slot at ${business.business_name}. Whenever you're ready to rebook and sort the deposit, just text us back — we'd love to have you in! 😊`
      ).catch(() => {})

      return `✅ Cancelled ${match.customer_name}'s ${service}. They've been notified and can rebook anytime.`
    }

    case 'send_quote': {
      const search = input.customer_name?.toLowerCase()
      const sb2 = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

      // Find pending_approval appointment for this customer
      const { data: pending } = await sb2.from('appointments')
        .select('*').eq('business_id', business.id).eq('status', 'pending_approval')
      const match = pending?.find(a => a.customer_name?.toLowerCase().includes(search))

      if (!match) return `No pending quote request found for "${input.customer_name}". Check the dashboard for the full list.`

      const price = input.price.startsWith('$') ? input.price : `$${input.price}`
      const serviceName = match.service_name || 'your service'
      const customMsg = input.message ? ` ${input.message}` : ''

      // Text the customer with the quote
      const { sendSMS } = require('../utils/sms')
      await sendSMS(business.sms_number, match.customer_phone,
        `Hi ${match.customer_name?.split(' ')[0] || 'there'}! Your quote for ${serviceName} is ${price}.${customMsg} Would you like to go ahead and book? 😊`
      )

      // Update appointment with quoted price and status
      await sb2.from('appointments')
        .update({ status: 'quote_sent', notes: (match.notes ? match.notes + ' | ' : '') + `Quote sent: ${price}` })
        .eq('id', match.id)

      return `✅ Quote sent! ${match.customer_name} has been texted: "${price} for ${serviceName}"`
    }

    case 'approve_booking_request': {
      const search = input.customer_name?.toLowerCase()
      const { data: pending } = await supabase.from('appointments')
        .select('*').eq('business_id', business.id).eq('status', 'pending_approval')
      const match = pending?.find(a => a.customer_name?.toLowerCase().includes(search))
      if (!match) return `No pending request found for "${input.customer_name}". Check the dashboard for the full list.`

      await supabase.from('appointments').update({ status: 'confirmed' }).eq('id', match.id)

      // Text the customer
      try {
        const { sendSMS } = require('../utils/sms')
        await sendSMS(business.sms_number, match.customer_phone,
          `Great news! Your ${match.service_name || 'appointment'} on ${match.appointment_date}${match.appointment_time ? ' at ' + match.appointment_time.slice(0,5) : ''} has been confirmed! ✅ We look forward to seeing you. Reply STOP to opt out.`
        )
        console.log(`[Approval] Confirmed — texted ${match.customer_phone}`)
      } catch(smsErr) {
        console.error('[Approval] Failed to text customer:', smsErr.message)
      }

      // Email confirmation if customer has email
      if (match.customer_email) {
        try {
          const { sendCustomerConfirmationEmail } = require('../utils/emailService')
          await sendCustomerConfirmationEmail({
            customerEmail: match.customer_email,
            customerName: match.customer_name,
            businessName: business.business_name,
            serviceName: match.service_name,
            appointmentDate: match.appointment_date,
            appointmentTime: match.appointment_time,
            smsNumber: business.sms_number
          })
        } catch(emailErr) {
          console.error('[Approval] Failed to email customer:', emailErr.message)
        }
      }

      return `✅ Approved! ${match.customer_name} has been texted their confirmation.`
    }

    case 'deny_booking_request': {
      const search = input.customer_name?.toLowerCase()
      const { data: pending } = await supabase.from('appointments')
        .select('*').eq('business_id', business.id).eq('status', 'pending_approval')
      const match = pending?.find(a => a.customer_name?.toLowerCase().includes(search))
      if (!match) return `No pending request found for "${input.customer_name}". Check the dashboard for the full list.`

      await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', match.id)

      try {
        const { sendSMS } = require('../utils/sms')
        await sendSMS(business.sms_number, match.customer_phone,
          `Hi ${match.customer_name?.split(' ')[0] || 'there'}! Unfortunately we weren't able to accommodate your ${match.service_name || 'appointment'} request at this time. Feel free to text us to explore other options. Reply STOP to opt out.`
        )
        console.log(`[Approval] Denied — texted ${match.customer_phone}`)
      } catch(smsErr) {
        console.error('[Approval] Failed to text customer:', smsErr.message)
      }

      return `❌ Denied. ${match.customer_name} has been notified.`
    }

    // 🔒 v191: owner reminders. The scheduler sweep (every 5 min) texts them
    // from the business number. Local time → UTC via the business timezone.
    case 'set_reminder': {
      const msg = String(input.message || '').trim().slice(0, 300)
      const local = String(input.remind_at_local || '').trim()
      const tz = business.timezone || 'America/Los_Angeles'
      let whenUtc = null
      if (input.minutes_from_now !== undefined && input.minutes_from_now !== null && !isNaN(Number(input.minutes_from_now))) {
        const mins = Math.min(Math.max(Number(input.minutes_from_now), 1), 60 * 24 * 90)
        whenUtc = new Date(Date.now() + mins * 60 * 1000)
      } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) {
        whenUtc = localToUtc(local, tz)
      }
      if (!msg || !whenUtc) return `Tell me what to remind you about and when, like "remind me tomorrow at 9 to order color".`
      if (!whenUtc || isNaN(whenUtc.getTime())) return `I couldn't work out that time. Try "tomorrow at 9am" or a date like Nov 3 at 2pm.`
      if (whenUtc.getTime() < Date.now() - 60 * 1000) return `That time already passed. When should I remind you?`
      const { error } = await supabase.from('owner_reminders').insert({ business_id: business.id, message: msg, remind_at: whenUtc.toISOString() })
      if (error) return `I couldn't save that reminder (${error.message}). Try again in a minute.`
      const pretty = whenUtc.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })
      return `✅ Reminder set for ${pretty}: "${msg}". I'll text you here.`
    }

    case 'list_reminders': {
      const tz = business.timezone || 'America/Los_Angeles'
      const { data: rows } = await supabase.from('owner_reminders')
        .select('message, remind_at').eq('business_id', business.id)
        .is('sent_at', null).is('cancelled_at', null).order('remind_at').limit(10)
      if (!rows?.length) return `No reminders set. Say "remind me tomorrow at 9 to..." and I'll add one.`
      return rows.map(r => `• ${new Date(r.remind_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })}: ${r.message}`).join('\n')
    }

    case 'cancel_reminder': {
      const needle = String(input.match || '').toLowerCase().trim()
      const { data: rows } = await supabase.from('owner_reminders')
        .select('id, message').eq('business_id', business.id)
        .is('sent_at', null).is('cancelled_at', null).order('remind_at').limit(20)
      const hit = (rows || []).find(r => r.message.toLowerCase().includes(needle)) || ((rows || []).length === 1 ? rows[0] : null)
      if (!hit) return `I couldn't find a reminder matching "${input.match}". Say "list reminders" to see them.`
      await supabase.from('owner_reminders').update({ cancelled_at: new Date().toISOString() }).eq('id', hit.id)
      return `Cancelled: "${hit.message}".`
    }

    // 🔒 v190: services by text. Names are matched case-insensitively against
    // existing active services so "Haircut" twice updates instead of duplicating.
    case 'add_services': {
      const list = Array.isArray(input.services) ? input.services.filter(x => x && x.name) : []
      if (!list.length) return `Tell me the service, how long it takes, and the price. Example: "Haircut 45 min $60".`
      const { data: existing } = await supabase.from('services')
        .select('id, name, sort_order').eq('business_id', business.id).neq('active', false)
      const byName = {}
      ;(existing || []).forEach(s => { byName[s.name.trim().toLowerCase()] = s })
      let nextOrder = (existing || []).reduce((m, s) => Math.max(m, s.sort_order || 0), -1) + 1
      const added = [], updated = []
      for (const svc of list.slice(0, 25)) {
        const name = String(svc.name).trim().slice(0, 80)
        if (!name) continue
        const dur = Math.min(Math.max(parseInt(svc.duration_mins) || 60, 5), 24 * 60)
        const row = { name, duration_mins: dur }
        if (svc.price !== undefined && svc.price !== null && !isNaN(Number(svc.price))) row.price = Math.max(0, Number(svc.price))
        const hit = byName[name.toLowerCase()]
        if (hit) {
          const { error } = await supabase.from('services').update(row).eq('id', hit.id)
          if (!error) updated.push(name)
        } else {
          const { error } = await supabase.from('services').insert({
            business_id: business.id, ...row, booking_mode: 'instant', active: true, sort_order: nextOrder++
          })
          if (!error) added.push(name)
        }
      }
      const fmt = (names) => names.join(', ')
      const parts = []
      if (added.length) parts.push(`Added: ${fmt(added)}`)
      if (updated.length) parts.push(`Updated: ${fmt(updated)}`)
      if (!parts.length) return `I couldn't save those. Try again like "Haircut 45 min $60".`
      return `✅ ${parts.join('. ')}. Clients can book these now. You can fine-tune deposits and staff in your dashboard under Services.`
    }

    case 'update_inventory': {
      const nameSearch = input.product_name?.toLowerCase()
      const { data: products } = await supabase
        .from('products')
        .select('*')
        .eq('business_id', business.id)

      if (!products?.length) return `No products found. Add products in your dashboard under Settings → Products.`

      const match = products.find(p => p.name?.toLowerCase().includes(nameSearch))
      if (!match) return `Couldn't find a product matching "${input.product_name}". Check your product names in Settings → Products.`

      let newQty
      if (input.set_quantity !== undefined && input.set_quantity !== null) {
        newQty = Math.max(0, input.set_quantity)
      } else if (input.quantity_change !== undefined) {
        newQty = Math.max(0, (match.qty || 0) + input.quantity_change)
      } else {
        return `Got it — what should I set the quantity to for ${match.name}?`
      }

      await supabase.from('products').update({ qty: newQty }).eq('id', match.id)

      // Check if still low stock after update
      let lowStockNote = ''
      if (match.low_stock_threshold !== null && newQty <= match.low_stock_threshold) {
        lowStockNote = ` (still below your alert threshold of ${match.low_stock_threshold})`
      }

      return `✅ Updated ${match.name} — stock is now ${newQty} units${lowStockNote}.`
    }

    case 'staff_callout':
      return await handleStaffCallout(business, input)

    case 'remove_staff':
      return await handleRemoveStaff(business, input)

    case 'reassign_appointments':
      return await handleReassignAppointments(business, input)

    default:
      return `Unknown command.`
  }
}

// ── Staff management helpers ────────────────────────────────────────────────
async function handleStaffCallout(business, input) {
  const { sendSMS } = require('../utils/sms')
  const staffMembers = business.staff_members || []
  const staffName = input.staff_name?.toLowerCase()
  const staff = staffMembers.find(s => s.name?.toLowerCase().includes(staffName))
  if (!staff) return `Couldn't find a staff member matching "${input.staff_name}". Your staff: ${staffMembers.map(s => s.name).join(', ') || 'none configured'}`

  const tz_sc = business.timezone || 'America/New_York'
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz_sc })
  const startDate = input.start_date || today
  const endDate = input.end_date || startDate

  // Block this staff member's dates
  const dates = []
  var d = new Date(startDate + 'T12:00:00')
  var end = new Date(endDate + 'T12:00:00')
  while (d <= end) {
    dates.push(d.toISOString().split('T')[0])
    d.setDate(d.getDate() + 1)
  }

  // Find all their appointments on those dates
  const { data: appts } = await supabase.from('appointments')
    .select('*').eq('business_id', business.id)
    .eq('staff_name', staff.name)
    .in('appointment_date', dates)
    .in('status', ['confirmed', 'pending'])

  var reassigned = 0, notified = 0
  var otherStaff = staffMembers.filter(s => s.name !== staff.name && s.name)

  for (var appt of (appts || [])) {
    // Try to reassign to another staff member
    var newStaff = otherStaff.length ? otherStaff[reassigned % otherStaff.length] : null
    if (newStaff) {
      await supabase.from('appointments').update({ staff_name: newStaff.name }).eq('id', appt.id)
      reassigned++
    }
    // Notify customer
    if (appt.customer_phone && business.sms_number) {
      var reason = input.reason || 'an unexpected schedule change'
      var msg = newStaff
        ? `Hi ${(appt.customer_name || '').split(' ')[0]}! Quick update — ${staff.name} is unavailable due to ${reason}. We've moved your ${appt.service_name || 'appointment'} to ${newStaff.name} at the same time. No action needed! Reply if you have questions.`
        : `Hi ${(appt.customer_name || '').split(' ')[0]}! Quick update — ${staff.name} is unavailable due to ${reason}. We're working on getting your ${appt.service_name || 'appointment'} covered — we'll text you with an update shortly. Reply STOP to opt out.`
      sendSMS(business.sms_number, appt.customer_phone, msg).catch(() => {})
      notified++
    }
  }

  var dateLabel = startDate === endDate
    ? new Date(startDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : new Date(startDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' – ' + new Date(endDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  // Block staff from new bookings during callout period
  var staffIdx = staffMembers.findIndex(s => s.name === staff.name)
  if (staffIdx !== -1) {
    staffMembers[staffIdx].blocked_until = endDate
    await supabase.from('businesses').update({ staff_members: staffMembers }).eq('id', business.id)
  }

  return `✅ ${staff.name} marked as out for ${dateLabel}.\n\n${(appts || []).length} appointments found:\n• ${reassigned} reassigned to other staff\n• ${notified} customers notified\n${otherStaff.length === 0 ? '\n⚠️ No other staff to reassign to — you may want to reschedule these manually.' : ''}`
}

async function handleRemoveStaff(business, input) {
  const { sendSMS } = require('../utils/sms')
  const staffMembers = business.staff_members || []
  const staffName = input.staff_name?.toLowerCase()
  const staffIdx = staffMembers.findIndex(s => s.name?.toLowerCase().includes(staffName))
  if (staffIdx === -1) return `Couldn't find a staff member matching "${input.staff_name}". Your staff: ${staffMembers.map(s => s.name).join(', ') || 'none configured'}`

  const removedName = staffMembers[staffIdx].name
  const today = new Date().toLocaleDateString('en-CA', { timeZone: business.timezone || 'America/New_York' })

  // Find all their future appointments
  const { data: appts } = await supabase.from('appointments')
    .select('*').eq('business_id', business.id)
    .eq('staff_name', removedName)
    .gte('appointment_date', today)
    .in('status', ['confirmed', 'pending'])

  var otherStaff = staffMembers.filter((s, i) => i !== staffIdx && s.name)
  var reassigned = 0

  for (var appt of (appts || [])) {
    var newStaff = otherStaff.length ? otherStaff[reassigned % otherStaff.length] : null
    if (newStaff) {
      await supabase.from('appointments').update({ staff_name: newStaff.name }).eq('id', appt.id)
      reassigned++
    } else {
      await supabase.from('appointments').update({ staff_name: null }).eq('id', appt.id)
    }
  }

  // Remove from staff list
  staffMembers.splice(staffIdx, 1)
  await supabase.from('businesses').update({ staff_members: staffMembers }).eq('id', business.id)

  return `✅ ${removedName} has been removed from your staff.\n\n• ${(appts || []).length} future appointments found\n• ${reassigned} reassigned to other staff\n${otherStaff.length === 0 ? '• Remaining appointments unassigned — reassign manually in dashboard' : ''}\n\nThe bot will no longer book appointments with ${removedName}.`
}

async function handleReassignAppointments(business, input) {
  const staffMembers = business.staff_members || []
  var fromName = input.from_staff?.toLowerCase()
  var toName = input.to_staff?.toLowerCase()

  var fromStaff = staffMembers.find(s => s.name?.toLowerCase().includes(fromName))
  var toStaff = staffMembers.find(s => s.name?.toLowerCase().includes(toName))

  if (!fromStaff) return `Couldn't find staff member "${input.from_staff}". Your staff: ${staffMembers.map(s => s.name).join(', ')}`
  if (!toStaff) return `Couldn't find staff member "${input.to_staff}". Your staff: ${staffMembers.map(s => s.name).join(', ')}`

  var today = new Date().toLocaleDateString('en-CA', { timeZone: business.timezone || 'America/New_York' })
  var dateFilter = today

  if (input.date === 'tomorrow') {
    var tm = new Date(new Date().getTime() + 86400000)
    dateFilter = tm.toLocaleDateString('en-CA', { timeZone: business.timezone || 'America/New_York' })
  } else if (input.date && input.date !== 'today' && input.date !== 'this week') {
    dateFilter = input.date
  }

  var query = supabase.from('appointments').select('*')
    .eq('business_id', business.id)
    .eq('staff_name', fromStaff.name)
    .in('status', ['confirmed', 'pending'])

  if (input.date === 'this week') {
    var weekEnd = new Date(new Date().getTime() + 7 * 86400000)
    query = query.gte('appointment_date', today).lte('appointment_date', weekEnd.toLocaleDateString('en-CA', { timeZone: business.timezone || 'America/New_York' }))
  } else if (input.date) {
    query = query.eq('appointment_date', dateFilter)
  } else {
    query = query.gte('appointment_date', today)
  }

  var { data: appts } = await query
  if (!(appts || []).length) return `No appointments found for ${fromStaff.name}${input.date ? ' on that date' : ''}.`

  for (var appt of appts) {
    await supabase.from('appointments').update({ staff_name: toStaff.name }).eq('id', appt.id)
  }

  return `✅ Moved ${appts.length} appointment${appts.length > 1 ? 's' : ''} from ${fromStaff.name} → ${toStaff.name}.`
}

// ── Owner conversation history (in-memory, per business) ────────────────────
const ownerSessions = new Map()

function getOwnerSession(businessId) {
  var session = ownerSessions.get(businessId)
  if (session) return session
  session = { messages: [] }
  ownerSessions.set(businessId, session)
  return session
}

// Trim history WITHOUT breaking tool_use/tool_result pairing. Naive slice(-10)
// can cut a tool_use away from its tool_result (or start the window on a
// tool_result), which the API rejects with a 400. This trims to ~10 messages but
// never leaves the first message as a tool_result, and drops a dangling final
// assistant turn whose tool_use has no following tool_result.
function trimSessionSafely(session, max = 10) {
  let msgs = session.messages
  if (msgs.length > max) msgs = msgs.slice(-max)
  // Don't let the window START on a tool_result (its tool_use was sliced off).
  const isToolResult = (m) => Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_result')
  while (msgs.length && isToolResult(msgs[0])) msgs = msgs.slice(1)
  // Don't let the window END on an assistant tool_use with no result after it.
  const hasToolUse = (m) => Array.isArray(m.content) && m.content.some(c => c && c.type === 'tool_use')
  while (msgs.length && msgs[msgs.length - 1].role === 'assistant' && hasToolUse(msgs[msgs.length - 1])) {
    msgs = msgs.slice(0, -1)
  }
  session.messages = msgs
}

// ── Main owner message handler ──────────────────────────────────────────────
async function handleOwnerMessage(business, incomingText) {
  console.log(`[Owner] Command from owner of ${business.business_name}: "${incomingText}"`)

  const tz = business.timezone || 'America/New_York'
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz })
  const todayFull = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz })

  const session = getOwnerSession(business.id)
  session.messages.push({ role: 'user', content: incomingText })

  // Trim old context safely (never split a tool_use/tool_result pair)
  trimSessionSafely(session)

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      tools: OWNER_TOOLS,
      system: `You are a business management assistant for ${business.business_name}. 
You are talking to the OWNER of this business via SMS. 
Today is ${todayFull} (${today}). The local time right now is ${new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} (${tz}).

You can help them:
- Check schedule — "What's on today?"
- Block dates/times — "Block next Friday"
- Running late — alert all customers
- Cancel appointments — "Cancel John's appointment"
- Reschedule appointments — "Reschedule Brandon's appointment" (cancels + texts customer to rebook)
- Staff callout — "Sarah is out today"
- Remove staff — "Remove John"
- Reassign clients — "Move Sarah's clients to Mike"
- Pause/resume the bot
- Mark no-shows
- Send group messages
- Approve/deny booking requests
- Send quotes
- Add services with duration and price — "Haircut 45 min $60, Color 2 hr $150"
- Set, list and cancel reminders — "Remind me tomorrow at 9 to call the supplier" (business timezone: ${tz})

RULES:
- Be concise — this is SMS.
- When the owner says "cancel" or mentions an appointment, ask: "Would you like to cancel only, or cancel and reschedule (I'll text the customer to pick a new time)?"
- When multiple appointments match, list them numbered and ask which one.
- Remember context from earlier messages in this conversation. If the owner said "check my schedule" and then says "cancel the 3pm", you know which appointment they mean.
- If the request is unclear, ask ONE clarifying question.
- Confirm all destructive actions before executing.
- NEVER agree to do something you have no tool for (emailing, calling, posting online, editing hours or prices, anything not listed). Say plainly that you can't do that yet by text and point them to the dashboard. Only say "I'll remind you" after the set_reminder tool has run.`,
      messages: session.messages
    })

    // Check if Claude wants to use tools. IMPORTANT: a single response can
    // contain MULTIPLE tool_use blocks — the API requires a matching tool_result
    // for EVERY one of them, in the very next user message. The old code handled
    // only the first (.find), orphaning the rest and 400-ing every future call.
    const toolUses = response.content.filter(c => c.type === 'tool_use')
    if (toolUses.length > 0) {
      // Execute each tool and build one tool_result per tool_use.
      const toolResults = []
      for (const tu of toolUses) {
        let result
        try {
          result = await executeOwnerTool(tu.name, tu.input, business)
        } catch (toolErr) {
          console.error('[Owner] Tool execution failed:', tu.name, toolErr.message)
          result = `Error running ${tu.name}: ${toolErr.message}`
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        })
      }

      // Push the assistant's tool_use turn, then ALL results in one user turn.
      session.messages.push({ role: 'assistant', content: response.content })
      session.messages.push({ role: 'user', content: toolResults })

      // A fallback reply from the first tool result, in case the follow-up fails.
      const firstResult = toolResults[0].content

      try {
        const followUp = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          tools: OWNER_TOOLS,
          system: `You are a business management assistant for ${business.business_name}. Be concise — this is SMS. Summarize the tool result naturally. Today is ${todayFull} (${today}). The local time right now is ${new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} (${tz}).`,
          messages: session.messages
        })
        const followText = followUp.content.find(c => c.type === 'text')
        const reply = followText?.text || firstResult
        session.messages.push({ role: 'assistant', content: reply })
        // Never let a tool_use block be the last saved turn without its result.
        trimSessionSafely(session)
        return reply
      } catch(followErr) {
        // Follow-up failed. Return the raw result BUT reset the session so the
        // broken tool-call turns don't poison every future message. (This is the
        // exact failure mode that caused the repeated 400s.)
        console.error('[Owner] Follow-up call failed:', followErr.message)
        session.messages = []
        return typeof firstResult === 'string' ? firstResult : JSON.stringify(firstResult)
      }
    }

    // Plain text response
    const text = response.content.find(c => c.type === 'text')
    const reply = text?.text || "Got it! Let me know if you need anything else."
    session.messages.push({ role: 'assistant', content: reply })
    trimSessionSafely(session)
    return reply

  } catch (err) {
    console.error('[Owner] Command error:', err.message)
    // If the session got into a bad state (e.g. orphaned tool_use blocks from a
    // prior partial failure), reset it so the owner isn't stuck failing forever.
    if (String(err.message).includes('tool_use') || String(err.message).includes('tool_result')) {
      session.messages = []
      console.log('[Owner] Reset poisoned session after tool_use/tool_result error')
    }
    return `Sorry, something went wrong. Try again or use your dashboard.`
  }
}

// ── Check if owner needs a welcome message ──────────────────────────────────
function getOwnerWelcome(business) {
  return `👋 Hi! This is your Wexly owner panel. I can help you:

• Check your schedule — "What's on today?"
• Block dates/times — "Block next Friday"
• Running late — "I'm running 15 min late"
• Reschedule all — "I'm sick tomorrow, cancel everything"
• Staff callout — "Sarah is out today" (auto-reassigns clients)
• Remove staff — "Remove John" (quit/fired)
• Reassign clients — "Move Sarah's clients to Mike"
• Text a group — "Text my VIP group: message"
• Cancel appointments — "Cancel John's appointment"
• Reschedule — "Reschedule Brandon's appointment" (cancels + texts them to rebook)
• Mark no-shows — "Mark John as no-show"
• Deposit alerts — "Confirm Sarah" or "Cancel Sarah"
• Approve/deny requests — "Approve John" or "Deny Lisa"
• Add services — "Haircut 45 min $60, Color 2 hr $150"
• Reminders — "Remind me tomorrow at 9 to order color"
• See the client experience — "DEMO"
• Pause/resume the bot

Just text me what you need!`
}

module.exports = { handleOwnerMessage, getOwnerWelcome }
