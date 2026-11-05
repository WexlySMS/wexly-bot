-- Wexly Checkout — transactions table
-- Run this in Supabase SQL editor

CREATE TABLE IF NOT EXISTS transactions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  customer_name text,
  customer_phone text,
  line_items jsonb DEFAULT '[]',
  subtotal integer DEFAULT 0,  -- cents
  tip integer DEFAULT 0,        -- cents
  discount integer DEFAULT 0,   -- cents
  total integer DEFAULT 0,      -- cents
  status text DEFAULT 'sent' CHECK (status IN ('sent', 'paid', 'unpaid', 'refunded')),
  notes text,
  payment_link text,
  appointment_id uuid,
  created_at timestamptz DEFAULT now()
);

-- Index for fast lookups by business + customer
CREATE INDEX IF NOT EXISTS transactions_business_id_idx ON transactions(business_id);
CREATE INDEX IF NOT EXISTS transactions_customer_phone_idx ON transactions(customer_phone);
CREATE INDEX IF NOT EXISTS transactions_created_at_idx ON transactions(created_at DESC);

-- Add payment_link column to businesses table if not already there
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_link text;

-- Stripe Connect columns for deposit feature
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_account_id text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_account_connected boolean DEFAULT false;

-- Deposit settings per service
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_enabled boolean DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_type text DEFAULT 'flat' CHECK (deposit_type IN ('flat','pct'));
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_amount numeric DEFAULT 0;

-- Deposit tracking on appointments
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_required boolean DEFAULT false;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_amount integer DEFAULT 0;  -- cents
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_status text DEFAULT 'none' CHECK (deposit_status IN ('none','pending','paid','waived'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_payment_intent text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_link text;

-- Deposit pending flow columns
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_expires_at timestamptz;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_reminder_sent boolean DEFAULT false;

-- Owner alert tracking for deposit flow
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_owner_alerted boolean DEFAULT false;

-- Per-customer deposit waiver flag
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deposit_waived boolean DEFAULT false;

-- Products table for retail items
CREATE TABLE IF NOT EXISTS products (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  price text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_business_id_idx ON products(business_id);
