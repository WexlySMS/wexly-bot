const express = require('express')
const router = express.Router()
const Stripe = require('stripe')
const { createClient } = require('@supabase/supabase-js')
const { assignNumberToBusiness, releaseNumberFromBusiness } = require('../utils/twilioManager')
const { sendWelcomeEmail, sendTrialConfirmationEmail, sendTrialEndingEmail, sendOwnerNewSignupNotification, sendEmail } = require('../utils/emailService')
const { startSetupInterview } = require('../bot/setupInterview')
const { sendSMS } = require('../utils/sms')
require('dotenv').config()

const stripe = Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ── Create checkout session ───────────────────────────────────────────────────
router.post('/create-checkout', async (req, res) => {
  try {
    const {
      userId, email, businessName, agreedToTerms, plan = 'standard',
      isResubscribe,
      // Attribution & referral fields (optional — all default to null/undefined)
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      referred_by_code
    } = req.body

    if (!agreedToTerms) {
      return res.status(400).json({ error: 'You must agree to the Terms of Service to continue.' })
    }

    if (!userId || !email) {
      return res.status(400).json({ error: 'Missing user information.' })
    }

    // Determine price ID and amount based on plan
    const isPro = plan === 'pro'
    const isSolo = plan === 'solo'
    console.log(`[Checkout] Plan received: "${plan}" | Solo: ${isSolo} | Pro: ${isPro}`)
    console.log(`[Checkout] SOLO price ID: ${process.env.STRIPE_SOLO_PRICE_ID ? 'SET' : 'MISSING'}`)
    const priceId = plan === 'pro' ? process.env.STRIPE_PRO_PRICE_ID
      : plan === 'solo' ? process.env.STRIPE_SOLO_PRICE_ID
      : process.env.STRIPE_PRICE_ID
    const planAmount = isPro ? '$199/mo' : isSolo ? '$79/mo' : '$149/mo'
    const planName = isPro ? 'Wexly Pro' : isSolo ? 'Wexly Solo' : 'Wexly Standard'

    if (!priceId) {
      return res.status(500).json({ error: `Price ID not configured for ${plan} plan` })
    }

    // ── Attribution: figure out which partner (if any) earns commission ──
    // For now, only 'meta' source pays Max 10%. Generic enough to add more.
    const ATTRIBUTION_RULES = {
      meta: 'max',
      facebook: 'max',
      instagram: 'max'
    }
    const normalizedSource = (utm_source || '').toLowerCase().trim()
    const attributionPartner = ATTRIBUTION_RULES[normalizedSource] || null

    // ── Referral: validate the code if provided ──────────────────────────
    let validReferralCode = null
    if (referred_by_code) {
      const code = String(referred_by_code).trim().toUpperCase()
      const { data: referrer } = await supabase.from('businesses')
        .select('id, business_name, status').eq('referral_code', code).maybeSingle()
      if (referrer && referrer.status !== 'cancelled') {
        validReferralCode = code
        console.log(`[Checkout] Referral code valid: ${code} (referred by ${referrer.business_name})`)
      } else {
        console.log(`[Checkout] Referral code invalid or referrer cancelled: ${code}`)
      }
    }

    // ── Generate this business's own referral_code (so they can refer others) ──
    // Format: BUSINESSNAME-XXXX (6 chars business prefix + 4 random).
    function generateReferralCode(name) {
      const prefix = (name || 'WEXLY')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 6)
        .toUpperCase() || 'WEXLY'
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // No 0/O/1/I confusion
      let suffix = ''
      for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
      return `${prefix}-${suffix}`
    }

    // Create or retrieve Stripe customer
    let customerId
    const { data: business } = await supabase
      .from('businesses')
      .select('stripe_customer_id, referral_code, status, trial_ends_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (business?.stripe_customer_id) {
      customerId = business.stripe_customer_id
    } else {
      const customer = await stripe.customers.create({
        email,
        name: businessName,
        metadata: { user_id: userId }
      })
      customerId = customer.id
      await supabase.from('businesses').update({ stripe_customer_id: customerId }).eq('user_id', userId)
    }

    // Generate a unique referral code (retry on the rare chance of collision)
    let ownReferralCode = business?.referral_code
    if (!ownReferralCode) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateReferralCode(businessName)
        const { data: clash } = await supabase.from('businesses')
          .select('id').eq('referral_code', candidate).maybeSingle()
        if (!clash) {
          ownReferralCode = candidate
          break
        }
      }
    }

    // Mark as pending so dashboard blocks access until Stripe confirms.
    // Save attribution + referral data — but ONLY overwrite fields that were
    // actually provided. The dashboard add-card banner and resubscribe flow call
    // this endpoint WITHOUT attribution; without this guard they'd null out the
    // attribution we saved at signup (create-business). Non-destructive by design.
    const checkoutUpdate = { plan }
    // Resubscribers keep their current status flow (webhook handles it); only a
    // brand-new pre-card signup should be (re)marked pending_checkout here.
    // 🔒 v190: an instant-trial account (status trial / trial_expired) already
    // has a live number; marking it pending_checkout here would switch the bot
    // off mid-trial. Only truly parked rows get (re)marked.
    const parked = !business?.status || ['pending_checkout', 'incomplete'].includes(business.status)
    if (!isResubscribe && parked) checkoutUpdate.status = 'pending_checkout'
    if (utm_source)   checkoutUpdate.signup_source = utm_source
    if (utm_medium)   checkoutUpdate.signup_medium = utm_medium
    if (utm_campaign) checkoutUpdate.signup_campaign = utm_campaign
    if (utm_term)     checkoutUpdate.signup_term = utm_term
    if (utm_content)  checkoutUpdate.signup_content = utm_content
    if (attributionPartner) checkoutUpdate.attribution_partner = attributionPartner
    if (validReferralCode)  checkoutUpdate.referred_by_code = validReferralCode
    if (ownReferralCode)    checkoutUpdate.referral_code = ownReferralCode
    await supabase.from('businesses')
      .update(checkoutUpdate)
      .eq('user_id', userId)

    // 🔒 v190: three billing shapes.
    //  - Live instant trial: Stripe's trial ends exactly when ours does (clock
    //    started at signup). Checkout requires trial_end >= 48h out, so a card
    //    added in the last two days pushes the first charge to ~49h from now.
    //  - Expired instant trial, or a resubscriber: pay today.
    //  - Legacy parked signup (no trial yet): 14 days from now, as before.
    const nowMs = Date.now()
    const ourEndMs = business?.trial_ends_at ? new Date(business.trial_ends_at).getTime() : null
    const liveTrial = business?.status === 'trial' && ourEndMs && ourEndMs > nowMs
    const paysToday = isResubscribe || business?.status === 'trial_expired'
    let trialConfig, firstChargeLabel
    if (paysToday) {
      trialConfig = {}
      firstChargeLabel = 'today'
    } else if (liveTrial) {
      const endMs = Math.max(ourEndMs, nowMs + 49 * 60 * 60 * 1000)
      trialConfig = { trial_end: Math.floor(endMs / 1000) }
      firstChargeLabel = new Date(endMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    } else {
      trialConfig = { trial_period_days: 14 }
      firstChargeLabel = 'after your 14-day free trial'
    }
    const chargeSentence = firstChargeLabel === 'today' ? `${planAmount}, billed today.`
      : firstChargeLabel.startsWith('after') ? `$0 due today — your card won't be charged for 14 days. Then ${planAmount}.`
      : `$0 due today — first charge ${firstChargeLabel}, then ${planAmount}.`

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_collection: 'always',
      // Show Stripe's "Add promotion code" field on the add-card page. Any coupon
      // created in Stripe → Coupons with a promotion code attached works here
      // with no code change. (Referral credits are applied to the subscription
      // AFTER checkout by the webhook, so the two never collide.)
      allow_promotion_codes: true,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        // Resubscribers already used their free trial — they pay right away.
        // New signups get the 14-day trial.
        ...trialConfig,
        metadata: { user_id: userId, plan, is_resubscribe: isResubscribe ? 'true' : 'false' }
      },
      custom_text: {
        submit: { message: isResubscribe
          ? `Reactivate ${planName} — ${planAmount}, billed today. Cancel anytime.`
          : `✅ ${chargeSentence} Cancel anytime.` },
        terms_of_service_acceptance: {
          message: paysToday
            ? `I agree to the Wexly [Terms of Service](https://getwexly.com/terms) and [Privacy Policy](https://getwexly.com/privacy). I understand my card will be charged ${planAmount}.`
            : `I agree to the Wexly [Terms of Service](https://getwexly.com/terms) and [Privacy Policy](https://getwexly.com/privacy). I understand my card will be charged ${planAmount} ${firstChargeLabel.startsWith('after') ? firstChargeLabel : 'on ' + firstChargeLabel}.`
        }
      },
      consent_collection: { terms_of_service: 'required' },
      success_url: `${process.env.SITE_URL}/dashboard.html?setup=complete&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/signup.html?cancelled=true`,
      metadata: { user_id: userId, business_name: businessName, plan, is_resubscribe: isResubscribe ? 'true' : 'false' }
    })

    res.json({ url: session.url })

  } catch (err) {
    console.error('[Stripe] Checkout error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Stripe webhook handler ────────────────────────────────────────────────────
// Stripe calls this URL when subscription events happen
// Set this URL in Stripe Dashboard → Webhooks: https://wexly-bot.onrender.com/stripe/webhook
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('[Stripe Webhook] Invalid signature:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  console.log(`[Stripe Webhook] ${event.type}`)

  try {
    switch (event.type) {

      // ── Trial started / subscription created ──────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object
        const userId = session.metadata?.user_id
        if (!userId) break

        const subscriptionId = session.subscription

        // Activate the business account. Resubscribers skip the trial (pay now),
        // new signups get the 14-day trial.
        const plan = session.metadata?.plan || 'standard'
        const isResub = session.metadata?.is_resubscribe === 'true'

        // 🔒 v190: read the row BEFORE updating so an instant trial keeps the
        // clock it started at signup, and an expired instant trial (paying
        // today) goes straight to active instead of getting 14 more free days.
        const { data: before } = await supabase
          .from('businesses')
          .select('status, trial_ends_at, onboarding, interview_state, owner_phone_verified_at')
          .eq('user_id', userId)
          .maybeSingle()
        const instantFlow = !!before?.owner_phone_verified_at
        const liveTrial = before?.status === 'trial' && before?.trial_ends_at && new Date(before.trial_ends_at) > new Date()
        const wasExpired = before?.status === 'trial_expired'
        const paysToday = isResub || wasExpired
        const trialEndsAt = paysToday ? null
          : liveTrial ? before.trial_ends_at
          : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

        await supabase
          .from('businesses')
          .update({
            status: paysToday ? 'active' : 'trial',
            active: true,
            plan,
            stripe_subscription_id: subscriptionId,
            trial_ends_at: trialEndsAt,
            ...(instantFlow ? { onboarding: { ...(before.onboarding || {}), card_added_at: new Date().toISOString() } } : {})
          })
          .eq('user_id', userId)

        // Get the business details — select all needed fields
        const { data: business } = await supabase
          .from('businesses')
          .select('id, address, sms_number, owner_name, owner_phone, business_name, business_type, email, timezone')
          .eq('user_id', userId)
          .maybeSingle()

        if (business) {
          console.log(`[Stripe] Card added for ${business.business_name} (instant=${instantFlow}, paysToday=${paysToday})`)

          if (instantFlow) {
            // The owner already met the bot at signup. Confirm from the business
            // number, in the thread they already have open.
            const tz = business.timezone || 'America/Los_Angeles'
            const line = paysToday
              ? `Card added. You're active and I'm answering clients again. Thanks for sticking with me.`
              : `Card added. Nothing changes today; your first charge is ${new Date(trialEndsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz })}. Thanks for trusting me with the front desk.`
            if (business.owner_phone && business.sms_number) {
              sendSMS(business.sms_number, business.owner_phone, line).catch(() => {})
            }
          } else {
            // Legacy card-first flow: welcome + trial receipt at card time.
            sendWelcomeEmail({
              email: business.email,
              firstName: business.owner_name?.split(' ')[0] || 'there',
              businessName: business.business_name,
              smsNumber: business.sms_number || 'Being assigned shortly...'
            }).then(() => console.log(`[Email] Welcome sent to ${business.email}`))
              .catch(err => console.error('[Email] Welcome email failed:', err.message))

            if (!paysToday) {
              sendTrialConfirmationEmail({
                email: business.email,
                firstName: business.owner_name?.split(' ')[0] || 'there',
                businessName: business.business_name,
                trialEndsAt,
                plan
              }).then(() => console.log(`[Email] Trial confirmation sent to ${business.email}`))
                .catch(err => console.error('[Email] Trial confirmation failed:', err.message))
            }

            // Notify Wexly owner (you) of new signup (instant-flow accounts
            // already notified at signup)
            notifyOwnerNewSignup(business).catch(err => console.error('[Notify] Owner notification failed:', err.message))
          }

          // Auto-assign Twilio number in background
          if (!business.sms_number) {
            const areaCode = extractAreaCode(business.address)
            assignNumberToBusiness(business.id, areaCode)
              .then(num => console.log(`[Stripe] Auto-assigned ${num} to ${business.business_name}`))
              .catch(err => console.error(`[Stripe] Auto-assign failed (non-blocking):`, err.message))
              .then(async (num) => {
                console.log(`[Stripe] Auto-assigned ${num} to user ${userId}`)
                // Reload business with new number and start interview
                const { data: updatedBiz } = await supabase
                  .from('businesses')
                  .select('*')
                  .eq('id', business.id)
                  .maybeSingle()
                if (updatedBiz?.owner_phone) {
                  setTimeout(() => startSetupInterview(updatedBiz), 10000) // 10 sec after welcome email
                }
              })
              .catch(err => console.error(`[Stripe] Number assignment failed:`, err.message))
          } else if (business.owner_phone && !before?.interview_state) {
            // Only if the interview was never offered (instant-flow accounts
            // get it from the drip 30 min after signup).
            setTimeout(() => startSetupInterview(business), 10000)
          }
        }

        console.log(`[Stripe] Account activated for user ${userId}`)
        break
      }

      // ── Trial ending soon — send reminder email ───────────────────────────
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object
        const userId = sub.metadata?.user_id
        if (!userId) break
        const { data: biz } = await supabase.from('businesses').select('owner_name,business_name,email,trial_ends_at,plan').eq('user_id', userId).maybeSingle()
        if (biz) {
          sendTrialEndingEmail({
            email: biz.email,
            firstName: biz.owner_name?.split(' ')[0] || 'there',
            businessName: biz.business_name,
            trialEndsAt: biz.trial_ends_at,
            plan: biz.plan || 'standard'
          }).catch(console.error)
        }
        break
      }

      // ── Payment succeeded — subscription active ───────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object
        if (invoice.billing_reason === 'subscription_create') break

        const sub = await stripe.subscriptions.retrieve(invoice.subscription)
        const userId = sub.metadata?.user_id
        if (!userId) break

        await supabase.from('businesses').update({ status: 'active' }).eq('user_id', userId)

        // Get business + attribution data — needed for payout/credit logic
        const { data: biz } = await supabase.from('businesses')
          .select('id, owner_name, business_name, email, attribution_partner, first_paid_at, referred_by_code, plan')
          .eq('user_id', userId).maybeSingle()

        if (biz) {
          const amount = `$${(invoice.amount_paid / 100).toFixed(2)}`
          await sendEmail({
            from: { email: 'noreply@mail.getwexly.com', name: 'Wexly Billing' },
            replyTo: 'billing@getwexly.com',
            to: biz.email,
            subject: `Payment confirmed — ${amount}`,
            html: `<p>Hi ${biz.owner_name?.split(' ')[0] || 'there'}, your payment of ${amount} for ${biz.business_name} has been confirmed. Thank you!</p><p><a href="https://getwexly.com/dashboard.html">Go to dashboard →</a></p>`
          }).catch(err => console.error('[Stripe] Payment-confirmed email error:', err.response?.body?.errors || err.message))

          // ── First-paid-at: stamp once, when this business has their first
          // real cleared charge. Defines the 12-month attribution window start
          // for Max and the trigger point for referral-credit creation.
          const isFirstPaid = !biz.first_paid_at
          if (isFirstPaid) {
            await supabase.from('businesses')
              .update({ first_paid_at: new Date().toISOString() })
              .eq('id', biz.id)
          }

          // ── ATTRIBUTION PAYOUT (e.g., Max gets 10% of Meta signups) ─────
          // Pay out the partner if:
          //   1. Business has an attribution_partner
          //   2. We're within 12 months of first_paid_at (or this IS the first)
          //   3. We haven't already created a payout for this invoice
          if (biz.attribution_partner && invoice.amount_paid > 0) {
            try {
              const firstPaidAt = biz.first_paid_at ? new Date(biz.first_paid_at) : new Date()
              const monthsSinceFirstPaid = (Date.now() - firstPaidAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
              const withinWindow = isFirstPaid || monthsSinceFirstPaid <= 12

              if (withinWindow) {
                const payoutPercent = 10
                const payoutCents = Math.round(invoice.amount_paid * payoutPercent / 100)
                const { error: payoutErr } = await supabase.from('referral_payouts').insert({
                  business_id: biz.id,
                  partner: biz.attribution_partner,
                  stripe_invoice_id: invoice.id,
                  stripe_charge_id: invoice.charge || null,
                  invoice_period_start: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
                  invoice_period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
                  gross_revenue_cents: invoice.amount_paid,
                  payout_percent: payoutPercent,
                  payout_amount_cents: payoutCents,
                  status: 'pending'
                })
                // Unique-violation = invoice already processed (Stripe retries
                // webhooks). Not an error — just skip silently.
                if (payoutErr && payoutErr.code !== '23505') {
                  console.error(`[Attribution] Payout insert failed:`, payoutErr.message)
                } else if (!payoutErr) {
                  console.log(`[Attribution] Created $${(payoutCents/100).toFixed(2)} payout for ${biz.attribution_partner} on ${biz.business_name}`)
                }
              } else {
                console.log(`[Attribution] ${biz.business_name} is past 12-month window — no payout`)
              }
            } catch (err) {
              console.error('[Attribution] Payout error:', err.message)
            }
          }

          // ── REFERRAL CREDITS ───────────────────────────────────────────
          // On FIRST paid invoice of a referred business, create 50%-off
          // credits for BOTH the referrer AND this new business. Stacking is
          // automatic (each new credit is a new row).
          if (isFirstPaid && biz.referred_by_code) {
            try {
              const { data: referrer } = await supabase.from('businesses')
                .select('id, business_name, status')
                .eq('referral_code', biz.referred_by_code)
                .maybeSingle()
              if (referrer && referrer.status !== 'cancelled') {
                // Credit for the referrer
                await supabase.from('referral_credits').insert({
                  business_id: referrer.id,
                  source_business_id: biz.id,
                  discount_percent: 50,
                  status: 'available'
                })
                // Credit for the new business (welcome discount)
                await supabase.from('referral_credits').insert({
                  business_id: biz.id,
                  source_business_id: referrer.id,
                  discount_percent: 50,
                  status: 'available'
                })
                console.log(`[Referral] Created credits for ${referrer.business_name} (referrer) and ${biz.business_name} (referred)`)
              }
            } catch (err) {
              console.error('[Referral] Credit creation error:', err.message)
            }
          }

          // ── AUTO-APPLY AVAILABLE CREDITS to next invoice ──────────────
          // Look for any available credit on this business. If one exists,
          // apply a one-time 50% discount to the next billing cycle via a
          // Stripe coupon, then mark the credit redeemed.
          try {
            const { data: nextCredit } = await supabase.from('referral_credits')
              .select('id, discount_percent')
              .eq('business_id', biz.id)
              .eq('status', 'available')
              .order('created_at', { ascending: true })
              .limit(1)
              .maybeSingle()

            if (nextCredit) {
              // Create a one-time coupon for this exact discount
              const coupon = await stripe.coupons.create({
                percent_off: nextCredit.discount_percent,
                duration: 'once',
                name: `Wexly Referral - ${nextCredit.discount_percent}% Off`,
                max_redemptions: 1
              })
              // Apply the coupon to the subscription — it'll discount the NEXT invoice
              await stripe.subscriptions.update(invoice.subscription, {
                coupon: coupon.id
              })
              // Mark the credit as redeemed (so we don't apply it twice)
              await supabase.from('referral_credits')
                .update({
                  status: 'redeemed',
                  redeemed_at: new Date().toISOString(),
                  redeemed_invoice_id: invoice.id
                })
                .eq('id', nextCredit.id)
              console.log(`[Referral] Applied ${nextCredit.discount_percent}% credit to ${biz.business_name} for next invoice`)
            }
          } catch (err) {
            console.error('[Referral] Credit application error:', err.message)
          }
        }

        console.log(`[Stripe] Payment succeeded — user ${userId} now active`)
        break
      }

      // ── Charge refunded — claw back any attribution payout ────────────────
      case 'charge.refunded': {
        const charge = event.data.object
        // Find the payout for this charge and mark it clawed_back
        const { data: payout } = await supabase.from('referral_payouts')
          .select('id, business_id, partner, payout_amount_cents, status')
          .eq('stripe_charge_id', charge.id)
          .maybeSingle()
        if (payout && payout.status === 'pending') {
          await supabase.from('referral_payouts')
            .update({
              status: 'clawed_back',
              clawed_back_at: new Date().toISOString(),
              clawback_reason: `Stripe charge ${charge.id} refunded`
            })
            .eq('id', payout.id)
          console.log(`[Attribution] Clawed back $${(payout.payout_amount_cents/100).toFixed(2)} payout for ${payout.partner} (charge ${charge.id} refunded)`)
        } else if (payout && payout.status === 'paid') {
          // Already paid out — flag it but don't change. You'll need to handle manually.
          console.warn(`[Attribution] Charge ${charge.id} refunded but payout was already PAID. Manual reconciliation needed for partner ${payout.partner}.`)
        }
        break
      }

      // ── Payment failed ────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const sub = await stripe.subscriptions.retrieve(invoice.subscription)
        const userId = sub.metadata?.user_id
        if (!userId) break

        await supabase.from('businesses').update({ status: 'past_due' }).eq('user_id', userId)

        // Send payment failed email — via the proven sendEmail path using the
        // AUTHENTICATED noreply@mail.getwexly.com sender. The previous raw
        // sgMail.send from billing@getwexly.com likely failed silently if that
        // sender isn't verified in SendGrid. sendEmail logs the real error.
        const { data: biz } = await supabase.from('businesses').select('owner_name,business_name,email,owner_phone,sms_number').eq('user_id', userId).maybeSingle()
        if (biz) {
          const FROM_NOREPLY = { email: 'noreply@mail.getwexly.com', name: 'Wexly Billing' }
          await sendEmail({
            from: FROM_NOREPLY,
            replyTo: 'billing@getwexly.com',
            to: biz.email,
            subject: `Payment failed — action required`,
            html: `<p>Hi ${biz.owner_name?.split(' ')[0] || 'there'}, we couldn't process your payment for ${biz.business_name}. Please update your payment method to keep your bot running.</p><p><a href="https://getwexly.com/dashboard.html">Update payment method →</a></p>`
          }).catch(err => console.error('[Stripe] Payment-failed business email error:', err.response?.body?.errors || err.message))

          // Text the business OWNER from their OWN bot number (they recognize it).
          // Most reliable channel — email has proven flaky. Best-effort.
          if (biz.sms_number && biz.owner_phone) {
            const { sendSMS } = require('../utils/sms')
            sendSMS(biz.sms_number, biz.owner_phone,
              `Hi ${biz.owner_name?.split(' ')[0] || 'there'} — your Wexly payment for ${biz.business_name} didn't go through, so your bot is paused. Update your card to switch it back on: https://getwexly.com/dashboard.html`
            ).catch(err => console.error('[Stripe] Payment-failed owner SMS failed:', err.message))
          }

          // ALSO alert the platform owner (Brandon) so failed payments aren't silent.
          const OWNER_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
          const OWNER_PHONE = process.env.OWNER_NOTIFICATION_PHONE
          await sendEmail({
            from: FROM_NOREPLY,
            to: OWNER_EMAIL,
            subject: `⚠️ Payment FAILED — ${biz.business_name}`,
            html: `<p>Payment failed for <strong>${biz.business_name}</strong> (${biz.owner_name} · ${biz.email}). They've been marked past_due and their dashboard is locked until they update their card.</p>`
          }).catch(err => console.error('[Stripe] Payment-failed owner email error:', err.response?.body?.errors || err.message))
          if (OWNER_PHONE && process.env.TWILIO_PHONE_NUMBER) {
            const { sendSMS } = require('../utils/sms')
            sendSMS(process.env.TWILIO_PHONE_NUMBER, OWNER_PHONE,
              `⚠️ Wexly payment FAILED\n${biz.business_name}\n${biz.owner_name} · ${biz.email}\nMarked past_due, dashboard locked.`
            ).catch(err => console.error('[Notify] Past-due owner SMS failed:', err.message))
          }
        }

        console.log(`[Stripe] Payment failed — user ${userId} marked past_due`)
        break
      }

      // ── Subscription cancelled ────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const userId = sub.metadata?.user_id
        if (!userId) break

        // Deactivate account — but DO NOT auto-release the Twilio number.
        // Numbers are reviewed/released manually via /admin/number-audit so a
        // resubscribing business keeps its original number (and its customers'
        // saved contact). The bot already goes silent for cancelled businesses.
        await supabase
          .from('businesses')
          .update({ status: 'cancelled', active: false })
          .eq('user_id', userId)

        console.log(`[Stripe] Subscription cancelled — user ${userId} deactivated. Number RETAINED (manual release via audit).`)
        break
      }

      // ── Subscription reactivated ──────────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object
        const userId = sub.metadata?.user_id
        if (!userId) break

        if (sub.status === 'active') {
          await supabase
            .from('businesses')
            .update({ status: 'active', active: true })
            .eq('user_id', userId)
        }
        break
      }
    }

    res.json({ received: true })

  } catch (err) {
    console.error('[Stripe Webhook] Handler error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Upgrade to Pro ────────────────────────────────────────────────────────────
// Generic upgrade — handles Solo→Standard, Solo→Pro, Standard→Pro
router.post('/upgrade-plan', async (req, res) => {
  try {
    const { userId, plan } = req.body
    if (!['standard', 'pro'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' })
    }
    const { data: business } = await supabase
      .from('businesses')
      .select('stripe_subscription_id, business_name, plan')
      .eq('user_id', userId)
      .maybeSingle()

    if (!business?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' })
    }

    const priceId = plan === 'pro'
      ? process.env.STRIPE_PRO_PRICE_ID
      : process.env.STRIPE_PRICE_ID

    if (!priceId) return res.status(500).json({ error: `${plan} price ID not configured` })

    const subscription = await stripe.subscriptions.retrieve(business.stripe_subscription_id)
    await stripe.subscriptions.update(business.stripe_subscription_id, {
      items: [{ id: subscription.items.data[0].id, price: priceId }],
      proration_behavior: 'always_invoice',
      metadata: { plan }
    })

    await supabase.from('businesses').update({ plan }).eq('user_id', userId)
    console.log(`[Stripe] Upgraded ${business.business_name} from ${business.plan} to ${plan}`)
    res.json({ success: true })
  } catch (err) {
    console.error('[Stripe] Upgrade error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Legacy endpoint — redirect to upgrade-plan
router.post('/upgrade-to-pro', async (req, res) => {
  req.body.plan = 'pro'
  try {
    const { userId } = req.body
    const { data: business } = await supabase
      .from('businesses').select('stripe_subscription_id, business_name, plan').eq('user_id', userId).maybeSingle()
    if (!business?.stripe_subscription_id) return res.status(400).json({ error: 'No active subscription found' })
    const priceId = process.env.STRIPE_PRO_PRICE_ID
    if (!priceId) return res.status(500).json({ error: 'Pro price ID not configured' })
    const subscription = await stripe.subscriptions.retrieve(business.stripe_subscription_id)
    await stripe.subscriptions.update(business.stripe_subscription_id, {
      items: [{ id: subscription.items.data[0].id, price: priceId }],
      proration_behavior: 'always_invoice', metadata: { plan: 'pro' }
    })
    await supabase.from('businesses').update({ plan: 'pro' }).eq('user_id', userId)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Customer portal (cancel, update card, see invoices) ───────────────────────
// Customer clicks "Manage billing" in dashboard → redirected to Stripe portal
router.post('/portal', async (req, res) => {
  try {
    const { userId } = req.body

    const { data: business } = await supabase
      .from('businesses')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (!business?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found.' })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: business.stripe_customer_id,
      return_url: `${process.env.SITE_URL}/dashboard.html`
    })

    res.json({ url: session.url })

  } catch (err) {
    console.error('[Stripe] Portal error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Helper: extract area code from address string ─────────────────────────────
// e.g. "123 Main St, Riverside CA 92501" → "951"
// ── Notify Wexly owner of new signup via email + SMS ─────────────────────────
async function notifyOwnerNewSignup(business) {
  const OWNER_EMAIL = process.env.OWNER_NOTIFICATION_EMAIL || 'hello@getwexly.com'
  const OWNER_PHONE = process.env.OWNER_NOTIFICATION_PHONE

  console.log(`[Notify] Sending owner notification — email: ${OWNER_EMAIL}, phone: ${OWNER_PHONE || 'not set'}`)

  // Email notification — always fires, defaults to hello@getwexly.com
  await sendOwnerNewSignupNotification({
    businessName: business.business_name,
    ownerName: business.owner_name,
    email: business.email,
    businessType: business.business_type
  }).catch(err => console.error('[Notify] Signup email failed:', err.message))

  // SMS notification — only if phone is set
  if (OWNER_PHONE && process.env.TWILIO_PHONE_NUMBER) {
    const { sendSMS } = require('../utils/sms')
    await sendSMS(
      process.env.TWILIO_PHONE_NUMBER,
      OWNER_PHONE,
      `🎉 New Wexly signup!\n${business.business_name}\n${business.owner_name} · ${business.email}\nTrial started — $149 on day 15`
    ).catch(err => console.error('[Notify] Signup SMS failed:', err.message))
  } else {
    console.warn('[Notify] OWNER_NOTIFICATION_PHONE not set — skipping SMS')
  }
}

function extractAreaCode(address) {
  if (!address) return null
  // Common CA area codes by city keyword
  const areaCodes = {
    'riverside':    '951',
    'san bernardino': '909',
    'los angeles':  '213',
    'long beach':   '562',
    'san diego':    '619',
    'san francisco': '415',
    'san jose':     '408',
    'sacramento':   '916',
    'fresno':       '559',
    'las vegas':    '702',
    'phoenix':      '602',
    'new york':     '212',
    'chicago':      '312',
    'houston':      '713',
    'miami':        '305',
    'dallas':       '214',
    'seattle':      '206',
    'denver':       '303',
    'atlanta':      '404',
    'boston':       '617',
  }
  const lower = address.toLowerCase()
  for (const [city, code] of Object.entries(areaCodes)) {
    if (lower.includes(city)) return code
  }
  return null // Twilio will pick any available US number
}

module.exports = router
