const state = {
  market: "ALL",
  search: "",
  startDate: "",
  endDate: "",
  sort: "desc",
  currentPage: 1,
};

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const PAGE_SIZE = 50;
const USD_M_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const COIN_M_URL = "https://dapi.binance.com/dapi/v1/exchangeInfo";
const PERPETUAL_DELIST_THRESHOLD_MS = 5 * 365 * 24 * 60 * 60 * 1000;

let contractsData = [];
let delistAnnouncements = [];
let lastFetchedAt = "";
let isLoading = false;

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

  const nowMs = Date.now();
  return item.deliveryDate < nowMs + PERPETUAL_DELIST_THRESHOLD_MS;
}

function normalizePayload(usdmPayload, coinmPayload) {
  const usdm = (usdmPayload.symbols || [])
    .filter((item) => item.status === "TRADING")
    .map((item) => buildContract(item, "USD-M", item.status));

  const coinm = (coinmPayload.symbols || [])
    .filter((item) => item.contractStatus === "TRADING")
    .map((item) => buildContract(item, "COIN-M", item.contractStatus));

  const allContracts = [...usdm, ...coinm].sort((a, b) => {
    return (a.onboardDate || 0) - (b.onboardDate || 0) || String(a.symbol || "").localeCompare(String(b.symbol || ""));
  });

  return allContracts.reduce(
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
  delistSectionEl.classList.toggle("hidden", searchMode || delistAnnouncements.length === 0);
}

function renderDelistAnnouncements(items) {
  delistTableBodyEl.innerHTML = "";

  if (!items.length) {
    delistSectionEl.classList.add("hidden");
    delistSummaryEl.textContent = "当前没有已公告下架的交易对。";
    return;
  }

  delistSectionEl.classList.remove("hidden");
  delistSummaryEl.textContent = `共 ${items.length} 个交易对已进入币安下架公告列表，这些交易对已从主列表中移除。`;

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td data-label="预计下架时间">${formatDate(item.deliveryDate)}</td>
      <td data-label="交易对"><strong>${item.symbol}</strong></td>
      <td data-label="市场"><span class="market-badge">${item.market}</span></td>
      <td data-label="基础币">${item.baseAsset}</td>
      <td data-label="计价币">${item.quoteAsset}</td>
      <td data-label="代币类型"><span class="type-badge">${item.tokenCategory || "-"}</span></td>
    `;
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

    try {
      const apiResponse = await fetch(options.force ? "/api/contracts?force=1" : "/api/contracts", {
        cache: "no-store",
      });

      if (!apiResponse.ok) {
        throw new Error(`API HTTP ${apiResponse.status}`);
      }

      payload = await apiResponse.json();
      contractsData = Array.isArray(payload.contracts) ? payload.contracts : [];
      delistAnnouncements = Array.isArray(payload.delistAnnouncements) ? payload.delistAnnouncements : [];
      lastFetchedAt = payload.fetchedAt || new Date().toISOString();
    } catch (_error) {
      const [usdmResponse, coinmResponse] = await Promise.all([
        fetch(USD_M_URL, { cache: "no-store" }),
        fetch(COIN_M_URL, { cache: "no-store" }),
      ]);

      if (!usdmResponse.ok) {
        throw new Error(`USD-M HTTP ${usdmResponse.status}`);
      }

      if (!coinmResponse.ok) {
        throw new Error(`COIN-M HTTP ${coinmResponse.status}`);
      }

      const [usdmPayload, coinmPayload] = await Promise.all([usdmResponse.json(), coinmResponse.json()]);
      const normalized = normalizePayload(usdmPayload, coinmPayload);

      contractsData = normalized.contracts;
      delistAnnouncements = normalized.delistAnnouncements;
      lastFetchedAt = new Date().toISOString();
    }

    initDateRange();
    renderDelistAnnouncements(delistAnnouncements);
    render();

    const refreshedAt = formatDateTime(lastFetchedAt);
    updateSyncStatus(
      `已同步 ${contractsData.length} 个活跃交易对，已剔除 ${delistAnnouncements.length} 个下架公告交易对 · 上次更新 ${refreshedAt}`
    );
  } catch (error) {
    updateSyncStatus(`同步失败 · ${error.message}`);
    renderDelistAnnouncements([]);
    renderTable([], { emptyMessage: "无法从币安官方接口拉取最新合约数据。" });
  } finally {
    isLoading = false;
    refreshButtonEl.disabled = false;
  }
}

function filterContracts() {
  const keyword = state.search.trim().toLowerCase();
  const startTimestamp = parseStartDate(state.startDate);
  const endTimestamp = parseEndDate(state.endDate);
  const exactMatches = getExactSymbolMatches();

  if (exactMatches.length) {
    return exactMatches.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  return contractsData
    .filter((item) => state.market === "ALL" || item.market === state.market)
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
    row.innerHTML = `
      <td data-label="上架时间">${formatDate(item.onboardDate)}</td>
      <td data-label="交易对"><strong>${item.symbol}</strong></td>
      <td data-label="市场"><span class="market-badge">${item.market}</span></td>
      <td data-label="基础币">${item.baseAsset}</td>
      <td data-label="计价币">${item.quoteAsset}</td>
      <td data-label="代币类型"><span class="type-badge">${item.tokenCategory || "-"}</span></td>
      <td data-label="合约类型">${item.contractType}</td>
    `;
    fragment.appendChild(row);
  });

  tableBodyEl.appendChild(fragment);
}

function render() {
  updateSearchModeUi();
  renderTable(filterContracts());
}

document.querySelectorAll(".filter-chip").forEach((button) => {
  button.addEventListener("click", () => {
    state.market = button.dataset.market;
    state.currentPage = 1;
    document.querySelectorAll(".filter-chip").forEach((chip) => {
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

  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.market === "ALL");
  });

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

  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.market === "ALL");
  });

  renderDelistAnnouncements(delistAnnouncements);
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
  loadContracts();
}, REFRESH_INTERVAL_MS);
