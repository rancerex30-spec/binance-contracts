const state = {
  market: "ALL",
  search: "",
  startDate: "",
  endDate: "",
  sort: "desc",
  currentPage: 1,
};

const REFRESH_INTERVAL_MS = 60 * 1000;
const PAGE_SIZE = 50;
const API_TIMEOUT_MS = 30000;
const USD_M_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COIN_M_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";
const USD_M_FUNDING_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";
const COIN_M_FUNDING_URL = "https://dapi.binance.com/dapi/v1/premiumIndex";
const INCLUDED_CONTRACT_STATUSES = new Set(["TRADING", "SETTLING"]);

let contractsData = [];
let delistAnnouncements = [];
let lastFetchedAt = "";
let isLoading = false;
let apiWarningsState = [];

const tableBodyEl = document.getElementById("table-body");
const emptyStateEl = document.getElementById("empty-state");
const resultSummaryEl = document.getElementById("result-summary");
const contractCountEl = document.getElementById("contract-count");
const tokenCountEl = document.getElementById("token-count");
const dateRangeEl = document.getElementById("date-range");
const searchInputEl = document.getElementById("search-input");
const startDateEl = document.getElementById("start-date");
const endDateEl = document.getElementById("end-date");
const sortSelectEl = document.getElementById("sort-select");
const homeButtonEl = document.getElementById("home-button");
const refreshButtonEl = document.getElementById("refresh-button");
const resetButtonEl = document.getElementById("reset-button");
const syncStatusEl = document.getElementById("sync-status");
const paginationEl = document.getElementById("pagination");
const prevPageEl = document.getElementById("prev-page");
const nextPageEl = document.getElementById("next-page");
const pageNumbersEl = document.getElementById("page-numbers");
const delistSectionEl = document.getElementById("delist-section");
const delistSummaryEl = document.getElementById("delist-summary");
const delistTableBodyEl = document.getElementById("delist-table-body");
const filterChipEls = Array.from(document.querySelectorAll(".filter-chip"));

function formatDate(timestamp) {
  if (!timestamp) {
    return "-";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function formatDateInput(timestamp) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatChinaDateTime(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function parseAnnouncementDateTime(value) {
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

function formatAnnouncementPublishedAt(value) {
  return formatChinaDateTime(value);
}

function formatAnnouncementDelistTime(value) {
  if (!value) {
    return "-";
  }

  const parsed = parseAnnouncementDateTime(value);
  if (parsed === null) {
    return value;
  }

  return `${formatChinaDateTime(parsed)} (UTC+8)`;
}

function parseStartDate(value) {
  return value ? new Date(`${value}T00:00:00`).getTime() : null;
}

function parseEndDate(value) {
  return value ? new Date(`${value}T23:59:59.999`).getTime() : null;
}

function getRangeLabel(items) {
  if (!items.length) {
    return "-";
  }

  const ordered = [...items].sort((a, b) => a.onboardDate - b.onboardDate);
  return `${formatDate(ordered[0].onboardDate)} - ${formatDate(
    ordered[ordered.length - 1].onboardDate
  )}`;
}

function initDateRange() {
  if (!contractsData.length) {
    startDateEl.min = "";
    startDateEl.max = "";
    endDateEl.min = "";
    endDateEl.max = "";
    return;
  }

  const ordered = [...contractsData].sort((a, b) => a.onboardDate - b.onboardDate);
  const minDate = formatDateInput(ordered[0].onboardDate);
  const maxDate = formatDateInput(ordered[ordered.length - 1].onboardDate);

  startDateEl.min = minDate;
  startDateEl.max = maxDate;
  endDateEl.min = minDate;
  endDateEl.max = maxDate;
}

function updateStats(items) {
  contractCountEl.textContent = String(items.length);
  tokenCountEl.textContent = String(new Set(items.map((item) => item.baseAsset)).size);
  dateRangeEl.textContent = getRangeLabel(items);
}

function updateSyncStatus(text) {
  syncStatusEl.textContent = text;
}

function buildFallbackContract(item, market, status) {
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
    fundingRate: null,
    nextFundingTime: null,
    fundingUpdatedAt: null,
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

function normalizeBrowserFallback(usdmPayload, coinmPayload, usdmFundingPayload = [], coinmFundingPayload = []) {
  const usdmFundingMap = buildFundingMap(usdmFundingPayload, "symbol");
  const coinmFundingMap = buildFundingMap(coinmFundingPayload, "symbol");

  const usdm = (usdmPayload.symbols || [])
    .filter((item) => INCLUDED_CONTRACT_STATUSES.has(item.status))
    .map((item) => ({
      ...buildFallbackContract(item, "USD-M", item.status),
      ...usdmFundingMap.get(item.symbol),
    }));

  const coinm = (coinmPayload.symbols || [])
    .filter((item) => INCLUDED_CONTRACT_STATUSES.has(item.contractStatus))
    .map((item) => ({
      ...buildFallbackContract(item, "COIN-M", item.contractStatus),
      ...coinmFundingMap.get(item.symbol),
    }));

  const contracts = [...usdm, ...coinm].sort((a, b) => {
    return (a.onboardDate || 0) - (b.onboardDate || 0) || String(a.symbol || "").localeCompare(String(b.symbol || ""));
  });

  return {
    contracts,
    delistAnnouncements: [],
  };
}

async function loadContractsViaBrowserFallback() {
  const [usdmResponse, coinmResponse, usdmFundingResponse, coinmFundingResponse] = await Promise.all([
    fetch(USD_M_URL, { cache: "no-store" }),
    fetch(COIN_M_URL, { cache: "no-store" }),
    fetch(USD_M_FUNDING_URL, { cache: "no-store" }).catch(() => null),
    fetch(COIN_M_FUNDING_URL, { cache: "no-store" }).catch(() => null),
  ]);

  if (!usdmResponse.ok) {
    throw new Error(`USD-M HTTP ${usdmResponse.status}`);
  }

  if (!coinmResponse.ok) {
    throw new Error(`COIN-M HTTP ${coinmResponse.status}`);
  }

  const [usdmPayload, coinmPayload, usdmFundingPayload, coinmFundingPayload] = await Promise.all([
    usdmResponse.json(),
    coinmResponse.json(),
    usdmFundingResponse?.ok ? usdmFundingResponse.json() : [],
    coinmFundingResponse?.ok ? coinmFundingResponse.json() : [],
  ]);
  return normalizeBrowserFallback(usdmPayload, coinmPayload, usdmFundingPayload, coinmFundingPayload);
}

async function fetchApiContracts(options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, API_TIMEOUT_MS);

  try {
    const apiResponse = await fetch(options.force ? "/api/contracts?force=1" : "/api/contracts", {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!apiResponse.ok) {
      throw new Error(`API HTTP ${apiResponse.status}`);
    }

    return await apiResponse.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`API timeout after ${API_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function persistBrowserFallbackCache(payload) {
  try {
    await fetch("/api/contracts/cache", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contracts: Array.isArray(payload.contracts) ? payload.contracts : [],
        delistAnnouncements: Array.isArray(payload.delistAnnouncements) ? payload.delistAnnouncements : [],
        fetchedAt: payload.fetchedAt || new Date().toISOString(),
        warnings: ["当前数据来自浏览器直连模式缓存"],
      }),
    });
  } catch (_error) {
    // Best effort only: browser fallback should still render even if local cache write fails.
  }
}

function getSearchKeyword() {
  return state.search.trim().toUpperCase();
}

function getExactSymbolMatches() {
  const keyword = getSearchKeyword();
  if (!keyword) {
    return [];
  }

  return contractsData.filter((item) => {
    const symbol = String(item.symbol || "").toUpperCase();
    const pair = String(item.pair || "").toUpperCase();
    return symbol === keyword || pair === keyword;
  });
}

function isSearchMode() {
  return state.search.trim().length > 0;
}

function updateSearchModeUi() {
  const searchMode = isSearchMode();
  homeButtonEl.classList.toggle("hidden", !searchMode);
  delistSectionEl.classList.toggle("hidden", searchMode);
}

function filterDelistAnnouncements() {
  return delistAnnouncements.filter((item) => state.market === "ALL" || item.market === state.market);
}

function getDelistUnavailableReason() {
  if (apiWarningsState.some((item) => String(item).includes("当前数据来自浏览器直连模式缓存"))) {
    return "当前这批数据来自浏览器直连缓存，只包含活跃合约列表，不包含下架公告明细。";
  }

  if (apiWarningsState.some((item) => String(item).includes("下架公告拉取失败"))) {
    return "本次活跃合约已同步成功，但下架公告接口超时或失败，所以公告区暂时为空。";
  }

  return "当前没有已公告下架的交易对。";
}

function appendDelistPlaceholderRow(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 10;
  cell.textContent = message;
  row.appendChild(cell);
  delistTableBodyEl.appendChild(row);
}

function renderDelistAnnouncements(items) {
  delistTableBodyEl.innerHTML = "";

  if (!items.length) {
    delistSectionEl.classList.remove("hidden");
    const reason = getDelistUnavailableReason();
    delistSummaryEl.textContent = reason;
    appendDelistPlaceholderRow(reason);
    return;
  }

  delistSectionEl.classList.remove("hidden");
  delistSummaryEl.textContent = `共 ${items.length} 条公告匹配结果已进入下架列表；状态标记会区分“未上现货 / 未上合约 / 合约已下架 / 合约下架中”，并且只展示当前这一侧仍存在的市场时间。`;

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const row = document.createElement("tr");
    row.appendChild(createCell("公告发布时间", formatAnnouncementPublishedAt(item.announcementPublishedAt)));
    row.appendChild(createStrongCell("交易对", item.symbol));
    row.appendChild(createCell("现货下架时间", formatAnnouncementDelistTime(item.announcementSpotDelistTimeText)));
    row.appendChild(createCell("合约下架时间", formatAnnouncementDelistTime(item.announcementFuturesDelistTimeText)));
    row.appendChild(createFundingRateCell("资金费率", item.fundingRate, item.nextFundingTime));
    row.appendChild(createBadgeCell("状态标记", item.availability || "-", "status-badge"));
    row.appendChild(createBadgeCell("市场", item.market, "market-badge"));
    row.appendChild(createCell("基础币", item.baseAsset));
    row.appendChild(createCell("计价币", item.quoteAsset));
    row.appendChild(createBadgeCell("代币类型", item.tokenCategory || "-", "type-badge"));
    fragment.appendChild(row);
  });

  delistTableBodyEl.appendChild(fragment);
}

async function loadContracts(options = {}) {
  if (isLoading) {
    return;
  }

  isLoading = true;
  refreshButtonEl.disabled = true;
  updateSyncStatus(options.force ? "正在强制刷新..." : "正在同步币安合约...");

  try {
    let payload;
    let usingBrowserFallback = false;

    try {
      payload = await fetchApiContracts(options);
    } catch (apiError) {
      payload = await loadContractsViaBrowserFallback();
      usingBrowserFallback = true;
      payload.apiErrorMessage = apiError instanceof Error ? apiError.message : String(apiError);
    }

    contractsData = Array.isArray(payload.contracts) ? payload.contracts : [];
    delistAnnouncements = Array.isArray(payload.delistAnnouncements) ? payload.delistAnnouncements : [];
    lastFetchedAt = payload.fetchedAt || new Date().toISOString();
    const apiWarnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    apiWarningsState = apiWarnings;
    const isStalePayload = payload.stale === true;

    initDateRange();
    renderDelistAnnouncements(delistAnnouncements);
    render();

    if (usingBrowserFallback) {
      await persistBrowserFallbackCache({
        contracts: contractsData,
        delistAnnouncements,
        fetchedAt: lastFetchedAt,
      });
      updateSyncStatus(
        `已切换浏览器直连模式，并写入本地缓存 · 显示 ${contractsData.length} 个活跃交易对 · 下架公告暂不可用`
      );
      return;
    }

    const refreshedAt = formatDateTime(lastFetchedAt);
    if (apiWarnings.length) {
      const modeLabel = isStalePayload ? "已回退缓存" : "部分接口降级";
      const usingBrowserCache = apiWarnings.some((item) => String(item).includes("当前数据来自浏览器直连模式缓存"));
      if (usingBrowserCache) {
        updateSyncStatus(
          `站内接口可用 · 当前读取浏览器直连缓存 · 活跃交易对 ${contractsData.length} 个 · 下架公告暂不可用 · 上次更新 ${refreshedAt}`
        );
        return;
      }

      updateSyncStatus(
        `站内接口可用 · ${modeLabel} · 活跃交易对 ${contractsData.length} 个 · 下架公告 ${delistAnnouncements.length} 条 · 上次更新 ${refreshedAt}`
      );
      return;
    }

    updateSyncStatus(
      `已同步 ${contractsData.length} 个活跃交易对，已剔除 ${delistAnnouncements.length} 个下架公告交易对 · 上次更新 ${refreshedAt}`
    );
  } catch (error) {
    apiWarningsState = [];
    updateSyncStatus(`同步失败 · ${error.message}`);
    renderDelistAnnouncements([]);
    renderTable([], { emptyMessage: "无法从站内合约接口或浏览器直连接口拉取最新数据。" });
  } finally {
    isLoading = false;
    refreshButtonEl.disabled = false;
  }
}

function filterContracts(market = state.market) {
  const keyword = state.search.trim().toLowerCase();
  const startTimestamp = parseStartDate(state.startDate);
  const endTimestamp = parseEndDate(state.endDate);
  const exactMatches = getExactSymbolMatches();

  if (exactMatches.length) {
    return exactMatches
      .filter((item) => market === "ALL" || item.market === market)
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  return contractsData
    .filter((item) => market === "ALL" || item.market === market)
    .filter((item) => !startTimestamp || item.onboardDate >= startTimestamp)
    .filter((item) => !endTimestamp || item.onboardDate <= endTimestamp)
    .filter((item) => {
      if (!keyword) {
        return true;
      }

      return [item.symbol, item.baseAsset, item.quoteAsset, item.market]
        .concat([item.tokenCategory || "", item.underlyingType || ""])
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    })
    .sort((a, b) => {
      if (state.sort === "asc") {
        return a.onboardDate - b.onboardDate || a.symbol.localeCompare(b.symbol);
      }
      return b.onboardDate - a.onboardDate || a.symbol.localeCompare(b.symbol);
    });
}

function getTotalPages(totalItems) {
  return Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
}

function createCell(label, value) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  cell.textContent = value ?? "-";
  return cell;
}

function createStrongCell(label, value) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  const strong = document.createElement("strong");
  strong.textContent = value ?? "-";
  cell.appendChild(strong);
  return cell;
}

function createBadgeCell(label, value, className) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  const span = document.createElement("span");
  span.className = className;
  span.textContent = value ?? "-";
  cell.appendChild(span);
  return cell;
}

function formatFundingRate(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  const sign = numericValue > 0 ? "+" : "";
  return `${sign}${(numericValue * 100).toFixed(4)}%`;
}

function createFundingRateCell(label, value, nextFundingTime) {
  const cell = document.createElement("td");
  cell.dataset.label = label;

  const span = document.createElement("span");
  const numericValue = Number(value);
  span.className = "funding-rate";
  if (Number.isFinite(numericValue)) {
    if (numericValue > 0) {
      span.classList.add("positive");
    } else if (numericValue < 0) {
      span.classList.add("negative");
    } else {
      span.classList.add("neutral");
    }
  }
  span.textContent = formatFundingRate(value);
  if (nextFundingTime) {
    span.title = `下次资金费率结算 ${formatChinaDateTime(nextFundingTime)}`;
  }
  cell.appendChild(span);
  return cell;
}

function getPagedContracts(items) {
  const totalPages = getTotalPages(items.length);
  state.currentPage = Math.min(state.currentPage, totalPages);
  state.currentPage = Math.max(state.currentPage, 1);

  const startIndex = (state.currentPage - 1) * PAGE_SIZE;
  return {
    totalPages,
    pageItems: items.slice(startIndex, startIndex + PAGE_SIZE),
  };
}

function createPageButton(label, page, isActive = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `page-button${isActive ? " active" : ""}`;
  button.textContent = label;
  button.disabled = isActive;
  button.addEventListener("click", () => {
    state.currentPage = page;
    render();
  });
  return button;
}

function renderPagination(totalItems, totalPages) {
  pageNumbersEl.innerHTML = "";

  if (totalItems <= PAGE_SIZE) {
    paginationEl.classList.add("hidden");
    return;
  }

  paginationEl.classList.remove("hidden");
  prevPageEl.disabled = state.currentPage === 1;
  nextPageEl.disabled = state.currentPage === totalPages;

  const pages = [];
  const startPage = Math.max(1, state.currentPage - 2);
  const endPage = Math.min(totalPages, state.currentPage + 2);

  if (startPage > 1) {
    pages.push(1);
    if (startPage > 2) {
      pages.push("ellipsis-start");
    }
  }

  for (let page = startPage; page <= endPage; page += 1) {
    pages.push(page);
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      pages.push("ellipsis-end");
    }
    pages.push(totalPages);
  }

  pages.forEach((page) => {
    if (typeof page === "string") {
      const ellipsis = document.createElement("span");
      ellipsis.className = "page-ellipsis";
      ellipsis.textContent = "...";
      pageNumbersEl.appendChild(ellipsis);
      return;
    }

    pageNumbersEl.appendChild(createPageButton(String(page), page, page === state.currentPage));
  });
}

function renderTable(items, options = {}) {
  const emptyMessage = options.emptyMessage || "没有找到符合条件的交易对。";
  tableBodyEl.innerHTML = "";

  if (!items.length) {
    emptyStateEl.classList.remove("hidden");
    paginationEl.classList.add("hidden");
    resultSummaryEl.textContent = emptyMessage;
    updateStats(items);
    return;
  }

  const { totalPages, pageItems } = getPagedContracts(items);
  emptyStateEl.classList.add("hidden");
  const exactMatches = getExactSymbolMatches();
  if (exactMatches.length) {
    paginationEl.classList.add("hidden");
    resultSummaryEl.textContent = `已定位到交易对 ${exactMatches[0].symbol}，当前只展示对应结果。点击“返回首页列表”可恢复完整列表。`;
  } else {
    resultSummaryEl.textContent = `共显示 ${items.length} 个交易对，第 ${state.currentPage} / ${totalPages} 页，每页 ${PAGE_SIZE} 条。`;
    renderPagination(items.length, totalPages);
  }
  updateStats(items);

  const fragment = document.createDocumentFragment();

  pageItems.forEach((item) => {
    const row = document.createElement("tr");
    row.appendChild(createCell("上架时间", formatDate(item.onboardDate)));
    row.appendChild(createStrongCell("交易对", item.symbol));
    row.appendChild(createBadgeCell("市场", item.market, "market-badge"));
    row.appendChild(createCell("基础币", item.baseAsset));
    row.appendChild(createCell("计价币", item.quoteAsset));
    row.appendChild(createBadgeCell("代币类型", item.tokenCategory || "-", "type-badge"));
    row.appendChild(createCell("合约类型", item.contractType));
    row.appendChild(createFundingRateCell("资金费率", item.fundingRate, item.nextFundingTime));
    fragment.appendChild(row);
  });

  tableBodyEl.appendChild(fragment);
}

function updateFilterChipLabels() {
  const counts = {
    ALL: filterContracts("ALL").length,
    "USD-M": filterContracts("USD-M").length,
    "COIN-M": filterContracts("COIN-M").length,
  };

  filterChipEls.forEach((button) => {
    const market = button.dataset.market;
    const label = button.dataset.label || market;
    button.textContent = `${label} ${counts[market] ?? 0}`;
  });
}

function render() {
  const filteredContracts = filterContracts();
  updateSearchModeUi();
  updateFilterChipLabels();
  renderDelistAnnouncements(filterDelistAnnouncements());
  renderTable(filteredContracts);
}

filterChipEls.forEach((button) => {
  button.addEventListener("click", () => {
    state.market = button.dataset.market;
    state.currentPage = 1;
    filterChipEls.forEach((chip) => {
      chip.classList.toggle("active", chip === button);
    });
    render();
  });
});

searchInputEl.addEventListener("input", (event) => {
  state.search = event.target.value;
  state.currentPage = 1;
  render();
});

startDateEl.addEventListener("change", (event) => {
  state.startDate = event.target.value;
  if (state.endDate && state.startDate && state.startDate > state.endDate) {
    state.endDate = state.startDate;
    endDateEl.value = state.startDate;
  }
  state.currentPage = 1;
  render();
});

endDateEl.addEventListener("change", (event) => {
  state.endDate = event.target.value;
  if (state.startDate && state.endDate && state.endDate < state.startDate) {
    state.startDate = state.endDate;
    startDateEl.value = state.endDate;
  }
  state.currentPage = 1;
  render();
});

sortSelectEl.addEventListener("change", (event) => {
  state.sort = event.target.value;
  state.currentPage = 1;
  render();
});

resetButtonEl.addEventListener("click", () => {
  state.market = "ALL";
  state.search = "";
  state.startDate = "";
  state.endDate = "";
  state.sort = "desc";
  state.currentPage = 1;

  searchInputEl.value = "";
  startDateEl.value = "";
  endDateEl.value = "";
  sortSelectEl.value = "desc";

  filterChipEls.forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.market === "ALL");
  });

  renderDelistAnnouncements(filterDelistAnnouncements());
  render();
});

homeButtonEl.addEventListener("click", () => {
  state.market = "ALL";
  state.search = "";
  state.startDate = "";
  state.endDate = "";
  state.sort = "desc";
  state.currentPage = 1;

  searchInputEl.value = "";
  startDateEl.value = "";
  endDateEl.value = "";
  sortSelectEl.value = "desc";

  filterChipEls.forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.market === "ALL");
  });

  renderDelistAnnouncements(filterDelistAnnouncements());
  render();
});

prevPageEl.addEventListener("click", () => {
  if (state.currentPage > 1) {
    state.currentPage -= 1;
    render();
  }
});

nextPageEl.addEventListener("click", () => {
  state.currentPage += 1;
  render();
});

refreshButtonEl.addEventListener("click", () => {
  loadContracts({ force: true });
});

loadContracts();
window.setInterval(() => {
  loadContracts({ force: true });
}, REFRESH_INTERVAL_MS);
