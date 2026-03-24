const SPOT_URL = "https://api.binance.com/api/v3/exchangeInfo";
const USD_M_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COIN_M_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";
const USD_M_FUNDING_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";
const COIN_M_FUNDING_URL = "https://dapi.binance.com/dapi/v1/premiumIndex";
const ANNOUNCEMENT_CATALOG_ID = 161;
const ANNOUNCEMENT_PAGE_SIZE = 50;
const ANNOUNCEMENT_INCREMENTAL_PAGES = 2;
const CACHE_TTL_SECONDS = 60;
const ANNOUNCEMENT_PAGE_CACHE_TTL_MS = 30 * 1000;
const ANNOUNCEMENT_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const ANNOUNCEMENT_TITLE_KEYWORDS = [
  "DELIST",
  "DELISTING",
  "CEASE SUPPORT",
  "POSTPONED",
];
const INCLUDED_CONTRACT_STATUSES = new Set(["TRADING", "SETTLING"]);
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

function buildContract(item, market, status, fundingInfo = null) {
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
    fundingRate: fundingInfo?.fundingRate ?? null,
    nextFundingTime: fundingInfo?.nextFundingTime ?? null,
    fundingUpdatedAt: fundingInfo?.fundingUpdatedAt ?? null,
  };
}

function buildFundingMap(payload, key = "symbol") {
  const values = new Map();

  (Array.isArray(payload) ? payload : []).forEach((item) => {
    const lookupKey = String(item?.[key] || item?.symbol || "").trim();
    if (!lookupKey) {
      return;
    }

    values.set(lookupKey, {
      fundingRate: item?.lastFundingRate ?? null,
      nextFundingTime: item?.nextFundingTime ?? null,
      fundingUpdatedAt: item?.time ?? null,
    });
  });

  return values;
}

function pickPreferredSpotSymbol(symbols) {
  const preferredQuotes = ["USDT", "FDUSD", "USDC", "BUSD", "BTC", "ETH"];
  const ordered = [...symbols].sort((left, right) => {
    const leftRank = preferredQuotes.indexOf(left.quoteAsset);
    const rightRank = preferredQuotes.indexOf(right.quoteAsset);
    return (leftRank === -1 ? 999 : leftRank) - (rightRank === -1 ? 999 : rightRank) || String(left.symbol).localeCompare(String(right.symbol));
  });

  return ordered[0] || null;
}

function buildSpotAssetMap(spotPayload) {
  const values = new Map();

  (spotPayload?.symbols || []).forEach((item) => {
    if (item?.status !== "TRADING" || item?.isSpotTradingAllowed === false) {
      return;
    }

    const baseAsset = normalizeText(item.baseAsset);
    if (!baseAsset) {
      return;
    }

    const current = values.get(baseAsset) || [];
    current.push({
      symbol: item.symbol,
      baseAsset: item.baseAsset,
      quoteAsset: item.quoteAsset,
    });
    values.set(baseAsset, current);
  });

  values.forEach((symbols, baseAsset) => {
    const preferredSymbol = pickPreferredSpotSymbol(symbols);
    values.set(baseAsset, {
      baseAsset,
      symbols,
      preferredSymbol: preferredSymbol?.symbol || null,
      quoteAsset: preferredSymbol?.quoteAsset || null,
    });
  });

  return values;
}

function buildContractAssetMap(items) {
  const values = new Map();

  items.forEach((item) => {
    const baseAsset = normalizeText(item.baseAsset);
    if (!baseAsset) {
      return;
    }

    const current = values.get(baseAsset) || [];
    current.push(item);
    values.set(baseAsset, current);
  });

  return values;
}

function getAvailabilityLabel({ hasCurrentSpot, hasCurrentFutures, futuresStatus, hadSpotAnnouncement, hadFuturesAnnouncement }) {
  if (hasCurrentSpot && hasCurrentFutures) {
    return "现货+合约";
  }

  if (hasCurrentSpot && !hasCurrentFutures) {
    if (futuresStatus === "SETTLING") {
      return "现货在售/合约下架中";
    }

    return hadFuturesAnnouncement ? "现货在售/合约已下架" : "仅现货/未上合约";
  }

  if (!hasCurrentSpot && hasCurrentFutures) {
    if (futuresStatus === "SETTLING") {
      return hadSpotAnnouncement ? "现货已下架/合约下架中" : "未上现货/合约下架中";
    }

    return hadSpotAnnouncement ? "现货已下架/仅合约" : "未上现货/仅合约";
  }

  if (hadSpotAnnouncement && hadFuturesAnnouncement) {
    return "现货已下架/合约已下架";
  }

  if (hadSpotAnnouncement) {
    return "现货已下架/未上合约";
  }

  if (hadFuturesAnnouncement) {
    return "未上现货/合约已下架";
  }

  return "未上现货/未上合约";
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

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSectionText(bodyText, startLabel, endLabels) {
  const startPattern = escapeRegex(startLabel);
  const endPattern = endLabels.map((label) => escapeRegex(label)).join("|");
  const matcher = new RegExp(`${startPattern}\\s*([\\s\\S]*?)(?=${endPattern}|$)`, "i");
  const matched = bodyText.match(matcher);
  return matched ? matched[1].trim() : "";
}

function extractFirstSectionText(bodyText, startLabels, endLabels) {
  for (const startLabel of startLabels) {
    const sectionText = extractSectionText(bodyText, startLabel, endLabels);
    if (sectionText) {
      return sectionText;
    }
  }

  return "";
}

function extractFirstMatchingTime(text, patterns) {
  for (const pattern of patterns) {
    const matched = text.match(pattern);
    if (matched) {
      return matched[0].trim();
    }
  }
  return null;
}

function extractGeneralDelistTimeText(bodyText) {
  const matched = bodyText.match(
    /(?:决定于|将于)\s*((?:\d{4}-\d{2}-\d{2}|\d{4}年\d{2}月\d{2}日)\s+\d{2}:\d{2}(?::\d{2})?\s*(?:[（(]?(?:东八区时间|UTC\+?8|UTC)[）)]?)?)\s*(?:停止交易并下架|下架以下币种)/i
  );
  return matched ? matched[1].trim() : extractAnnouncementDelistTimeText(bodyText);
}

function extractSectionDelistTimeText(sectionText, preferredPatterns) {
  if (!sectionText) {
    return null;
  }

  const lines = sectionText.split(/[。！？\n]/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!preferredPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    const timeText = extractFirstMatchingTime(line, DELIST_TIME_PATTERNS);
    if (timeText) {
      return timeText;
    }
  }

  return extractAnnouncementDelistTimeText(sectionText);
}

function extractFuturesDelistTimeText(bodyText) {
  const directPatterns = [
    /Binance Futures[\s\S]{0,800}?at\s*((?:\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}(?::\d{2})?\s*\(UTC(?:\+?8)?\))/i,
    /币安合约[\s\S]{0,800}?于\s*((?:\d{4}-\d{2}-\d{2}|\d{4}年\d{2}月\d{2}日)\s+\d{2}:\d{2}(?::\d{2})?\s*(?:[（(]?(?:东八区时间|UTC\+?8|UTC)[）)]?)?)/i,
  ];

  for (const pattern of directPatterns) {
    const matched = bodyText.match(pattern);
    if (matched) {
      return matched[1].trim();
    }
  }

  return extractSectionDelistTimeText(
    extractFirstSectionText(bodyText, ["币安合约", "Binance Futures"], [
      "币安资金费率套利机器人",
      "币安赚币",
      "币安矿池",
      "币安借币",
      "币安杠杆",
      "币安闪兑",
      "Binance Funding Rate Arbitrage Bot",
      "Funding Rate Arbitrage Bot",
      "Binance Earn",
      "Simple Earn",
      "Binance Pool",
      "Binance Loans",
      "Binance Margin",
      "Binance Convert",
    ]),
    [/自动清算/i, /永续合约/i, /交易对/i, /下架/i, /automatic settlement/i, /automatically settle/i, /perpetual/i, /delist/i]
  );
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

function buildAnnouncementMatcherSet(items, spotAssetMap) {
  const values = new Set();
  items.forEach((item) => {
    values.add(normalizeText(item.baseAsset));
  });
  [...spotAssetMap.keys()].forEach((value) => {
    values.add(value);
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

async function fetchDelistAnnouncementMetadata(items, spotAssetMap) {
  if (!items.length) {
    return [];
  }

  const matcherSet = buildAnnouncementMatcherSet(items, spotAssetMap);
  const contractAssetMap = buildContractAssetMap(items);
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

  return announcements
    .flatMap((announcement) => {
      return announcement.assets.flatMap((asset) => {
        const baseAsset = normalizeText(asset);
        const contracts = contractAssetMap.get(baseAsset) || [];
        const spotInfo = spotAssetMap.get(baseAsset) || null;

        if (contracts.length) {
          return contracts.map((item) => ({
            ...item,
            availability: getAvailabilityLabel({
              hasCurrentSpot: Boolean(spotInfo),
              hasCurrentFutures: item.status === "TRADING",
              futuresStatus: item.status,
              hadSpotAnnouncement: Boolean(announcement.spotDelistTimeText),
              hadFuturesAnnouncement: Boolean(announcement.futuresDelistTimeText),
            }),
            hasSpot: Boolean(spotInfo),
            hasFutures: item.status === "TRADING",
            hasContractRecord: true,
            announcementPublishedAt: announcement.releaseDate || null,
            announcementSpotDelistTimeText: spotInfo ? announcement.spotDelistTimeText || null : null,
            announcementFuturesDelistTimeText: item.status === "TRADING" ? announcement.futuresDelistTimeText || null : null,
          }));
        }

        if (!spotInfo) {
          return [];
        }

        return [
          {
            symbol: spotInfo.preferredSymbol || `${baseAsset}（仅现货）`,
            pair: spotInfo.preferredSymbol || baseAsset,
            market: "仅现货",
            baseAsset,
            quoteAsset: spotInfo.quoteAsset || "-",
            marginAsset: null,
            underlyingType: null,
            underlyingSubType: [],
            tokenCategory: "仅现货",
            contractType: "SPOT_ONLY",
            status: "SPOT_ONLY",
            onboardDate: null,
            deliveryDate: null,
            availability: getAvailabilityLabel({
              hasCurrentSpot: true,
              hasCurrentFutures: false,
              futuresStatus: null,
              hadSpotAnnouncement: Boolean(announcement.spotDelistTimeText),
              hadFuturesAnnouncement: Boolean(announcement.futuresDelistTimeText),
            }),
            hasSpot: true,
            hasFutures: false,
            hasContractRecord: false,
            announcementPublishedAt: announcement.releaseDate || null,
            announcementSpotDelistTimeText: announcement.spotDelistTimeText || null,
            announcementFuturesDelistTimeText: null,
          },
        ];
      });
    })
    .sort((left, right) => {
      return (right.announcementPublishedAt || 0) - (left.announcementPublishedAt || 0) || String(left.symbol || "").localeCompare(String(right.symbol || ""));
    });
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
  const uncachedArticles = candidateArticles.filter((article) => !getFreshAnnouncementDetail(article.code));
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
            spotDelistTimeText: extractGeneralDelistTimeText(bodyText),
            futuresDelistTimeText: extractFuturesDelistTimeText(bodyText),
            delistTimestamp: parseAnnouncementDelistTime(
              extractFuturesDelistTimeText(bodyText) || extractGeneralDelistTimeText(bodyText)
            ),
            assets: [...new Set([...(article.titleAssets || []), ...extractAnnouncementAssetsFromBody(bodyText)])],
          },
        ];
      } catch (_error) {
        return [article.code, null];
      }
    })
  );

  fetchedRows.forEach(([code, row]) => {
    announcementDetailCache.set(code, {
      value: row,
      cachedAt: Date.now(),
    });
  });

  return candidateArticles
    .map((article) => getFreshAnnouncementDetail(article.code))
    .filter(Boolean);
}

function getFreshAnnouncementDetail(code) {
  const cached = announcementDetailCache.get(code);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.cachedAt >= ANNOUNCEMENT_DETAIL_CACHE_TTL_MS) {
    announcementDetailCache.delete(code);
    return null;
  }

  return cached.value;
}

function normalizePayload(usdmPayload, coinmPayload, usdmFundingPayload = [], coinmFundingPayload = []) {
  const usdmFundingMap = buildFundingMap(usdmFundingPayload, "symbol");
  const coinmFundingMap = buildFundingMap(coinmFundingPayload, "symbol");

  const usdm = (usdmPayload.symbols || [])
    .filter((item) => INCLUDED_CONTRACT_STATUSES.has(item.status))
    .map((item) => buildContract(item, "USD-M", item.status, usdmFundingMap.get(item.symbol)));

  const coinm = (coinmPayload.symbols || [])
    .filter((item) => INCLUDED_CONTRACT_STATUSES.has(item.contractStatus))
    .map((item) => buildContract(item, "COIN-M", item.contractStatus, coinmFundingMap.get(item.symbol)));

  const contracts = [...usdm, ...coinm].sort((a, b) => {
    return (a.onboardDate || 0) - (b.onboardDate || 0) || String(a.symbol || "").localeCompare(String(b.symbol || ""));
  });

  return { contracts, delistAnnouncements: [] };
}

async function rebuildContractsPayload() {
  const results = await Promise.allSettled([
    fetchJson(SPOT_URL),
    fetchJson(USD_M_URL),
    fetchJson(COIN_M_URL),
    fetchJson(USD_M_FUNDING_URL),
    fetchJson(COIN_M_FUNDING_URL),
  ]);

  const sourceWarnings = [];
  const [
    spotResult,
    usdmResult,
    coinmResult,
    usdmFundingResult,
    coinmFundingResult,
  ] = results;

  const spotPayload = spotResult.status === "fulfilled" ? spotResult.value : {};
  const usdmPayload = usdmResult.status === "fulfilled" ? usdmResult.value : null;
  const coinmPayload = coinmResult.status === "fulfilled" ? coinmResult.value : null;
  const usdmFundingPayload = usdmFundingResult.status === "fulfilled" ? usdmFundingResult.value : [];
  const coinmFundingPayload = coinmFundingResult.status === "fulfilled" ? coinmFundingResult.value : [];

  if (!usdmPayload || !coinmPayload) {
    const missingRequiredSources = [];
    if (!usdmPayload) {
      missingRequiredSources.push("USD-M");
    }
    if (!coinmPayload) {
      missingRequiredSources.push("COIN-M");
    }
    throw new Error(`必需合约接口不可用：${missingRequiredSources.join("、")}`);
  }

  if (spotResult.status === "rejected") {
    sourceWarnings.push(`现货接口拉取失败：${spotResult.reason instanceof Error ? spotResult.reason.message : String(spotResult.reason)}`);
  }
  if (usdmFundingResult.status === "rejected") {
    sourceWarnings.push(`USD-M 资金费率拉取失败：${usdmFundingResult.reason instanceof Error ? usdmFundingResult.reason.message : String(usdmFundingResult.reason)}`);
  }
  if (coinmFundingResult.status === "rejected") {
    sourceWarnings.push(`COIN-M 资金费率拉取失败：${coinmFundingResult.reason instanceof Error ? coinmFundingResult.reason.message : String(coinmFundingResult.reason)}`);
  }

  const payload = normalizePayload(usdmPayload, coinmPayload, usdmFundingPayload, coinmFundingPayload);
  const spotAssetMap = buildSpotAssetMap(spotPayload);
  const enrichedDelistAnnouncements = await fetchDelistAnnouncementMetadata(payload.contracts, spotAssetMap);
  const delistSymbols = new Set(
    enrichedDelistAnnouncements
      .filter((item) => item.hasContractRecord)
      .map((item) => `${item.market}:${item.symbol}`)
  );
  const activeContracts = payload.contracts.filter((item) => !delistSymbols.has(`${item.market}:${item.symbol}`));
  return {
    contracts: activeContracts,
    delistAnnouncements: enrichedDelistAnnouncements,
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds: CACHE_TTL_SECONDS,
    refreshing: false,
    warnings: sourceWarnings,
  };
}

function hasFreshContractsCache() {
  return contractsPayloadCache && Date.now() - contractsPayloadCacheAt < CACHE_TTL_SECONDS * 1000;
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
    if (force || !contractsPayloadCache || !hasFreshContractsCache()) {
      contractsPayloadCache = await rebuildContractsPayload();
      contractsPayloadCacheAt = Date.now();
    }

    const body = buildContractsResponseBody(false);

    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
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
