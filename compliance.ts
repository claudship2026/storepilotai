/**
 * Deterministic prohibited-claims scanner.
 *
 * Runs on every piece of generated external-facing text before a human sees it.
 * A model cannot soften, override or argue with a hard block here: the scan is
 * pattern matching over the final string, and the block is applied by the caller
 * regardless of what the model said about its own output.
 */

export type Finding = {
  category: string;
  severity: "warn" | "block";
  match: string;
  reason: string;
  rewrite: string;
};

type Rule = {
  category: string;
  severity: "warn" | "block";
  pattern: RegExp;
  reason: string;
  rewrite: string;
};

const RULES: Rule[] = [
  // --- Health and medical -------------------------------------------------
  {
    category: "medical",
    severity: "block",
    pattern: /\b(cure[sd]?|heals?|treats?|prevents?|diagnos\w+|remedy|therapeutic|clinically proven|FDA[- ]approved|medical[- ]grade)\b/gi,
    reason: "Health and medical claims require substantiation you do not have, and draw regulatory attention.",
    rewrite: "Describe what the product does physically, not what it does to a condition.",
  },
  {
    category: "medical",
    severity: "block",
    pattern: /\b(anxiety|depression|arthritis|migraine|insomnia|inflammation|chronic pain|blood pressure|diabetes)\b/gi,
    reason: "Naming a condition turns a product claim into a medical claim.",
    rewrite: "Talk about the everyday situation instead of the diagnosis.",
  },
  // --- Guarantees ---------------------------------------------------------
  {
    category: "guarantee",
    severity: "block",
    pattern: /\b(guaranteed results?|guarantee[sd]? to|100% (?:effective|guaranteed)|risk[- ]free|works? for everyone|no questions asked refund)\b/gi,
    reason: "An outcome guarantee is a promise you cannot keep for every buyer.",
    rewrite: "State the actual return window and terms from the approved refund policy.",
  },
  // --- False scarcity and urgency ----------------------------------------
  {
    category: "scarcity",
    severity: "block",
    pattern: /\b(only \d+ left|almost (?:sold out|gone)|selling fast|last chance|ends (?:tonight|in \d+)|limited stock|hurry|while supplies last|\d+ people are viewing)\b/gi,
    reason: "Scarcity language must reflect real inventory or a real deadline. Invented urgency is a deceptive practice.",
    rewrite: "Remove it, or wire the number to live inventory and let the real figure show.",
  },
  // --- Fake discounts -----------------------------------------------------
  {
    category: "pricing",
    severity: "block",
    pattern: /\b(was \$\d+|\$\d+ value|retail price \$\d+|\d{1,3}% off (?:today|now)|compare at \$\d+)\b/gi,
    reason: "A reference price must be a price the product genuinely sold at.",
    rewrite: "Show only the price you actually charge, or a compare-at price you can evidence.",
  },
  // --- Invented social proof ---------------------------------------------
  {
    category: "testimonial",
    severity: "block",
    pattern: /\b(\d{1,3}(?:,\d{3})* (?:happy|satisfied) customers|as seen on|rated #1|best[- ]selling|award[- ]winning|customers say|thousands of reviews|join \d+)\b/gi,
    reason: "Social proof must come from real, countable records. You have none yet at launch.",
    rewrite: "Leave the space and fill it after real reviews exist.",
  },
  // --- Unsupported comparatives ------------------------------------------
  {
    category: "comparative",
    severity: "warn",
    pattern: /\b(better than|superior to|outperforms|beats? the competition|the only|world'?s (?:best|first)|unmatched|revolutionary)\b/gi,
    reason: "A comparative claim needs a substantiated basis for the comparison.",
    rewrite: "Compare a specific measurable attribute, or drop the comparison.",
  },
  // --- Environmental and certification -----------------------------------
  {
    category: "environmental",
    severity: "warn",
    pattern: /\b(eco[- ]friendly|100% recyclable|carbon[- ]neutral|non[- ]toxic|chemical[- ]free|sustainable|biodegradable|certified organic)\b/gi,
    reason: "Green and certification claims need documentation from the supplier that you can produce on request.",
    rewrite: "Name the specific material or certificate number, or remove the claim.",
  },
  // --- Delivery promises --------------------------------------------------
  {
    category: "delivery",
    severity: "block",
    pattern: /\b(next[- ]day delivery|overnight shipping|arrives? in \d+ days? guaranteed|guaranteed delivery by|instant delivery|same[- ]day)\b/gi,
    reason: "A delivery promise must come from the approved delivery estimate on the product decision.",
    rewrite: "Use the approved delivery window and describe it as an estimate.",
  },
];

export function scanText(text: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const matches = text.match(rule.pattern);
    if (!matches) continue;
    for (const m of matches.slice(0, 3)) {
      const key = `${rule.category}:${m.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        category: rule.category,
        severity: rule.severity,
        match: m,
        reason: rule.reason,
        rewrite: rule.rewrite,
      });
    }
  }
  return findings;
}

/** Recursively scans any JSON payload, so a claim buried in an array is still caught. */
export function scanPayload(payload: unknown): Finding[] {
  const parts: string[] = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === "object") Object.values(v as object).forEach((x) => walk(x, depth + 1));
  };
  walk(payload);
  return scanText(parts.join("\n"));
}

export function isBlocked(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "block");
}

/**
 * Checks that every claim an asset relies on appears in the approved claim list
 * from the product decision. A claim outside that list is unsupported by
 * definition, whatever the model believed.
 */
export function checkClaims(
  claimsUsed: string[],
  claimsAllowed: string[],
  claimsProhibited: string[],
): { unsupported: string[]; prohibited: string[] } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const allowed = claimsAllowed.map(norm);
  const banned = claimsProhibited.map(norm);

  const unsupported: string[] = [];
  const prohibited: string[] = [];

  for (const claim of claimsUsed) {
    const n = norm(claim);
    if (banned.some((b) => b && n.includes(b))) prohibited.push(claim);
    else if (!allowed.some((a) => a && (n.includes(a) || a.includes(n)))) unsupported.push(claim);
  }
  return { unsupported, prohibited };
}
