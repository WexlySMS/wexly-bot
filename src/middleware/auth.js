// ── Authentication middleware ──────────────────────────────────────────────────
// Validates Supabase JWT token from Authorization header
// Attaches req.user (user_id) and optionally verifies business ownership

const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Middleware: require a valid Supabase auth token
function requireAuth(req, res, next) {
  var authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  var token = authHeader.replace('Bearer ', '')

  // Verify token with Supabase using service key (can validate any user's token)
  supabase.auth.getUser(token).then(function(result) {
    if (result.error || !result.data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
    req.user = result.data.user
    req.userId = result.data.user.id
    next()
  }).catch(function() {
    res.status(401).json({ error: 'Authentication failed' })
  })
}

// Middleware: require auth + verify user owns the businessId in request
function requireBusinessAuth(req, res, next) {
  requireAuth(req, res, function() {
    // Extract businessId from body, query, or params
    var businessId = req.body?.businessId || req.body?.business_id ||
      req.query?.businessId || req.params?.businessId

    if (!businessId) {
      return next() // No businessId to check — auth token is enough
    }

    supabase
      .from('businesses')
      .select('id, user_id')
      .eq('id', businessId)
      .maybeSingle()
      .then(function(result) {
        if (!result.data) {
          return res.status(404).json({ error: 'Business not found' })
        }
        if (result.data.user_id !== req.userId) {
          return res.status(403).json({ error: 'You do not own this business' })
        }
        req.businessId = businessId
        next()
      })
      .catch(function() {
        res.status(500).json({ error: 'Auth check failed' })
      })
  })
}

// Middleware: allow EITHER an internal server-to-server call (carrying the
// shared ADMIN_SECRET) OR a normal authenticated business-owner session.
// Used for endpoints the bot calls internally (e.g. create-deposit) that also
// need to be reachable from the dashboard. The bot runs in the same process
// and includes the secret header; dashboard calls fall through to the normal
// business-auth check.
function requireInternalOrBusinessAuth(req, res, next) {
  var internalSecret = req.headers['x-internal-secret'] || req.body?.internalSecret
  var hasInternalHeader = internalSecret !== undefined && internalSecret !== null && internalSecret !== ''
  // Trusted internal server-to-server call (the bot calling its own API):
  //  - If ADMIN_SECRET is configured, the header must match it.
  //  - If ADMIN_SECRET is NOT configured (some envs don't set it), accept any
  //    request that carries the internal header at all — matches the existing
  //    "no secret configured = allow internal" pattern used elsewhere.
  var secretOk = process.env.ADMIN_SECRET
    ? internalSecret === process.env.ADMIN_SECRET
    : hasInternalHeader
  if (secretOk) {
    var businessId = req.body?.businessId || req.body?.business_id
    if (businessId) req.businessId = businessId
    return next()
  }
  // Not an internal call — require a real logged-in business owner.
  return requireBusinessAuth(req, res, next)
}

// Middleware: require Wexly platform admin (Brandon's admin endpoints only)
function requireAdmin(req, res, next) {
  var secret = req.body?.secret || req.headers['x-admin-secret'] || req.query?.secret
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
}

module.exports = { requireAuth, requireBusinessAuth, requireInternalOrBusinessAuth, requireAdmin }
