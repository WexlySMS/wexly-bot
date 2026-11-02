-- ============================================================
-- Wexly — Complete RLS Security Setup
-- Run this entire file in Supabase SQL Editor
-- This enables proper security while keeping the bot working
-- ============================================================

-- ── STEP 1: Enable RLS on all tables ─────────────────────────
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

-- ── STEP 2: Drop any existing policies to start clean ────────
DROP POLICY IF EXISTS "owners_own_business" ON businesses;
DROP POLICY IF EXISTS "owners_own_services" ON services;
DROP POLICY IF EXISTS "owners_own_faqs" ON faqs;
DROP POLICY IF EXISTS "owners_own_appointments" ON appointments;
DROP POLICY IF EXISTS "owners_own_sessions" ON conversation_sessions;
DROP POLICY IF EXISTS "owners_own_waitlist" ON waitlist;
DROP POLICY IF EXISTS "owners_own_blocked" ON blocked_dates;
DROP POLICY IF EXISTS "owners_own_qual" ON qualification_questions;
DROP POLICY IF EXISTS "owners_own_followup" ON followup_sequences;
DROP POLICY IF EXISTS "owners_own_intake" ON intake_fields;
DROP POLICY IF EXISTS "owners_own_responses" ON intake_responses;
DROP POLICY IF EXISTS "owners_own_customers" ON customers;
DROP POLICY IF EXISTS "owners_own_campaigns" ON email_campaigns;
DROP POLICY IF EXISTS "owners_own_promotions" ON promotions;

-- ── STEP 3: BUSINESSES table ─────────────────────────────────
-- Owners can read/write only their own business
CREATE POLICY "owners_own_business" ON businesses
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── STEP 4: SERVICES table ───────────────────────────────────
CREATE POLICY "owners_own_services" ON services
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 5: FAQS table ───────────────────────────────────────
CREATE POLICY "owners_own_faqs" ON faqs
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 6: APPOINTMENTS table ───────────────────────────────
CREATE POLICY "owners_own_appointments" ON appointments
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 7: CONVERSATION SESSIONS table ─────────────────────
CREATE POLICY "owners_own_sessions" ON conversation_sessions
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 8: WAITLIST table ───────────────────────────────────
CREATE POLICY "owners_own_waitlist" ON waitlist
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 9: BLOCKED DATES table ──────────────────────────────
CREATE POLICY "owners_own_blocked" ON blocked_dates
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 10: QUALIFICATION QUESTIONS table ───────────────────
CREATE POLICY "owners_own_qual" ON qualification_questions
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 11: FOLLOWUP SEQUENCES table ───────────────────────
CREATE POLICY "owners_own_followup" ON followup_sequences
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 12: INTAKE FIELDS table ─────────────────────────────
CREATE POLICY "owners_own_intake" ON intake_fields
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 13: INTAKE RESPONSES table ──────────────────────────
CREATE POLICY "owners_own_responses" ON intake_responses
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 14: CUSTOMERS table ─────────────────────────────────
CREATE POLICY "owners_own_customers" ON customers
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 15: EMAIL CAMPAIGNS table ───────────────────────────
CREATE POLICY "owners_own_campaigns" ON email_campaigns
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 16: PROMOTIONS table ────────────────────────────────
CREATE POLICY "owners_own_promotions" ON promotions
  FOR ALL
  USING (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ))
  WITH CHECK (business_id IN (
    SELECT id FROM businesses WHERE user_id = auth.uid()
  ));

-- ── STEP 17: Create disable_all_rls function for bot server ──
-- The bot server uses the service key which bypasses RLS automatically
-- This function is kept for emergency use only
CREATE OR REPLACE FUNCTION disable_all_rls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- This should only be called in emergencies
  -- Normal operation uses service key which bypasses RLS
  RAISE NOTICE 'disable_all_rls called — service key bypasses RLS automatically';
END;
$$;

-- ── DONE ─────────────────────────────────────────────────────
-- Every business owner can only see and modify their own data
-- The bot server uses SUPABASE_SERVICE_KEY which bypasses all RLS
-- No customer can see another business's data
-- Supabase security warning will be resolved
