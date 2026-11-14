// Shared fakes for the contract tests. No network, no database, no model:
// Supabase and sendSMS are replaced with in-memory versions so each test
// drives the real handler code against known rows.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://test.local'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test'
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_x'

const path = require('path')
const ROOT = path.join(__dirname, '..')

const state = { rows: {}, sms: [], writes: [] }

function reset(rows = {}) {
  state.rows = JSON.parse(JSON.stringify(rows))
  state.sms = []
  state.writes = []
}

function builder(table) {
  let data = (state.rows[table] || []).slice()
  let op = 'select'
  let pendingUpdate = null
  const filters = []
  const apply = () => { data = (state.rows[table] || []).filter(r => filters.every(f => f(r))) }
  const b = {
    select() { return b },
    eq(k, v) { filters.push(r => r[k] === v); apply(); return b },
    neq(k, v) { filters.push(r => r[k] !== v); apply(); return b },
    in(k, vs) { filters.push(r => vs.includes(r[k])); apply(); return b },
    gte(k, v) { filters.push(r => r[k] >= v); apply(); return b },
    lte(k, v) { filters.push(r => r[k] <= v); apply(); return b },
    gt(k, v) { filters.push(r => r[k] > v); apply(); return b },
    lt(k, v) { filters.push(r => r[k] < v); apply(); return b },
    is(k, v) { filters.push(r => (r[k] ?? null) === v); apply(); return b },
    not(k, opr, v) { filters.push(r => !(opr === 'is' ? (r[k] ?? null) === v : r[k] === v)); apply(); return b },
    ilike(k, v) { const n = String(v).replace(/%/g, '').toLowerCase(); filters.push(r => String(r[k] ?? '').toLowerCase().includes(n)); apply(); return b },
    or() { return b },
    order(k, o) { const asc = !o || o.ascending !== false; data.sort((x, y) => String(x[k] ?? '').localeCompare(String(y[k] ?? '')) * (asc ? 1 : -1)); return b },
    limit(n) { data = data.slice(0, n); return b },
    maybeSingle() { return Promise.resolve({ data: op === 'select' ? (data[0] || null) : (data[0] || null), error: null }) },
    single() { return Promise.resolve({ data: data[0] || null, error: data[0] ? null : { message: 'no rows' } }) },
    update(p) { op = 'update'; pendingUpdate = p; return b },
    insert(p) { op = 'insert'; const list = Array.isArray(p) ? p : [p]; for (const row of list) { const r = { id: row.id || `${table}-${Math.random().toString(36).slice(2, 8)}`, created_at: new Date().toISOString(), ...row }; (state.rows[table] ||= []).push(r); state.writes.push([table, 'insert', r]) } return b },
    upsert(p) { op = 'upsert'; state.writes.push([table, 'upsert', p]); return Promise.resolve({ data: null, error: null }) },
    delete() { op = 'delete'; return b },
    then(resolve) {
      if (op === 'update') { for (const r of data) { Object.assign(r, pendingUpdate); state.writes.push([table, 'update', r.id, pendingUpdate]) } return resolve({ data, error: null }) }
      if (op === 'delete') { const ids = new Set(data.map(r => r.id)); state.rows[table] = (state.rows[table] || []).filter(r => !ids.has(r.id)); state.writes.push([table, 'delete', [...ids]]); return resolve({ data: null, error: null }) }
      return resolve({ data, error: null })
    }
  }
  return b
}

function mock(id, exports) {
  const p = require.resolve(id)
  require.cache[p] = { id: p, filename: p, loaded: true, exports }
}

mock('@supabase/supabase-js', { createClient: () => ({ from: builder, storage: { from: () => ({}) } }) })
mock(path.join(ROOT, 'src/utils/sms.js'), {
  sendSMS: async (from, to, body) => { state.sms.push({ from, to, body }); return { success: true, sid: 'SM' + state.sms.length } }
})
mock(path.join(ROOT, 'src/utils/emailService.js'), new Proxy({}, { get: () => async () => ({}) }))
mock(path.join(ROOT, 'src/utils/shortener.js'), { shortenUrl: async (u) => u })

const today = (tz = 'America/Los_Angeles') => new Date().toLocaleDateString('en-CA', { timeZone: tz })
const plusDays = (n, tz = 'America/Los_Angeles') => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: tz })

const BIZ = { id: 'biz-1', business_name: 'Glow Studio', timezone: 'America/Los_Angeles', sms_number: '+13100000000', owner_phone: '+13105550199', staff_members: [], hours: [
  { day: 'Mon', open: '09:00', close: '18:00' }, { day: 'Tue', open: '09:00', close: '18:00' }, { day: 'Wed', open: '09:00', close: '18:00' }, { day: 'Thu', open: '09:00', close: '18:00' }, { day: 'Fri', open: '09:00', close: '18:00' }, { day: 'Sat', open: '09:00', close: '18:00' }, { day: 'Sun', closed: true }
], buffer_mins: 0 }

module.exports = { state, reset, mock, ROOT, today, plusDays, BIZ }
