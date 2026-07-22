# Supplement Purchase Tracker — Vercel Webhook + Meta CAPI

Tracks a custom Meta Pixel event **"Supplement Purchase"** only when specific supplement products are present in an order.

This repo is designed for a Shopify store using **Shiprocket Checkout**, where Shopify Web Pixel sandbox blocks direct calls to `graph.facebook.com`.

## Step 1: Deploy to Vercel
```bash
npm install -g vercel
vercel login
vercel deploy
```
Note deployed URL e.g. `https://supplement-tracker-xyz.vercel.app`

## Step 2: Set Environment Variables in Vercel Dashboard
- `META_PIXEL_ID` = `1085850645845966`
- `META_CAPI_TOKEN` = (from Meta Events Manager → Settings → Generate Access Token)
- `SHOPIFY_WEBHOOK_SECRET` = (from Shopify webhook setup step below)

## Step 3: Add Shopify Webhook
Shopify Admin → Settings → Notifications → Webhooks → Add webhook

Event: Order creation  
URL: `https://YOUR-VERCEL-URL/api/order-webhook`  
Format: JSON

Copy the webhook secret shown → paste as `SHOPIFY_WEBHOOK_SECRET` in Vercel

## Step 4: Test
- Place a test order with Gut Fuel Capsules (COD)
- Check Vercel function logs: Vercel Dashboard → Functions → order-webhook → Logs
- Check Meta Events Manager → Test Events (use `TEST66143`)

## Step 5: Go Live
- Remove or comment out `test_event_code` line in webhook code
- Redeploy

## Shopify Custom Pixel code (Customer Events)
Add a Custom Pixel in: Shopify Admin → Settings → Customer Events → Custom Pixel.

Update `YOUR-VERCEL-URL` below:

```javascript
// Supplement Purchase Tracker — Forwards to Vercel backend
// graph.facebook.com is blocked in Shopify sandbox
// So we call our own Vercel endpoint which then calls Meta CAPI

const VERCEL_ENDPOINT = "https://YOUR-VERCEL-URL/api/pixel-event";

const SUPPLEMENT_IDS = new Set([
  "8075024990397", "8075025121469", "8075025154237",
  "8075023974589", "8075024695485", "8075025088701", "8075024335037"
]);

analytics.subscribe("PurchaseSR", async (event) => {
  const d = event?.customData;
  if (!d) return;

  const hasSupplements = (d.items || []).some(
    item => SUPPLEMENT_IDS.has(String(item.id))
  );
  if (!hasSupplements) return;

  // Note: Vercel endpoint does NOT need webhook secret verification
  // because this is not sensitive — it's just a pixel event forwarder
  // Main tracking happens via Shopify Webhook (server-side, verified)
  try {
    await fetch(VERCEL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "pixel", customData: d }),
      keepalive: true,
    });
  } catch (e) {
    // Silent fail — Shopify webhook is primary tracker
  }
});
```
