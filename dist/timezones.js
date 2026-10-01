/**
 * A channel's own time zone, from its country -- for the second time column
 * on the title page's schedule ("21:30 here, 17:00 in the UK").
 *
 * One zone per country. Where a country spans several, this is the one its
 * national broadcasters schedule by (the capital's, or the most populous
 * region's): US -> New York, CA -> Toronto, RU -> Moscow, AU -> Sydney,
 * BR -> São Paulo, MX -> Mexico City, ID -> Jakarta. A regional channel in
 * another zone shows that zone's offset from the capital -- an
 * approximation, and labelled with the country so it reads as one.
 * Unknown countries get no second column rather than a guess.
 */
const ZONES = {
    AD: "Europe/Andorra", AE: "Asia/Dubai", AF: "Asia/Kabul", AL: "Europe/Tirane", AM: "Asia/Yerevan",
    AO: "Africa/Luanda", AR: "America/Argentina/Buenos_Aires", AT: "Europe/Vienna", AU: "Australia/Sydney",
    AZ: "Asia/Baku", BA: "Europe/Sarajevo", BD: "Asia/Dhaka", BE: "Europe/Brussels", BG: "Europe/Sofia",
    BH: "Asia/Bahrain", BO: "America/La_Paz", BR: "America/Sao_Paulo", BY: "Europe/Minsk", CA: "America/Toronto",
    CH: "Europe/Zurich", CL: "America/Santiago", CN: "Asia/Shanghai", CO: "America/Bogota", CR: "America/Costa_Rica",
    CU: "America/Havana", CY: "Asia/Nicosia", CZ: "Europe/Prague", DE: "Europe/Berlin", DK: "Europe/Copenhagen",
    DO: "America/Santo_Domingo", DZ: "Africa/Algiers", EC: "America/Guayaquil", EE: "Europe/Tallinn", EG: "Africa/Cairo",
    ES: "Europe/Madrid", ET: "Africa/Addis_Ababa", FI: "Europe/Helsinki", FR: "Europe/Paris", GB: "Europe/London",
    GE: "Asia/Tbilisi", GH: "Africa/Accra", GR: "Europe/Athens", GT: "America/Guatemala", HK: "Asia/Hong_Kong",
    HN: "America/Tegucigalpa", HR: "Europe/Zagreb", HU: "Europe/Budapest", ID: "Asia/Jakarta", IE: "Europe/Dublin",
    IL: "Asia/Jerusalem", IN: "Asia/Kolkata", IQ: "Asia/Baghdad", IR: "Asia/Tehran", IS: "Atlantic/Reykjavik",
    IT: "Europe/Rome", JM: "America/Jamaica", JO: "Asia/Amman", JP: "Asia/Tokyo", KE: "Africa/Nairobi",
    KH: "Asia/Phnom_Penh", KR: "Asia/Seoul", KW: "Asia/Kuwait", KZ: "Asia/Almaty", LB: "Asia/Beirut",
    LK: "Asia/Colombo", LT: "Europe/Vilnius", LU: "Europe/Luxembourg", LV: "Europe/Riga", LY: "Africa/Tripoli",
    MA: "Africa/Casablanca", MD: "Europe/Chisinau", ME: "Europe/Podgorica", MK: "Europe/Skopje", MM: "Asia/Yangon",
    MN: "Asia/Ulaanbaatar", MT: "Europe/Malta", MX: "America/Mexico_City", MY: "Asia/Kuala_Lumpur", NG: "Africa/Lagos",
    NI: "America/Managua", NL: "Europe/Amsterdam", NO: "Europe/Oslo", NP: "Asia/Kathmandu", NZ: "Pacific/Auckland",
    OM: "Asia/Muscat", PA: "America/Panama", PE: "America/Lima", PH: "Asia/Manila", PK: "Asia/Karachi",
    PL: "Europe/Warsaw", PR: "America/Puerto_Rico", PS: "Asia/Gaza", PT: "Europe/Lisbon", PY: "America/Asuncion",
    QA: "Asia/Qatar", RO: "Europe/Bucharest", RS: "Europe/Belgrade", RU: "Europe/Moscow", SA: "Asia/Riyadh",
    SD: "Africa/Khartoum", SE: "Europe/Stockholm", SG: "Asia/Singapore", SI: "Europe/Ljubljana", SK: "Europe/Bratislava",
    SN: "Africa/Dakar", SV: "America/El_Salvador", SY: "Asia/Damascus", TH: "Asia/Bangkok", TN: "Africa/Tunis",
    TR: "Europe/Istanbul", TT: "America/Port_of_Spain", TW: "Asia/Taipei", TZ: "Africa/Dar_es_Salaam", UA: "Europe/Kyiv",
    UG: "Africa/Kampala", US: "America/New_York", UY: "America/Montevideo", UZ: "Asia/Tashkent", VE: "America/Caracas",
    VN: "Asia/Ho_Chi_Minh", XK: "Europe/Belgrade", YE: "Asia/Aden", ZA: "Africa/Johannesburg", ZM: "Africa/Lusaka",
    ZW: "Africa/Harare"
};
/** The IANA zone a channel from `country` schedules by, or "". */
export function zoneForCountry(country) {
    const code = String(country || "").trim().toUpperCase();
    return ZONES[code === "UK" ? "GB" : code] || "";
}
