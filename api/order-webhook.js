// Shopify orders/create webhook -> Meta CAPI "Supplement Purchase"
// - Verifies Shopify HMAC signature (x-shopify-hmac-sha256)
// - Filters for specific supplement product IDs
// - Sends server-side CAPI event
// - Always returns 200 for validly-signed webhooks (even if Meta errors)

const crypto = require("crypto");

const DEFAULT_SUPPLEMENT_PRODUCT_IDS = [
  "8075024990397", // Gut Fuel Capsules
  "8075025121469", // Liver Detox Tablets
  "8075025154237", // Lung Care Tablets
  "8075023974589", // Brain Fuel Capsules
  "8075024695485", // Dia Shield Tablets
  "8075025088701", // Immune Care Tablets
  "8075024335037", // Calcium+ Vitamins Tablets
    "8310135521469", // Shilajeet Drops
      "8005829656765", // Dreamy Sleep Gummies
  
];

function getSupplementIdSet() {
  const csv = process.env.SUPPLEMENT_PRODUCT_IDS_CSV;
  if (csv && String(csv).trim()) {
    return new Set(
      String(csv)
        .split(/[,\s]+/g)
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  return new Set(DEFAULT_SUPPLEMENT_PRODUCT_IDS);
}

function sha256Hex(value) {
  if (value == null) return undefined;
  const s = String(value);
  if (!s) return undefined;
  return crypto.createHash("sha256").update(s).digest("hex");
}

function normalizeEmail(email) {
  if (!email) return undefined;
  return String(email).trim().toLowerCase();
}

function normalizeIndianPhone(phone) {
  if (!phone) return undefined;
  let digits = String(phone).replace(/\D/g, "");
  if (!digits) return undefined;

  // Keep last 10 digits, then prefix "91"
  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length !== 10) return undefined;
  return `91${digits}`;
}

function pickFirst(...values) {
  return values.find((value) => value != null && String(value).trim() !== "");
}

function getOrderAttribute(order, names) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  const attrs = [
    ...(Array.isArray(order?.note_attributes) ? order.note_attributes : []),
    ...(Array.isArray(order?.attributes) ? order.attributes : []),
  ];

  for (const attr of attrs) {
    const name = String(attr?.name || attr?.key || "").toLowerCase();
    if (wanted.has(name)) return attr?.value;
  }

  return undefined;
}

function getUrlParam(url, name) {
  if (!url) return undefined;
  try {
    const parsed = new URL(String(url), "https://store.aayushwellness.com");
    return parsed.searchParams.get(name) || undefined;
  } catch {
    return undefined;
  }
}

function normalizeFbc(value) {
  if (!value) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  if (s.startsWith("fb.1.")) return s;
  return `fb.1.${Math.floor(Date.now() / 1000)}.${s}`;
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifyShopifyHmac({ rawBody, hmacHeader, secret }) {
  if (!hmacHeader || !secret) return false;
  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  // timing-safe compare
  const a = Buffer.from(computed);
  const b = Buffer.from(String(hmacHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function sendToMetaCapi({ pixelId, accessToken, payload }) {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(
    pixelId
  )}/events`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  const rawBody = await getRawBody(req);

  const hmacHeader =
    req.headers["x-shopify-hmac-sha256"] ||
    req.headers["X-Shopify-Hmac-Sha256"];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  const isValid = verifyShopifyHmac({
    rawBody,
    hmacHeader,
    secret,
  });

  if (!isValid) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid webhook signature" }));
    return;
  }

  let order;
  try {
    order = JSON.parse(rawBody.toString("utf8"));
  } catch (e) {
    console.error("[SupplementTracker] Invalid JSON payload");
    // Signed webhook but malformed JSON: return 200 to avoid retries
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", note: "invalid_json" }));
    return;
  }

  const orderId = order?.id;
  const orderName = order?.name || String(orderId || "");
  console.log(`[SupplementTracker] Order ${orderName} received`);

  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
  const supplementIdSet = getSupplementIdSet();
  const supplementItems = lineItems.filter((item) => {
    const productId = item?.product_id != null ? String(item.product_id) : "";
    const variantId = item?.variant_id != null ? String(item.variant_id) : "";
    return supplementIdSet.has(productId) || supplementIdSet.has(variantId);
  });

  if (supplementItems.length === 0) {
    console.log("[SupplementTracker] No supplement products found — skipping");
    // Debug aid: product ids are not PII, safe to log.
    try {
      const ids = lineItems.map((i) => ({
        product_id: i?.product_id != null ? String(i.product_id) : null,
        variant_id: i?.variant_id != null ? String(i.variant_id) : null,
        title: i?.title || null,
      }));
      console.log("[SupplementTracker] Line item IDs:", ids);
      console.log(
        "[SupplementTracker] Supplement match set:",
        Array.from(supplementIdSet)
      );
    } catch {
      // ignore
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "skipped" }));
    return;
  }

  const supplementValueNumber = supplementItems.reduce((sum, item) => {
    const price = Number.parseFloat(item?.price);
    const qty = Number(item?.quantity) || 0;
    if (!Number.isFinite(price) || qty <= 0) return sum;
    return sum + price * qty;
  }, 0);

  const supplementValue = Number.isFinite(supplementValueNumber)
    ? supplementValueNumber
    : 0;

  const supplementTitles = supplementItems
    .map((i) => `${i?.title || "Item"} (x${Number(i?.quantity) || 0})`)
    .join(", ");
  console.log(
    `[SupplementTracker] Supplement items found: ${supplementTitles}`
  );
  console.log(
    `[SupplementTracker] Supplement value: ₹${supplementValue.toFixed(2)}`
  );

  const email = normalizeEmail(
    pickFirst(order?.email, order?.contact_email, order?.customer?.email)
  );
  const phone = normalizeIndianPhone(
    pickFirst(
      order?.billing_address?.phone,
      order?.shipping_address?.phone,
      order?.phone,
      order?.customer?.phone,
      order?.customer?.default_address?.phone
    )
  );
  const firstName = pickFirst(
    order?.billing_address?.first_name,
    order?.shipping_address?.first_name,
    order?.customer?.first_name,
    order?.customer?.default_address?.first_name
  )
    ? String(
        pickFirst(
          order?.billing_address?.first_name,
          order?.shipping_address?.first_name,
          order?.customer?.first_name,
          order?.customer?.default_address?.first_name
        )
      )
        .trim()
        .toLowerCase()
    : undefined;
  const lastName = pickFirst(
    order?.billing_address?.last_name,
    order?.shipping_address?.last_name,
    order?.customer?.last_name,
    order?.customer?.default_address?.last_name
  )
    ? String(
        pickFirst(
          order?.billing_address?.last_name,
          order?.shipping_address?.last_name,
          order?.customer?.last_name,
          order?.customer?.default_address?.last_name
        )
      )
        .trim()
        .toLowerCase()
    : undefined;
  const city = pickFirst(
    order?.billing_address?.city,
    order?.shipping_address?.city,
    order?.customer?.default_address?.city
  )
    ? String(
        pickFirst(
          order?.billing_address?.city,
          order?.shipping_address?.city,
          order?.customer?.default_address?.city
        )
      )
        .trim()
        .toLowerCase()
    : undefined;
  const zip = pickFirst(
    order?.billing_address?.zip,
    order?.shipping_address?.zip,
    order?.customer?.default_address?.zip
  )
    ? String(
        pickFirst(
          order?.billing_address?.zip,
          order?.shipping_address?.zip,
          order?.customer?.default_address?.zip
        )
      )
        .trim()
        .toLowerCase()
    : undefined;
  const clientIp = pickFirst(order?.browser_ip, order?.client_details?.browser_ip);
  const clientUserAgent = pickFirst(
    order?.client_details?.user_agent,
    order?.client_details?.browser_user_agent,
    order?.user_agent
  );
  const sourceUrl = pickFirst(order?.landing_site, order?.referring_site);
  const fbclid = pickFirst(
    getOrderAttribute(order, ["fbclid", "_fbclid"]),
    getUrlParam(order?.landing_site, "fbclid"),
    getUrlParam(order?.referring_site, "fbclid")
  );
  const fbc = pickFirst(
    getOrderAttribute(order, ["fbc", "_fbc"]),
    normalizeFbc(fbclid)
  );
  const fbp = pickFirst(getOrderAttribute(order, ["fbp", "_fbp"]));

  const hashedEmail = sha256Hex(email);
  const hashedPhone = sha256Hex(phone);
  const hashedFirstName = sha256Hex(firstName);
  const hashedLastName = sha256Hex(lastName);
  const hashedCity = sha256Hex(city);
  const hashedZip = sha256Hex(zip);
  const hashedCountry = sha256Hex("in");
  const hashedExternalId = sha256Hex(order?.customer?.id || order?.customer?.admin_graphql_api_id);

  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_TOKEN;

  if (!pixelId || !accessToken) {
    console.error(
      "[SupplementTracker] Missing META_PIXEL_ID or META_CAPI_TOKEN; skipping Meta call"
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", note: "missing_meta_env" }));
    return;
  }

  const eventId = `supp_${String(orderId || "unknown")}_${Date.now()}`;

  const payload = {
    data: [
      {
        event_name: "Supplement Purchase",
        event_time: Math.floor(Date.now() / 1000),
        action_source: "website",
        event_id: eventId,
        user_data: {
          ...(hashedEmail ? { em: [hashedEmail] } : {}),
          ...(hashedPhone ? { ph: [hashedPhone] } : {}),
          ...(hashedFirstName ? { fn: [hashedFirstName] } : {}),
          ...(hashedLastName ? { ln: [hashedLastName] } : {}),
          ...(hashedCity ? { ct: [hashedCity] } : {}),
          ...(hashedZip ? { zp: [hashedZip] } : {}),
          ...(hashedExternalId ? { external_id: [hashedExternalId] } : {}),
          country: [hashedCountry],
          ...(clientIp ? { client_ip_address: String(clientIp) } : {}),
          ...(clientUserAgent
            ? { client_user_agent: String(clientUserAgent) }
            : {}),
          ...(fbc ? { fbc: String(fbc) } : {}),
          ...(fbp ? { fbp: String(fbp) } : {}),
        },
        ...(sourceUrl ? { event_source_url: String(sourceUrl) } : {}),
        custom_data: {
          currency: order?.currency || "INR",
          value: supplementValue.toFixed(2),
          content_type: "product",
          content_name: "Supplement Purchase",
          content_category: "Health Supplements",
          contents: supplementItems.map((item) => ({
            id: String(item?.product_id),
            quantity: Number(item?.quantity) || 0,
            item_price: Number.parseFloat(item?.price) || 0,
            title: item?.title,
          })),
          num_items: supplementItems.reduce(
            (s, i) => s + (Number(i?.quantity) || 0),
            0
          ),
          order_id: String(orderId || ""),
          order_name: order?.name,
        },
      },
    ],
    access_token: accessToken,
  };

  // If you set META_TEST_EVENT_CODE in Vercel env vars, events will appear under Meta "Test Events".
  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  try {
    const result = await sendToMetaCapi({ pixelId, accessToken, payload });
    if (result.ok) {
      const eventsReceived =
        result?.json?.events_received ??
        result?.json?.events_received?.toString?.();
      console.log(
        `[SupplementTracker] ✅ Meta CAPI event sent | events_received: ${
          eventsReceived ?? "unknown"
        } | event_id: ${eventId}`
      );
    } else {
      console.error("[SupplementTracker] Meta CAPI error", {
        status: result.status,
        error: result.json?.error || result.json,
        event_id: eventId,
        order_id: String(orderId || ""),
      });
    }
  } catch (e) {
    console.error("[SupplementTracker] Meta CAPI request failed", {
      message: e?.message,
      event_id: eventId,
      order_id: String(orderId || ""),
    });
  }

  // Critical: Always 200 for valid signature to prevent Shopify retries
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "ok" }));
};