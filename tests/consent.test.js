const test = require('node:test')
const assert = require('node:assert/strict')
const { state, reset, ROOT, BIZ } = require('./helpers')
const path = require('path')

test('marketing texts are held for imported customers and sent to texted-in ones', async () => {
  reset({ customers: [
    { id: 'c1', business_id: 'biz-1', phone: '+13105550201', consent_source: 'imported' },
    { id: 'c2', business_id: 'biz-1', phone: '+13105550202', consent_source: 'texted_in' }
  ], conversation_sessions: [] })
  const { canMarket } = require(path.join(ROOT, 'src/utils/consent.js'))
  assert.equal(await canMarket('biz-1', '+13105550201'), false)
  assert.equal(await canMarket('biz-1', '310-555-0202'), true, 'any phone format matches')
})

test('an older row with no consent value is marketable only if a conversation exists', async () => {
  reset({ customers: [{ id: 'c3', business_id: 'biz-1', phone: '+13105550203', consent_source: null }], conversation_sessions: [{ business_id: 'biz-1', customer_phone: '+13105550203', messages: [] }] })
  const { canMarket } = require(path.join(ROOT, 'src/utils/consent.js'))
  assert.equal(await canMarket('biz-1', '+13105550203'), true)
  reset({ customers: [{ id: 'c4', business_id: 'biz-1', phone: '+13105550204', consent_source: null }], conversation_sessions: [] })
  assert.equal(await canMarket('biz-1', '+13105550204'), false)
})

test('partner notices only fire for partner-tagged signups', () => {
  const { isPartnerAccount } = require(path.join(ROOT, 'src/utils/partner.js'))
  assert.equal(isPartnerAccount({ signup_source: 'reckless' }), true)
  assert.equal(isPartnerAccount({ signup_source: 'meta' }), false)
  assert.equal(isPartnerAccount({}), false)
})
