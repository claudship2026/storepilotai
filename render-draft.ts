/**
 * Turns a validated draft payload into the HTML that would actually be written
 * to Shopify. Rendering happens here rather than in a prompt, so the operator's
 * approval diff shows the exact bytes that will be sent.
 */

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

type Section = {
  heading: string;
  subheading: string | null;
  body: string;
  bullets: string[];
  cta: string | null;
  layoutNote: string;
};

function sectionHtml(s: Section): string {
  return [
    `<section>`,
    `<h2>${esc(s.heading)}</h2>`,
    s.subheading ? `<h3>${esc(s.subheading)}</h3>` : "",
    `<p>${esc(s.body)}</p>`,
    s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "",
    s.cta ? `<p><strong>${esc(s.cta)}</strong></p>` : "",
    `</section>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderDraftHtml(kind: string, content: Record<string, unknown>): string {
  switch (kind) {
    case "product_page": {
      const c = content as {
        headline: string;
        valueProposition: string;
        benefits: Array<{ benefit: string; backedBy: string }>;
        offer: { primary: string; bundles: Array<{ name: string; contents: string; priceLogic: string }> };
        faq: Array<{ q: string; a: string }>;
        shippingExpectation: string;
        returnsExplanation: string;
        objectionHandling: Array<{ objection: string; response: string }>;
        comparison: { includeIt: boolean; rows: Array<{ attribute: string; us: string; them: string }> };
      };
      return [
        `<h1>${esc(c.headline)}</h1>`,
        `<p>${esc(c.valueProposition)}</p>`,
        `<h2>Benefits</h2><ul>${(c.benefits ?? [])
          .map((b) => `<li>${esc(b.benefit)}</li>`)
          .join("")}</ul>`,
        `<h2>Offer</h2><p>${esc(c.offer?.primary)}</p>`,
        (c.offer?.bundles ?? []).length
          ? `<ul>${c.offer.bundles.map((b) => `<li><strong>${esc(b.name)}</strong> — ${esc(b.contents)}</li>`).join("")}</ul>`
          : "",
        c.comparison?.includeIt && c.comparison.rows?.length
          ? `<h2>How it compares</h2><table><tbody>${c.comparison.rows
              .map((r) => `<tr><td>${esc(r.attribute)}</td><td>${esc(r.us)}</td><td>${esc(r.them)}</td></tr>`)
              .join("")}</tbody></table>`
          : "",
        `<h2>Common questions</h2>${(c.objectionHandling ?? [])
          .map((o) => `<h3>${esc(o.objection)}</h3><p>${esc(o.response)}</p>`)
          .join("")}`,
        `<h2>Shipping</h2><p>${esc(c.shippingExpectation)}</p>`,
        `<h2>Returns</h2><p>${esc(c.returnsExplanation)}</p>`,
        `<h2>FAQ</h2>${(c.faq ?? []).map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join("")}`,
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "shipping_policy":
    case "refund_policy":
    case "privacy_policy":
    case "terms": {
      const c = content as { title: string; bodyHtml: string };
      // The model returns HTML for policies; tags are stripped to a safe subset.
      const safe = String(c.bodyHtml ?? "").replace(/<(?!\/?(p|h2|h3|ul|ol|li|strong|em|br|a)\b)[^>]*>/gi, "");
      return `<h1>${esc(c.title)}</h1>\n${safe}`;
    }

    case "faq":
    case "specifications":
    case "bundles":
    case "cart_upsells":
    case "trust_sections":
    case "order_tracking_plan":
    case "photo_shot_list":
    case "ugc_shot_list":
    case "launch_checklist":
    case "mobile_structure": {
      const c = content as { items: Array<{ title: string; detail: string }> };
      return (c.items ?? [])
        .map((i) => `<h3>${esc(i.title)}</h3>\n<p>${esc(i.detail)}</p>`)
        .join("\n");
    }

    case "homepage": {
      const c = content as { sections: Section[] };
      return (c.sections ?? []).map(sectionHtml).join("\n");
    }

    case "about":
    case "contact":
    case "benefits":
    case "how_it_works":
    case "comparison":
    case "email_optin": {
      const c = content as { title: string; sections: Section[] };
      return [`<h1>${esc(c.title)}</h1>`, ...(c.sections ?? []).map(sectionHtml)].join("\n");
    }

    default:
      return `<pre>${esc(JSON.stringify(content, null, 2))}</pre>`;
  }
}

/** Which Shopify write, if any, a draft kind maps to. */
export function pushTargetFor(kind: string): "product" | "page" | "seo" | null {
  if (kind === "product_page") return "product";
  if (kind === "seo") return "seo";
  if (
    [
      "faq",
      "about",
      "contact",
      "shipping_policy",
      "refund_policy",
      "privacy_policy",
      "terms",
      "homepage",
      "benefits",
      "how_it_works",
      "comparison",
      "order_tracking_plan",
      "trust_sections",
    ].includes(kind)
  ) {
    return "page";
  }
  return null;
}
