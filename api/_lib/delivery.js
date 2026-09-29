// Shared delivery logic used by BOTH the Ziina webhook (real payments) and
// create-payment.js (100%-off coupon purchases, which never touch Ziina and
// therefore never trigger the webhook). Keeping this in one shared file
// means both paths stay in sync automatically.
//
// Access codes for BOTH tools are issued by plan.bricksmedia.org's
// /api/issue-code (one shared code database):
//   - Content Plan Generator  -> product "content-plan", 34 calls, 30 days
//   - UAE Business Launch Planner -> product "launch-planner", lifetime
//
// Env vars used here:
//   RESEND_API_KEY, SENDER_EMAIL, CONTENT_ADMIN_SECRET (unchanged)
//   TOOLKIT_DRIVE_URL   - Finance & Sales Toolkit files (falls back to BLUEPRINT_DRIVE_URL)
//   BOOKING_URL         - booking link for the strategy + follow-up sessions
//   COURSE_URL          - course material link. Leave EMPTY until the course is
//                         ready: buyers are then told it will be emailed separately.
//   REPLY_TO_EMAIL      - optional: where customer replies go (if different from SENDER_EMAIL)

const crypto = require("crypto");

const CONTENT_TOOL_URL = "https://plan.bricksmedia.org";
const PLANNER_URL = "https://planner.bricksmedia.org";
const CODE_API = `${CONTENT_TOOL_URL}/api/issue-code`;

const TOOLKIT_URL = process.env.TOOLKIT_DRIVE_URL || process.env.BLUEPRINT_DRIVE_URL || "";
const COURSE_URL = process.env.COURSE_URL || "";
const BOOKING_URL = process.env.BOOKING_URL || "";

// Brand colours (match the assessment, planner and content generator).
const C = { plum: "#7A1F5C", deep: "#4A1242", rasp: "#9C2A63", sun: "#FFC857", blush: "#FBEFF4", ink: "#363731", muted: "#6E6A63" };

// ---------- access codes ----------

async function issueCode(product, attempt = 0) {
  if (attempt > 1) return null; // give up after 2 tries; the email explains a follow-up is coming

  const prefix = product === "launch-planner" ? "PLANNER-" : "BRICKS-";
  const code = prefix + crypto.randomBytes(5).toString("hex").toUpperCase();
  const body = product === "launch-planner"
    ? { code, product: "launch-planner", lifetime: true }
    : { code, product: "content-plan", callsAllowed: 34, validDays: 30 };

  try {
    const res = await fetch(CODE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": process.env.CONTENT_ADMIN_SECRET },
      body: JSON.stringify(body)
    });
    if (res.status === 409) return issueCode(product, attempt + 1);
    if (!res.ok) {
      console.error(`issueCode(${product}) failed:`, res.status, await res.text());
      return null;
    }
    return code;
  } catch (err) {
    console.error(`issueCode(${product}) error:`, err);
    return null;
  }
}

// Kept for anything that still imports the old name.
function issueContentToolCode() { return issueCode("content-plan"); }
function issuePlannerCode() { return issueCode("launch-planner"); }

// ---------- what each purchase includes ----------

const TIER_CONTENT = {
  entrepreneur: {
    name: "Entrepreneur Package",
    subject: "Your Bricks Entrepreneur Package is ready",
    contentTool: true, planner: true, toolkit: true, course: true, booking: true
  },
  starter: {
    name: "Starter Package",
    subject: "Your Bricks Starter Package is ready",
    contentTool: true, planner: true, toolkit: true
  },
  content: {
    name: "AI Content Plan Generator",
    subject: "Your AI Content Plan Generator access",
    contentTool: true
  },
  planner: {
    name: "UAE Business Launch Planner",
    subject: "Your UAE Business Launch Planner access",
    planner: true
  },
  toolkit: {
    name: "Finance & Sales Toolkit",
    subject: "Your Finance & Sales Toolkit is here",
    toolkit: true
  },
  // Legacy tiers - no longer sold, kept so any older purchase still delivers.
  blueprint: { name: "Bricks Blueprint", subject: "Your Bricks Blueprint is here", contentTool: true, toolkit: true },
  consultation: { name: "Consultation Package", subject: "Welcome to your Bricks Consultation Package", contentTool: true, toolkit: true, course: true, booking: true },
  upgrade: { name: "Consultation Upgrade", subject: "Your Bricks Consultation Upgrade is confirmed", booking: true }
};

// ---------- email ----------

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function button(url, label) {
  return `<a href="${url}" style="display:inline-block;background:${C.plum};color:#ffffff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">${label}</a>`;
}

function codeBlock(title, url, code, note) {
  return `<div style="background:${C.blush};border-radius:12px;padding:16px 20px;margin:18px 0">
      <p style="margin:0 0 8px 0;color:${C.ink}"><b>${title}</b></p>
      <p style="margin:0 0 8px 0">Open it here: <a href="${url}" style="color:${C.rasp}">${url}</a></p>
      <p style="margin:0">Your access code: <span style="font-family:monospace;font-size:16px;font-weight:bold;background:#ffffff;padding:3px 10px;border-radius:6px;color:${C.deep}">${code}</span></p>
      <p style="margin:8px 0 0 0;font-size:12px;color:${C.muted}">${note}</p>
    </div>`;
}

function pendingLine(what) {
  return `<p style="color:${C.rasp}">We're finishing setting up your ${what} access. You'll get a follow-up email shortly.</p>`;
}

function linkBlock(title, url, label) {
  return `<div style="margin:18px 0"><p style="margin:0 0 10px 0;color:${C.ink}"><b>${title}</b></p>${button(url, label)}</div>`;
}

async function sendDeliveryEmail({ to, name, tier, contentToolCode, plannerCode }) {
  const t = TIER_CONTENT[tier];
  if (!t) throw new Error("Unknown tier: " + tier);

  const parts = [];   // HTML blocks
  const text = [];    // plain-text version (helps inbox delivery)
  const missing = []; // anything we could not include - logged loudly for manual follow-up

  if (t.contentTool) {
    if (contentToolCode) {
      parts.push(codeBlock("AI Content Plan Generator", CONTENT_TOOL_URL, contentToolCode,
        "Valid for 30 days. Generate your full 30-day plan, then regenerate any single day as often as you like."));
      text.push(`AI Content Plan Generator\nOpen: ${CONTENT_TOOL_URL}\nAccess code: ${contentToolCode} (valid 30 days)`);
    } else { parts.push(pendingLine("Content Plan Generator")); text.push("AI Content Plan Generator: your code will follow in a separate email."); missing.push("content code"); }
  }
  if (t.planner) {
    if (plannerCode) {
      parts.push(codeBlock("UAE Business Launch Planner", PLANNER_URL, plannerCode,
        "Lifetime access. Your progress is saved on the device you use."));
      text.push(`UAE Business Launch Planner\nOpen: ${PLANNER_URL}\nAccess code: ${plannerCode} (lifetime access)`);
    } else { parts.push(pendingLine("Launch Planner")); text.push("UAE Business Launch Planner: your code will follow in a separate email."); missing.push("planner code"); }
  }
  if (t.toolkit) {
    if (TOOLKIT_URL) { parts.push(linkBlock("Finance & Sales Toolkit", TOOLKIT_URL, "Open your toolkit files")); text.push(`Finance & Sales Toolkit\nFiles: ${TOOLKIT_URL}`); }
    else { parts.push(pendingLine("Finance & Sales Toolkit")); text.push("Finance & Sales Toolkit: your files will follow in a separate email."); missing.push("TOOLKIT_DRIVE_URL"); }
  }
  if (t.booking) {
    if (BOOKING_URL) { parts.push(linkBlock("Your strategy session and follow-up session", BOOKING_URL, "Book your first session")); text.push(`Strategy session + follow-up session\nBook here: ${BOOKING_URL}`); }
    else { parts.push(pendingLine("session booking")); text.push("Sessions: we'll email you a booking link shortly."); missing.push("BOOKING_URL"); }
  }
  if (t.course) {
    if (COURSE_URL) { parts.push(linkBlock("Course material", COURSE_URL, "Open the course")); text.push(`Course material\n${COURSE_URL}`); }
    else {
      parts.push(`<div style="margin:18px 0"><p style="margin:0 0 6px 0;color:${C.ink}"><b>Course material</b></p><p style="margin:0">Your course material is included in your package. We'll email you access separately as soon as it's available.</p></div>`);
      text.push("Course material: included in your package. We'll email you access separately as soon as it's available.");
    }
  }
  if (missing.length) console.error(`DELIVERY INCOMPLETE for ${to} (tier: ${tier}) - missing: ${missing.join(", ")}. Follow up manually.`);

  const greeting = name ? `Hi ${esc(name)},` : "Hi,";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;color:${C.ink};line-height:1.55">
      <div style="background:linear-gradient(135deg,${C.deep},${C.plum});border-radius:14px;padding:22px 24px;margin-bottom:20px">
        <p style="margin:0;color:${C.sun};font-size:12px;font-weight:bold;letter-spacing:1px">BRICKS · BUSINESS BUILDING STUDIO</p>
        <p style="margin:6px 0 0 0;color:#ffffff;font-size:20px;font-weight:bold">${t.name}</p>
      </div>
      <p style="margin:0 0 6px 0;font-size:17px"><b>${greeting}</b></p>
      <p>Thank you for your purchase. Here is everything you need to get started:</p>
      ${parts.join("\n")}
      <p style="margin-top:22px">If you have any questions, just reply to this email.</p>
      <p>The Bricks Team</p>
    </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.SENDER_EMAIL || "Bricks <hello@bricksmedia.org>",
      to: [to],
      subject: t.subject,
      html,
      text: `${name ? "Hi " + name + "," : "Hi,"}\n\nThank you for your purchase of the ${t.name}. Here is everything you need:\n\n${text.join("\n\n")}\n\nIf you have any questions, just reply to this email.\n\nThe Bricks Team`,
      ...(process.env.REPLY_TO_EMAIL ? { reply_to: process.env.REPLY_TO_EMAIL } : {})
    })
  });
  if (!res.ok) throw new Error("Resend error: " + (await res.text()));
}

// Issue whatever codes this purchase needs, then send one email.
// Used identically by the webhook (real payments) and create-payment.js (free coupons).
async function deliverPurchase({ email, name, tier }) {
  const t = TIER_CONTENT[tier];
  let contentToolCode = null, plannerCode = null;

  if (t && t.contentTool) {
    contentToolCode = await issueContentToolCode();
    if (!contentToolCode) console.error(`Could not issue Content Plan code for ${email} (tier: ${tier}) - issue one manually in admin.html`);
  }
  if (t && t.planner) {
    plannerCode = await issuePlannerCode();
    if (!plannerCode) console.error(`Could not issue Launch Planner code for ${email} (tier: ${tier}) - issue one manually in admin.html`);
  }

  await sendDeliveryEmail({ to: email, name: name || null, tier, contentToolCode, plannerCode });
  return contentToolCode; // same return value as before, for existing callers
}

module.exports = {
  deliverPurchase, sendDeliveryEmail, issueCode, issueContentToolCode, issuePlannerCode,
  TIER_CONTENT, CONTENT_TOOL_URL, PLANNER_URL
};
