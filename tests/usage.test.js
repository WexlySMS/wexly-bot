const test = require('node:test')
const assert = require('node:assert/strict')
const { ROOT } = require('./helpers')
const path = require('path')
const { modelCostCents, segmentsFor } = require(path.join(ROOT, 'src/utils/usage.js'))

test('model cost uses list prices and cache rates', () => {
  // 14K uncached input + 250 out ≈ 4.2c + 0.375c
  assert.equal(modelCostCents('claude-sonnet-4-6', { input_tokens: 14000, output_tokens: 250 }), 4.58)
  // same call with 13K served from cache ≈ 0.3c + 0.39c + 0.375c
  assert.equal(modelCostCents('claude-sonnet-4-6', { input_tokens: 1000, cache_read_input_tokens: 13000, output_tokens: 250 }), 1.07)
})

test('SMS segments follow Twilio rules', () => {
  assert.equal(segmentsFor('Hi Jess, you are booked.'), 1)
  assert.equal(segmentsFor('a'.repeat(160)), 1)
  assert.equal(segmentsFor('a'.repeat(161)), 2)
  assert.equal(segmentsFor('Great news 😊 ' + 'a'.repeat(60)), 2) // emoji forces UCS-2 (70 per segment)
})

test('client engine sends a cached system block and cached tools', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'src/bot/conversationEngine.js'), 'utf8')
  assert.match(src, /system: systemBlocks\(systemPrompt\)/)
  assert.match(src, /tools: cachedTools/)
  // nothing time-dependent above the split
  const a = src.indexOf('return `You are ${botName}'), b = src.indexOf('${DYNAMIC_SPLIT}')
  const head = src.slice(a, b)
  for (const bad of ['${today}', 'new Date', 'returningCustomer', 'upcoming']) assert.ok(!head.includes(bad), `${bad} must sit below the cache split`)
})
