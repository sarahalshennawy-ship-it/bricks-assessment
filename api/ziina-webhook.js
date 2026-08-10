const crypto = require("crypto");
const { deliverPurchase } = require("./_lib/delivery.js");

// Vercel gives us the raw body via req.body already parsed as an object by
// default for JSON content-type. We need the RAW string to verify the HMAC,
// so we disable the default body parser for this function.
module.exports.config = {
  api: { bodyParser: false }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(signatureHeader, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

module.exports = async (req, res) => {
  // Ziina (or other tools) may send a GET/HEAD request to verify this URL
  // is real and responding before accepting webhook registration.
  if (req.method === "GET" || req.method === "HEAD") {
    res.status(200).json({ status: "ok" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["x-hmac-signature"];

  const valid = verifySignature(rawBody, signature, process.env.ZIINA_WEBHOOK_SECRET);
  if (!valid) {
    console.error("Ziina webhook: invalid signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  const paymentIntentId = event.id || event.payment_intent_id || (event.data && event.data.id);
  if (!paymentIntentId) {
    console.error("Ziina webhook: no payment intent id in payload", event);
    res.status(400).json({ error: "Missing payment intent id" });
    return;
  }

  // Defense in depth: don't trust the webhook payload's status field alone.
  // Re-fetch the payment intent directly from Ziina to confirm it actually succeeded.
  const verifyRes = await fetch(`https://api-v2.ziina.com/api/payment_intent/${paymentIntentId}`, {
    headers: { "Authorization": `Bearer ${process.env.ZIINA_API_KEY}` }
  });
  const intent = await verifyRes.json();

  if (!verifyRes.ok || intent.status !== "completed") {
    // Not a successful payment (could be a failure/cancel event) - nothing to deliver.
    res.status(200).json({ received: true, action: "ignored", status: intent.status });
    return;
  }

  const TIER_CODE_REVERSE = { b: "blueprint", c: "consultation", u: "upgrade" };
  const [tierCode, email] = (intent.message || "").split("|");
  const tier = TIER_CODE_REVERSE[tierCode];

  if (!tier || !email) {
    console.error("Ziina webhook: could not parse packed message", intent.message);
    res.status(200).json({ received: true, action: "error", detail: "unparseable message" });
    return;
  }

  try {
    const contentToolCode = await deliverPurchase({ email, name: null, tier });
    res.status(200).json({ received: true, action: "delivered", tier, email, contentToolCode: contentToolCode || "manual_needed" });
  } catch (err) {
    console.error("Delivery email failed:", err);
    // Return 200 anyway so Ziina doesn't endlessly retry - but log loudly since
    // this means a paying customer did NOT get their files automatically.
    res.status(200).json({ received: true, action: "delivery_failed", error: String(err) });
  }
};
