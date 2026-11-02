const twilio = require('twilio')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const WEBHOOK_URL = `${process.env.BOT_URL}/webhook/sms`
const STATUS_URL  = `${process.env.BOT_URL}/webhook/status`
const VOICE_URL   = `${process.env.BOT_URL}/webhook/voice`

// ── Buy and assign a local number to a business ───────────────────────────────
async function assignNumberToBusiness(businessId, areaCode = null) {
  try {
    console.log(`[Twilio] Buying number for business ${businessId}...`)

    // Search for available local numbers
    // Try their area code first, fall back to any US number
    const searchParams = {
      smsEnabled: true,
      limit: 5
    }
    if (areaCode && /^\d{3}$/.test(String(areaCode))) searchParams.areaCode = parseInt(areaCode)

    let available = await client.availablePhoneNumbers('US')
      .local.list(searchParams)

    // If no numbers with that area code, search without
    if (available.length === 0 && areaCode) {
      available = await client.availablePhoneNumbers('US')
        .local.list({ smsEnabled: true, limit: 5 })
    }

    if (available.length === 0) {
      throw new Error('No available phone numbers found')
    }

    // Buy the first available number
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: available[0].phoneNumber,
      smsUrl: WEBHOOK_URL,
      smsMethod: 'POST',
      voiceUrl: VOICE_URL,
      voiceMethod: 'POST',
      statusCallback: STATUS_URL,
      friendlyName: `Wexly — Business ${businessId}`
    })

    console.log(`[Twilio] Purchased ${purchased.phoneNumber} for business ${businessId}`)

    // Assign to 10DLC campaign messaging service if configured
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID
    if (messagingServiceSid) {
      try {
        await client.messaging.v1.services(messagingServiceSid)
          .phoneNumbers.create({ phoneNumberSid: purchased.sid })
        console.log(`[Twilio] Assigned ${purchased.phoneNumber} to messaging service ${messagingServiceSid}`)
      } catch (campaignErr) {
        console.error(`[Twilio] Warning: Could not assign to messaging service:`, campaignErr.message)
        // Don't throw — number still works, just not campaign-assigned yet
      }
    }

    // Save the number to Supabase
    const { error } = await supabase
      .from('businesses')
      .update({
        sms_number: purchased.phoneNumber,
        active: true
      })
      .eq('id', businessId)

    if (error) throw error

    console.log(`[Twilio] Number ${purchased.phoneNumber} assigned to business ${businessId}`)
    return purchased.phoneNumber

  } catch (err) {
    console.error(`[Twilio] Failed to assign number to business ${businessId}:`, err.message)
    throw err
  }
}

// ── Release a number when subscription is cancelled ───────────────────────────
async function releaseNumberFromBusiness(businessId) {
  try {
    // Get the business's number
    const { data: business } = await supabase
      .from('businesses')
      .select('sms_number')
      .eq('id', businessId)
      .maybeSingle()

    if (!business?.sms_number) return

    // Find the Twilio SID for this number
    const numbers = await client.incomingPhoneNumbers.list({
      phoneNumber: business.sms_number,
      limit: 1
    })

    if (numbers.length > 0) {
      await client.incomingPhoneNumbers(numbers[0].sid).remove()
      console.log(`[Twilio] Released ${business.sms_number} from business ${businessId}`)
    }

    // Clear from Supabase
    await supabase
      .from('businesses')
      .update({ sms_number: null })
      .eq('id', businessId)

  } catch (err) {
    console.error(`[Twilio] Failed to release number for business ${businessId}:`, err.message)
  }
}

// ── Update webhook URLs for all numbers (useful after redeployment) ───────────
async function syncAllWebhooks() {
  try {
    const numbers = await client.incomingPhoneNumbers.list({ limit: 100 })
    for (const num of numbers) {
      if (num.friendlyName?.startsWith('Wexly')) {
        await client.incomingPhoneNumbers(num.sid).update({
          smsUrl: WEBHOOK_URL,
          smsMethod: 'POST',
          voiceUrl: VOICE_URL,
          voiceMethod: 'POST'
        })
        console.log(`[Twilio] Synced SMS + Voice webhook for ${num.phoneNumber}`)
      }
    }
    console.log(`[Twilio] Synced ${numbers.length} numbers`)
  } catch (err) {
    console.error('[Twilio] Sync failed:', err.message)
  }
}

module.exports = { assignNumberToBusiness, releaseNumberFromBusiness, syncAllWebhooks }
