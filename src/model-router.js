"use strict";

const LOGICAL = {
  luna: { codex: "gpt-5.6-luna", claude: "haiku", effort: "high" },
  terra: { codex: "gpt-5.6-terra", claude: "sonnet", effort: "high" },
  sol: { codex: "gpt-5.6-sol", claude: "opus", effort: "high" },
  "sol-max": { codex: "gpt-5.6-sol", claude: "opus", effort: "max" }
};

function route({ kind = "implementation", engine = "claude", failedRepairs = 0, preferred, solAvailable = true } = {}) {
  let tier = preferred || (['inventory', 'log-parsing', 'compression'].includes(kind) ? "luna" : "terra");
  let escalationReason = null;
  if (["architecture", "difficult-repair"].includes(kind)) tier = "sol";
  if (failedRepairs >= 2) {
    tier = "sol-max";
    escalationReason = "two-bounded-repairs-failed";
  }
  if (tier.startsWith("sol") && !solAvailable) {
    tier = "terra";
    escalationReason = "sol-capacity-unavailable";
  }
  const policy = LOGICAL[tier];
  return { tier, model: policy[engine] || policy.claude, effort: policy.effort, escalationReason };
}

module.exports = { route, LOGICAL };
