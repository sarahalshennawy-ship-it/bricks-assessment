// POST /api/create-payment
// Body: { token: string, code: string, tier: "blueprint" | "consultation", name: string, email: string, coupon?: string }
// Requires a valid, unexpired OTP token+code from /api/send-verification first.
// Returns: { redirect_url: string } OR { redirect_url: string, free: true } for 100% off codes

const crypto = require("crypto");

// Pricing in fils (1 AED = 100 fils). Update these if pricing changes.
const TIER_PRICING = {
  blueprint: { amountFils: 21900, label: "Bricks Blueprint" },      // 219 AED (~$59)
  consultation: { amountFils: 72900, label: "Bricks Consultation Package" }, // 729 AED (~$199)
  upgrade: { amountFils: 36500, label: "Consultation Upgrade" }     // 365 AED (~$99) - hidden upgrade, not linked publicly
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

    // 100% off - skip Ziina entirely, go straight to a free-access success page.
    if (discountPct === 100) {
      res.status(200).json({
        redirect_url: `${siteUrl}/payment-success.html?tier=${tier}&free=true`,
        free: true
      });
      return;
    }

    // Pack tier + email into a short code so the webhook can identify who
    // bought what once payment succeeds (Ziina's payment intent has no
    // separate metadata field, and the "message" field has a real length
    // limit). We drop the name here to stay safely short.
    const TIER_CODE = { blueprint: "b", consultation: "c", upgrade: "u" };
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
