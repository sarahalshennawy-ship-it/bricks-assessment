// POST /api/test-delivery
// Admin-only. Sends the real delivery email for any product to any address,
// so you can check it without buying anything.
//
// Headers: x-admin-key: <ASSESSMENT_ADMIN_SECRET>   (same key as /api/list-users)
// Body:    { email: "you@example.com", tier: "entrepreneur", realCodes: false }
//   tier:      entrepreneur | starter | content | planner | toolkit
//   realCodes: false (default) -> email shows sample codes like TEST-PLANNER-0000; nothing is issued
//              true            -> issues REAL codes on plan.bricksmedia.org (tests the full chain;
//                                 the codes work, so treat that email like a purchase)

const { deliverPurchase, sendDeliveryEmail, TIER_CONTENT } = require("./_lib/delivery.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const adminKey = req.headers["x-admin-key"];
  if (!adminKey || adminKey !== process.env.ASSESSMENT_ADMIN_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { email, tier, realCodes } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Invalid email" });
    return;
  }
  if (!tier || !TIER_CONTENT[tier]) {
    res.status(400).json({ error: "Invalid tier", valid: Object.keys(TIER_CONTENT) });
    return;
  }

  try {
    if (realCodes === true) {
      await deliverPurchase({ email, name: "Test", tier });
    } else {
      await sendDeliveryEmail({
        to: email, name: "Test", tier,
        contentToolCode: "TEST-BRICKS-0000",
        plannerCode: "TEST-PLANNER-0000"
      });
    }
    res.status(200).json({ ok: true, sentTo: email, tier, realCodes: realCodes === true });
  } catch (err) {
    console.error("test-delivery error:", err);
    res.status(500).json({ error: "send_failed", message: String(err.message || err) });
  }
};
