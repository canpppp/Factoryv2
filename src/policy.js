"use strict";

const PROTECTED_AUTHORITY_CLASSES = Object.freeze([
  "capability-policy",
  "turn-authority",
  "canonical-executor-tools-run",
  "confirmation-gate",
  "guest-privacy",
  "model-egress-dlp",
  "speech-authority",
  "durable-state-authority",
  "credential-handling",
  "external-write-permissions",
  "destructive-migrations"
]);

const FORBIDDEN_COMMANDS = Object.freeze([
  { re: /\bgit\s+merge\b/, why: "merge waits for Ship it" },
  { re: /\bgh\s+pr\s+merge\b/, why: "merge waits for Ship it" },
  { re: /\bgit\s+push\b[^|;&]*\s+(?:origin\s+)?(?:HEAD:)?main\b/, why: "main writes are F5 only" },
  { re: /\bdeploy(?:\.sh)?\b/, why: "JARVIS auto-deploy is absent during Factory development" },
  { re: /\bsecurity\s+(?:add|delete|find)-generic-password\b|\bkeychain\b/i, why: "credential access is protected" },
  { re: /\brm\s+-rf\s+\/(?:\s|$)|\brm\s+-rf\s+~(?:\s|$)/, why: "unbounded deletion" }
]);

const AUDIO_LOCKED_COMMANDS = Object.freeze([
  { re: /(?:^|[\s/])(?:say|afplay|jarvis-play)(?:\s|$)/i, why: "audio playback binary is forbidden while audio is locked" },
  { re: /persistent-candidate-spoken-acceptance|voice-drill|tts-stream-test|local-voice-test|\be-checks\.js\b/i, why: "audible fixture is forbidden while audio is locked" },
  { re: /\bosascript\b[^\n]*(?:set\s+volume|output\s+muted\s+false|without\s+output\s+muted)/i, why: "system volume changes are forbidden while audio is locked" },
  { re: /\bSwitchAudioSource\b[^\n]*(?:-s|-i|-u)/i, why: "output-device changes are forbidden while audio is locked" },
  { re: /\bspotify\b[^\n]*(?:play|resume|next|previous|shuffle)/i, why: "Spotify playback is forbidden while audio is locked" },
  { re: /\bopen\b[^\n]*(?:Claude\.app|com\.anthropic\.claudefordesktop)/i, why: "Claude Desktop media activation is forbidden while audio is locked" }
]);

function commandAllowed(command, { trustDomain = null, env = process.env } = {}) {
  const s = String(command || "");
  if (!s.trim()) return { ok: false, reason: "empty-command" };
  for (const f of FORBIDDEN_COMMANDS) {
    if (f.re.test(s)) return { ok: false, reason: "forbidden-command", detail: f.why };
  }
  if (String(env.FACTORY_AUDIO_LOCKED || "") === "1") {
    for (const f of AUDIO_LOCKED_COMMANDS) {
      if (f.re.test(s)) return { ok: false, reason: "audio-locked", detail: f.why };
    }
    const opensJarvis = /(?:\/usr\/bin\/)?open\b[^\n]*(?:JARVIS|Candidate|\.app)/i.test(s);
    const candidateJourney = /(?:app-managed-startup-gate|persistent-candidate-(?:typed|close-shutdown)-acceptance)\.js/i.test(s);
    if ((opensJarvis || candidateJourney) && !/--audio-locked\b/.test(s)) {
      return { ok: false, reason: "audio-locked", detail: "JARVIS launch requires --audio-locked" };
    }
    if (trustDomain === "jarvis" && /(?:^|\s)(?:npm\s+test|\.\/scripts\/verify\.sh)(?:\s|$)/.test(s)
        && !/VERIFY_SUITES_OVERRIDE=/.test(s)) {
      return { ok: false, reason: "audio-locked", detail: "broad JARVIS verification includes audible fixtures" };
    }
  }
  return { ok: true };
}

function protectedImpact(goalText) {
  const text = String(goalText || "").toLowerCase();
  const hits = PROTECTED_AUTHORITY_CLASSES.filter((c) => text.includes(c.replace(/-/g, " ")));
  return { ok: hits.length === 0, classes: hits };
}

function releaseAllowed({ trustDomain, shipIt = false }) {
  if (trustDomain === "factoryv2") return { ok: true, reason: "factoryv2-self-authorized" };
  if (trustDomain === "jarvis" && shipIt) return { ok: true, reason: "human-release-gate" };
  if (trustDomain === "jarvis") return { ok: false, reason: "jarvis-release-needs-human-ship-it" };
  return { ok: false, reason: "unknown-trust-domain" };
}

module.exports = { PROTECTED_AUTHORITY_CLASSES, FORBIDDEN_COMMANDS, AUDIO_LOCKED_COMMANDS,
  commandAllowed, protectedImpact, releaseAllowed };
