const USD_M_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COIN_M_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";
const ANNOUNCEMENT_CATALOG_ID = 161;
const ANNOUNCEMENT_PAGE_SIZE = 50;
const ANNOUNCEMENT_INCREMENTAL_PAGES = 2;
const CACHE_TTL_SECONDS = 30 * 60;
const ANNOUNCEMENT_PAGE_CACHE_TTL_MS = 60 * 1000;
const ANNOUNCEMENT_TITLE_KEYWORDS = [
  "DELIST",
  "DELISTING",
  "CEASE SUPPORT",
  "POSTPONED",
];
const DELIST_TIME_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*\(UTC\+?8\)/i,
  /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*\(UTC\)/i,
  /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*UTC(?:\+?8)?/i,
  /\b[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}\s+\d{2}:\d{2}\s*\(UTC\+?8\)/i,
  /\b[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4}\s+\d{2}:\d{2}\s*\(UTC\)/i,
  /\b\d{4}年\d{2}月\d{2}日\s+\d{2}:\d{2}\s*[（(]?(?:东八区时间|UTC\+?8|UTC)[）)]?/i,
];
const DELIST_TIME_CONTEXT_PATTERNS = [
  /(stop trading|cease trading|delist|remove|suspend trading|terminate trading|will no longer support|停止交易|下架)[^.!?]{0,120}/i,
  /[^.!?]{0,120}(stop trading|cease trading|delist|remove|suspend trading|terminate trading|will no longer support|停止交易|下架)/i,
];

let announcementPageCache = null;
let announcementPageCacheAt = 0;
const announcementDetailCache = new Map();
const trackedAnnouncementArticles = new Map();
let contractsPayloadCache = null;
let contractsPayloadCacheAt = 0;
let contractsPayloadRefreshPromise = null;

function buildContract(item, market, status) {
  const underlyingSubType = Array.isArray(item.underlyingSubType) ? item.underlyingSubType : [];

  return {
    symbol: item.symbol,
    pair: item.pair,
    market,
    baseAsset: item.baseAsset,
    quoteAsset: item.quoteAsset,
    marginAsset: item.marginAsset,
    underlyingType: item.underlyingType,
    underlyingSubType,
    tokenCategory: underlyingSubType.length ? underlyingSubType.join(" / ") : item.underlyingType || "Unknown",
    contractType: item.contractType,
    status,
    onboardDate: item.onboardDate,
    deliveryDate: item.deliveryDate,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cf: {
      cacheTtl: CACHE_TTL_SECONDS,
      cacheEverything: false,
    },
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Binance API request failed: ${response.status}`);
  }

  return response.json();
}

function buildAnnouncementListUrl(pageNo) {
  return `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${ANNOUNCEMENT_CATALOG_ID}&pageNo=${pageNo}&pageSize=${ANNOUNCEMENT_PAGE_SIZE}`;
}

function buildAnnouncementDetailUrl(code) {
  return `https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode=${encodeURIComponent(code)}`;
}

function normalizeText(value) {
  return String(value || "").toUpperCase();
}

function extractTextFromBody(body) {
  if (!body) {
    return "";
  }

  let parsedBody = body;
  if (typeof parsedBody === "string") {
    try {
      parsedBody = JSON.parse(parsedBody);
    } catch (_error) {
      return body;
    }
  }

  const chunks = [];

  function walk(value, key = "") {
    if (typeof value === "string") {
      if (key === "text" || key === "content") {
        chunks.push(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, key));
      return;
    }

    if (value && typeof value === "object") {
      Object.keys(value).forEach((childKey) => walk(value[childKey], childKey));
    }
  }

  walk(parsedBody);
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function extractAnnouncementDelistTimeText(bodyText) {
  if (!bodyText) {
    return null;
  }

  for (const contextPattern of DELIST_TIME_CONTEXT_PATTERNS) {
    const contextMatch = bodyText.match(contextPattern);
    if (!contextMatch) {
      continue;
    }

    const context = contextMatch[0];
    for (const timePattern of DELIST_TIME_PATTERNS) {
      const timeMatch = context.match(timePattern);
      if (timeMatch) {
        return timeMatch[0].trim();
      }
    }
  }

  for (const timePattern of DELIST_TIME_PATTERNS) {
    const match = bodyText.match(timePattern);
    if (match) {
      return match[0].trim();
    }
  }

  return null;
}

function parseAnnouncementDelistTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  let match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(?:\((UTC(?:\+?8)?)\)|\s+(UTC(?:\+?8)?))$/i
  );
  if (match) {
    const [, year, month, day, hour, minute, second = "00", zoneA, zoneB] = match;
    const zone = String(zoneA || zoneB || "UTC").toUpperCase();
    const offsetHours = zone.includes("+8") ? 8 : 0;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - offsetHours,
      Number(minute),
      Number(second)
    );
  }

  match = text.match(
    /^(\d{4})年(\d{2})月(\d{2})日\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*[（(]?(东八区时间|UTC\+?8|UTC)[）)]?$/i
  );
  if (match) {
    const [, year, month, day, hour, minute, second = "00", zoneText] = match;
    const zone = String(zoneText || "UTC").toUpperCase();
    const offsetHours = zone.includes("8") || zone.includes("东八区") ? 8 : 0;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - offsetHours,
      Number(minute),
      Number(second)
    );
  }

  return null;
}

function extractAnnouncementAssetsFromTitle(title) {
  const normalizedTitle = String(title || "");
  const matched = normalizedTitle.match(/DELIST\s+(.+?)\s+ON\s+\d{4}-\d{2}-\d{2}/i);
  if (!matched) {
    return [];
  }

  return matched[1]
    .split(/,|\s+AND\s+/i)
    .map((item) => item.trim().replace(/[^A-Z0-9_-]/gi, ""))
    .filter(Boolean)
    .map((item) => normalizeText(item));
}

function extractAnnouncementAssetsFromBody(bodyText) {
  const matches = bodyText.match(/\(([A-Z0-9]{2,15})\)/g) || [];
  return matches.map((item) => normalizeText(item.replace(/[()]/g, "")));
}

function buildAnnouncementMatcherSet(items) {
  const values = new Set();
  items.forEach((item) => {
    values.add(normalizeText(item.baseAsset));
  });
  values.delete("");
  return values;
}

function shouldInspectAnnouncement(article, matcherSet) {
  const title = normalizeText(article.title);
  const keywordHit = ANNOUNCEMENT_TITLE_KEYWORDS.some((keyword) => title.includes(keyword));
  if (!keywordHit) {
    return false;
  }

  return [...matcherSet].some((value) => value && title.includes(value));
}

function scoreAnnouncementMatch(contract, announcement) {
  const baseAsset = normalizeText(contract.baseAsset);
  let score = 0;

  if (announcement.assets.includes(baseAsset)) {
    score += 100;
  }

  return score;
}

async function fetchDelistAnnouncementMetadata(items) {
  if (!items.length) {
    return [];
  }

  const matcherSet = buildAnnouncementMatcherSet(items);
  const pagePayloads = await fetchAnnouncementPagePayloads();

  const latestCandidateArticles = pagePayloads
    .flatMap((payload) => payload?.data?.catalogs?.[0]?.articles || [])
    .map((article) => ({
      ...article,
      titleAssets: extractAnnouncementAssetsFromTitle(article.title),
    }))
    .filter((article) => shouldInspectAnnouncement(article, matcherSet))
    .filter((article) => article.titleAssets.some((asset) => matcherSet.has(asset)));

  latestCandidateArticles.forEach((article) => {
    trackedAnnouncementArticles.set(article.code, article);
  });

  const trackedCandidateArticles = [...trackedAnnouncementArticles.values()].filter((article) =>
    article.titleAssets.some((asset) => matcherSet.has(asset))
  );

  const details = await fetchAnnouncementDetails(trackedCandidateArticles);

  const nowMs = Date.now();
  const announcements = details.filter((item) => item && item.assets.length > 0 && item.delistTimestamp && item.delistTimestamp >= nowMs);

  const latestCodes = new Set(latestCandidateArticles.map((article) => article.code));
  const futureCodes = new Set(announcements.map((announcement) => announcement.code));
  [...trackedAnnouncementArticles.keys()].forEach((code) => {
    if (!latestCodes.has(code) && !futureCodes.has(code)) {
      trackedAnnouncementArticles.delete(code);
    }
  });

  return items.map((item) => {
    const bestMatch = announcements
      .map((announcement) => ({
        announcement,
        score: scoreAnnouncementMatch(item, announcement),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return (right.announcement.releaseDate || 0) - (left.announcement.releaseDate || 0);
      })[0];

    if (!bestMatch) {
      return null;
    }

    return {
      ...item,
      announcementPublishedAt: bestMatch.announcement.releaseDate || null,
      announcementDelistTimeText: bestMatch.announcement.delistTimeText || null,
    };
  }).filter(Boolean);
}

async function fetchAnnouncementPagePayloads() {
  if (announcementPageCache && Date.now() - announcementPageCacheAt < ANNOUNCEMENT_PAGE_CACHE_TTL_MS) {
    return announcementPageCache;
  }

  const payloads = (
    await Promise.all(
      Array.from({ length: ANNOUNCEMENT_INCREMENTAL_PAGES }, (_, index) =>
        fetchJson(buildAnnouncementListUrl(index + 1)).catch(() => null)
      )
    )
  ).filter(Boolean);

  announcementPageCache = payloads;
  announcementPageCacheAt = Date.now();
  return payloads;
}

async function fetchAnnouncementDetails(candidateArticles) {
  const uncachedArticles = candidateArticles.filter((article) => !announcementDetailCache.has(article.code));
  const fetchedRows = await Promise.all(
    uncachedArticles.map(async (article) => {
      try {
        const detailPayload = await fetchJson(buildAnnouncementDetailUrl(article.code));
        const detail = detailPayload?.data || {};
        const bodyText = extractTextFromBody(detail.body);
        return [
          article.code,
          {
            code: article.code,
            title: article.title,
            releaseDate: article.releaseDate,
            delistTimeText: extractAnnouncementDelistTimeText(bodyText),
            delistTimestamp: parseAnnouncementDelistTime(extractAnnouncementDelistTimeText(bodyText)),
            assets: [...new Set([...(article.titleAssets || []), ...extractAnnouncementAssetsFromBody(bodyText)])],
          },
        ];
      } catch (_error) {
        return [article.code, null];
      }
    })
  );

  fetchedRows.forEach(([code, row]) => {
    announcementDetailCache.set(code, row);
  });

  return candidateArticles.map((article) => announcementDetailCache.get(article.code)).filter(Boolean);
}

function normalizePayload(usdmPayload, coinmPayload) {
  const usdm = (usdmPayload.symbols || [])
    .filter((item) => item.status === "TRADING")
    .map((item) => buildContract(item, "USD-M", item.status));

  const coinm = (coinmPayload.symbols || [])
    .filter((item) => item.contractStatus === "TRADING")
    .map((item) => buildContract(item, "COIN-M", item.contractStatus));

  const contracts = [...usdm, ...coinm].sort((a, b) => {
    return (a.onboardDate || 0) - (b.onboardDate || 0) || String(a.symbol || "").localeCompare(String(b.symbol || ""));
  });

  return { contracts, delistAnnouncements: [] };
}

async function rebuildContractsPayload() {
  const [usdmPayload, coinmPayload] = await Promise.all([fetchJson(USD_M_URL), fetchJson(COIN_M_URL)]);
  const payload = normalizePayload(usdmPayload, coinmPayload);
  const enrichedDelistAnnouncements = await fetchDelistAnnouncementMetadata(payload.contracts);
  const delistSymbols = new Set(enrichedDelistAnnouncements.map((item) => `${item.market}:${item.symbol}`));
  const activeContracts = payload.contracts.filter((item) => !delistSymbols.has(`${item.market}:${item.symbol}`));
  return {
    contracts: activeContracts,
    delistAnnouncements: enrichedDelistAnnouncements,
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    refreshing: false,
  };
}

function hasFreshContractsCache() {
  return contractsPayloadCache && Date.now() - contractsPayloadCacheAt < CACHE_TTL_SECONDS * 1000;
}

function startContractsBackgroundRefresh() {
  if (contractsPayloadRefreshPromise) {
    return contractsPayloadRefreshPromise;
  }

  contractsPayloadRefreshPromise = rebuildContractsPayload()
    .then((payload) => {
      contractsPayloadCache = payload;
      contractsPayloadCacheAt = Date.now();
    })
    .finally(() => {
      contractsPayloadRefreshPromise = null;
    });

  return contractsPayloadRefreshPromise;
}

function buildContractsResponseBody(refreshing = false) {
  return JSON.stringify({
    ...contractsPayloadCache,
    refreshing,
  });
}

export async function onRequestGet(context) {
  try {
    const force = new URL(context.request.url).searchParams.get("force") === "1";
    let body;

    if (contractsPayloadCache && hasFreshContractsCache()) {
      if (force) {
        context.waitUntil(startContractsBackgroundRefresh());
        body = buildContractsResponseBody(true);
      } else {
        body = buildContractsResponseBody(Boolean(contractsPayloadRefreshPromise));
      }
    } else if (contractsPayloadCache) {
      context.waitUntil(startContractsBackgroundRefresh());
      body = buildContractsResponseBody(true);
    } else {
      contractsPayloadCache = await rebuildContractsPayload();
      contractsPayloadCacheAt = Date.now();
      body = buildContractsResponseBody(false);
    }

    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch Binance contracts",
        message: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 502,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
      }
    );
  }
}
