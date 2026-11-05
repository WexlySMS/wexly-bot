// ── Site importer (v203, Entry 72) ────────────────────────────────────────────
// Turns an existing booking page or website (GlossGenius, Booksy, StyleSeat,
// Square, Squarespace, Wix, anything server-rendered) into Wexly data:
// services, hours, address, bio, photos, logo, social links. Two steps so a
// human (or the owner by text) can check before anything is written:
//   importFromUrl(url)              → { ...extracted, warnings[] }   (no writes)
//   applyImport(businessId, data)   → writes services/hours/profile, re-hosts photos
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const MODEL = process.env.IMPORT_MODEL || 'claude-sonnet-4-6'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const FETCH_MS = 20000
const MAX_HTML = 3 * 1024 * 1024
const MAX_TEXT = 60000
const MAX_BLOBS = 80000

function normalizeUrl(raw) {
  let u = String(raw || '').trim()
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try { const x = new URL(u); if (!/\./.test(x.hostname)) return null; return x.toString() } catch { return null }
}

async function fetchText(url, { timeoutMs = FETCH_MS, maxBytes = MAX_HTML, accept = 'text/html,application/xhtml+xml' } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: ctl.signal })
    const ct = r.headers.get('content-type') || ''
    const buf = Buffer.from(await r.arrayBuffer())
    return { ok: r.ok, status: r.status, contentType: ct, finalUrl: r.url, body: buf.subarray(0, maxBytes).toString('utf8'), bytes: buf.length }
  } finally { clearTimeout(t) }
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
const abs = (base, href) => { try { return new URL(href, base).toString() } catch { return null } }

// Pull the parts of a page a model can reason over: JSON-LD, framework state
// blobs, meta tags, candidate images, and the visible text.
function dissect(html, baseUrl) {
  const out = { jsonld: [], blobs: [], meta: {}, images: [], text: '' }
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.jsonld.push(JSON.parse(m[1].trim())) } catch { /* ignore */ }
  }
  for (const m of html.matchAll(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)) out.blobs.push(m[1])
  for (const m of html.matchAll(/window\.(?:__NUXT__|__INITIAL_STATE__|__PRELOADED_STATE__|__APOLLO_STATE__)\s*=\s*([\s\S]*?);\s*<\/script>/gi)) out.blobs.push(m[1])
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*)["']/gi)) out.meta[m[1].toLowerCase()] = decode(m[2])
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']([^"']+)["']/gi)) out.meta[m[2].toLowerCase()] = decode(m[1])
  const seen = new Set()
  const pushImg = (src, hint) => { const u = abs(baseUrl, decode(src)); if (!u || seen.has(u) || /\.svg(\?|$)|data:|sprite|pixel|tracking|1x1/i.test(u)) return; seen.add(u); out.images.push({ url: u, hint }) }
  for (const k of ['og:image', 'og:image:secure_url', 'twitter:image']) if (out.meta[k]) pushImg(out.meta[k], 'og')
  for (const m of html.matchAll(/<img[^>]*>/gi)) {
    const tag = m[0]
    const src = (tag.match(/\s(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i) || [])[1]
    const srcset = (tag.match(/\s(?:data-srcset|srcset)=["']([^"']+)["']/i) || [])[1]
    const best = srcset ? srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean).pop() : null
    const alt = decode((tag.match(/\salt=["']([^"']*)["']/i) || [])[1] || '')
    const w = parseInt((tag.match(/\swidth=["']?(\d+)/i) || [])[1] || '0', 10)
    if (w && w < 120) continue
    if (best || src) pushImg(best || src, /logo/i.test(alt + tag) ? 'logo' : alt.slice(0, 60))
    if (out.images.length >= 60) break
  }
  for (const m of html.matchAll(/background(?:-image)?:\s*url\((['"]?)([^'")]+)\1\)/gi)) { pushImg(m[2], 'bg'); if (out.images.length >= 80) break }
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  t = t.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  t = decode(t).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  out.text = t.slice(0, MAX_TEXT)
  return out
}


// ── Platform adapters ─────────────────────────────────────────────────────────
// Deterministic parsers for platforms whose pages carry structured data. Each
// returns a partial import object or null; the model fills whatever is missing.

// GlossGenius: Next.js, everything lives in __NEXT_DATA__.props.serverContext
// (publicUser.users[].services, locations[0].hours, cover_image_original,
// organization_brand_logo, social urls) and a public portfolio API.
async function parseGlossGenius(html, url) {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!m) return null
  let sc; try { sc = JSON.parse(m[1]).props?.serverContext } catch { return null }
  const pu = sc?.publicUser; if (!pu || !Array.isArray(pu.users)) return null
  const loc = (sc.locations || [])[0] || {}
  const pad = n => String(n).padStart(2, '0')
  const hhmm = t => t && Number.isFinite(+t.hours) ? `${pad(t.hours)}:${pad(t.minutes || 0)}` : null
  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const hours = loc.hours ? dayKeys.map((k, i) => { const r = (loc.hours[k] || [])[0]; const from = r && hhmm(r.startTime), to = r && hhmm(r.endTime); return from && to ? { day: dayNames[i], open: true, from, to } : { day: dayNames[i], open: false } }) : null
  const services = []
  for (const u of pu.users) for (const sv of u.services || []) {
    if (!sv.name || sv.price_hidden) continue
    const price = sv.price != null && sv.price !== '' ? String(parseFloat(sv.price)).replace(/\.0+$/, '') + (sv.price_varies ? '+' : '') : ''
    services.push({ name: String(sv.name).trim(), price, duration_mins: +sv.total_duration || +sv.start_duration || null, description: sv.description ? String(sv.description).trim() : null, category: sv.category_name && sv.category_name !== 'None' ? sv.category_name : null, deposit: sv.deposit_amount ? String(sv.deposit_amount) : null, by_request: false, _order: sv.ordering ?? 999 })
  }
  services.sort((a, b) => a._order - b._order); services.forEach(x => delete x._order)
  for (const pk of sc.packages || []) if (pk && pk.name) services.push({ name: String(pk.name).trim(), price: pk.price != null ? String(parseFloat(pk.price)).replace(/\.0+$/, '') : '', duration_mins: +pk.total_duration || null, description: pk.description || null, category: 'Packages', by_request: false })
  const addr = loc.contactInfo?.address
  const street = addr?.street_line_1 ? String(addr.street_line_1).replace(new RegExp('\\s*' + (addr.locality || '') + '.*$', 'i'), '').trim() : null
  const address = addr ? [street, addr.street_line_2, [addr.locality, (addr.administrative_area || '').replace(/^us_/, '').toUpperCase(), addr.postal_code].filter(Boolean).join(' ')].filter(Boolean).join('\n') : (pu.business_address || null)
  const handle = v => v ? String(v).replace(/^https?:\/\/(www\.)?(instagram|facebook|tiktok)\.com\//i, '').replace(/^@/, '').replace(/\/$/, '') : null
  const social = {}
  const ig = pu.instagram_url || pu.users[0]?.instagram_url; if (ig) social.instagram = handle(ig)
  const fb = pu.facebook_url || pu.users[0]?.facebook_url; if (fb) social.facebook = fb
  if (pu.website_url) social.website = pu.website_url
  if (pu.yelp_url) social.yelp = pu.yelp_url
  let photos = []
  if (pu.slug) {
    try { const r = await fetchText(`https://api.glossgenius.com/v3/web/portfolio_images?slug=${encodeURIComponent(pu.slug)}`, { accept: 'application/json', timeoutMs: 10000 }); const j = JSON.parse(r.body); photos = (j.data || []).map(x => x.image?.original || x.image?.medium).filter(Boolean) } catch { /* portfolio optional */ }
  }
  const cover = pu.cover_image_original || pu.cover_image_medium || null
  const logo = pu.organization_brand_logo || (pu.users.length === 1 && !pu.users[0].default_avatar ? pu.users[0].avatar_medium : null) || null
  const about = pu.about || pu.users[0]?.about || null
  const notes = []
  if (cover && /stockimage/.test(cover)) notes.push('Cover is a GlossGenius stock image; swap for a real photo if they have one.')
  if (sc.reviewSummary?.reviewCount) notes.push(`${sc.reviewSummary.reviewCount} reviews on GlossGenius (${sc.reviewSummary.ratingValue} stars).`)
  return { platform: 'glossgenius', name: pu.business_name || loc.name || null, phone: pu.business_phone || loc.contactInfo?.phone || pu.phone || null, address, city: addr?.locality || null, about, hours, services, social, cover, logo, photos, accent: pu.organization_accent_color || null, notes: notes.join(' ') || undefined }
}

// ── Shared helpers for adapters ───────────────────────────────────────────────
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_FULL = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const emptyWeek = () => DAYS.map(day => ({ day, open: false }))
// "11:00 AM" / "9:30pm" / "17:00" / "09:00:00" → "HH:MM"
function to24(t) {
  if (!t) return null
  const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/i)
  if (!m) return null
  let h = +m[1]; const mi = m[2] || '00'; const ap = (m[3] || '').toLowerCase().replace(/\./g, '')
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0
  if (h > 23) return null
  return `${String(h).padStart(2, '0')}:${mi}`
}
// "1 hr 30 min", "40 min", "2 hr", "90" → minutes
function toMinutes(c) {
  if (c == null) return null
  if (typeof c === 'number') return c > 0 ? Math.round(c) : null
  const str = String(c).toLowerCase(); let m = 0
  const h = str.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/); if (h) m += Math.round(parseFloat(h[1]) * 60)
  const mi = str.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/); if (mi) m += +mi[1]
  if (!h && !mi && /^\d+$/.test(str.trim())) m = +str.trim()
  return m > 0 ? m : null
}
// "from $40", "$65.00", "US$15", "$150+" → "40", "65", "150+"
function toPrice(p) {
  if (p == null || p === '') return ''
  if (typeof p === 'number') return String(p).replace(/\.0+$/, '')
  const str = String(p); const from = /\bfrom\b|\+|and up|starting/i.test(str)
  const n = str.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/); if (!n) return ''
  return String(parseFloat(n[1])).replace(/\.0+$/, '') + (from ? '+' : '')
}
function jsonLdAll(html) {
  const out = []
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { const j = JSON.parse(m[1].trim()); (Array.isArray(j) ? j : j['@graph'] ? j['@graph'] : [j]).forEach(x => out.push(x)) } catch { /* ignore */ } }
  return out
}
function ldBusiness(html) {
  return jsonLdAll(html).find(x => { const t = [].concat(x['@type'] || []).join(' '); return /Salon|Barber|Spa|Beauty|LocalBusiness|HealthAndBeauty|Store|NailSalon|DaySpa|TattooParlor|Dentist|MedicalBusiness/i.test(t) && x.name && x.name !== 'Booksy' })
}
function hoursFromLd(biz) {
  const spec = biz?.openingHoursSpecification; if (!Array.isArray(spec) || !spec.length) return null
  const week = emptyWeek()
  for (const sp of spec) { const from = to24(sp.opens), to = to24(sp.closes); if (!from || !to) continue; for (const d of [].concat(sp.dayOfWeek || [])) { const i = DAY_FULL[String(d).replace(/.*\//, '').toLowerCase()]; if (i != null) week[i] = { day: DAYS[i], open: true, from, to } } }
  return week.some(w => w.open) ? week : null
}
function addressFromLd(biz) {
  const a = biz?.address; if (!a) return null
  if (typeof a === 'string') return a
  const line2 = [a.addressLocality, (a.addressRegion || '').replace(/^California$/i, 'CA'), a.postalCode].filter(Boolean).join(' ')
  const street = (a.streetAddress || '').replace(new RegExp(',?\\s*' + (a.addressLocality || '§') + '.*$', 'i'), '').trim()
  return [street, line2].filter(Boolean).join('\n') || null
}
function handleOf(url) { return url ? String(url).replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\//i, '').replace(/^@/, '').replace(/[/?].*$/, '') : null }
function socialFromLd(biz) {
  const soc = {}
  for (const u of [].concat(biz?.sameAs || [])) { if (/instagram\.com/i.test(u)) soc.instagram = handleOf(u); else if (/facebook\.com/i.test(u)) soc.facebook = u; else if (/tiktok\.com/i.test(u)) soc.tiktok = handleOf(u); else if (/yelp\.com/i.test(u)) soc.yelp = u }
  return soc
}

// Nuxt "devalue" payload (__NUXT_DATA__): a flat array where numbers are
// references to other slots. Resolve lazily with a cycle guard.
function devalueResolver(arr) {
  const cache = new Map()
  const res = (i, depth = 0) => {
    if (typeof i !== 'number' || depth > 12) return i
    if (cache.has(i)) return cache.get(i)
    const v = arr[i]
    if (Array.isArray(v)) { if (typeof v[0] === 'string' && /^(ShallowReactive|Reactive|Ref|ShallowRef|Set|Map|NaN|Date)$/.test(v[0])) return res(v[1], depth + 1); const out = []; cache.set(i, out); v.forEach(x => out.push(res(x, depth + 1))); return out }
    if (v && typeof v === 'object') { const out = {}; cache.set(i, out); for (const [k, x] of Object.entries(v)) out[k] = res(x, depth + 1); return out }
    return v
  }
  return res
}

// ── Booksy: __NUXT_DATA__ business object + JSON-LD ───────────────────────────
async function parseBooksy(html, url) {
  const m = html.match(/<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i); if (!m) return null
  let arr; try { arr = JSON.parse(m[1]) } catch { return null }
  const idx = arr.findIndex(v => v && typeof v === 'object' && !Array.isArray(v) && 'serviceCategories' in v && 'openHours' in v)
  if (idx < 0) return null
  const b = devalueResolver(arr)(idx)
  const ld = ldBusiness(html)
  const services = []
  for (const cat of b.serviceCategories || []) for (const sv of cat.services || []) {
    if (!sv?.name) continue
    const v = (sv.variants || [])[0] || {}
    services.push({ name: sv.name, price: toPrice(v.price ?? sv.servicePrice), duration_mins: toMinutes(v.duration), description: sv.description || null, category: cat.name || null, deposit: v.deposit ? toPrice(v.deposit) : null, by_request: false })
    for (const extra of (sv.variants || []).slice(1)) if (extra.label) services.push({ name: `${sv.name} (${extra.label})`, price: toPrice(extra.price), duration_mins: toMinutes(extra.duration), description: null, category: cat.name || null, deposit: extra.deposit ? toPrice(extra.deposit) : null, by_request: false })
  }
  let hours = hoursFromLd(ld)
  if (!hours && Array.isArray(b.openHours) && b.openHours.length) { hours = emptyWeek(); for (const h of b.openHours) { const i = (h.dayOfWeek + 1) % 7; const from = to24(h.openFrom), to = to24(h.openTill); if (from && to) hours[i] = { day: DAYS[i], open: true, from, to } } }
  const img = b.images || {}
  const first = k => (img[k] || [])[0]?.image || null
  const photos = [...(img.bizPhoto || []), ...(img.inspiration || [])].map(x => x.image).filter(Boolean)
  const social = { ...socialFromLd(ld) }; if (b.instagramLink) social.instagram = handleOf(b.instagramLink); if (b.facebookLink) social.facebook = b.facebookLink; if (b.website) social.website = b.website
  const notes = []; if (ld?.aggregateRating?.reviewCount) notes.push(`${ld.aggregateRating.reviewCount} reviews on Booksy (${ld.aggregateRating.ratingValue} stars).`)
  return { platform: 'booksy', name: b.name || ld?.name || null, phone: ld?.telephone || null, address: addressFromLd(ld) || b.location?.address || null, city: b.location?.city || null, about: b.description || null, policies: b.depositPolicy || null, hours, services, social, cover: first('cover') || ld?.image || null, logo: first('logo') || ld?.logo || null, photos, notes: notes.join(' ') || undefined }
}

// ── Fresha: __NEXT_DATA__.props.pageProps.data.location + JSON-LD ─────────────
async function parseFresha(html, url) {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i); if (!m) return null
  let loc; try { loc = JSON.parse(m[1]).props?.pageProps?.data?.location } catch { return null }
  if (!loc) return null
  const ld = ldBusiness(html)
  const services = []
  const cats = [...(loc.services || [])].sort((a, b) => (/^featured$/i.test(a.name) ? 1 : 0) - (/^featured$/i.test(b.name) ? 1 : 0))
  for (const cat of cats) for (const it of cat.items || []) {
    if (!it?.name) continue
    const v = (it.variants || [])[0] || {}
    services.push({ name: it.name.trim(), price: toPrice(it.formattedRetailPrice || it.retailPrice?.value), duration_mins: toMinutes(it.caption || v.caption), description: it.description || null, category: /^featured$/i.test(cat.name) ? null : cat.name, by_request: false })
  }
  let hours = hoursFromLd(ld)
  if (!hours && loc.workingTime?.days) { hours = emptyWeek(); for (const d of loc.workingTime.days) { const i = DAY_FULL[String(d.dayName).toLowerCase()]; const span = (d.values || [])[0]?.value; if (i == null || d.isClosed || !span) continue; const [a, bb] = span.split(/\s*[-–]\s*/); const from = to24(a), to = to24(bb); if (from && to) hours[i] = { day: DAYS[i], open: true, from, to } } if (!hours.some(h => h.open)) hours = null }
  const photos = [...((loc.portfolioGallery?.edges || []).map(e => e.node?.image?.url)), ...((loc.galleryMobileImages || []).map(x => x.url)), ...((loc.venueSnippetImages || []).map(x => x.url))].filter(Boolean)
  const notes = []; if (ld?.aggregateRating?.reviewCount) notes.push(`${ld.aggregateRating.reviewCount} reviews on Fresha (${ld.aggregateRating.ratingValue} stars).`)
  return { platform: 'fresha', name: loc.name || ld?.name || null, phone: loc.contactNumber || ld?.telephone || null, address: addressFromLd(ld), about: loc.description || null, hours, services, social: socialFromLd(ld), cover: loc.coverImage?.url || null, logo: loc.venueLogo?.url || null, photos, notes: notes.join(' ') || undefined }
}

// ── StyleSeat: public JSON APIs keyed by the vanity slug ──────────────────────
async function parseStyleSeat(html, url) {
  const slug = (url.match(/styleseat\.com\/(?:m\/)?v\/([a-z0-9_-]+)/i) || [])[1]; if (!slug) return null
  const get = async u => { const r = await fetchText(u, { accept: 'application/json', timeoutMs: 12000 }); if (!r.ok) throw new Error(`${u} → ${r.status}`); return JSON.parse(r.body) }
  const prof = await get(`https://www.styleseat.com/api/v1/consumer/${encodeURIComponent(slug)}/providerprofileclientview`)
  if (!prof?.id) return null
  const [groups, gallery] = await Promise.all([
    get(`https://www.styleseat.com/api/v2/providers/${prof.id}/servicegroups`).catch(() => ({ results: [] })),
    get(`https://www.styleseat.com/api/v3/providers/${prof.id}/gallery_media/`).catch(() => ({ results: [] }))
  ])
  const services = []
  for (const g of groups.results || []) for (const sv of g.services || []) {
    if (!sv?.name || sv.is_private) continue
    services.push({ name: sv.name.trim(), price: toPrice(sv.cost) + (sv.cost_and_up && sv.cost ? '+' : ''), duration_mins: toMinutes(sv.duration_minutes), description: sv.blurb || null, category: g.name || null, deposit: sv.require_deposit && sv.deposit_amount ? toPrice(sv.deposit_amount) : null, by_request: !sv.is_online_bookable })
  }
  let hours = null
  if (Array.isArray(prof.business_hours) && prof.business_hours.length) { hours = emptyWeek(); for (const h of prof.business_hours) { const i = DAY_FULL[String(h.day).toLowerCase()]; const from = to24(h.start_time), to = to24(h.end_time); if (i != null && !h.closed && from && to) hours[i] = { day: DAYS[i], open: true, from, to } } if (!hours.some(h => h.open)) hours = null }
  const address = [prof.address1, prof.address2, [prof.city, prof.state, prof.zipcode].filter(Boolean).join(' ')].filter(Boolean).join('\n') || null
  const photos = (gallery.results || []).filter(x => x.media_type === 'image' && x.url).map(x => x.url)
  const social = {}; if (prof.instagram) social.instagram = handleOf(prof.instagram)
  const policies = [prof.cancellation_policy_text, prof.deposit_policy_text].filter(Boolean).join('\n') || null
  const notes = []; if (prof.ratings_count) notes.push(`${prof.ratings_count} reviews on StyleSeat (${prof.rating_stars} stars).`)
  return { platform: 'styleseat', name: prof.business_name || prof.name || null, phone: prof.public_phone_number || null, address, city: prof.city || null, about: prof.blurb || null, policies, hours, services, social, logo: prof.profile_photo || null, cover: photos[0] || null, photos, notes: notes.join(' ') || undefined }
}

// ── Vagaro: server-rendered /services page; model reads it (no durations/hours public)
async function parseVagaro(html, url) {
  const base = (url.match(/^https?:\/\/(?:www\.)?vagaro\.com\/[a-z0-9_-]+/i) || [])[0]; if (!base) return null
  const extra = []
  for (const path of ['/services', '/about']) { try { const r = await fetchText(base + path); if (r.ok && /html/i.test(r.contentType)) extra.push(r.body) } catch { /* optional */ } }
  return { platform: 'vagaro', _extraHtml: extra, notes: 'Vagaro does not publish durations or hours; check those with the owner.' }
}

// ── Square: booking widget is a JavaScript app with no readable content ───────
async function parseSquare(html, url) {
  return { platform: 'square', services: [], notes: 'Square booking pages only load inside the browser, so there is nothing to read here. If they have a Square Online site (name.square.site) import that, or ask for a photo of their menu.' }
}

const ADAPTERS = [
  { test: (url, html) => /\.glossgenius\.com/i.test(url) || /"serverContext":\{"browser"/.test(html), run: parseGlossGenius },
  { test: (url) => /booksy\.com\//i.test(url), run: parseBooksy },
  { test: (url) => /fresha\.com\/a\//i.test(url), run: parseFresha },
  { test: (url) => /styleseat\.com\/(m\/)?v\//i.test(url), run: parseStyleSeat },
  { test: (url) => /vagaro\.com\//i.test(url), run: parseVagaro },
  { test: (url) => /(book\.)?squareup\.com\/appointments|square\.site\/book/i.test(url), run: parseSquare },
]

// Own websites: if the landing page has few services, look at the usual
// subpages before giving up.
async function discoverSubpages(html, base) {
  const found = new Set()
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#?]+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi)) {
    const href = m[1], label = decode(m[2].replace(/<[^>]+>/g, ' '))
    if (/services?|menu|pricing|prices?|price-list|treatments?|book/i.test(href + ' ' + label)) { const u = abs(base, href); if (u && new URL(u).origin === new URL(base).origin && u.replace(/\/$/, '') !== base.replace(/\/$/, '')) found.add(u) }
    if (found.size >= 3) break
  }
  const pages = []
  for (const u of found) { try { const r = await fetchText(u); if (r.ok && /html/i.test(r.contentType)) pages.push(r.body) } catch { /* skip */ } }
  return pages
}

// Extraction schema. Everything optional; the model must not invent.
const TOOL = {
  name: 'save_import',
  description: 'Record the business data found on the page. Only include values actually present on the page. Never invent prices, durations, hours or addresses.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Business name as written' },
      business_type: { type: 'string', enum: ['salon', 'barbershop', 'spa', 'nails', 'medical', 'gym', 'other'], description: 'Closest type. Med spa / aesthetics / injectables = medical. Lashes, brows, waxing, skin = spa.' },
      tagline: { type: 'string', description: 'One line, under 140 chars, in the business voice. From the page if it has one; otherwise a plain factual line like "Color and blowouts in Venice". No marketing fluff.' },
      about: { type: 'string', description: 'The about/bio text from the page, lightly cleaned, up to ~800 chars. Omit if the page has none.' },
      address: { type: 'string', description: 'Street address, one or two lines, as written' },
      city: { type: 'string' },
      phone: { type: 'string', description: 'Business phone as written' },
      hours: { type: 'array', description: 'Seven entries Sun..Sat. Only if hours are on the page.', items: { type: 'object', properties: { day: { type: 'string', enum: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }, open: { type: 'boolean' }, from: { type: 'string', description: 'HH:MM 24h' }, to: { type: 'string', description: 'HH:MM 24h' } }, required: ['day', 'open'] } },
      services: { type: 'array', description: 'Every bookable service on the page, in page order. Packages and add-ons included. Skip retail products and gift cards.', items: { type: 'object', properties: {
        name: { type: 'string' },
        price: { type: 'string', description: 'Number only, e.g. "65", "180", or "300+" for starting-at. Empty string if not shown. No $ sign.' },
        duration_mins: { type: 'integer', description: 'Minutes. Omit if not shown.' },
        description: { type: 'string', description: 'Short description from the page, if any' },
        category: { type: 'string', description: 'Section heading the service sits under on the page, if any (e.g. Color, Blowouts, Extensions)' },
        deposit: { type: 'string', description: 'Deposit amount if stated, number only' },
        by_request: { type: 'boolean', description: 'true if the page says consultation required / price on request' }
      }, required: ['name'] } },
      policies: { type: 'string', description: 'Cancellation, deposit, late, no-show policy text from the page, cleaned, up to ~800 chars' },
      social: { type: 'object', properties: { instagram: { type: 'string', description: 'handle without @ or full URL' }, tiktok: { type: 'string' }, facebook: { type: 'string' }, yelp: { type: 'string' }, google: { type: 'string' }, website: { type: 'string' } } },
      logo: { type: 'string', description: 'URL from the candidate image list that is the logo, if any' },
      cover: { type: 'string', description: 'URL from the candidate image list best suited as a full-width cover photo (a salon interior, hero shot, or strong work photo). Not the logo.' },
      photos: { type: 'array', items: { type: 'string' }, description: 'Up to 12 URLs from the candidate list showing their work or space, best first. Exclude logos, icons, stock badges, payment logos.' },
      platform: { type: 'string', description: 'Booking platform the page runs on, if recognisable: glossgenius, booksy, square, vagaro, styleseat, fresha, acuity, mangomint, boulevard, squarespace, wix, other' },
      notes: { type: 'string', description: 'Anything a human should check: ambiguous prices, hours in two places, services that looked like products, etc.' }
    }
  }
}

async function extract(url, parts) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const candidates = parts.images.slice(0, 60).map((i, n) => `${n + 1}. ${i.url}${i.hint ? `  (${i.hint})` : ''}`).join('\n')
  const blobs = [...parts.jsonld.map(j => JSON.stringify(j)), ...parts.blobs].join('\n\n').slice(0, MAX_BLOBS)
  const meta = Object.entries(parts.meta).filter(([k]) => /title|description|og:|twitter:|geo|place/i.test(k)).map(([k, v]) => `${k}: ${v}`).join('\n')
  const content = `Source URL: ${url}\n\nMETA TAGS:\n${meta || '(none)'}\n\nSTRUCTURED DATA (JSON-LD / framework state, may be truncated):\n${blobs || '(none)'}\n\nCANDIDATE IMAGES:\n${candidates || '(none)'}\n\nVISIBLE PAGE TEXT:\n${(parts.text || '(empty)').slice(0, MAX_TEXT * 2)}`
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 8000,
    system: 'You extract business listing data from a salon, spa, barbershop or similar service business web page into the save_import tool. The STRUCTURED DATA block (JSON-LD and framework state) is part of the page and is usually the most complete source: services, prices, durations and hours found there must be extracted exactly as if they were visible text. Be exhaustive on services. Be literal: copy names and prices as shown. Convert durations to minutes ("1 hr 30 min" = 90). Prices like "$150+" or "starting at $150" become "150+". If a value is not on the page, leave it out. Hours: map every day; closed days get open=false. If the page is a booking platform and the text is thin or empty, still return what you can and say so in notes.',
    tools: [TOOL], tool_choice: { type: 'tool', name: 'save_import' },
    messages: [{ role: 'user', content }]
  })
  const call = resp.content.find(c => c.type === 'tool_use')
  return call ? call.input : {}
}

function clean(data, baseUrl) {
  const d = { ...data }
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  if (Array.isArray(d.hours) && d.hours.length) {
    const by = {}; d.hours.forEach(h => { if (h && days.includes(h.day)) by[h.day] = h })
    d.hours = days.map(day => { const h = by[day] || { open: false }; const open = !!h.open && hhmm.test(h.from || '') && hhmm.test(h.to || ''); return { open, from: open ? h.from : '09:00', to: open ? h.to : '17:00' } })
    if (!d.hours.some(h => h.open)) delete d.hours
  } else delete d.hours
  d.services = (Array.isArray(d.services) ? d.services : []).map(s => ({
    name: String(s.name || '').trim().slice(0, 80),
    price: String(s.price || '').replace(/[^\d.+]/g, '').replace(/\.0+$/, '').slice(0, 12),
    duration_mins: Number.isFinite(+s.duration_mins) && +s.duration_mins > 0 ? Math.min(Math.round(+s.duration_mins), 24 * 60) : null,
    description: String(s.description || '').trim().slice(0, 300) || null,
    category: String(s.category || '').trim().slice(0, 60) || null,
    deposit: String(s.deposit || '').replace(/[^\d.]/g, '').slice(0, 8) || null,
    by_request: !!s.by_request
  })).filter(s => s.name)
  // de-dupe by name
  const seen = new Set(); d.services = d.services.filter(s => { const k = s.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
  for (const k of ['logo', 'cover']) if (d[k]) { d[k] = abs(baseUrl, d[k]); if (!/^https?:/.test(d[k] || '')) delete d[k] }
  d.photos = (Array.isArray(d.photos) ? d.photos : []).map(u => abs(baseUrl, u)).filter(u => u && /^https?:/.test(u) && u !== d.logo).slice(0, 12)
  if (d.social && typeof d.social === 'object') { const soc = {}; for (const k of ['instagram', 'tiktok', 'facebook', 'yelp', 'google', 'website']) if (d.social[k]) soc[k] = String(d.social[k]).trim().replace(/^@/, '').slice(0, 200); d.social = soc } else d.social = {}
  for (const k of ['tagline', 'about', 'address', 'policies', 'name', 'city', 'phone', 'platform', 'notes', 'accent']) if (d[k] != null) d[k] = String(d[k]).trim().slice(0, k === 'about' || k === 'policies' ? 2000 : 300) || undefined
  return d
}

async function importFromUrl(rawUrl) {
  const url = normalizeUrl(rawUrl)
  if (!url) return { error: 'That does not look like a web address.' }
  const warnings = []
  let page
  try { page = await fetchText(url) } catch (err) { return { error: `Could not load ${url}: ${err.name === 'AbortError' ? 'timed out' : err.message}` } }
  if (!page.ok) return { error: `${url} answered ${page.status}.` }
  if (!/html/i.test(page.contentType)) return { error: `${url} is not a web page (${page.contentType.split(';')[0]}).` }
  const parts = dissect(page.body, page.finalUrl || url)
  if (parts.text.length < 200 && !parts.blobs.length && !parts.jsonld.length) warnings.push('The page has almost no readable content; it probably draws everything with JavaScript. Try the services or menu page of their site, or ask for a photo of the menu.')
  // Platform adapter first (exact), then the model for anything it left blank.
  let adapted = null
  for (const a of ADAPTERS) { if (a.test(page.finalUrl || url, page.body)) { try { adapted = await a.run(page.body, page.finalUrl || url) } catch (err) { console.error('[Import] adapter failed:', err.message) } if (adapted) break } }
  let data
  try {
    // Extra pages (platform /services pages, or discovered subpages on an own site) feed the model.
    let extraParts = []
    if (adapted?._extraHtml?.length) extraParts = adapted._extraHtml.map(h => dissect(h, page.finalUrl || url))
    else if (!adapted && !/booksy|fresha|styleseat|glossgenius|squareup/i.test(url)) { const sub = await discoverSubpages(page.body, page.finalUrl || url); extraParts = sub.map(h => dissect(h, page.finalUrl || url)) }
    if (extraParts.length) { parts.text = [parts.text, ...extraParts.map(p => p.text)].join('\n\n----- next page -----\n\n').slice(0, MAX_TEXT * 2); parts.blobs.push(...extraParts.flatMap(p => p.blobs)); parts.jsonld.push(...extraParts.flatMap(p => p.jsonld)); extraParts.forEach(p => parts.images.push(...p.images)) }
    if (adapted) delete adapted._extraHtml
    const modelOut = adapted && adapted.services?.length && adapted.hours ? {} : await extract(page.finalUrl || url, parts)
    const merged = { ...modelOut, ...(adapted || {}) }
    for (const k of ['about', 'tagline', 'policies', 'business_type', 'address', 'city']) if (!merged[k] && modelOut[k]) merged[k] = modelOut[k]
    if (adapted && !(adapted.services || []).length && modelOut.services?.length) merged.services = modelOut.services
    if (adapted && !adapted.hours && modelOut.hours) merged.hours = modelOut.hours
    if (adapted && !adapted.photos?.length && modelOut.photos?.length) merged.photos = modelOut.photos
    data = clean(merged, page.finalUrl || url)
  } catch (err) { return { error: `Could not read the page: ${err.message}` } }
  if (!data.services.length) warnings.push('No services found on this page. If their menu is on another page, import that URL too.')
  if (!data.hours) warnings.push('No hours found on this page.')
  if (data.notes) warnings.push(data.notes)
  console.log(`[Import] ${url}: ${data.services.length} services, hours=${!!data.hours}, photos=${data.photos.length}, platform=${data.platform || '?'}`)
  return { source: page.finalUrl || url, bytes: page.bytes, ...data, warnings }
}

// ── Apply ─────────────────────────────────────────────────────────────────────
async function rehost(businessId, url, kind) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000)
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, signal: ctl.signal }); clearTimeout(t)
    const ct = (r.headers.get('content-type') || '').split(';')[0]
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(ct)) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length || buf.length > 8 * 1024 * 1024) return null
    const path = `${businessId}/${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ct.split('/')[1].replace('jpeg', 'jpg')}`
    const { error } = await supabase.storage.from('profile-photos').upload(path, buf, { contentType: ct, cacheControl: '31536000', upsert: false })
    if (error) return null
    return supabase.storage.from('profile-photos').getPublicUrl(path).data.publicUrl
  } catch { return null }
}

// options: { services, hours, profile, photos } booleans (default all true);
// serviceNames: optional allow-list of service names to write.
async function applyImport(businessId, data, options = {}) {
  const opt = { services: true, hours: true, profile: true, photos: true, ...options }
  const result = { services: { added: [], updated: [] }, hours: false, profile: [], photos: 0, logo: false, cover: false }
  const { data: biz } = await supabase.from('businesses').select('id, business_name, hours, profile_description, profile_about, profile_policies, address, logo_url, profile_cover_url, profile_social, profile_photos, business_type, timezone, profile_slug').eq('id', businessId).maybeSingle()
  if (!biz) throw new Error('Business not found')

  if (opt.services && Array.isArray(data.services) && data.services.length) {
    const allow = Array.isArray(options.serviceNames) ? new Set(options.serviceNames.map(n => n.toLowerCase())) : null
    const { data: existing } = await supabase.from('services').select('id, name, sort_order').eq('business_id', businessId).neq('active', false)
    const byName = {}; (existing || []).forEach(x => { byName[x.name.trim().toLowerCase()] = x })
    let order = (existing || []).reduce((m, x) => Math.max(m, x.sort_order || 0), -1) + 1
    for (const s of data.services.slice(0, 80)) {
      if (allow && !allow.has(s.name.toLowerCase())) continue
      const priceNum = parseFloat(String(s.price || '').replace('+', ''))
      const row = { name: s.name, duration_mins: s.duration_mins || 60, description: s.description, category: s.category, booking_mode: s.by_request ? 'approval' : 'instant' }
      if (s.price) { row.price = s.price; if (Number.isFinite(priceNum)) row.price_cents = Math.round(priceNum * 100) }
      if (s.deposit) row.deposit_amount = s.deposit
      const hit = byName[s.name.toLowerCase()]
      if (hit) { const { error } = await supabase.from('services').update(row).eq('id', hit.id); if (!error) result.services.updated.push(s.name) }
      else { const { error } = await supabase.from('services').insert({ business_id: businessId, ...row, active: true, sort_order: order++ }); if (!error) result.services.added.push(s.name) }
    }
  }

  const upd = {}
  if (opt.hours && data.hours) { upd.hours = data.hours; result.hours = true }
  if (opt.profile) {
    if (data.tagline && !biz.profile_description) { upd.profile_description = data.tagline; result.profile.push('tagline') }
    if (data.about && !biz.profile_about) { upd.profile_about = data.about; result.profile.push('about') }
    if (data.policies && !biz.profile_policies) { upd.profile_policies = data.policies; result.profile.push('policies') }
    if (data.address && !biz.address) { upd.address = data.address; result.profile.push('address') }
    if (data.social && Object.keys(data.social).length) { upd.profile_social = { ...(biz.profile_social || {}), ...data.social }; result.profile.push('social') }
    if (data.business_type && (!biz.business_type || biz.business_type === 'other')) { upd.business_type = data.business_type; result.profile.push('type') }
  }
  if (opt.photos) {
    if (data.logo && !biz.logo_url) { const u = await rehost(businessId, data.logo, 'logo'); if (u) { upd.logo_url = u; result.logo = true } }
    if (data.cover && !biz.profile_cover_url) { const u = await rehost(businessId, data.cover, 'cover'); if (u) { upd.profile_cover_url = u; result.cover = true } }
    if (Array.isArray(data.photos) && data.photos.length && !(biz.profile_photos || []).length) {
      const hosted = []
      for (const p of data.photos.slice(0, 12)) { const u = await rehost(businessId, p, 'work'); if (u) hosted.push(u) }
      if (hosted.length) { upd.profile_photos = hosted; result.photos = hosted.length }
    }
  }
  if (Object.keys(upd).length) {
    const { error } = await supabase.from('businesses').update(upd).eq('id', businessId)
    if (error) throw error
  }
  try { await require('../bot/trialOnboarding').ensureProfileSlug(biz) } catch { /* non-fatal */ }
  console.log(`[Import] applied to ${biz.business_name}: +${result.services.added.length} ~${result.services.updated.length} services, hours=${result.hours}, profile=${result.profile.join('/') || '-'}, photos=${result.photos}`)
  return result
}

module.exports = { importFromUrl, applyImport, normalizeUrl }
