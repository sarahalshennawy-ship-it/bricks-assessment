// POST /api/validate-coupon
// Body: { code: string }
// Returns: { valid: true, discount: number } or { valid: false }

function getCoupons() {
  try {
    return JSON.parse(process.env.COUPON_CODES || "{}");
  } catch (e) {
    console.error("COUPON_CODES env var is not valid JSON:", e);
    return {};
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { code } = req.body || {};
  if (!code) {
    res.status(400).json({ valid: false });
    return;
  }

  const coupons = getCoupons();
  const key = code.trim().toUpperCase();

  if (key in coupons) {
    res.status(200).json({ valid: true, discount: coupons[key] });
  } else {
    res.status(200).json({ valid: false });
  }
};
