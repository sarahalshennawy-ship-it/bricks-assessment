// POST /api/create-payment
// Body: { token, code, tier: "entrepreneur" | "starter" | "content" | "planner" | "toolkit" | "upgrade", name, email, coupon? }
// Requires a valid, unexpired OTP token+code from /api/send-verification first.
// Returns: { redirect_url: string } OR { redirect_url: string, free: true } for 100% off codes

const crypto = require("crypto");
const { deliverPurchase } = require("./_lib/delivery.js");

// Pricing in fils (1 AED = 100 fils). Ziina charges in AED; the page shows
// USD. Keep these in sync with PRICES in index.html.
//   USD -> AED at ~3.6725, rounded to a whole dirham.
const TIER_PRICING = {
  entrepreneur: { amountFils: 47400, label: "Bricks Entrepreneur Package" },   // 474 AED  (~$129)
  starter:      { amountFils: 25400, label: "Bricks Starter Package" },        // 254 AED  (~$69)
  content:      { amountFils: 18000, label: "AI Content Plan Generator" },     // 180 AED  (~$49)
  planner:      { amountFils: 10700, label: "UAE Business Launch Planner" },   // 107 AED  (~$29)
  toolkit:      { amountFils: 10700, label: "Finance & Sales Toolkit" },       // 107 AED  (~$29)
  // Legacy: the $50 upgrade link already sent in older Blueprint emails.
  upgrade:      { amountFils: 18500, label: "Consultation Upgrade" }           // 185 AED  (~$50)
};

// Coupon codes live in the COUPON_CODES environment variable as JSON, e.g.:
// {"TESTFREE100": 100, "LAUNCH50": 50, "FRIENDS20": 20}
// Value = percent off (100 = fully free, skips Ziina entirely).
function getCoupons() {
  try {
    return JSON.parse(process.env.COUPON_CODES || "{}");
  } catch (e) {
    console.error("COUPON_CODES env var is not valid JSON:", e);
    return {};
  }
}

function verifyOtpToken(token, submittedCode, expectedEmail, expectedTier) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed_token" };
  }
  const [b64, sig] = token.split(".");
  const expectedSig = crypto.createHmac("sha256", process.env.EMAIL_OTP_SECRET).update(b64).digest("hex");

  const sigBuf = Buffer.from(sig, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString());
  } catch (e) {
    return { ok: false, reason: "malformed_payload" };
  }

  if (Date.now() > payload.exp) {
    return { ok: false, reason: "expired" };
  }
  if (payload.email !== expectedEmail || payload.tier !== expectedTier) {
    return { ok: false, reason: "mismatch" };
  }
  if (String(payload.code) !== String(submittedCode)) {
    return { ok: false, reason: "wrong_code" };
  }

  return { ok: true };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { token, code, tier, name, email, coupon } = req.body || {};

    if (!tier || !TIER_PRICING[tier]) {
      res.status(400).json({ error: "Invalid or missing tier" });
      return;
    }
    if (!email) {
      res.status(400).json({ error: "Missing email" });
      return;
    }

    const verification = verifyOtpToken(token, code, email, tier);
    if (!verification.ok) {
      res.status(400).json({ error: "otp_verification_failed", reason: verification.reason });
      return;
    }

    let { amountFils, label } = TIER_PRICING[tier];
    let discountPct = 0;
    const siteUrl = process.env.SITE_URL || "https://bricks-assessment.vercel.app";

    if (coupon) {
      const coupons = getCoupons();
      const couponCode = coupon.trim().toUpperCase();
      if (!(couponCode in coupons)) {
        res.status(400).json({ error: "Invalid coupon code" });
        return;
      }
      discountPct = coupons[couponCode];
      amountFils = Math.round(amountFils * (1 - discountPct / 100));
    }

    // 100% off - skip Ziina entirely (nothing to charge), but we still need
    // to actually deliver the purchase ourselves here, since there's no
    // Ziina payment and therefore the webhook will never fire for this one.
    if (discountPct === 100) {
      try {
        await deliverPurchase({ email, name: name || null, tier });
      } catch (err) {
        console.error("Free-coupon delivery failed:", err);
        // Still send them to the success page - but this is logged loudly
        // because it means a "free" customer did NOT get their files.
      }
      res.status(200).json({
        redirect_url: `${siteUrl}/payment-success.html?tier=${tier}&free=true`,
        free: true
      });
      return;
    }

    // Ziina refuses any charge under 2 AED (200 fils). This can happen when a
    // steep coupon is applied to a low-priced tool. Catch
    // this BEFORE calling Ziina, so the customer/admin gets a clear message
    // instead of Ziina's raw "TRANSFER_UNDER_MINIMUM" error surfacing as a
    // generic "something went wrong".
    const ZIINA_MIN_FILS = 200; // 2 AED
    if (amountFils < ZIINA_MIN_FILS) {
      res.status(400).json({
        error: "amount_below_minimum",
        message: `This discount brings the price to ${(amountFils / 100).toFixed(2)} AED, below Ziina's 2 AED minimum charge. Please use a smaller discount or a 100%-off coupon instead.`
      });
      return;
    }

    // Pack tier + email into a short code so the webhook can identify who
    // bought what once payment succeeds (Ziina's payment intent has no
    // separate metadata field, and the "message" field has a real length
    // limit). We drop the name here to stay safely short.
    // IMPORTANT: the Ziina webhook must decode these same letters.
    const TIER_CODE = { entrepreneur: "e", starter: "s", content: "g", planner: "p", toolkit: "t", upgrade: "u" };
    const packedMessage = `${TIER_CODE[tier]}|${email}`.slice(0, 60);

    const ziinaRes = await fetch("https://api-v2.ziina.com/api/payment_intent", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.ZIINA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: amountFils,
        currency_code: "AED",
        message: packedMessage,
        success_url: `${siteUrl}/payment-success.html?tier=${tier}`,
        cancel_url: `${siteUrl}/`,
        failure_url: `${siteUrl}/`,
        test: process.env.ZIINA_TEST_MODE === "true"
      })
    });

    const data = await ziinaRes.json();

    if (!ziinaRes.ok) {
      console.error("Ziina payment_intent error:", data);
      res.status(502).json({ error: "Payment provider error", detail: data });
      return;
    }

    res.status(200).json({ redirect_url: data.redirect_url });
  } catch (err) {
    console.error("create-payment error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
