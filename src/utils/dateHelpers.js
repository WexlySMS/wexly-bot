// ── Staff-aware slot calculator ────────────────────────────────────────────────
// Each staff member has their own hours and service assignments
// Slots are available when at least one qualified staff member is free

function getAvailableSlots(business, date, existingAppts, serviceDuration = 60, blockedDates = [], serviceCapacity = 1, serviceName = null) {
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const dayOfWeek = dayNames[new Date(date + 'T12:00:00').getDay()]
  const dayShort = dayOfWeek.slice(0, 3) // Mon, Tue etc

  const buffer = business.buffer_mins || 10
  const staffMembers = (business.staff_members || []).filter(s => s.name)

  // ── Past-time filtering ────────────────────────────────────────────────────
  // Compute the earliest slot start (in minutes-since-midnight) that's still
  // valid for THIS date. If the date is in the past entirely → no slots. If
  // it's today → only future slots that respect min_notice_mins. If it's a
  // future date → no past-time filter (all open slots OK).
  const tz = business.timezone || 'America/New_York'
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz })
  const minNotice = business.min_notice_mins || 0
  let minStartMins = 0
  if (date < todayStr) {
    // Date is fully in the past — no bookable slots at all.
    return []
  } else if (date === todayStr) {
    // Today — figure out current local time and add min_notice
    const nowParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date())
    const nowHour = parseInt(nowParts.find(p => p.type === 'hour').value, 10)
    const nowMin = parseInt(nowParts.find(p => p.type === 'minute').value, 10)
    const nowMinutes = nowHour * 60 + nowMin
    // Round up to the next 30-min increment so we don't show partial slots
    const earliest = nowMinutes + minNotice
    minStartMins = Math.ceil(earliest / 30) * 30
  }

  // Check partial blocked times
  const partialBlocks = (blockedDates || []).filter(b =>
    b.blocked_date === date && b.start_time && b.end_time
  ).map(b => {
    const [sh, sm] = b.start_time.split(':').map(Number)
    const [eh, em] = b.end_time.split(':').map(Number)
    return { start: sh * 60 + sm, end: eh * 60 + em }
  })

  // If no staff configured, fall back to business hours + capacity model
  if (!staffMembers.length) {
    return getSlotsByBusinessHours(business, date, existingAppts, serviceDuration, partialBlocks, buffer, serviceCapacity, minStartMins)
  }

  // Filter to staff who can perform this service
  const qualifiedStaff = serviceName
    ? staffMembers.filter(s => !s.services?.length || s.services.includes(serviceName))
    : staffMembers

  if (!qualifiedStaff.length) {
    return getSlotsByBusinessHours(business, date, existingAppts, serviceDuration, partialBlocks, buffer, serviceCapacity, minStartMins)
  }

  // For each staff member, get their available slots
  const allSlots = new Set()

  for (const staff of qualifiedStaff) {
    const staffHours = staff.hours || {}
    
    // Check if staff works this day
    if (staffHours[dayShort] === false) continue

    // Check if staff is temporarily blocked (callout/sick)
    if (staff.blocked_until && date <= staff.blocked_until) continue

    // Get staff hours (fall back to business hours)
    const staffFrom = staffHours.from || null
    const staffTo = staffHours.to || null

    let openMins, closeMins
    if (staffFrom && staffTo) {
      const [fh, fm] = staffFrom.split(':').map(Number)
      const [th, tm] = staffTo.split(':').map(Number)
      openMins = fh * 60 + fm
      closeMins = th * 60 + tm
    } else {
      // Fall back to business hours
      const hours = Array.isArray(business.hours) ? business.hours : []
      let dayHours
      if (hours.length > 0 && !hours[0]?.day) {
        // Indexed format: [Sunday, Monday, ...Tuesday...]
        const dayIdx = new Date(date + 'T12:00:00').getDay()
        dayHours = hours[dayIdx]
        if (!dayHours || !dayHours.open) continue
      } else {
        dayHours = hours.find(h => h.day === dayOfWeek)
        if (!dayHours || !dayHours.open) continue
      }
      const [oh, om] = (dayHours.from || '09:00').split(':').map(Number)
      const [ch, cm] = (dayHours.to || '17:00').split(':').map(Number)
      openMins = oh * 60 + om
      closeMins = ch * 60 + cm
    }

    // Get this staff member's existing appointments for the day
    const staffAppts = existingAppts.filter(a =>
      a.staff_name === staff.name || a.staff_id === staff.name
    ).map(a => {
      const [h, m] = a.appointment_time.split(':').map(Number)
      const start = h * 60 + m
      return { start, end: start + (a.duration_mins || 60) + buffer }
    })

    // Generate slots for this staff member
    for (let t = openMins; t + serviceDuration <= closeMins; t += 30) {
      // Skip past-time slots (and slots inside the min-notice window)
      if (t < minStartMins) continue

      const slotEnd = t + serviceDuration + buffer

      // Check hard blocks
      const hardBlocked = partialBlocks.some(b => !(slotEnd <= b.start || t >= b.end))
      if (hardBlocked) continue

      // Check if this staff member is free during this slot
      const staffBusy = staffAppts.some(a => !(slotEnd <= a.start || t >= a.end))
      if (!staffBusy) {
        const h = Math.floor(t / 60)
        const m = t % 60
        allSlots.add(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
      }
    }
  }

  return Array.from(allSlots).sort()
}

// Find which staff member is available for a specific slot
function findAvailableStaff(business, date, time, serviceDuration, existingAppts, serviceName = null) {
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const dayOfWeek = dayNames[new Date(date + 'T12:00:00').getDay()]
  const dayShort = dayOfWeek.slice(0, 3)
  const buffer = business.buffer_mins || 10
  const staffMembers = (business.staff_members || []).filter(s => s.name)

  if (!staffMembers.length) return null

  const qualifiedStaff = serviceName
    ? staffMembers.filter(s => !s.services?.length || s.services.includes(serviceName))
    : staffMembers

  const [h, m] = time.split(':').map(Number)
  const slotStart = h * 60 + m
  const slotEnd = slotStart + serviceDuration + buffer

  for (const staff of qualifiedStaff) {
    const staffHours = staff.hours || {}
    if (staffHours[dayShort] === false) continue

    const staffAppts = existingAppts.filter(a =>
      a.staff_name === staff.name || a.staff_id === staff.name
    ).map(a => {
      const [ah, am] = a.appointment_time.split(':').map(Number)
      const start = ah * 60 + am
      return { start, end: start + (a.duration_mins || 60) + buffer }
    })

    const busy = staffAppts.some(a => !(slotEnd <= a.start || slotStart >= a.end))
    if (!busy) return staff
  }
  return null
}

// Fallback — no staff configured
function getSlotsByBusinessHours(business, date, existingAppts, serviceDuration, partialBlocks, buffer, serviceCapacity, minStartMins = 0) {
  const dateObj = new Date(date + 'T12:00:00')
  const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' })
  const dayIndex = dateObj.getDay() // 0=Sunday, 1=Monday...
  const dayShort = dayOfWeek.slice(0, 3) // Mon, Tue...
  const hours = Array.isArray(business.hours) ? business.hours : []

  let dayHours = null

  if (hours.length > 0 && hours[0] && !hours[0].day) {
    // Format 1: indexed array [{open,from,to}, ...]
    dayHours = hours[dayIndex]
    if (!dayHours || !dayHours.open) return []
    var openTime = dayHours.from || '09:00'
    var closeTime = dayHours.to || '17:00'
  } else {
    // Format 2: named days [{day:'Mon', open:'09:00', close:'17:00'}, ...]
    dayHours = hours.find(h => h.day === dayOfWeek || h.day === dayShort)
    if (!dayHours || (!dayHours.open && dayHours.open !== undefined) || dayHours.closed) return []
    var openTime = dayHours.open || dayHours.from || '09:00'
    var closeTime = dayHours.close || dayHours.to || '17:00'
  }


  const [openH, openM] = openTime.split(':').map(Number)
  const [closeH, closeM] = closeTime.split(':').map(Number)
  const openMins = openH * 60 + openM
  const closeMins = closeH * 60 + closeM

  const occupied = existingAppts.map(a => {
    const [h, m] = a.appointment_time.split(':').map(Number)
    const start = h * 60 + m
    return { start, end: start + (a.duration_mins || 60) + buffer }
  })

  const slots = []
  for (let t = openMins; t + serviceDuration <= closeMins; t += 30) {
    // Skip past-time slots (and slots inside the min-notice window)
    if (t < minStartMins) continue
    const slotEnd = t + serviceDuration + buffer
    const hardBlocked = partialBlocks.some(b => !(slotEnd <= b.start || t >= b.end))
    if (hardBlocked) continue
    const concurrent = occupied.filter(o => !(slotEnd <= o.start || t >= o.end)).length
    if (concurrent < serviceCapacity) {
      const h = Math.floor(t / 60)
      const mv = t % 60
      slots.push(`${String(h).padStart(2,'0')}:${String(mv).padStart(2,'0')}`)
    }
  }
  return slots
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function formatTime(timeStr) {
  if (!timeStr) return ''
  const [h, m] = timeStr.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${String(m).padStart(2,'0')} ${period}`
}

module.exports = { getAvailableSlots, findAvailableStaff, formatDate, formatTime }
