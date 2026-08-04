// Shopify Custom Pixel forwarder endpoint -> Meta CAPI
// - No Shopify signature verification (non-sensitive backup/parallel signal)
// - Expects payload: { source: "pixel" | "add_to_cart", customData: {...} }
//
// LOGGING: every request prints a line tagged [SupplementTracker] with a short
// reqId so you can trace one request end-to-end in Vercel logs. No PII is logged
// (only which match keys were present, never their values).

const crypto = require("crypto");

const LOG = "[SupplementTracker]";

// Set your live store origin here. Use "*" temporarily if testing from
// multiple domains (staging, preview URLs), then lock it back down.
const ALLOWED_ORIGIN = "https://store.aayushwellness.com";

const DEFAULT_SUPPLEMENT_PRODUCT_IDS = [
  "8075024990397",
  "8075025121469",
  "8075025154237",
  "8075023974589",
  "8075024695485",
  "8075025088701",
  "8075024335037",
  "8310135521469",
  "8005829656765"
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
  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length !== 10) return undefined;
  return `91${digits}`;
}

function pickFirst(...values) {
  return values.find((value) => value != null && String(value).trim() !== "");
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

async function getJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function sendToMetaCapi({ pixelId, payload }) {
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
  // Short id to correlate all log lines for this one request
  const reqId = crypto.randomUUID().slice(0, 8);

  // ── CORS: must be set on EVERY response, including preflight ──────────
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        status: "ok",
        note: "POST only",
        example: { source: "pixel", customData: { items: [] } },
      })
    );
    return;
  }

  let body;
  try {
    body = await getJson(req);
  } catch {
    console.warn(`${LOG} INVALID_JSON`, { reqId });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", note: "invalid_json" }));
    return;
  }

  const headerUserAgent = req.headers["user-agent"];
  const xff = req.headers["x-forwarded-for"];
  const headerIp =
    typeof xff === "string" && xff.trim()
      ? xff.split(",")[0].trim()
      : undefined;

  // Accept either:
  // - { source: "pixel", customData: {...Shiprocket PurchaseSR payload...} }
  // - { ...Shiprocket PurchaseSR payload... }
  const d = body?.customData && typeof body.customData === "object" ? body.customData : body || {};

  // ── EVENT NAME: gives AddToCart its own row in Events Manager,
  //    separate from "Supplement Purchase" and from the general ATC event ──
  const eventName =
    body?.event_name ||
    (body?.source === "add_to_cart" ? "Supplement AddToCart" : "Supplement Purchase");

  const items = Array.isArray(d?.items)
    ? d.items
    : Array.isArray(d?.ecommerce?.items)
      ? d.ecommerce.items
      : [];
  const supplementIdSet = getSupplementIdSet();
  const supplementItems = items.filter((item) => {
    const id = item?.id != null ? String(item.id) : "";
    return supplementIdSet.has(id);
  });

  // ── LOG 1: what came in ─────────────────────────────────────────────
  console.log(`${LOG} RECEIVED`, {
    reqId,
    source: body?.source || "(none)",
    resolved_event: eventName,
    items_total: items.length,
    items_supplement: supplementItems.length,
  });

  if (supplementItems.length === 0) {
    // LOG: skipped — show the ids we saw so you can spot GID/format mismatches
    console.log(`${LOG} SKIPPED (no supplement items matched)`, {
      reqId,
      resolved_event: eventName,
      ids_seen: items.map((i) => (i?.id != null ? String(i.id) : "(none)")),
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "skipped" }));
    return;
  }

  const supplementValueNumber = supplementItems.reduce((sum, item) => {
    const price = Number.parseFloat(item?.price ?? item?.item_price ?? 0);
    const qty = Number(item?.quantity || 1);
    if (!Number.isFinite(price)) return sum;
    return sum + price * qty;
  }, 0);

  const supplementValue = Number.isFinite(supplementValueNumber)
    ? supplementValueNumber
    : 0;

  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_TOKEN;
  if (!pixelId || !accessToken) {
    console.warn(`${LOG} MISSING_ENV (META_PIXEL_ID / META_CAPI_TOKEN not set)`, {
      reqId,
      has_pixel_id: !!pixelId,
      has_token: !!accessToken,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", note: "missing_meta_env" }));
    return;
  }

  // Shiprocket fields (per doc): email, phone_num, first_name, last_name, city, pincode, country, user_agent
  const email = normalizeEmail(
    pickFirst(d?.email, d?.customer_email, d?.contact_email)
  );
  const phone = normalizeIndianPhone(
    pickFirst(d?.phone_num, d?.phone, d?.customer_phone)
  );
  const firstName = d?.first_name
    ? String(d.first_name).trim().toLowerCase()
    : undefined;
  const lastName = d?.last_name
    ? String(d.last_name).trim().toLowerCase()
    : undefined;
  const city = d?.city ? String(d.city).trim().toLowerCase() : undefined;
  const zip = d?.pincode
    ? String(d.pincode).trim().toLowerCase()
    : d?.zip
      ? String(d.zip).trim().toLowerCase()
      : undefined;

  const hashedEmail = sha256Hex(email);
  const hashedPhone = sha256Hex(phone);
  const hashedFirstName = sha256Hex(firstName);
  const hashedLastName = sha256Hex(lastName);
  const hashedCity = sha256Hex(city);
  const hashedZip = sha256Hex(zip);
  const hashedCountry = sha256Hex("in");
  const hashedExternalId = sha256Hex(d?.customer_id || d?.user_id);

  const sourceUrl = pickFirst(
    d?.landing_page,
    d?.landing_site,
    d?.url,
    d?.page_location
  );
  const fbclid = pickFirst(
    d?.fbclid,
    getUrlParam(sourceUrl, "fbclid"),
    getUrlParam(d?.abandoned_cart_url, "fbclid")
  );
  const fbc = pickFirst(d?.fbc, d?._fbc, normalizeFbc(fbclid));
  const fbp = pickFirst(d?.fbp, d?._fbp);

  const orderId =
    d?.transaction_id ||
    d?.order_id ||
    d?.orderId ||
    d?.cart_token ||
    d?.token ||
    d?.checkout_token ||
    d?.checkout_id ||
    d?.id ||
    crypto.randomUUID();

  const eventPrefix = eventName
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();

  const eventId = `${eventPrefix}_${String(orderId)}_${Date.now()}`;

  const payload = {
    data: [
      {
        event_name: eventName,
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
          ...(d?.user_agent || headerUserAgent
            ? { client_user_agent: String(d?.user_agent || headerUserAgent) }
            : {}),
          ...(headerIp ? { client_ip_address: headerIp } : {}),
          ...(fbc ? { fbc: String(fbc) } : {}),
          ...(fbp ? { fbp: String(fbp) } : {}),
          ...(body?.fbp ? { fbp: body.fbp } : {}),
          ...(body?.fbc ? { fbc: body.fbc } : {}),
        },
        ...(sourceUrl ? { event_source_url: String(sourceUrl) } : {}),
        custom_data: {
          currency: d?.currency || "INR",
          value: Number(supplementValue).toFixed(2),
          content_type: "product",
          content_name:
            body?.source === "add_to_cart"
              ? "Supplement Add To Cart"
              : "Supplement Purchase",
          content_category: "Health Supplements",
          contents: supplementItems.map((item) => ({
            id: String(item.id),
            quantity: Number(item.quantity || 1),
            item_price: Number.parseFloat(item.price ?? item.item_price ?? 0),
            title: item.name || item.title || "Supplement",
          })),
          num_items: supplementItems.reduce(
            (s, i) => s + Number(i.quantity || 1),
            0
          ),
          order_id: String(orderId),
        },
      },
    ],
    access_token: accessToken,
  };

  // If you set META_TEST_EVENT_CODE in Vercel env vars, events will appear under Meta "Test Events".
  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  // ── LOG 2: exactly what we're about to send (match_keys = which identifiers
  //           were present, so you can gauge match quality without seeing PII) ──
  console.log(`${LOG} SENDING`, {
    reqId,
    event_name: eventName,
    content_name: payload.data[0].custom_data.content_name,
    event_id: eventId,
    value: payload.data[0].custom_data.value,
    currency: payload.data[0].custom_data.currency,
    num_items: payload.data[0].custom_data.num_items,
    match_keys: Object.keys(payload.data[0].user_data),
    test_event: !!process.env.META_TEST_EVENT_CODE,
  });

  let metaResult = null;
  try {
    metaResult = await sendToMetaCapi({ pixelId, payload });
    if (metaResult.ok) {
      // ── LOG 3a: Meta accepted it. events_received:1 = success. ──
      console.log(`${LOG} META_OK`, {
        reqId,
        event_name: eventName,
        event_id: eventId,
        events_received: metaResult.json?.events_received,
        fbtrace_id: metaResult.json?.fbtrace_id,
        messages: metaResult.json?.messages,
      });
    } else {
      // ── LOG 3b: Meta rejected it. Read error for the reason. ──
      console.error(`${LOG} META_ERROR`, {
        reqId,
        status: metaResult.status,
        error: metaResult.json?.error || metaResult.json,
        event_id: eventId,
      });
    }
  } catch (e) {
    console.error(`${LOG} REQUEST_FAILED`, {
      reqId,
      message: e?.message,
      event_id: eventId,
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      status: "ok",
      reqId,
      event_name: eventName,
      event_id: eventId,
      events_received: metaResult?.json?.events_received ?? null,
    })
  );
};