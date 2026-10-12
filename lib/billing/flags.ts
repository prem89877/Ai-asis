// Dependency-free so it can be unit tested with `node --test`.
type Env = Record<string, string | undefined>;

// Testing aid: lets a plan upgrade apply without payment. It is IGNORED in production:
//  * on a Vercel production deployment (VERCEL_ENV=production), and
//  * on any other host running a production build (NODE_ENV=production with no VERCEL_ENV).
// So the flag only works with `next dev` and on Vercel Preview deployments. Leave it unset in production;
// the payment phase is what confirms paid upgrades.
export function allowUnpaidUpgrades(env: Env = process.env): boolean {
  if (env.VERCEL_ENV === "production") return false;
  if (env.VERCEL_ENV === undefined && env.NODE_ENV === "production") return false;
  return env.BILLING_ALLOW_UNPAID_UPGRADES?.trim().toLowerCase() === "true";
}
