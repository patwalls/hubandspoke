/**
 * Recipients for system-level alerts (credit-exhaustion, integration
 * outages — anything blocking the operator workflow). Distinct from
 * per-user notification emails because these go to people who can ACT
 * on the failure, regardless of opt-in state.
 *
 * Keep this short — it's a fan-out, not a digest. Adding noise here
 * trains everyone to ignore the alerts.
 */
export const ALERT_RECIPIENTS = [
  "patrickswalls@gmail.com",
  "sam@starterstory.com",
];
