const crypto = require("crypto");

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

const CONTENT_TOOL_URL = "https://bricks-content-plan.vercel.app";

// Automatically issues a Content Plan Generator access code, valid for 30
// days, by calling the content generator's own issue-code endpoint. Retries
// once with a fresh random code on the rare chance of a name collision.
async function issueContentToolCode(attempt = 0) {
  if (attempt > 1) return null; // give up after 2 tries, deliver without the code

  const code = "BRICKS-" + crypto.randomBytes(5).toString("hex").toUpperCase();

  try {
    const res = await fetch(`${CONTENT_TOOL_URL}/api/issue-code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": process.env.CONTENT_ADMIN_SECRET
      },
      body: JSON.stringify({ code, callsAllowed: 4, validDays: 30 })
    });

    if (res.status === 409) {
      // Extremely unlikely name collision - try once more with a new code.
      return issueContentToolCode(attempt + 1);
    }
    if (!res.ok) {
      const detail = await res.text();
      console.error("issueContentToolCode failed:", res.status, detail);
      return null;
    }
    return code;
  } catch (err) {
    console.error("issueContentToolCode error:", err);
    return null;
  }
}

const TIER_CONTENT = {
  blueprint: {
    subject: "Your Bricks Blueprint is here 🎉",
    driveUrl: process.env.BLUEPRINT_DRIVE_URL || "REPLACE_WITH_BLUEPRINT_DRIVE_LINK",
    bookingUrl: null,
    includeContentTool: true
  },
  consultation: {
    subject: "Welcome to your Bricks Consultation Package 🎉",
    driveUrl: process.env.CONSULTATION_DRIVE_URL || "REPLACE_WITH_CONSULTATION_DRIVE_LINK",
    bookingUrl: process.env.BOOKING_URL || "REPLACE_WITH_BOOKING_LINK",
    includeContentTool: true
  },
  upgrade: {
    subject: "Your Bricks Consultation Upgrade is confirmed 🎉",
    driveUrl: null,
    bookingUrl: process.env.BOOKING_URL || "REPLACE_WITH_BOOKING_LINK",
    includeContentTool: false // they already got a code with their original toolkit purchase
  }
};

async function sendDeliveryEmail({ to, name, tier, contentToolCode }) {
  const content = TIER_CONTENT[tier];
  if (!content) throw new Error(`Unknown tier: ${tier}`);

  const greeting = name ? `Hi ${name},` : "Hi,";

  const filesLine = content.driveUrl
    ? `<p><a href="${content.driveUrl}" style="display:inline-block;background:#ff6b35;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Access Your Files</a></p>`
    : "";

  const bookingLine = content.bookingUrl
    ? `<p>Book your consultation session(s) here: <a href="${content.bookingUrl}">${content.bookingUrl}</a></p>`
    : "";

  const contentToolLine = (content.includeContentTool && contentToolCode)
    ? `
      <div style="background:#f5f0eb;border-radius:10px;padding:16px 20px;margin:20px 0">
        <p style="margin:0 0 8px 0"><b>Your AI Content Plan Generator access:</b></p>
        <p style="margin:0 0 8px 0">Tool link: <a href="${CONTENT_TOOL_URL}">${CONTENT_TOOL_URL}</a></p>
        <p style="margin:0">Your access code: <span style="font-family:monospace;font-size:16px;font-weight:bold;background:#fff;padding:2px 8px;border-radius:4px">${contentToolCode}</span></p>
        <p style="margin:8px 0 0 0;font-size:12px;color:#888">This code is valid for 30 days and generates one full 30-day content plan.</p>
      </div>
    `
    : (content.includeContentTool
        ? `<p style="color:#a8402e">We're finishing setting up your Content Plan Generator access — you'll get a follow-up email with your code shortly.</p>`
        : "");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#2C1F17">
      <h2>${greeting}</h2>
      <p>Thank you for your purchase! Here is everything you need to get started:</p>
      ${filesLine}
      ${contentToolLine}
      ${bookingLine}
      <p>If you have any questions, just reply to this email.</p>
      <p>— The Bricks &amp; Co Team</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.SENDER_EMAIL || "Bricks & Co <hello@bricksmedia.org>",
      to: [to],
      subject: content.subject,
      html
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
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
    let contentToolCode = null;
    if (TIER_CONTENT[tier] && TIER_CONTENT[tier].includeContentTool) {
      contentToolCode = await issueContentToolCode();
      if (!contentToolCode) {
        console.error(`Could not auto-issue content tool code for ${email} (tier: ${tier}) - manual follow-up needed via admin.html`);
      }
    }

    await sendDeliveryEmail({ to: email, name: null, tier, contentToolCode });
    res.status(200).json({ received: true, action: "delivered", tier, email, contentToolCode: contentToolCode || "manual_needed" });
  } catch (err) {
    console.error("Delivery email failed:", err);
    // Return 200 anyway so Ziina doesn't endlessly retry - but log loudly since
    // this means a paying customer did NOT get their files automatically.
    res.status(200).json({ received: true, action: "delivery_failed", error: String(err) });
  }
};
