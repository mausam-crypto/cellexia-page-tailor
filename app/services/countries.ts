// Countries for the "Read live pages as a visitor from" setting. A store can
// show different product copy per country (Shopify Markets), and Shopify
// picks the country of an anonymous request from the caller's IP address -
// for the app that is wherever its server happens to be hosted. The setting
// pins the country so the copy the app adapts is the copy the merchant
// means. Shared by the server and the Settings screen (no server imports).

export const DEFAULT_PAGE_COUNTRY = "US";

// ISO 3166-1 alpha-2 (plus XK, which Shopify accepts).
export const COUNTRY_CODES: readonly string[] = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ " +
  "BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR " +
  "CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU " +
  "ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ " +
  "LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ " +
  "MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF " +
  "PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI " +
  "SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR " +
  "TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

const KNOWN = new Set(COUNTRY_CODES);

/** A stored or submitted value as a known country code; anything else
 *  becomes the default, so a bad value can never break page reading. */
export function normalizePageCountry(raw: unknown): string {
  const code = String(raw ?? "").trim().toUpperCase();
  return KNOWN.has(code) ? code : DEFAULT_PAGE_COUNTRY;
}

let displayNames: Intl.DisplayNames | null | undefined;

/** English country name for a code ("IE" -> "Ireland"); the code itself
 *  when the runtime cannot name it. */
export function countryName(code: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Select options, sorted by country name. */
export function countryOptions(): Array<{ label: string; value: string }> {
  return COUNTRY_CODES.map((code) => ({
    label: `${countryName(code)} (${code})`,
    value: code,
  })).sort((a, b) => a.label.localeCompare(b.label, "en"));
}

/**
 * The country the storefront actually rendered a page for, read from the
 * `Shopify.country = "XX"` line Shopify prints in every theme page; null
 * when the page does not carry it.
 */
export function renderedCountry(html: string): string | null {
  return /Shopify\.country\s*=\s*["']([A-Za-z]{2})["']/.exec(html)?.[1]?.toUpperCase() ?? null;
}
