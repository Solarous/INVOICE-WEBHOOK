// paypal-discord bridge
// Receives PayPal webhook events and forwards a clean message to a Discord webhook.
// Deploy to Railway (or any Node host). REQUIRES Node 18+ (for global fetch).
//
// Environment variables (set in Railway → Variables):
//   DISCORD_WEBHOOK_URL   your Discord webhook URL  (required)
//   PAYPAL_CLIENT_ID      from developer.paypal.com (optional — enables verification)
//   PAYPAL_CLIENT_SECRET  from developer.paypal.com (optional)
//   PAYPAL_WEBHOOK_ID     the webhook id PayPal shows after you create the webhook (optional)
//   PAYPAL_ENV            "live" or "sandbox"  (default: live)
//
// QUICK TEST: once deployed, open  https://YOUR-APP.up.railway.app/test  in a browser.
//   If a message appears in Discord, the bridge→Discord link works.

const express = require('express')
const app = express()

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL
const PAYPAL_ENV      = (process.env.PAYPAL_ENV || 'live').toLowerCase()
const PAYPAL_BASE     = PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com'

// Keep the raw body so PayPal's signature can be verified.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') }
}))

// ── Helpers ────────────────────────────────────────────────────────────────
function money(obj = {}) {
  const v = obj.value ?? obj.total ?? ''
  const c = obj.currency_code ?? obj.currency ?? ''
  return v ? `${v} ${c}`.trim() : '—'
}

// Fetches the live PayPal account balance (primary currency).
// Returns a formatted string like "1,234.56 USD" or null if unavailable.
async function getPayPalBalance() {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET
  if (!id || !secret) { console.log('ℹ️  Balance fetch skipped (PAYPAL_* not set)'); return null }
  try {
    const tokRes = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    const { access_token } = await tokRes.json()
    const balRes = await fetch(`${PAYPAL_BASE}/v1/reporting/balances`, {
      headers: { Authorization: `Bearer ${access_token}` },
    })
    if (!balRes.ok) {
      console.warn('⚠️  Balance API returned HTTP', balRes.status)
      return null
    }
    const data = await balRes.json()
    // balances is an array; grab the first available balance
    const primary = data.balances?.[0]
    if (!primary) return null
    const val = primary.available_balance ?? primary.total_balance
    if (!val) return null
    const num = parseFloat(val.value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return `${num} ${val.currency_code || ''}`
  } catch (e) {
    console.error('❌ Balance fetch error:', e.message)
    return null
  }
}

// Posts an embed to Discord and LOGS the outcome so you can see problems in Railway logs.
async function postToDiscord(embed) {
  if (!DISCORD_WEBHOOK) { console.error('❌ DISCORD_WEBHOOK_URL is not set'); return false }
  if (typeof fetch !== 'function') { console.error('❌ global fetch missing — use Node 18+'); return false }
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'PayPal', avatar_url: PAYPAL_LOGO, embeds: [embed] }),
    })
    if (res.ok || res.status === 204) { console.log('✅ Posted to Discord (HTTP', res.status + ')'); return true }
    const body = await res.text().catch(() => '')
    console.error('❌ Discord rejected the post — HTTP', res.status, body.slice(0, 200))
    return false
  } catch (e) {
    console.error('❌ Could not reach Discord:', e.message)
    return false
  }
}

// Verify the event really came from PayPal. Returns true/false.
// NOTE: PayPal's "Webhooks Simulator" mock events CANNOT pass this check — to test
// with the simulator, leave the PAYPAL_* vars unset so verification is skipped.
async function verifyPayPalSignature(req, event) {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET
  const webhookId = process.env.PAYPAL_WEBHOOK_ID
  if (!id || !secret || !webhookId) { console.log('ℹ️  Verification skipped (PAYPAL_* not set)'); return true }
  try {
    const tokRes = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    const { access_token } = await tokRes.json()
    const verifyRes = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo:         req.headers['paypal-auth-algo'],
        cert_url:          req.headers['paypal-cert-url'],
        transmission_id:   req.headers['paypal-transmission-id'],
        transmission_sig:  req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id:        webhookId,
        webhook_event:     event,
      }),
    })
    const out = await verifyRes.json()
    if (out.verification_status !== 'SUCCESS') console.warn('⚠️  Verification status:', out.verification_status)
    return out.verification_status === 'SUCCESS'
  } catch (e) {
    console.error('❌ verify error:', e.message)
    return false
  }
}

// PayPal brand assets/colors used to make the Discord cards look official.
const PAYPAL_LOGO = 'https://www.paypalobjects.com/webstatic/icon/pp258.png'
const PAYPAL_BLUE = 0x0070ba

// Per-event card styling (emoji + title + color)
const INVOICE_STYLES = {
  'INVOICING.INVOICE.CREATED':                 { emoji: '🧾', title: 'Invoice Created',   color: PAYPAL_BLUE },
  'INVOICING.INVOICE.SENT':                    { emoji: '📨', title: 'Invoice Sent',      color: PAYPAL_BLUE },
  'INVOICING.INVOICE.SCHEDULED':               { emoji: '📅', title: 'Invoice Scheduled', color: PAYPAL_BLUE },
  'INVOICING.INVOICE.UPDATED':                 { emoji: '✏️', title: 'Invoice Updated',   color: PAYPAL_BLUE },
  'INVOICING.INVOICE.AUTOMATIC-REMINDER-SENT': { emoji: '🔔', title: 'Reminder Sent',     color: PAYPAL_BLUE },
  'INVOICING.INVOICE.PAID':                    { emoji: '✅', title: 'Invoice Paid',       color: 0x00a650 },
  'INVOICING.INVOICE.UNPAID':                  { emoji: '⚠️', title: 'Invoice Unpaid',    color: 0xf0ad4e },
  'INVOICING.INVOICE.CANCELLED':               { emoji: '❌', title: 'Invoice Cancelled', color: 0xd9534f },
  'INVOICING.INVOICE.REFUNDED':                { emoji: '↩️', title: 'Invoice Refunded',  color: 0xff9900 },
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/(^|\s|_)\w/g, c => c.toUpperCase()).replace(/_/g, ' ')
}

function invoiceFields(inv) {
  const fields = []
  const num = inv.detail?.invoice_number || inv.id
  if (num) fields.push({ name: 'Invoice #', value: String(num), inline: true })
  const amt = money(inv.amount || inv.due_amount)
  if (amt && amt !== '—') fields.push({ name: 'Amount', value: amt, inline: true })
  if (inv.status) fields.push({ name: 'Status', value: titleCase(inv.status), inline: true })
  const payer = inv.primary_recipients?.[0]?.billing_info?.email_address
  if (payer) fields.push({ name: 'Billed to', value: payer, inline: false })
  return fields
}

function buildEmbed(event, balance = null) {
  const type = event.event_type || 'UNKNOWN'
  const r = event.resource || {}
  const balanceField = balance
    ? [{ name: '💰 Account Balance', value: balance, inline: false }]
    : []

  // ── Invoice events (all of them) ──
  if (type.startsWith('INVOICING.')) {
    const inv = r.invoice || r
    const style = INVOICE_STYLES[type] || { emoji: '🧾', title: titleCase(type.replace('INVOICING.INVOICE.', '')), color: PAYPAL_BLUE }
    const viewUrl = inv.detail?.metadata?.recipient_view_url
      || inv.detail?.metadata?.invoicer_view_url
      || (inv.links || []).find(l => /payer|recipient|view/i.test(l.rel || ''))?.href

    // Pull description + transaction ID for paid invoices
    const desc = inv.detail?.memo || inv.detail?.note || inv.items?.[0]?.name || null
    const txnId = inv.payments?.transactions?.[0]?.payment_id
      || inv.payments?.transactions?.[0]?.transaction_id
      || null
    const extraFields = []
    if (desc) extraFields.push({ name: 'Description', value: String(desc), inline: false })
    if (txnId) extraFields.push({ name: 'Transaction ID', value: String(txnId), inline: true })
    // Only show balance on money-moving invoice events
    const isMoneyEvent = ['INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.REFUNDED'].includes(type)

    return {
      author: { name: 'PayPal Invoicing', icon_url: PAYPAL_LOGO },
      title: `${style.emoji} ${style.title}`,
      url: viewUrl || undefined,
      color: style.color,
      thumbnail: { url: PAYPAL_LOGO },
      fields: [
        ...invoiceFields(inv),
        ...extraFields,
        ...(isMoneyEvent ? balanceField : []),
      ],
      footer: { text: 'PayPal', icon_url: PAYPAL_LOGO },
      timestamp: new Date().toISOString(),
    }
  }

  // ── Direct payments (capture / sale completed) ──
  if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.SALE.COMPLETED') {
    // Description lives in custom_id, soft_descriptor, or the note_to_payer on the order
    const desc = r.custom_id || r.soft_descriptor || r.description || r.note_to_payer || null
    const fields = [
      { name: 'Amount',         value: money(r.amount), inline: true },
      { name: 'Transaction ID', value: String(r.id || '—'), inline: true },
      { name: 'From',           value: r.payer?.email_address || r.payer_email || '—', inline: false },
    ]
    if (desc) fields.push({ name: 'Description', value: String(desc), inline: false })
    fields.push(...balanceField)
    return {
      author: { name: 'PayPal Payments', icon_url: PAYPAL_LOGO },
      title: '💸 Payment Received',
      color: 0x00a650,
      thumbnail: { url: PAYPAL_LOGO },
      fields,
      footer: { text: 'PayPal', icon_url: PAYPAL_LOGO },
      timestamp: new Date().toISOString(),
    }
  }

  // ── Fallback for anything else subscribed ──
  return {
    author: { name: 'PayPal', icon_url: PAYPAL_LOGO },
    title: titleCase(type.replace(/\./g, ' ')),
    description: 'A new PayPal event was received.',
    color: PAYPAL_BLUE,
    thumbnail: { url: PAYPAL_LOGO },
    footer: { text: 'PayPal', icon_url: PAYPAL_LOGO },
    timestamp: new Date().toISOString(),
  }
}

// ── Webhook endpoint ─────────────────────────────────────────────────────────
app.post('/paypal-webhook', async (req, res) => {
  const event = req.body || {}
  res.sendStatus(200) // acknowledge fast so PayPal doesn't retry
  console.log('📨 Received PayPal event:', event.event_type || '(no type)')

  const ok = await verifyPayPalSignature(req, event)
  if (!ok) { console.warn('🚫 Rejected unverified event — not posting to Discord'); return }

  // Fetch live balance for money-moving events so the Discord card always shows the up-to-date balance.
  const BALANCE_EVENTS = new Set([
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.SALE.COMPLETED',
    'INVOICING.INVOICE.PAID',
    'INVOICING.INVOICE.REFUNDED',
  ])
  const balance = BALANCE_EVENTS.has(event.event_type) ? await getPayPalBalance() : null

  try { await postToDiscord(buildEmbed(event, balance)) } catch (e) { console.error('post failed', e) }
})

// ── Browser test: hit /test to fire a sample message straight to Discord ──────
app.get('/test', async (_req, res) => {
  const ok = await postToDiscord({
    title: '🔔 Bridge test',
    description: 'If you can see this in Discord, the bridge → Discord connection works. ✅',
    color: 0x5865f2,
    timestamp: new Date().toISOString(),
  })
  res.send(ok
    ? 'Sent! Check your Discord channel. ✅'
    : 'Failed to post to Discord. Check the Railway logs and confirm DISCORD_WEBHOOK_URL is correct. ❌')
})

// ── One-time setup: register a PayPal "webhook lookup" ───────────────────────
// Links your PayPal ACCOUNT to this REST app, so invoices/payments you make by
// hand on paypal.com get delivered to your app's webhook. Visit this once.
async function getPayPalAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set')
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Could not get token: ' + JSON.stringify(data).slice(0, 200))
  return data.access_token
}

app.get('/setup-lookup', async (_req, res) => {
  try {
    const token = await getPayPalAccessToken()
    // Create the lookup (empty body = tie to the calling app's own account)
    const r = await fetch(`${PAYPAL_BASE}/v1/notifications/webhooks-lookup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await r.text()
    console.log('🔗 webhook-lookup result:', r.status, body.slice(0, 300))
    if (r.ok || r.status === 201) {
      res.send('✅ Webhook lookup created — invoices you make on paypal.com will now be delivered to this app. You can now send a normal invoice and watch it appear in Discord.')
    } else {
      res.status(500).send('Lookup request returned HTTP ' + r.status + ':\n\n' + body)
    }
  } catch (e) {
    res.status(500).send('Setup failed: ' + e.message)
  }
})

app.get('/list-lookups', async (_req, res) => {
  try {
    const token = await getPayPalAccessToken()
    const r = await fetch(`${PAYPAL_BASE}/v1/notifications/webhooks-lookup`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    res.type('text/plain').send('HTTP ' + r.status + '\n\n' + (await r.text()))
  } catch (e) {
    res.status(500).send('Failed: ' + e.message)
  }
})

// Health check
app.get('/', (_req, res) => res.send('PayPal → Discord bridge is running ✅  (try /test)'))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log('Listening on', PORT, '| PayPal env:', PAYPAL_ENV)
  if (!DISCORD_WEBHOOK) console.warn('⚠️  DISCORD_WEBHOOK_URL is not set — Discord posts will fail until you add it.')
  if (typeof fetch !== 'function') console.warn('⚠️  global fetch missing — set Railway to Node 18+ (engines field is already in package.json).')
})
