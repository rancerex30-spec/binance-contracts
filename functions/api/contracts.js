const USD_M_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COIN_M_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";
const CACHE_TTL_SECONDS = 30 * 60;
const PERPETUAL_DELIST_THRESHOLD_MS = 5 * 365 * 24 * 60 * 60 * 1000;

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

function isScheduledDelist(item) {
  if (!item || !item.deliveryDate || !String(item.contractType || "").includes("PERPETUAL")) {
    return false;
  }

  return item.deliveryDate < Date.now() + PERPETUAL_DELIST_THRESHOLD_MS;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cf: {
      cacheTtl: CACHE_TTL_SECONDS,
      cacheEverything: false,
    },
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Binance API request failed: ${response.status}`);
  }

  return response.json();
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

  return contracts.reduce(
    (accumulator, item) => {
      if (isScheduledDelist(item)) {
        accumulator.delistAnnouncements.push(item);
      } else {
        accumulator.contracts.push(item);
      }
      return accumulator;
    },
    { contracts: [], delistAnnouncements: [] }
  );
}

export async function onRequestGet() {
  try {
    const [usdmPayload, coinmPayload] = await Promise.all([fetchJson(USD_M_URL), fetchJson(COIN_M_URL)]);
    const payload = normalizePayload(usdmPayload, coinmPayload);
    const body = JSON.stringify({
      contracts: payload.contracts,
      delistAnnouncements: payload.delistAnnouncements,
      fetchedAt: new Date().toISOString(),
      cacheTtlSeconds: CACHE_TTL_SECONDS,
    });

    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`,
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
        },
      }
    );
  }
}
