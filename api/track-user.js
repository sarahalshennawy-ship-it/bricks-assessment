// POST /api/track-user
// Called the moment someone reaches their report (whether they ever pay or
// not). Saves their business data and quiz results so nothing is lost when
// the browser tab closes.

const { upsertUser } = require("./_lib/store.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { email, name, businessName, phone, introAnswers, overallScore, sectionScores } = req.body || {};

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Invalid email" });
      return;
    }

    await upsertUser(email, {
      email,
      name: name || null,
      businessName: businessName || null,
      phone: phone || null,
      introAnswers: introAnswers || {},
      overallScore: typeof overallScore === "number" ? overallScore : null,
      sectionScores: sectionScores || null,
      status: "free_only" // upsertUser will never downgrade an existing higher status
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("track-user error:", err);
    // Never block the user's experience over a tracking failure.
    res.status(200).json({ ok: false, error: String(err) });
  }
};
