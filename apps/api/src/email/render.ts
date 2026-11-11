export interface TemplateVars {
  first_name: string | null;
  review_link: string;
  order_name: string;
  shop_name: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface LegalFooter {
  unsubscribeUrl: string;
  legalBasisNotice: string; // z. B. Hinweis auf Widerspruchsrecht (§ 7 Abs. 3 Nr. 4 UWG)
  imprint: string; // Absenderangaben
}

export const ALLOWED_PLACEHOLDERS = ["first_name", "review_link", "order_name", "shop_name"] as const;

export function findUnknownPlaceholders(template: string): string[] {
  const found = [...template.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!);
  return found.filter((p) => !(ALLOWED_PLACEHOLDERS as readonly string[]).includes(p));
}

function substitute(template: string, vars: TemplateVars): string {
  let out = template;
  // Fehlender Vorname: "Hallo {{first_name}}," → "Hallo,"
  if (!vars.first_name?.trim()) out = out.replace(/[ \t]*\{\{\s*first_name\s*\}\}/g, "");
  return out.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key: string) => {
    const v = (vars as unknown as Record<string, string | null>)[key];
    return v ?? "";
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderEmail(subjectTpl: string, bodyTpl: string, vars: TemplateVars, footer: LegalFooter): RenderedEmail {
  const subject = substitute(subjectTpl, { ...vars, review_link: "" }).replace(/\s+/g, " ").trim();
  const body = substitute(bodyTpl, vars).trim();
  const footerText = `\n\n—\n${footer.legalBasisNotice}\nKeine Bewertungsanfragen mehr? Hier austragen: ${footer.unsubscribeUrl}\n${footer.imprint}`;
  const text = body + footerText;

  const htmlBody = body
    .split(/\n{2,}/)
    .map((para) => {
      const trimmed = para.trim();
      if (trimmed === vars.review_link) {
        return `<p style="margin:24px 0"><a href="${escapeHtml(vars.review_link)}" style="background:#1f2937;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Jetzt bewerten</a></p>`;
      }
      const escaped = escapeHtml(trimmed).replace(/\n/g, "<br>");
      return `<p style="margin:0 0 16px">${escaped.split(escapeHtml(vars.review_link)).join(`<a href="${escapeHtml(vars.review_link)}">${escapeHtml(vars.review_link)}</a>`)}</p>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:600px;margin:0 auto;padding:24px">
${htmlBody}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px">
<p style="font-size:12px;color:#6b7280">${escapeHtml(footer.legalBasisNotice)}<br>
Keine Bewertungsanfragen mehr? <a href="${escapeHtml(footer.unsubscribeUrl)}" style="color:#374151;text-decoration:underline">Hier austragen</a><br>${escapeHtml(footer.imprint)}</p>
</body></html>`;
  return { subject, text, html };
}

export const DEFAULT_TEMPLATES: { step: number; subject: string; body: string }[] = [
  {
    step: 1,
    subject: "Wie zufrieden bist du mit deiner Bestellung bei Adfunture?",
    body: `Hallo {{first_name}},

vielen Dank für deine Bestellung bei Adfunture!

Wir hoffen, dass alles gut bei dir angekommen ist.

Wir würden uns freuen, wenn du dir kurz Zeit nimmst und deine Einkaufserfahrung bewertest.

{{review_link}}

Vielen Dank für deine Unterstützung!

Liebe Grüße
Dein Adfunture-Team`,
  },
  {
    step: 2,
    subject: "Deine Meinung zu Adfunture ist uns wichtig",
    body: `Hallo {{first_name}},

vor einigen Tagen haben wir dich um eine Bewertung deiner Bestellung gebeten.

Falls du noch nicht dazu gekommen bist, freuen wir uns über dein Feedback.

{{review_link}}

Vielen Dank!

Liebe Grüße
Dein Adfunture-Team`,
  },
  {
    step: 3,
    subject: "Eine letzte Bitte um dein Feedback",
    body: `Hallo {{first_name}},

wir möchten dich ein letztes Mal einladen, deine Einkaufserfahrung bei Adfunture zu bewerten.

Deine Rückmeldung hilft uns, unseren Service weiterzuentwickeln.

{{review_link}}

Vielen Dank und liebe Grüße
Dein Adfunture-Team`,
  },
];

/**
 * Vorlagen speziell für das Google-Unternehmensprofil (Scope "GOOGLE_BUSINESS"). Neutral formuliert
 * („ganz gleich, wie sie ausgefallen ist“) – kein Anreiz, keine Bitte um positive Bewertungen.
 */
export const GOOGLE_BUSINESS_TEMPLATES: { step: number; subject: string; body: string }[] = [
  {
    step: 1,
    subject: "Wie zufrieden bist du mit Adfunture? Teile deine Erfahrung auf Google",
    body: `Hallo {{first_name}},

vielen Dank für deine Bestellung {{order_name}} bei Adfunture!

Wir hoffen, dass alles gut bei dir angekommen ist.

Wir würden uns freuen, wenn du dir kurz Zeit nimmst und deine Erfahrung mit uns auf Google teilst – ganz gleich, wie sie ausgefallen ist. Deine ehrliche Meinung hilft anderen Outdoor-Fans bei ihrer Entscheidung.

{{review_link}}

Für die Bewertung brauchst du ein Google-Konto.

Vielen Dank für deine Unterstützung!

Liebe Grüße
Dein Adfunture-Team`,
  },
  {
    step: 2,
    subject: "Deine Meinung zu Adfunture ist uns wichtig",
    body: `Hallo {{first_name}},

vor einigen Tagen haben wir dich gebeten, deine Erfahrung mit Adfunture auf Google zu teilen.

Falls du noch nicht dazu gekommen bist, freuen wir uns über dein ehrliches Feedback.

{{review_link}}

Vielen Dank!

Liebe Grüße
Dein Adfunture-Team`,
  },
  {
    step: 3,
    subject: "Eine letzte Bitte um dein Feedback",
    body: `Hallo {{first_name}},

wir möchten dich ein letztes Mal einladen, deine Einkaufserfahrung bei Adfunture auf Google zu bewerten.

Deine Rückmeldung hilft uns, unseren Service weiterzuentwickeln.

{{review_link}}

Vielen Dank und liebe Grüße
Dein Adfunture-Team`,
  },
];

/**
 * Vorlagen für idealo (Scope "IDEALO"). Das idealo-Formular verlangt die Bestellnummer – sie steht deshalb in der Mail.
 */
export const IDEALO_TEMPLATES: { step: number; subject: string; body: string }[] = [
  {
    step: 1,
    subject: "Du hast über idealo bei Adfunture bestellt – wie war dein Einkauf?",
    body: `Hallo {{first_name}},

vielen Dank für deine Bestellung bei Adfunture, die du über idealo gefunden hast!

Wir hoffen, dass alles gut bei dir angekommen ist.

Wir würden uns freuen, wenn du deine Erfahrung mit uns auf idealo teilst – ganz gleich, wie sie ausgefallen ist. Deine ehrliche Meinung hilft anderen bei der Wahl des passenden Shops.

{{review_link}}

idealo fragt im Formular nach deiner Bestellnummer: {{order_name}}

Vielen Dank für deine Unterstützung!

Liebe Grüße
Dein Adfunture-Team`,
  },
  {
    step: 2,
    subject: "Deine Meinung zu Adfunture ist uns wichtig",
    body: `Hallo {{first_name}},

vor einigen Tagen haben wir dich gebeten, deine Erfahrung mit Adfunture auf idealo zu teilen.

Falls du noch nicht dazu gekommen bist, freuen wir uns über dein ehrliches Feedback.

{{review_link}}

Deine Bestellnummer für das Formular: {{order_name}}

Vielen Dank!

Liebe Grüße
Dein Adfunture-Team`,
  },
  {
    step: 3,
    subject: "Eine letzte Bitte um dein Feedback",
    body: `Hallo {{first_name}},

wir möchten dich ein letztes Mal einladen, deine Einkaufserfahrung bei Adfunture auf idealo zu bewerten.

{{review_link}}

Deine Bestellnummer für das Formular: {{order_name}}

Vielen Dank und liebe Grüße
Dein Adfunture-Team`,
  },
];
