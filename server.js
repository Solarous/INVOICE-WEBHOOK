// paypal-discord bridge
// Receives PayPal webhook events and forwards a clean message to a Discord webhook.
// Deploy to Railway (or any Node host). Node 18+ (has global fetch).
//
// Required environment variables (set these in Railway → Variables):
//   DISCORD_WEBHOOK_URL   your Discord webhook URL (keep it secret!)
//   PAYPAL_CLIENT_ID      from developer.paypal.com (for signature verification)
//   PAYPAL_CLIENT_SECRET  from developer.paypal.com
//   PAYPAL_WEBHOOK_ID     the webhook id PayPal shows after you create the webhook
//   PAYPAL_ENV            "live" or "sandbox"  (default: live)

const express = require('express')
const app = express()

const DISCORD_WEBHOOK   = process.env.DISCORD_WEBHOOK_URL
const PAYPAL_ENV        = (process.env.PAYPAL_ENV || 'live').toLowerCase()
const PAYPAL_BASE       = PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com'

// We need the raw body to verify PayPal's signature, so capture it here.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') }
}))

// ── Helpers ────────────────────────────────────────────────────────────────
function money(obj = {}) {
  const v = obj.value ?? obj.total ?? ''
  const c = obj.currency_code ?? obj.currency ?? ''
  return v ? `${v} ${c}`.trim() : '—'
}

async function postToDiscord(embed) {
  if (!DISCORD_WEBHOOK) { console.error('DISCORD_WEBHOOK_URL not set'); return }
  await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'PayPal', embeds: [embed] }),
  })
}

// Verify the event really came from PayPal (recommended). Returns true/false.
async function verifyPayPalSignature(req, event) {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET
  const webhookId = process.env.PAYPAL_WEBHOOK_ID
  if (!id || !secret || !webhookId) return true // skip if not configured (less secure)
  try {
    // Get an access token
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
    return out.verification_status === 'SUCCESS'
  } catch (e) {
    console.error('verify error', e)
    return false
  }
}

// ── Webhook endpoint ─────────────────────────────────────────────────────────
app.post('/paypal-webhook', async (req, res) => {
  const event = req.body || {}
  res.sendStatus(200) // acknowledge immediately so PayPal doesn't retry

  const ok = await verifyPayPalSignature(req, event)
  if (!ok) { console.warn('Rejected unverified PayPal event'); return }

  const type = event.event_type || 'UNKNOWN'
  const r = event.resource || {}
  let embed

  if (type === 'INVOICING.INVOICE.PAID') {
    const inv = r.invoice || r
    const link = (inv.links || []).find(l => /payer|view/i.test(l.rel || ''))?.href
    embed = {
      title: '✅ Invoice Paid',
      color: 0x2ecc71,
      fields: [
        { name: 'Invoice #', value: String(inv.detail?.invoice_number || inv.id || '—'), inline: true },
        { name: 'Amount',    value: money(inv.amount), inline: true },
        { name: 'Payer',     value: inv.primary_recipients?.[0]?.billing_info?.email_address || '—' },
      ],
      url: link || undefined,
      timestamp: new Date().toISOString(),
    }
  } else if (type === 'INVOICING.INVOICE.CREATED' || type === 'INVOICING.INVOICE.SENT') {
    const inv = r.invoice || r
    const link = (inv.links || []).find(l => /payer|view/i.test(l.rel || ''))?.href
    embed = {
      title: type.endsWith('SENT') ? '📨 Invoice Sent' : '🧾 Invoice Created',
      color: 0xf1c40f,
      fields: [
        { name: 'Invoice #', value: String(inv.detail?.invoice_number || inv.id || '—'), inline: true },
        { name: 'Amount',    value: money(inv.amount), inline: true },
      ],
      url: link || undefined,
      timestamp: new Date().toISOString(),
    }
  } else if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.SALE.COMPLETED') {
    embed = {
      title: '💸 Payment Received',
      color: 0x3498db,
      fields: [
        { name: 'Amount',      value: money(r.amount), inline: true },
        { name: 'Transaction', value: String(r.id || '—'), inline: true },
        { name: 'From',        value: r.payer?.email_address || r.payer_email || '—' },
      ],
      timestamp: new Date().toISOString(),
    }
  } else {
    // Anything you subscribed to but didn't map above
    embed = {
      title: `PayPal event: ${type}`,
      color: 0x95a5a6,
      description: 'A new PayPal event was received.',
      timestamp: new Date().toISOString(),
    }
  }

  try { await postToDiscord(embed) } catch (e) { console.error('discord post failed', e) }
})

// Health check so you can confirm it's live in a browser
app.get('/', (_req, res) => res.send('PayPal → Discord bridge is running ✅'))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('Listening on', PORT))
