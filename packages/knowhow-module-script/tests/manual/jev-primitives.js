// Paid manual verification for the Jev-backed script primitives.
// Run from the repository root after configuring the Jev model provider:
//   source ~/.bashrc
//   knowhow script --input-file packages/knowhow-module-script/tests/manual/jev-primitives.js

const urgency = await noul(
  "Customer: My payouts have failed for three days. Fix this now!",
  "Does this message convey urgency?",
  { true: "Explicitly urgent or time-sensitive", false: "No urgency expressed" }
);

const routing = await choice(
  "Customer: My payout was rejected again.",
  "Which team should handle this request?",
  {
    billing: "Payments, invoicing, refunds, and payouts",
    technical: "Bugs, outages, and integrations",
    sales: "Pricing, upgrades, and new accounts",
  }
);

const frustration = await score(
  "Customer: This is ridiculous. It has broken every day this week!",
  "How frustrated is the customer?",
  ["Calm", "Frustrated", "Very angry"]
);

if (urgency.type !== "noul" || urgency.noul < 0 || urgency.noul > 1) {
  throw new Error(`Invalid noul response: ${JSON.stringify(urgency)}`);
}
if (routing.type !== "choice" || routing.choice !== "billing") {
  throw new Error(`Invalid choice response: ${JSON.stringify(routing)}`);
}
if (
  frustration.type !== "score" || frustration.score < 0 || frustration.score > 2
) {
  throw new Error(`Invalid score response: ${JSON.stringify(frustration)}`);
}

console.log(JSON.stringify({ urgency, routing, frustration }, null, 2));
({ urgency, routing, frustration });
