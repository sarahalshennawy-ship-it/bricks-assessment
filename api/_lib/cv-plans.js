// CV Screener plans sold at checkout. Prices are monthly USD; longer terms get a discount.
// The plan keys (starter, growth, pro) must match PLANS in the CV Screener repo (lib/plans.js).
// Tier keys look like "cvstarter3" (plan + months). Packed letters for Ziina look like "cs3".
const USD_TO_AED = 3.6725;

const CV_PLANS = {
  starter: { label: "Starter", usd: 19,  cvs: 300,  jobs: 2 },
  growth:  { label: "Growth",  usd: 49,  cvs: 1000, jobs: 10 },
  pro:     { label: "Pro",    usd: 119, cvs: 3000, jobs: 30 }
};
const CV_TERMS = { 1: 0, 3: 0.10, 6: 0.15 }; // months -> discount

function cvTiers() {
  const out = {};
  for (const [plan, p] of Object.entries(CV_PLANS)) {
    for (const [m, disc] of Object.entries(CV_TERMS)) {
      const months = Number(m);
      const usd = Math.round(p.usd * months * (1 - disc));
      out["cv" + plan + months] = {
        plan, months, usd,
        amountFils: Math.round(usd * USD_TO_AED) * 100,
        label: `CV Screener ${p.label} (${months} month${months > 1 ? "s" : ""})`,
        packed: "c" + plan[0] + months,
        planLabel: p.label, cvs: p.cvs, jobs: p.jobs
      };
    }
  }
  return out;
}

module.exports = { CV_PLANS, CV_TERMS, cvTiers };
