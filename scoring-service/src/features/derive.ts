// Shared derivations; see contracts/feature_spec.md "Shared derivations".

export const DISPOSABLE_DOMAINS = new Set(["quickinbox.io", "tmpbox.net", "mailnow.xyz", "burnr.email"]);

const UNIT_SUFFIX = /\s+(apt|unit|suite|ste|#)\s*\S*$/i;
const HEADLESS = /headless|python-requests|curl|wget|phantomjs|selenium/i;

export interface AddressLike {
  line1?: string | undefined;
  postal_code: string;
  country: string;
}

export function addressKey(a: AddressLike): string {
  const line = (a.line1 ?? "").toLowerCase().trim().replace(UNIT_SUFFIX, "").replace(/\s+/g, " ");
  return `${a.country}|${a.postal_code}|${line}`;
}

export function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
}

export function emailParts(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf("@");
  return { local: email.slice(0, at).toLowerCase(), domain: email.slice(at + 1).toLowerCase() };
}

export function isHeadless(userAgent: string | undefined): boolean {
  return userAgent !== undefined && HEADLESS.test(userAgent);
}
