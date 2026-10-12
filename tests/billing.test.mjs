import test from "node:test";
import assert from "node:assert/strict";
import { formatPlanPrice, changeKind, usagePercent, usageLevel, displayFeatures, FALLBACK_PLANS } from "../lib/billing/plans.ts";
import { allowUnpaidUpgrades } from "../lib/billing/flags.ts";
import { describeEnqueue } from "../lib/billing/notices.ts";

const plan = (code, sort_order) => ({ code, sort_order });

test("formatPlanPrice: free, single price and range (prices are in paise)", () => {
  assert.equal(formatPlanPrice({ price_paise: 0, price_max_paise: null }), "Free");
  assert.equal(formatPlanPrice({ price_paise: 79900, price_max_paise: null }), "₹799");
  assert.equal(formatPlanPrice({ price_paise: 149900, price_max_paise: 299900 }), "₹1,499 – ₹2,999");
  assert.equal(formatPlanPrice({ price_paise: 149900, price_max_paise: 149900 }), "₹1,499"); // max equal to min is not a range
  assert.equal(formatPlanPrice({ price_paise: 49950, price_max_paise: null }), "₹499.5");
  assert.equal(formatPlanPrice({ price_paise: 10000, price_max_paise: null, currency: "USD" }), "$100.00");
});

test("formatPlanPrice works for every fallback plan and the CA Firm shows a range", () => {
  const out = FALLBACK_PLANS.map((p) => formatPlanPrice(p));
  assert.deepEqual(out, ["Free", "₹799", "₹1,499 – ₹2,999"]);
});

test("changeKind follows sort_order, like the database", () => {
  const pilot = plan("pilot", 10), solo = plan("solo", 20), firm = plan("ca_firm", 30);
  assert.equal(changeKind(pilot, pilot), "current");
  assert.equal(changeKind(pilot, solo), "upgrade");
  assert.equal(changeKind(pilot, firm), "upgrade");
  assert.equal(changeKind(firm, solo), "downgrade");
  assert.equal(changeKind(solo, pilot), "downgrade");
  // Re-ordering plans in SQL changes the answer without touching code.
  assert.equal(changeKind(plan("a", 50), plan("b", 40)), "downgrade");
});

test("usagePercent clamps and handles a zero limit", () => {
  assert.equal(usagePercent(0, 25), 0);
  assert.equal(usagePercent(5, 25), 20);
  assert.equal(usagePercent(25, 25), 100);
  assert.equal(usagePercent(40, 25), 100); // never above 100
  assert.equal(usagePercent(-3, 25), 0);
  assert.equal(usagePercent(0, 0), 0);
  assert.equal(usagePercent(1, 0), 100);
});

test("usageLevel: warning from 80%, full at 100%, exact (no rounding up)", () => {
  assert.equal(usageLevel(0, 100), "ok");
  assert.equal(usageLevel(79, 100), "ok");
  assert.equal(usageLevel(80, 100), "warning");
  assert.equal(usageLevel(99, 100), "warning");
  assert.equal(usageLevel(100, 100), "full");
  assert.equal(usageLevel(101, 100), "full");
  assert.equal(usageLevel(19, 25), "ok"); // 76%
  assert.equal(usageLevel(20, 25), "warning"); // exactly 80%
  assert.equal(usageLevel(795, 1000), "ok"); // 79.5% would round to 80 but is not a warning
  assert.equal(usageLevel(0, 0), "full"); // a plan with no quota is full
});

test("displayFeatures hides lines that only repeat the numeric limits", () => {
  const out = displayFeatures({ features: ["25 invoices per month", "Up to 5 files per upload", "AI extraction with GST checks", "Review, verify and export (CSV and Excel)", "Email support", "", 7] });
  assert.deepEqual(out, ["AI extraction with GST checks", "Review, verify and export (CSV and Excel)", "Email support"]);
  assert.deepEqual(displayFeatures({ features: null }), []);
});

test("allowUnpaidUpgrades is off unless explicitly enabled", () => {
  assert.equal(allowUnpaidUpgrades({}), false);
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "false" }), false);
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "1" }), false);
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "" }), false);
});

test("allowUnpaidUpgrades works in development and on Vercel preview", () => {
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "true", NODE_ENV: "development" }), true);
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: " TRUE ", VERCEL_ENV: "preview", NODE_ENV: "production" }), true);
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "true", VERCEL_ENV: "development" }), true);
});

test("allowUnpaidUpgrades is IGNORED in production", () => {
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "true", VERCEL_ENV: "production", NODE_ENV: "production" }), false);
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "true", VERCEL_ENV: "production" }), false);
  // Self-hosted production build (no VERCEL_ENV): also ignored.
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "true", NODE_ENV: "production" }), false);
});

test("describeEnqueue: quota_exceeded, batch_limit and subscription_inactive explain what happens next", () => {
  const q = describeEnqueue(402, { code: "quota_exceeded", error: "x" }, 3);
  assert.equal(q.ok, false);
  assert.equal(q.upgrade, true);
  assert.match(q.text, /3 files were saved and stay "Uploaded"/);
  assert.match(q.text, /upgrade/i);

  const b = describeEnqueue(400, { code: "batch_limit", error: "Your plan allows up to 5 invoices at a time." }, 1);
  assert.equal(b.upgrade, true);
  assert.match(b.text, /up to 5 invoices/);
  assert.match(b.text, /1 file was saved/);

  const s = describeEnqueue(402, { code: "subscription_inactive", error: "Your subscription is not active." }, 2);
  assert.equal(s.upgrade, true);
  assert.match(s.text, /not active/);

  const n = describeEnqueue(409, { code: "no_subscription", error: "No subscription was found." }, 2);
  assert.equal(n.upgrade, false);

  const other = describeEnqueue(500, { error: "The invoices could not be queued. Try again." }, 2);
  assert.equal(other.text, "The invoices could not be queued. Try again.");
  assert.equal(other.upgrade, false);
});

test("describeEnqueue: partial success reports the invoices skipped for quota", () => {
  const n = describeEnqueue(200, { enqueued: [{ invoiceId: "a" }, { invoiceId: "b" }], skipped: [{ invoiceId: "c", reason: "quota_exceeded" }, { invoiceId: "d", reason: "already_queued" }] }, 3);
  assert.equal(n.ok, false);
  assert.equal(n.upgrade, true);
  assert.match(n.text, /2 invoices were queued/);
  assert.match(n.text, /1 invoice was not queued/);
  assert.match(n.text, /stay "Uploaded"/);
});

test("describeEnqueue: a clean success has no message", () => {
  const n = describeEnqueue(200, { enqueued: [{ invoiceId: "a" }], skipped: [] }, 1);
  assert.deepEqual(n, { ok: true, upgrade: false, text: "" });
  assert.deepEqual(describeEnqueue(200, {}, 0), { ok: true, upgrade: false, text: "" });
});
