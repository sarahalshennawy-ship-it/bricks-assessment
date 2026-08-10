// POST /api/send-verification
// Body: { email: string, name?: string, tier: "blueprint" | "consultation" | "upgrade" }
// Sends a 6-digit code to the customer's email and returns a signed token.
// No database needed - the token itself carries the code, email, tier and
// expiry, signed so it can't be tampered with. The frontend holds onto this
// token and sends it back along with the code the user types in.

const crypto = require("crypto");

const VALID_TIERS = ["blueprint", "consultation", "upgrade"];
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function signToken(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.EMAIL_OTP_SECRET).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

async function sendCodeEmail({ to, code }) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;color:#2C1F17">
      <h2>Your verification code</h2>
      <p>Enter this code to confirm your email and complete your purchase:</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;background:#f5f0eb;padding:20px;border-radius:10px;text-align:center;margin:20px 0">${code}</div>
      <p style="font-size:13px;color:#888">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.SENDER_EMAIL || "Bricks & Co <hello@mail.bricksmedia.org>",
      to: [to],
      subject: `Your verification code: ${code}`,
      html
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { email, tier } = req.body || {};

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Invalid email" });
      return;
    }
    if (!tier || !VALID_TIERS.includes(tier)) {
      res.status(400).json({ error: "Invalid tier" });
      return;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    const token = signToken({ email, tier, code, exp: Date.now() + CODE_TTL_MS });

    await sendCodeEmail({ to: email, code });

    res.status(200).json({ token });
  } catch (err) {
    console.error("send-verification error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
