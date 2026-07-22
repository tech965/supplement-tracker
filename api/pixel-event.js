// Shopify Custom Pixel forwarder endpoint -> Meta CAPI
// - No Shopify signature verification (non-sensitive backup/parallel signal)
// - Expects payload: { source: "pixel", customData: {...} }

const crypto = require("crypto");

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

  if (supplementItems.length === 0) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "skipped" }));
    return;
  }

  const supplementValueNumber = supplementItems.reduce((sum, item) => {
    const price = Number.parseFloat(item?.price ?? item?.item_price);
    const qty = Number(item?.quantity) || 0;
    if (!Number.isFinite(price) || qty <= 0) return sum;
    return sum + price * qty;
  }, 0);
  const supplementValue = Number.isFinite(supplementValueNumber)
    ? supplementValueNumber
    : 0;

  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_TOKEN;
  if (!pixelId || !accessToken) {
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

  const sourceUrl = pickFirst(d?.landing_page, d?.landing_site, d?.url);
  const fbclid = pickFirst(
    d?.fbclid,
    getUrlParam(sourceUrl, "fbclid"),
    getUrlParam(d?.abandoned_cart_url, "fbclid")
  );
  const fbc = pickFirst(d?.fbc, d?._fbc, normalizeFbc(fbclid));
  const fbp = pickFirst(d?.fbp, d?._fbp);

  const orderId =
    d?.transaction_id || d?.order_id || d?.orderId || d?.id || "pixel";
  const eventId = `supp_pixel_${String(orderId)}_${Date.now()}`;

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
          ...(d?.user_agent || headerUserAgent
            ? { client_user_agent: String(d?.user_agent || headerUserAgent) }
            : {}),
          ...(headerIp ? { client_ip_address: headerIp } : {}),
          ...(fbc ? { fbc: String(fbc) } : {}),
          ...(fbp ? { fbp: String(fbp) } : {}),
        },
        ...(sourceUrl ? { event_source_url: String(sourceUrl) } : {}),
        custom_data: {
          currency: d?.currency || "INR",
          value: supplementValue.toFixed(2),
          content_type: "product",
          content_name: "Supplement Purchase",
          content_category: "Health Supplements",
          contents: supplementItems.map((item) => ({
            id: String(item?.id),
            quantity: Number(item?.quantity) || 0,
            item_price: Number.parseFloat(item?.price ?? item?.item_price) || 0,
            title: item?.name || item?.title,
          })),
          num_items: supplementItems.reduce(
            (s, i) => s + (Number(i?.quantity) || 0),
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

  try {
    const result = await sendToMetaCapi({ pixelId, payload });
    if (!result.ok) {
      console.error("[SupplementTracker] Pixel Meta CAPI error", {
        status: result.status,
        error: result.json?.error || result.json,
        event_id: eventId,
      });
    }
  } catch (e) {
    console.error("[SupplementTracker] Pixel Meta CAPI request failed", {
      message: e?.message,
      event_id: eventId,
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "ok" }));
};