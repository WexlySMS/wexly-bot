// One place for phone normalization. Twilio hands us E.164 (+1XXXXXXXXXX);
// owners type anything ("760-604-1791", "(760) 604 1791", "7606041791").
// Every exact-match lookup on customer_phone goes through phoneVariants so a
// row saved in any of those shapes still matches the person texting.
function toE164(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
  if (d.length === 10) return '+1' + d
  if (d.length > 11 && String(raw).trim().startsWith('+')) return '+' + d
  return null
}
function phoneVariants(raw) {
  const v = new Set([String(raw || '')])
  const e = toE164(raw)
  if (e && e.startsWith('+1') && e.length === 12) {
    const d = e.slice(2)
    ;[e, d, '1' + d, `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`, `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`, `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`, `+1 ${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`, `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `1-${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`].forEach(x => v.add(x))
  } else if (e) v.add(e)
  return [...v].filter(Boolean)
}
module.exports = { toE164, phoneVariants }
