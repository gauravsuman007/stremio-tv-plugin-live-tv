/**
 * How a channel is GROUPED for browsing: one genre, its languages, its
 * part of the world.
 *
 * WHY A FIXED VOCABULARY, AND WHY HERE
 * ------------------------------------
 * Every scraper writes `categories` its own way -- iptv-org's thirty-odd
 * lowercase words, a sports site's "All Soccer Events", a Brazilian
 * directory's Portuguese. A browse page built on those raw strings has
 * sixty groups, half of them with one channel in. So the page groups by a
 * dozen genres a person would recognise from any TV guide, and every raw
 * category is MAPPED onto one of them here, in one table, rather than
 * asking each scraper to agree on a list it cannot see. Anything unmapped
 * lands in General, which is honest: it is a channel nobody described.
 *
 * Language is the other axis, and for Indian television it is the FIRST
 * one: the same genre exists in a dozen languages, and a Tamil viewer
 * scrolling past Hindi news is not browsing, they are wading. iptv-org
 * tags languages; most other scrapers do not, so for Indian channels with
 * none the language is guessed from the name ("Sun TV" is Tamil) -- a
 * small, conservative table, because a wrong guess files a channel under
 * the wrong language where its viewers will never look.
 */
/** In the order the browse page lists them. */
export const GENRES = [
    { id: "news", label: "News" },
    { id: "entertainment", label: "Entertainment" },
    { id: "movies", label: "Movies" },
    { id: "sports", label: "Sports" },
    { id: "kids", label: "Kids" },
    { id: "music", label: "Music" },
    { id: "documentary", label: "Documentary" },
    { id: "lifestyle", label: "Lifestyle" },
    { id: "business", label: "Business" },
    { id: "devotional", label: "Devotional" },
    { id: "general", label: "General" }
];
/**
 * Never listed on the browse pages. Shopping channels are adverts, and
 * adult channels are not something a family television should offer to a
 * remote; both stay reachable by search and by country, where somebody
 * asked for them by name.
 */
const HIDDEN = new Set(["xxx", "shop", "shopping", "adult"]);
/** Raw category words (lowercased) -> genre id. First match wins, in the
 *  channel's own category order. */
const ALIASES = {
    news: "news",
    weather: "news",
    legislative: "news",
    politics: "news",
    noticias: "news",
    entertainment: "entertainment",
    series: "entertainment",
    comedy: "entertainment",
    family: "entertainment",
    culture: "entertainment",
    "general entertainment": "entertainment",
    reality: "entertainment",
    drama: "entertainment",
    movies: "movies",
    movie: "movies",
    films: "movies",
    film: "movies",
    cinema: "movies",
    classic: "movies",
    filmes: "movies",
    sports: "sports",
    sport: "sports",
    outdoor: "sports",
    auto: "sports",
    soccer: "sports",
    football: "sports",
    cricket: "sports",
    tennis: "sports",
    esportes: "sports",
    deportes: "sports",
    kids: "kids",
    animation: "kids",
    children: "kids",
    cartoons: "kids",
    infantil: "kids",
    music: "music",
    musica: "music",
    "música": "music",
    documentary: "documentary",
    science: "documentary",
    education: "documentary",
    history: "documentary",
    nature: "documentary",
    lifestyle: "lifestyle",
    cooking: "lifestyle",
    food: "lifestyle",
    travel: "lifestyle",
    relax: "lifestyle",
    fashion: "lifestyle",
    business: "business",
    finance: "business",
    religious: "devotional",
    religion: "devotional",
    devotional: "devotional",
    spiritual: "devotional",
    general: "general"
};
/** When a channel carries no category at all: guessed from its name, the
 *  way a person scanning a channel list would. */
const BY_NAME = [
    [/\b(news|samachar|khabar|taas|tak|noticias|nachrichten|journal)\b/i, "news"],
    [/\b(sports?|espn|cricket|football|soccer|racing|golf|tennis|arena|bein|dazn)\b/i, "sports"],
    [/\b(kids|junior|cartoon|nick|disney|pogo|toons?|baby)\b/i, "kids"],
    [/\b(music|beats|hits|mtv|9xm|radio|fm)\b/i, "music"],
    [/\b(movies?|cinema|films?|flix)\b/i, "movies"],
    [/\b(bhakti|aastha|sanskar|devotional|gurbani|darshan|church|gospel|quran|islam|catholic|god tv|peace tv)\b/i, "devotional"],
    [/\b(discovery|history|nat geo|national geographic|documentar)/i, "documentary"],
    [/\b(food|cook|travel|living|lifestyle|home)\b/i, "lifestyle"],
    [/\b(business|bloomberg|cnbc|money|finance)\b/i, "business"]
];
const genreCache = new WeakMap();
/** The genre this channel is browsed under, or `null` when it should not
 *  be browsed at all (see `HIDDEN`). */
export function genreOf(channel) {
    const cached = genreCache.get(channel);
    if (cached !== undefined)
        return cached;
    let found = null;
    const words = channel.categories.map((category) => category.trim().toLowerCase());
    if (words.some((word) => HIDDEN.has(word))) {
        found = null;
    }
    else {
        for (const word of words) {
            const hit = ALIASES[word];
            if (hit && hit !== "general") {
                found = hit;
                break;
            }
        }
        if (!found) {
            for (const [pattern, genre] of BY_NAME) {
                if (pattern.test(channel.name)) {
                    found = genre;
                    break;
                }
            }
        }
        if (!found)
            found = "general";
    }
    genreCache.set(channel, found);
    return found;
}
export function genreLabel(id) {
    return GENRES.find((genre) => genre.id === id)?.label || id;
}
/** ISO 639-3 -> the name people use. The languages that matter most here
 *  first; anything else falls back to the host's own table. */
const LANGUAGE_NAMES = {
    hin: "Hindi",
    eng: "English",
    tam: "Tamil",
    tel: "Telugu",
    mal: "Malayalam",
    kan: "Kannada",
    ben: "Bengali",
    mar: "Marathi",
    pan: "Punjabi",
    guj: "Gujarati",
    ori: "Odia",
    ory: "Odia",
    asm: "Assamese",
    urd: "Urdu",
    bho: "Bhojpuri",
    nep: "Nepali",
    sin: "Sinhala",
    spa: "Spanish",
    por: "Portuguese",
    fra: "French",
    deu: "German",
    ita: "Italian",
    ara: "Arabic",
    tur: "Turkish",
    rus: "Russian",
    zho: "Chinese",
    jpn: "Japanese",
    kor: "Korean",
    pol: "Polish",
    nld: "Dutch",
    ell: "Greek",
    fas: "Persian",
    ind: "Indonesian",
    msa: "Malay",
    tha: "Thai",
    vie: "Vietnamese",
    heb: "Hebrew",
    ron: "Romanian",
    swe: "Swedish",
    ukr: "Ukrainian",
    srp: "Serbian",
    hrv: "Croatian",
    bul: "Bulgarian",
    ces: "Czech",
    hun: "Hungarian",
    dan: "Danish",
    nor: "Norwegian",
    fin: "Finnish",
    tgl: "Filipino",
    fil: "Filipino",
    swa: "Swahili",
    amh: "Amharic"
};
export function languageLabel(code, fallback) {
    return LANGUAGE_NAMES[code] || fallback(code) || code;
}
/** Indian channels with no language tag: the name usually says it. */
const INDIAN_BY_NAME = [
    [/\b(tamil|sun (tv|news|music)|ktv|polimer|puthiya|thanthi|kalaignar|jaya (tv|plus)|vijay|raj (tv|news)|sathiyam|news ?7 tamil|adithya)\b/i, "tam"],
    [/\b(telugu|gemini|tv ?9 telugu|ntv telugu|sakshi|tv5 news|abn|v6 news|etv (telugu|andhra|telangana)|maa (tv|movies))\b/i, "tel"],
    [/\b(malayalam|asianet|mazhavil|manorama|mathrubhumi|kairali|surya (tv|movies)|flowers|janam|amrita|media ?one|24 news)\b/i, "mal"],
    [/\b(kannada|udaya|suvarna|tv ?9 kannada|public (tv|music)|colors kannada)\b/i, "kan"],
    [/\b(bangla|bengali|ananda|kolkata|ruposhi|aakash aath|sangeet bangla|jalsha|zee 24 ghanta)\b/i, "ben"],
    [/\b(marathi|majha|saam|lokshahi|tv ?9 marathi|zee 24 taas|mi marathi)\b/i, "mar"],
    [/\b(punjabi|ptc|pitaara|jus punjabi|chardikla)\b/i, "pan"],
    [/\b(gujarati|gstv|sandesh|tv ?9 gujarati|vtv)\b/i, "guj"],
    [/\b(odia|odisha|kanak|otv|sarthak)\b/i, "ori"],
    [/\b(assam|pratidin|dy ?365)\b/i, "asm"],
    [/\b(bhojpuri)\b/i, "bho"]
];
const languageCache = new WeakMap();
/** The channel's languages, with a guess for an untagged Indian channel. */
export function languagesOf(channel) {
    const cached = languageCache.get(channel);
    if (cached)
        return cached;
    let found = channel.languages;
    if (!found.length && channel.country === "IN") {
        const hit = INDIAN_BY_NAME.find(([pattern]) => pattern.test(channel.name));
        if (hit)
            found = [hit[1]];
    }
    languageCache.set(channel, found);
    return found;
}
/*
    THE PARTS OF THE WORLD, for the World TV page.

    iptv-org's codes, which are ISO 3166-1 alpha-2 except "UK" for the
    United Kingdom -- both spellings are listed so either source works. A
    code missing here is shown under "Elsewhere" rather than dropped.
*/
const CONTINENTS = [
    ["asia", "AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE AE"],
    ["europe", "AD AL AT BA BE BG BY CH CZ DE DK EE ES FI FO FR GB UK GI GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK"],
    ["africa", "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW RE"],
    ["north-america", "US CA MX GL BM"],
    ["latin-america", "AG AI AR AW BB BO BQ BR BS BZ CL CO CR CU CW DM DO EC GD GT GY HN HT JM KN KY LC NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI MQ GP GF"],
    ["oceania", "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS"]
];
export const CONTINENT_LABELS = {
    asia: "Asia",
    europe: "Europe",
    africa: "Africa",
    "north-america": "North America",
    "latin-america": "Latin America & Caribbean",
    oceania: "Oceania",
    elsewhere: "Elsewhere"
};
const continentOfCode = new Map();
for (const [continent, codes] of CONTINENTS) {
    for (const code of codes.split(" "))
        continentOfCode.set(code, continent);
}
export function continentOf(code) {
    return continentOfCode.get(code.toUpperCase()) || "elsewhere";
}
