// Client-side logic for the static Sentence-Probability Result Explorer.
//
// Data is loaded lazily: at startup only `manifest.json` is fetched (small --
// filter option lists and a chunk index, no row data). Filter/metric/x-axis
// control changes determine which summary-chunk JSON files under data/
// actually contain the rows needed for the current view and fetch only
// those (data partitioning + lazy loading -- see CLAUDE.md section 6). A
// bounded cache keeps recently-used chunks around so switching back to a
// previous view doesn't always re-fetch. Heavy per-token detail fields
// (diff tokens, surprisal arrays) live in separate detail chunks and are
// fetched only after a point is clicked.
//
// Architecture note (CLAUDE.md Part 15): highlighting is never implemented
// by deleting/filtering the underlying row set. Every plotted row stays
// plotted; gloss-tag matches and click-related matches are expressed purely
// as per-point marker styling (size/opacity/line) computed from the same
// filtered row array used to compute summary statistics, so mean/median
// stay correct. Only actual data-point traces carry `customdata`
// (`_pair_id`), so clicking a mean/median marker can never select a row.

(function () {
  "use strict";

  const GROUPING_FIELDS = ["English baseline", "Subject/Undergoer Person+Number", "Time"];
  const RELATED_CLICK_METRICS = new Set(["token_logprob_diff", "SLOR_token_logprob_diff"]);

  // Beyond the chunks required for the *current* view (which are always
  // kept, regardless of these numbers -- correctness first), keep this many
  // additional recently-used chunks around so switching back to a previous
  // view doesn't always re-fetch (CLAUDE.md 6.7 "bounded... e.g. most
  // recent 3-5 summary / 1-3 detail chunks"). This app's paired left/right +
  // language-comparison views routinely need more than 3-5 chunks for a
  // single view, so the cache is sized relative to "currently active" +
  // a fixed slack, rather than a fixed absolute ceiling that would evict
  // data the current view still needs.
  const EXTRA_SUMMARY_CHUNKS_CACHED = 6;
  const EXTRA_DETAIL_CHUNKS_CACHED = 3;

  // All data-loading state (manifest, currently-loaded rows, caches,
  // selection). Named distinctly from the many local `state` variables
  // (`getState()` results) used throughout this file for DOM-control state.
  const store = {
    manifest: null,
    activeRows: [],
    rowsById: new Map(),
    selectedPairId: null,
    selectedRow: null,
    summaryCache: new Map(), // path -> records[]
    summaryCacheOrder: [],
    detailCache: new Map(), // path -> Map(_pair_id -> record)
    detailCacheOrder: [],
    requestSeq: 0,
  };

  let pairwiseRestrictionActive = false;
  let xaxisModeBeforePairwiseForce = null;

  const graphInitialized = { left: false, right: false };
  let surprisalGraphInitialized = false;

  // Per-section (left/right Matching examples) table controls, independent
  // of the shared graph/filter state.
  const tableState = {
    left: { sortField: "yValue", sortDir: "asc", categoryFilter: "" },
    right: { sortField: "yValue", sortDir: "asc", categoryFilter: "" },
  };

  const el = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------
  // Fetch helpers + bounded caches
  // ---------------------------------------------------------------------

  async function fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  function touchCacheEntry(order, key) {
    const idx = order.indexOf(key);
    if (idx !== -1) order.splice(idx, 1);
    order.push(key);
  }

  // Evicts least-recently-used entries beyond `maxSize`, but never a key in
  // `protectedKeys` (the chunks the current view actually needs).
  function pruneCache(cache, order, maxSize, protectedKeys) {
    let i = 0;
    while (order.length > maxSize && i < order.length) {
      const key = order[i];
      if (protectedKeys.has(key)) {
        i += 1;
        continue;
      }
      order.splice(i, 1);
      cache.delete(key);
    }
  }

  function setLoading(isLoading) {
    el("loading-status").style.display = isLoading ? "block" : "none";
  }

  function showDataError(message) {
    const box = el("data-error");
    box.textContent = message;
    box.style.display = "block";
  }

  function clearDataError() {
    el("data-error").style.display = "none";
    el("data-error").textContent = "";
  }

  function updateChunkDebug() {
    const list = el("chunk-debug-list");
    list.innerHTML = "";
    Array.from(store.summaryCache.keys()).forEach((path) => {
      const li = document.createElement("li");
      li.textContent = path;
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------------
  // Chunk selection: which summary-chunk paths does the current control
  // state need? (CLAUDE.md 6.6: "controls change -> determine required
  // chunk paths -> fetch missing -> reuse cache -> evict old".)
  // ---------------------------------------------------------------------

  function requiredChunkPaths(state) {
    const manifest = store.manifest;
    if (!manifest) return [];

    const family = state.metric === manifest.pairwise_metric ? "gpt_pairwise" : "local";
    const modelSet = state.models.length ? new Set(state.models) : null;
    const conditionSet = state.conditions.length ? new Set(state.conditions) : null;

    let neededDirections;
    if (state.xaxisMode === "language") {
      neededDirections = new Set();
      (manifest.language_order || []).forEach((lang) => {
        neededDirections.add(`${lang}-vs-en`);
        neededDirections.add(`en-vs-${lang}`);
      });
    } else if (state.comparisonLang) {
      neededDirections = new Set([`${state.comparisonLang}-vs-en`, `en-vs-${state.comparisonLang}`]);
    } else {
      neededDirections = new Set();
    }

    const paths = new Set();
    (manifest.chunks || []).forEach((chunk) => {
      if (chunk.family !== family) return;
      if (modelSet && !modelSet.has(chunk.model)) return;
      if (!neededDirections.has(chunk.direction)) return;
      if (conditionSet && chunk.condition && !conditionSet.has(chunk.condition)) return;
      paths.add(chunk.summary_path);
    });
    return Array.from(paths);
  }

  async function ensureChunksLoaded(paths) {
    const missing = paths.filter((p) => !store.summaryCache.has(p));

    if (missing.length) {
      setLoading(true);
      try {
        const fetched = await Promise.all(missing.map((p) => fetchJson(p)));
        missing.forEach((p, i) => store.summaryCache.set(p, fetched[i]));
        clearDataError();
      } catch (err) {
        showDataError(`Failed to load data chunk(s): ${err.message}`);
        setLoading(false);
        throw err;
      }
      setLoading(false);
    }

    paths.forEach((p) => touchCacheEntry(store.summaryCacheOrder, p));
    pruneCache(store.summaryCache, store.summaryCacheOrder, paths.length + EXTRA_SUMMARY_CHUNKS_CACHED, new Set(paths));

    const rows = [];
    paths.forEach((p) => {
      const cached = store.summaryCache.get(p);
      if (cached) rows.push(...cached);
    });
    store.activeRows = rows;
    store.rowsById = new Map(rows.map((r) => [r._pair_id, r]));
    updateChunkDebug();
  }

  async function ensureDetailLoaded(detailPath) {
    if (!detailPath) return null;
    if (!store.detailCache.has(detailPath)) {
      const records = await fetchJson(detailPath);
      store.detailCache.set(detailPath, new Map(records.map((r) => [r._pair_id, r])));
    }
    touchCacheEntry(store.detailCacheOrder, detailPath);
    pruneCache(store.detailCache, store.detailCacheOrder, EXTRA_DETAIL_CHUNKS_CACHED + 1, new Set([detailPath]));
    return store.detailCache.get(detailPath);
  }

  // ---------------------------------------------------------------------
  // Setup / control population
  // ---------------------------------------------------------------------

  function populateSelect(select, values, opts) {
    const previouslySelected = new Set(Array.from(select.selectedOptions).map((o) => o.value));
    select.innerHTML = "";
    values.forEach((v) => {
      const opt = document.createElement("option");
      if (opts && opts.valueKey) {
        opt.value = v[opts.valueKey];
        opt.textContent = v[opts.labelKey];
      } else {
        opt.value = v;
        opt.textContent = v;
      }
      if (opts && opts.preserveSelection && previouslySelected.has(opt.value)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }

  function selectedValues(select) {
    return Array.from(select.selectedOptions).map((o) => o.value);
  }

  function orEmpty(value) {
    return value === null || value === undefined ? "" : value;
  }

  function parseNumberOrNull(text) {
    if (text === null || text === undefined || text === "") return null;
    const n = Number(text);
    return Number.isNaN(n) ? null : n;
  }

  function getState() {
    const xaxisEl = document.querySelector('input[name="xaxis-mode"]:checked');
    const leftGlossModeEl = document.querySelector('input[name="left-gloss-tag-mode"]:checked');
    const rightGlossModeEl = document.querySelector('input[name="right-gloss-tag-mode"]:checked');
    return {
      metric: el("metric-select").value,
      xaxisMode: xaxisEl ? xaxisEl.value : "condition",
      comparisonLang: el("comparison-lang-select").value,
      models: selectedValues(el("model-filter")),
      posStrategies: selectedValues(el("pos-strategy-filter")),
      negStrategies: selectedValues(el("neg-strategy-filter")),
      conditions: selectedValues(el("condition-filter")),
      includeIdentical: el("include-identical").checked,
      glossTags: {
        left: selectedValues(el("left-gloss-tag-filter")),
        right: selectedValues(el("right-gloss-tag-filter")),
      },
      glossMode: {
        left: leftGlossModeEl ? leftGlossModeEl.value : "Both",
        right: rightGlossModeEl ? rightGlossModeEl.value : "Both",
      },
      highlightFields: selectedValues(el("highlight-fields-select")),
      averageFields: selectedValues(el("average-fields-select")),
      statsFields: selectedValues(el("stats-fields-select")),
      statsThreshold: parseNumberOrNull(el("stats-threshold-input").value),
      thresholdLower: parseNumberOrNull(el("threshold-lower").value),
      thresholdUpper: parseNumberOrNull(el("threshold-upper").value),
    };
  }

  async function init() {
    setLoading(true);
    try {
      store.manifest = await fetchJson("manifest.json");
    } catch (err) {
      setLoading(false);
      showDataError(
        `Failed to load manifest.json: ${err.message}. Make sure you're serving this directory over HTTP ` +
          `(e.g. "cd docs && python3 -m http.server 8000"), not opening index.html via file://.`
      );
      return;
    }
    setLoading(false);

    const manifest = store.manifest;
    el("outputs-dir-line").textContent = `Loaded from: ${manifest.outputs_dir}`;

    const warningsDiv = el("warnings");
    (manifest.warnings || []).forEach((w) => {
      const p = document.createElement("p");
      p.className = "warning";
      p.textContent = w;
      warningsDiv.appendChild(p);
    });

    if (manifest.metric_options.length) {
      populateSelect(el("metric-select"), manifest.metric_options, { valueKey: "value", labelKey: "label" });
    } else {
      populateSelect(
        el("metric-select"),
        [{ value: "token_logprob_diff", label: "Token-wise log probability difference" }],
        { valueKey: "value", labelKey: "label" }
      );
    }

    populateSelect(el("comparison-lang-select"), manifest.language_order || []);
    populateSelect(el("model-filter"), manifest.filters.models);
    populateSelect(el("pos-strategy-filter"), manifest.filters.pos_strategies);
    populateSelect(el("neg-strategy-filter"), manifest.filters.neg_strategies);
    populateSelect(el("condition-filter"), manifest.filters.conditions || []);
    // Gloss-tag options come from the manifest's global vocabulary (computed
    // once over the full dataset at build time), not from whatever chunks
    // happen to be loaded right now -- an intentional, documented trade-off
    // of lazy loading (options stay stable; highlighting still only applies
    // to currently-loaded rows, via rowMatchesGloss below).
    populateSelect(el("left-gloss-tag-filter"), manifest.filters.gloss_tags || []);
    populateSelect(el("right-gloss-tag-filter"), manifest.filters.gloss_tags || []);

    el("metric-select").addEventListener("change", () => {
      closeAllStatsDetails();
      applyMetricRestrictions();
      refreshAll();
    });

    [
      "comparison-lang-select",
      "model-filter",
      "pos-strategy-filter",
      "neg-strategy-filter",
      "condition-filter",
      "include-identical",
      "stats-fields-select",
    ].forEach((id) => el(id).addEventListener("change", () => { closeAllStatsDetails(); refreshAll(); }));

    el("highlight-fields-select").addEventListener("change", () => renderGraphs());
    el("average-fields-select").addEventListener("change", () => { closeAllStatsDetails(); refreshAll(); });

    el("threshold-lower").addEventListener("input", () => { closeAllStatsDetails(); renderExamples(); });
    el("threshold-upper").addEventListener("input", () => { closeAllStatsDetails(); renderExamples(); });
    el("stats-threshold-input").addEventListener("input", () => renderExamples());
    document.querySelectorAll('input[name="xaxis-mode"]').forEach((r) =>
      r.addEventListener("change", () => { closeAllStatsDetails(); onXaxisModeChange(); })
    );
    ["left", "right"].forEach((side) => {
      el(`${side}-gloss-tag-filter`).addEventListener("change", () => renderGraphs());
    });
    document
      .querySelectorAll('input[name="left-gloss-tag-mode"], input[name="right-gloss-tag-mode"]')
      .forEach((r) => r.addEventListener("change", () => renderGraphs()));
    el("show-surprisal-toggle").addEventListener("change", () => renderDetailPanel(store.selectedPairId));

    ["left", "right"].forEach((side) => {
      el(`${side}-sort-field`).addEventListener("change", () => onTableControlChange(side));
      el(`${side}-sort-dir`).addEventListener("change", () => onTableControlChange(side));
      el(`${side}-category-filter`).addEventListener("change", () => onTableControlChange(side));
    });

    applyMetricRestrictions();
    onXaxisModeChange();
    renderDetailPanel(null);
  }

  function onXaxisModeChange() {
    const state = getState();
    el("comparison-lang-control").style.display = state.xaxisMode === "language" ? "none" : "";
    refreshAll();
  }

  function onTableControlChange(side) {
    tableState[side].sortField = el(`${side}-sort-field`).value;
    tableState[side].sortDir = el(`${side}-sort-dir`).value;
    tableState[side].categoryFilter = el(`${side}-category-filter`).value;
    renderExamples();
  }

  // ---------------------------------------------------------------------
  // Pairwise view restriction (CLAUDE.md section 5): rows carrying only the
  // pairwise metric (no per-condition variation, e.g. the OpenAI backend)
  // only support the language-comparison x-axis mode and their own metric.
  // ---------------------------------------------------------------------

  function applyMetricRestrictions() {
    const manifest = store.manifest;
    const isPairwise = manifest && el("metric-select").value === manifest.pairwise_metric;

    const conditionRadio = document.querySelector('input[name="xaxis-mode"][value="condition"]');
    const modelRadio = document.querySelector('input[name="xaxis-mode"][value="model"]');
    const languageRadio = document.querySelector('input[name="xaxis-mode"][value="language"]');

    conditionRadio.disabled = isPairwise;
    modelRadio.disabled = isPairwise;
    el("condition-filter-control").style.display = isPairwise ? "none" : "";
    el("surprisal-control").style.display = isPairwise ? "none" : "";

    if (isPairwise && !pairwiseRestrictionActive) {
      const current = document.querySelector('input[name="xaxis-mode"]:checked');
      xaxisModeBeforePairwiseForce = current ? current.value : "condition";
      languageRadio.checked = true;
      // A local-condition selection can never match a pairwise row's
      // _condition_label ("Pairwise"), so it must be cleared here -- left in
      // place it would silently filter every pairwise row out of the view.
      Array.from(el("condition-filter").options).forEach((o) => { o.selected = false; });
      pairwiseRestrictionActive = true;
    } else if (!isPairwise && pairwiseRestrictionActive) {
      if (xaxisModeBeforePairwiseForce) {
        const prev = document.querySelector(`input[name="xaxis-mode"][value="${xaxisModeBeforePairwiseForce}"]`);
        if (prev) prev.checked = true;
      }
      pairwiseRestrictionActive = false;
      xaxisModeBeforePairwiseForce = null;
    }

    const activeXaxis = document.querySelector('input[name="xaxis-mode"]:checked');
    el("comparison-lang-control").style.display = activeXaxis && activeXaxis.value === "language" ? "none" : "";
  }

  // ---------------------------------------------------------------------
  // Filtering (mirrors viz_data.apply_filters, minus gloss tags: gloss tags
  // highlight only, so they never remove rows here)
  // ---------------------------------------------------------------------

  function isIdenticalPair(row) {
    // Mirrors pandas `positive_sentence != negative_sentence`: missing
    // (NaN/null) values are never treated as equal to each other.
    if (row.positive_sentence === null || row.negative_sentence === null) return false;
    return row.positive_sentence === row.negative_sentence;
  }

  function applyBaseFilters(rows, state) {
    return rows.filter((r) => {
      if (state.models.length && !state.models.includes(r.model_name)) return false;
      if (state.posStrategies.length && !state.posStrategies.includes(r.pos_strategy)) return false;
      if (state.negStrategies.length && !state.negStrategies.includes(r.neg_strategy)) return false;
      if (state.conditions.length && !state.conditions.includes(r._condition_label)) return false;
      if (!state.includeIdentical && isIdenticalPair(r)) return false;
      return true;
    });
  }

  // Direction/side selection (paired construction-language view / Language
  // comparison mode). Uses pos_construction_lang / neg_construction_lang --
  // the actual per-row direction columns -- rather than the compound
  // `construction_lang` string, so the logic does not depend on that
  // field's exact formatting.
  function sideRows(baseFiltered, state, side) {
    const languageSet = new Set(store.manifest.language_order || []);
    if (state.xaxisMode === "language") {
      if (side === "left") {
        return baseFiltered.filter((r) => languageSet.has(r.lang));
      }
      return baseFiltered.filter((r) => r.lang === "en" && languageSet.has(r.neg_construction_lang));
    }
    const lang = state.comparisonLang;
    if (!lang) return [];
    if (side === "left") {
      return baseFiltered.filter((r) => r.pos_construction_lang === lang && r.neg_construction_lang === "en");
    }
    return baseFiltered.filter((r) => r.pos_construction_lang === "en" && r.neg_construction_lang === lang);
  }

  function xColForSide(state, side) {
    if (state.xaxisMode === "model") return "model_name";
    if (state.xaxisMode === "language") return side === "left" ? "lang" : "neg_construction_lang";
    return "_condition_label";
  }

  function computeCategories(state) {
    if (state.xaxisMode === "model") {
      if (state.models.length) return state.models;
      return (store.manifest.filters.models || []).slice();
    }
    if (state.xaxisMode === "language") {
      return store.manifest.language_order || [];
    }
    return store.manifest.setting_order;
  }

  function sideTitle(state, side) {
    if (state.xaxisMode === "language") {
      return side === "left" ? "Target-language comparison" : "English task language by construction language";
    }
    const lang = state.comparisonLang || "?";
    return side === "left" ? `${lang} vs en` : `en vs ${lang}`;
  }

  // ---------------------------------------------------------------------
  // Gloss-tag highlight predicate: highlights, never filters. Options are
  // populated once at init from the manifest's global vocabulary (see
  // init()); only the label text below is refreshed per view.
  // ---------------------------------------------------------------------

  function refreshGlossTagLabels(state) {
    ["left", "right"].forEach((side) => {
      el(`${side}-gloss-tag-label`).textContent = `${sideTitle(state, side)} — Interlinear-gloss tags`;
    });
  }

  function glossTagsSatisfy(selected, tags) {
    const set = new Set(tags || []);
    return selected.every((t) => set.has(t));
  }

  function rowMatchesGloss(row, glossTags, glossMode) {
    if (!glossTags.length) return false;
    if (glossMode === "Positive") return glossTagsSatisfy(glossTags, row._pos_gloss_tags);
    if (glossMode === "Negative") return glossTagsSatisfy(glossTags, row._neg_gloss_tags);
    return glossTagsSatisfy(glossTags, row._pos_gloss_tags) && glossTagsSatisfy(glossTags, row._neg_gloss_tags);
  }

  // ---------------------------------------------------------------------
  // Click-related-point predicate: matches the clicked row on every
  // selected grouping field. Rows missing any selected field are excluded
  // from the comparison (never treated as a matching "missing" category).
  // Never uses _pair_id as the grouping identity.
  // ---------------------------------------------------------------------

  function rowsMatchOnFields(row, other, fields) {
    if (!fields.length || !other) return false;
    for (const f of fields) {
      const a = row[f];
      const b = other[f];
      if (a === null || a === undefined || a === "") return false;
      if (b === null || b === undefined || b === "") return false;
      if (a !== b) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Small numeric helpers
  // ---------------------------------------------------------------------

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function mean(values) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  // ---------------------------------------------------------------------
  // Marker styling: exact clicked point (strongest) > related+gloss
  // combined > related > gloss > ordinary.
  // ---------------------------------------------------------------------

  // Bright, maximally-contrasting fill colors for the click-to-highlight
  // group, distinct from every ordinary trace color (blue scatter points,
  // red/blue diff-token markers) and from each other, so the highlighted
  // group is unmistakable at a glance rather than only a thin outline change.
  const RELATED_HIGHLIGHT_COLOR = "rgb(255,0,0)"; // bright red
  const RELATED_GLOSS_HIGHLIGHT_COLOR = "rgb(255,0,170)"; // bright magenta
  const EXACT_HIGHLIGHT_COLOR = "rgb(255,215,0)"; // gold

  function computeStyle(row, ctx, baseColor) {
    const isExact = ctx.selectedPairId !== null && row._pair_id === ctx.selectedPairId;
    const isGloss = rowMatchesGloss(row, ctx.glossTags, ctx.glossMode);
    const isRelated = ctx.relatedEnabled && rowsMatchOnFields(row, ctx.selectedRow, ctx.highlightFields);

    let size = 7;
    let opacity = 0.55;
    let lineWidth = 0;
    let lineColor = "rgba(0,0,0,0)";
    let color = baseColor;

    if (isGloss) {
      size = 9;
      opacity = 0.85;
      lineWidth = 1.5;
      lineColor = "rgb(255,140,0)";
    }

    if (isRelated) {
      // The clicked point's matching group: swap the fill to a bright color
      // (never just a subtle outline) so it stands out immediately against
      // the ordinary points, even before considering size/outline.
      color = isGloss ? RELATED_GLOSS_HIGHLIGHT_COLOR : RELATED_HIGHLIGHT_COLOR;
      size = 12;
      opacity = 1;
      lineWidth = 2;
      lineColor = "black";
    }

    if (isExact) {
      // The exact clicked point stands out even from the rest of its
      // highlighted group.
      color = EXACT_HIGHLIGHT_COLOR;
      size = Math.max(size, 15);
      opacity = 1;
      lineWidth = 3.5;
      lineColor = "black";
    }

    return { size, opacity, lineWidth, lineColor, color };
  }

  // ---------------------------------------------------------------------
  // X-axis label visibility (CLAUDE.md section 1): model and condition
  // labels are shown diagonally, in full (never abbreviated/wrapped), with
  // enough bottom margin -- scaled to the longest label for model names,
  // since Hugging Face model identifiers vary widely in length.
  // ---------------------------------------------------------------------

  function getXAxisDisplaySettings(xAxisMode, labels) {
    const longestLabelLength = Math.max(0, ...labels.map((label) => String(label).length));

    if (xAxisMode === "model") {
      return {
        tickangle: -35,
        automargin: true,
        bottomMargin: Math.max(130, Math.min(260, 70 + longestLabelLength * 2.5)),
      };
    }

    if (xAxisMode === "condition") {
      return {
        tickangle: -35,
        automargin: true,
        bottomMargin: 120,
      };
    }

    return {
      tickangle: 0,
      automargin: true,
      bottomMargin: 80,
    };
  }

  // ---------------------------------------------------------------------
  // Main scatter graphs
  // ---------------------------------------------------------------------

  function zeroLineShape() {
    return { type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: 0, y1: 0, line: { dash: "dash", color: "gray" } };
  }

  function baseLayout(yTitle, xaxisMode, presentCategories) {
    const settings = getXAxisDisplaySettings(xaxisMode, presentCategories);
    return {
      yaxis: { title: yTitle },
      xaxis: {
        title: xaxisMode === "model" ? "Model" : xaxisMode === "language" ? "Language" : "Condition",
        tickmode: "array",
        tickvals: presentCategories.map((_, i) => i),
        ticktext: presentCategories.map((c) => String(c)),
        tickangle: settings.tickangle,
        automargin: settings.automargin,
      },
      shapes: [zeroLineShape()],
      legend: { orientation: "h", x: 1, y: 1, xanchor: "right", yanchor: "top" },
      margin: { t: 30, b: settings.bottomMargin },
      uirevision: "main-graph",
    };
  }

  // ---------------------------------------------------------------------
  // Hover text (CLAUDE.md section 6): a raw pairwise point shows both
  // vote-level (AB/BA) confidence values plus the final signed confidence;
  // every other metric keeps the existing prompt/sentence hover. Built as a
  // single preformatted string per point (rather than juggling several
  // possibly-missing customdata fields with Plotly's own number formatting),
  // since legacy result files may be missing the individual per-vote
  // confidence fields entirely (CLAUDE.md 2.2) and must show clearly as such
  // rather than as a formatting error.
  // ---------------------------------------------------------------------

  function fmtNum(v) {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "n/a";
  }

  function fmtSigned(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "n/a";
    return (v >= 0 ? "+" : "") + v.toFixed(4);
  }

  function isPairwiseMetric(metric) {
    return metric === store.manifest.pairwise_metric;
  }

  function buildHoverText(row, metricCol, metricLabel) {
    const lines = [`model: ${orEmpty(row.model_name)}`, `English baseline: ${orEmpty(row["English baseline"])}`];

    if (isPairwiseMetric(metricCol)) {
      lines.push(
        `AB output: ${orEmpty(row.pairwise_ab_raw_output)}`,
        `AB original choice: ${orEmpty(row.pairwise_ab_original_chosen_label)}`,
        `AB confidence: ${fmtNum(row.pairwise_ab_confidence)}`,
        `AB signed confidence: ${fmtSigned(row.pairwise_ab_signed_confidence)}`,
        `BA output: ${orEmpty(row.pairwise_ba_raw_output)}`,
        `BA original choice: ${orEmpty(row.pairwise_ba_original_chosen_label)}`,
        `BA confidence: ${fmtNum(row.pairwise_ba_confidence)}`,
        `BA signed confidence: ${fmtSigned(row.pairwise_ba_signed_confidence)}`,
        `Final signed confidence: ${fmtSigned(row.pairwise_signed_choice_confidence)}`
      );
    } else {
      lines.push(`prompt: ${orEmpty(row.prompt)}`);
    }

    lines.push(`positive_sentence: ${orEmpty(row.positive_sentence)}`, `negative_sentence: ${orEmpty(row.negative_sentence)}`);
    lines.push(`${metricLabel || "y"}: ${fmtNum(row[metricCol])}`);
    return lines.join("<br>");
  }

  function buildScatterTraces(rows, metric, xCol, categories, ctx) {
    const present = new Set(rows.map((r) => r[xCol]).filter((v) => v !== null && v !== undefined));
    const presentCategories = categories.filter((c) => present.has(c));
    const traces = [];
    const rng = mulberry32(1);

    presentCategories.forEach((cat, i) => {
      const catRows = rows.filter((r) => r[xCol] === cat && typeof r[metric] === "number");
      if (!catRows.length) return;
      const ys = catRows.map((r) => r[metric]);
      const xs = ys.map(() => i + (rng() * 2 - 1) * 0.12);
      const customdata = catRows.map((r) => r._pair_id);
      const text = catRows.map((r) => buildHoverText(r, metric, null));
      const styles = catRows.map((r) => computeStyle(r, ctx, "rgb(31,119,180)"));

      traces.push({
        x: xs,
        y: ys,
        mode: "markers",
        type: "scatter",
        name: "data point",
        legendgroup: "points",
        showlegend: i === 0,
        marker: {
          color: styles.map((s) => s.color),
          size: styles.map((s) => s.size),
          opacity: styles.map((s) => s.opacity),
          line: { width: styles.map((s) => s.lineWidth), color: styles.map((s) => s.lineColor) },
        },
        customdata,
        text,
        hovertemplate: "%{text}<extra></extra>",
      });

      const med = median(ys);
      const avg = mean(ys);
      traces.push({
        x: [i - 0.22, i + 0.22],
        y: [med, med],
        mode: "lines",
        type: "scatter",
        name: "median",
        legendgroup: "median",
        showlegend: i === 0,
        line: { color: "crimson", width: 3 },
        hoverinfo: "skip",
      });
      traces.push({
        x: [i],
        y: [avg],
        mode: "markers",
        type: "scatter",
        name: "mean",
        legendgroup: "mean",
        showlegend: i === 0,
        marker: { color: "seagreen", size: 13, symbol: "diamond", line: { color: "black", width: 1 } },
        hovertemplate: `mean: ${avg.toFixed(4)}<extra></extra>`,
      });
    });

    return { traces, presentCategories };
  }

  function buildDiffTraces(rows, xCol, categories, ctx) {
    const present = new Set(rows.map((r) => r[xCol]).filter((v) => v !== null && v !== undefined));
    const presentCategories = categories.filter((c) => present.has(c));
    const traces = [];
    const entries = Object.values(store.manifest.diff_metric_columns);

    entries.forEach((spec, mIdx) => {
      const offset = mIdx === 0 ? -0.15 : 0.15;
      const rng = mulberry32(mIdx + 2);

      presentCategories.forEach((cat, i) => {
        const catRows = rows.filter((r) => r[xCol] === cat && typeof r[spec.column] === "number");
        if (!catRows.length) return;
        const ys = catRows.map((r) => r[spec.column]);
        const xs = ys.map(() => i + offset + (rng() * 2 - 1) * 0.05);
        const customdata = catRows.map((r) => r._pair_id);
        const text = catRows.map((r) => buildHoverText(r, spec.column, `${spec.label} logprob diff`));
        const styles = catRows.map((r) => computeStyle(r, ctx, spec.color));

        traces.push({
          x: xs,
          y: ys,
          mode: "markers",
          type: "scatter",
          name: spec.label,
          legendgroup: spec.label,
          showlegend: i === 0,
          marker: {
            color: styles.map((s) => s.color),
            size: styles.map((s) => Math.max(s.size, 6)),
            symbol: spec.symbol,
            opacity: styles.map((s) => s.opacity),
            line: { width: styles.map((s) => s.lineWidth), color: styles.map((s) => s.lineColor) },
          },
          customdata,
          text,
          hovertemplate: "%{text}<extra></extra>",
        });

        const med = median(ys);
        const avg = mean(ys);
        traces.push({
          x: [i + offset - 0.06, i + offset + 0.06],
          y: [med, med],
          mode: "lines",
          type: "scatter",
          name: `${spec.label} median`,
          legendgroup: `${spec.label} median`,
          showlegend: i === 0,
          line: { color: spec.color, width: 3, dash: "dot" },
          hoverinfo: "skip",
        });
        traces.push({
          x: [i + offset],
          y: [avg],
          mode: "markers",
          type: "scatter",
          name: `${spec.label} mean`,
          legendgroup: `${spec.label} mean`,
          showlegend: i === 0,
          marker: { color: spec.color, size: 12, symbol: "diamond-open", line: { width: 2 } },
          hovertemplate: `${spec.label} mean: ${avg.toFixed(4)}<extra></extra>`,
        });
      });
    });

    return { traces, presentCategories };
  }

  // ---------------------------------------------------------------------
  // Average plots (CLAUDE.md section 8): grouped by the active x-axis
  // category plus the selected averaging dimensions, arithmetic mean,
  // non-finite values ignored, never averaged across different x-axis
  // categories. Replaces the raw per-row plot entirely when one or more
  // dimensions are selected -- it does not overlay it.
  // ---------------------------------------------------------------------

  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function groupRowsForAveraging(rows, xCol, categories, metricCol, groupingFields) {
    const byCategory = new Map();
    categories.forEach((c) => byCategory.set(c, new Map()));

    rows.forEach((r) => {
      const cat = r[xCol];
      const catGroups = byCategory.get(cat);
      if (!catGroups) return;
      const y = r[metricCol];
      if (!isFiniteNumber(y)) return; // non-finite metric values are ignored

      const keyParts = [];
      for (const f of groupingFields) {
        const v = r[f];
        if (v === null || v === undefined || v === "") return; // row can't be grouped -- excluded
        keyParts.push(String(v));
      }
      const key = keyParts.join("||");

      if (!catGroups.has(key)) {
        catGroups.set(key, { groupValues: Object.fromEntries(groupingFields.map((f) => [f, r[f]])), values: [], rows: [] });
      }
      const g = catGroups.get(key);
      g.values.push(y);
      g.rows.push(r);
    });

    return byCategory;
  }

  function meanOfField(rows, field) {
    const values = rows.map((r) => r[field]).filter(isFiniteNumber);
    return values.length ? mean(values) : null;
  }

  function buildAveragedPointsForMetric(rows, metricCol, xCol, categories, groupingFields, includePairwiseSummary) {
    const grouped = groupRowsForAveraging(rows, xCol, categories, metricCol, groupingFields);
    const presentCategories = categories.filter((c) => grouped.get(c) && grouped.get(c).size > 0);

    const xs = [];
    const ys = [];
    const texts = [];

    presentCategories.forEach((cat, i) => {
      const groups = Array.from(grouped.get(cat).values());
      groups.forEach((g, gi) => {
        const groupMean = mean(g.values);
        const offset = groups.length > 1 ? (gi - (groups.length - 1) / 2) * 0.18 : 0;
        xs.push(i + offset);
        ys.push(groupMean);

        const lines = groupingFields.map((f) => `${f}: ${orEmpty(g.groupValues[f])}`);
        lines.push(`Mean: ${groupMean.toFixed(4)}`);
        lines.push(`Number of examples: ${g.values.length}`);
        if (includePairwiseSummary) {
          lines.push(
            `Mean AB confidence: ${fmtNum(meanOfField(g.rows, "pairwise_ab_confidence"))}`,
            `Mean AB signed confidence: ${fmtSigned(meanOfField(g.rows, "pairwise_ab_signed_confidence"))}`,
            `Mean BA confidence: ${fmtNum(meanOfField(g.rows, "pairwise_ba_confidence"))}`,
            `Mean BA signed confidence: ${fmtSigned(meanOfField(g.rows, "pairwise_ba_signed_confidence"))}`
          );
        }
        texts.push(lines.join("<br>"));
      });
    });

    return { xs, ys, texts, presentCategories };
  }

  function averagedTrace(name, color, points) {
    return {
      x: points.xs,
      y: points.ys,
      mode: "markers",
      type: "scatter",
      name,
      marker: { color, size: 13, symbol: "diamond", line: { color: "black", width: 1.5 } },
      text: points.texts,
      hovertemplate: "%{text}<extra></extra>",
      // Averaged points are aggregates, never individually selectable --
      // customdata is intentionally omitted so onGraphClick treats them like
      // the existing mean/median overlay markers.
    };
  }

  function buildAveragedTraces(rows, metric, xCol, categories, groupingFields) {
    const points = buildAveragedPointsForMetric(rows, metric, xCol, categories, groupingFields, isPairwiseMetric(metric));
    return { traces: [averagedTrace("averaged", "rgb(255,127,14)", points)], presentCategories: points.presentCategories };
  }

  function buildAveragedDiffTraces(rows, xCol, categories, groupingFields) {
    const traces = [];
    const entries = Object.values(store.manifest.diff_metric_columns);
    const categorySet = new Set();
    const offsets = [-0.15, 0.15];

    entries.forEach((spec, mIdx) => {
      const points = buildAveragedPointsForMetric(rows, spec.column, xCol, categories, groupingFields, false);
      points.presentCategories.forEach((c) => categorySet.add(c));
      const offsetPoints = { ...points, xs: points.xs.map((x) => x + offsets[mIdx]) };
      traces.push(averagedTrace(`${spec.label} averaged`, spec.color, offsetPoints));
    });

    return { traces, presentCategories: categories.filter((c) => categorySet.has(c)) };
  }

  // ---------------------------------------------------------------------
  // Win rate (CLAUDE.md section 7): wins / (wins + losses), exact zero and
  // non-finite values excluded from both. Computed from whichever values are
  // actually displayed -- raw per-row values normally, or the averaged
  // group means when averaging is active -- so it never implies a
  // denominator larger than what the plot actually shows.
  // ---------------------------------------------------------------------

  function computeWinRateStats(ys) {
    let wins = 0;
    let losses = 0;
    ys.forEach((y) => {
      if (!isFiniteNumber(y) || y === 0) return;
      if (y > 0) wins += 1;
      else losses += 1;
    });
    const denom = wins + losses;
    return { wins, losses, denom, rate: denom > 0 ? wins / denom : null };
  }

  function displayedValuesByCategory(rows, metricCol, xCol, categories, groupingFields) {
    const byCategory = new Map();
    categories.forEach((c) => byCategory.set(c, []));

    if (!groupingFields.length) {
      rows.forEach((r) => {
        const bucket = byCategory.get(r[xCol]);
        if (!bucket) return;
        const y = r[metricCol];
        if (isFiniteNumber(y)) bucket.push(y);
      });
      return byCategory;
    }

    const grouped = groupRowsForAveraging(rows, xCol, categories, metricCol, groupingFields);
    categories.forEach((cat) => {
      const groups = grouped.get(cat);
      if (!groups) return;
      groups.forEach((g) => byCategory.get(cat).push(mean(g.values)));
    });
    return byCategory;
  }

  function renderWinRates(side, state, rows, xCol, categories) {
    const container = el(`${side}-winrate`);
    if (!container) return;
    container.innerHTML = "";
    if (!rows.length) return;

    const metricSpecs =
      state.metric === "diff_comparison"
        ? Object.values(store.manifest.diff_metric_columns).map((spec) => [spec.column, spec.label])
        : [[state.metric, null]];

    metricSpecs.forEach(([metricCol, label]) => {
      const byCategory = displayedValuesByCategory(rows, metricCol, xCol, categories, state.averageFields);
      const anyData = categories.some((cat) => (byCategory.get(cat) || []).length > 0);
      if (!anyData) return;

      const row = document.createElement("div");
      row.className = "winrate-row";

      const heading = document.createElement("span");
      heading.className = "winrate-heading";
      heading.textContent = label ? `${label} win rate:` : "Win rate:";
      row.appendChild(heading);

      categories.forEach((cat) => {
        const stats = computeWinRateStats(byCategory.get(cat) || []);
        if (stats.denom === 0) return;
        const item = document.createElement("span");
        item.className = "winrate-item";
        item.textContent = `${cat}: ${(stats.rate * 100).toFixed(1)}% (${stats.wins}/${stats.denom})`;
        row.appendChild(item);
      });

      container.appendChild(row);
    });
  }

  function renderSideGraph(side, state, baseFiltered) {
    const rows = sideRows(baseFiltered, state, side);
    const xCol = xColForSide(state, side);
    const categories = computeCategories(state);
    const relatedEnabled = RELATED_CLICK_METRICS.has(state.metric);
    const isAveraging = state.averageFields.length > 0;
    const ctx = {
      selectedPairId: store.selectedPairId,
      selectedRow: store.selectedRow,
      glossTags: state.glossTags[side],
      glossMode: state.glossMode[side],
      highlightFields: state.highlightFields,
      relatedEnabled,
    };

    let traces, presentCategories, yTitle;
    if (state.metric === "diff_comparison") {
      ({ traces, presentCategories } = isAveraging
        ? buildAveragedDiffTraces(rows, xCol, categories, state.averageFields)
        : buildDiffTraces(rows, xCol, categories, ctx));
      yTitle = store.manifest.metric_y_labels.diff_comparison;
    } else {
      ({ traces, presentCategories } = isAveraging
        ? buildAveragedTraces(rows, state.metric, xCol, categories, state.averageFields)
        : buildScatterTraces(rows, state.metric, xCol, categories, ctx));
      yTitle = store.manifest.metric_y_labels[state.metric] || state.metric;
    }

    const layout = baseLayout(yTitle, state.xaxisMode, presentCategories);
    const graphDiv = el(`${side}-graph`);

    if (!graphInitialized[side]) {
      Plotly.newPlot(graphDiv, traces, layout, { responsive: true });
      graphDiv.on("plotly_click", onGraphClick);
      graphInitialized[side] = true;
    } else {
      Plotly.react(graphDiv, traces, layout, { responsive: true });
    }

    el(`${side}-graph-title`).textContent = sideTitle(state, side);
    renderWinRates(side, state, rows, xCol, categories);
    return rows;
  }

  function onGraphClick(eventData) {
    if (!eventData || !eventData.points || !eventData.points.length) return;
    const point = eventData.points[0];
    const pairId = point.customdata;
    // Mean/median/averaged traces carry no customdata, so clicking them is a
    // no-op: only actual data-point traces are selectable.
    if (pairId === null || pairId === undefined) return;
    store.selectedPairId = pairId;
    store.selectedRow = store.rowsById.get(pairId) || null;
    renderDetailPanel(store.selectedPairId);
    renderGraphs();
  }

  function renderGraphs() {
    const state = getState();
    const baseFiltered = applyBaseFilters(store.activeRows, state);
    const leftRows = renderSideGraph("left", state, baseFiltered);
    const rightRows = renderSideGraph("right", state, baseFiltered);
    return { state, leftRows, rightRows };
  }

  // ---------------------------------------------------------------------
  // Detail panel + surprisal plot. Heavy per-token fields (pos_diff_tokens,
  // positive_tokens/surprisals, etc.) are not present on a row until its
  // detail chunk (row._detail_chunk) has been fetched -- this happens
  // lazily here, on click, never up front.
  // ---------------------------------------------------------------------

  function formatValue(value) {
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "number" && !Number.isInteger(value)) return value.toFixed(4);
    return String(value);
  }

  function appendField(container, label, value) {
    if (value === null || value === undefined || value === "") return;
    const p = document.createElement("p");
    const b = document.createElement("b");
    b.textContent = label + ": ";
    p.appendChild(b);
    p.appendChild(document.createTextNode(formatValue(value)));
    container.appendChild(p);
  }

  async function renderDetailPanel(pairId) {
    const container = el("detail-panel");
    container.innerHTML = "";
    const row = pairId !== null && pairId !== undefined ? store.rowsById.get(pairId) : null;

    if (!row) {
      const p = document.createElement("p");
      p.textContent = "Click a point in either plot to see details here.";
      container.appendChild(p);
      updateSurprisalPanel(null);
      return;
    }

    appendField(container, "Model", row.model_name);
    appendField(container, "Lang / construction lang", `${orEmpty(row.lang)} (${orEmpty(row.construction_lang)})`);
    appendField(container, "Condition", row._condition_label);
    appendField(container, "Positive / negative strategy", `${orEmpty(row.pos_strategy)} vs ${orEmpty(row.neg_strategy)}`);
    appendField(container, "English baseline", row["English baseline"]);
    appendField(container, "Subject/Undergoer Person+Number", row["Subject/Undergoer Person+Number"]);
    appendField(container, "Time", row.Time);
    appendField(container, "Prompt", row.prompt);
    appendField(container, "Positive sentence", row.positive_sentence);
    appendField(container, "Negative sentence", row.negative_sentence);
    appendField(container, "Positive Interlinear gloss", row.positive_Interlinear_gloss);
    appendField(container, "Negative Interlinear gloss", row.negative_Interlinear_gloss);

    if (row.pairwise_winner !== null && row.pairwise_winner !== undefined) {
      // Same fields as the raw-point hover tooltip (CLAUDE.md section 6).
      // Legacy result files may be missing the individual per-vote
      // confidence/signed-confidence fields entirely (CLAUDE.md 2.2) --
      // appendField already omits any field whose value is null/undefined,
      // so those simply do not appear rather than showing a fabricated value.
      container.appendChild(document.createElement("hr"));
      appendField(container, "AB output", row.pairwise_ab_raw_output);
      appendField(container, "AB original choice", row.pairwise_ab_original_chosen_label);
      appendField(container, "AB confidence", row.pairwise_ab_confidence);
      appendField(container, "AB signed confidence", row.pairwise_ab_signed_confidence);
      appendField(container, "BA output", row.pairwise_ba_raw_output);
      appendField(container, "BA original choice", row.pairwise_ba_original_chosen_label);
      appendField(container, "BA confidence", row.pairwise_ba_confidence);
      appendField(container, "BA signed confidence", row.pairwise_ba_signed_confidence);
      appendField(container, "Pairwise winner", row.pairwise_winner);
      appendField(container, "Final signed confidence", row.pairwise_signed_choice_confidence);
    }

    const diffFields = [
      ["Positive diff tokens", row.pos_diff_tokens],
      ["Negative diff tokens", row.neg_diff_tokens],
      ["Positive after-diff tokens", row.pos_after_diff_tokens],
      ["Negative after-diff tokens", row.neg_after_diff_tokens],
    ].filter(([, v]) => v !== null && v !== undefined);
    if (diffFields.length) {
      container.appendChild(document.createElement("hr"));
      diffFields.forEach(([label, value]) => appendField(container, label, value));
    }

    updateSurprisalPanel(row);

    if (row._detail_chunk && !row._detail_loaded) {
      const note = document.createElement("p");
      note.className = "detail-loading-note";
      note.textContent = "Loading token-level detail…";
      container.appendChild(note);

      try {
        const detailMap = await ensureDetailLoaded(row._detail_chunk);
        const detailRecord = detailMap && detailMap.get(row._pair_id);
        if (detailRecord) Object.assign(row, detailRecord);
        row._detail_loaded = true;
      } catch (err) {
        note.textContent = `Failed to load token-level detail: ${err.message}`;
        return;
      }

      // The selection may have changed while the detail chunk was in
      // flight; only re-render if this pair is still the one selected.
      if (store.selectedPairId === pairId) {
        renderDetailPanel(pairId);
      }
    }
  }

  function hasSurprisalData(row) {
    if (!row) return false;
    return ["positive_tokens", "positive_token_surprisals", "negative_tokens", "negative_token_surprisals"].every(
      (k) => Array.isArray(row[k]) && row[k].length > 0
    );
  }

  function updateSurprisalPanel(row) {
    const container = el("surprisal-graph-container");
    const showRequested = el("show-surprisal-toggle").checked;

    if (row && hasSurprisalData(row) && showRequested) {
      container.style.display = "block";
      renderSurprisalGraph(row);
    } else {
      container.style.display = "none";
    }
  }

  function renderSurprisalGraph(row) {
    const posTokens = row.positive_tokens;
    const posSurp = row.positive_token_surprisals;
    const negTokens = row.negative_tokens;
    const negSurp = row.negative_token_surprisals;

    const traces = [
      {
        x: posSurp.map((_, i) => i),
        y: posSurp,
        text: posTokens,
        mode: "lines+markers",
        type: "scatter",
        name: "positive",
        hovertemplate: "token: %{text}<br>surprisal: %{y:.3f} nats<extra></extra>",
      },
      {
        x: negSurp.map((_, i) => i),
        y: negSurp,
        text: negTokens,
        mode: "lines+markers",
        type: "scatter",
        name: "negative",
        hovertemplate: "token: %{text}<br>surprisal: %{y:.3f} nats<extra></extra>",
      },
    ];
    const layout = {
      xaxis: { title: "Token position (scored sentence tokens only)" },
      yaxis: { title: "Surprisal (nats)" },
      margin: { t: 30, b: 40 },
    };
    const graphDiv = el("surprisal-graph");
    if (!surprisalGraphInitialized) {
      Plotly.newPlot(graphDiv, traces, layout, { responsive: true });
      surprisalGraphInitialized = true;
    } else {
      Plotly.react(graphDiv, traces, layout, { responsive: true });
    }
  }

  // ---------------------------------------------------------------------
  // Matching examples + statistics
  // ---------------------------------------------------------------------

  function groupKeyFor(row, fields) {
    if (!fields.length) return null;
    const parts = [];
    for (const f of fields) {
      const v = row[f];
      if (v === null || v === undefined || v === "") return null;
      parts.push(String(v));
    }
    return parts.join("");
  }

  // Groups computed from the *full* side dataset (after main filters,
  // before gloss-tag highlighting -- gloss tags never affect the
  // denominator) for one metric column.
  function computeGroups(rows, metricCol, fields, lower, upper) {
    const groups = new Map();
    rows.forEach((r) => {
      const key = groupKeyFor(r, fields);
      if (key === null) return;
      const y = r[metricCol];
      if (typeof y !== "number") return; // NaN/missing never counts toward the denominator
      if (!groups.has(key)) groups.set(key, { validRows: [], inRangeRows: [], outRangeRows: [] });
      const g = groups.get(key);
      g.validRows.push(r);
      const inRange = (lower === null || y >= lower) && (upper === null || y <= upper);
      if (inRange) g.inRangeRows.push(r);
      else g.outRangeRows.push(r);
    });
    return groups;
  }

  function statisticFor(row, metricCol, groups, fields) {
    const key = groupKeyFor(row, fields);
    if (key === null) return null;
    const g = groups.get(key);
    if (!g || !g.validRows.length) return null;
    return (g.inRangeRows.length / g.validRows.length) * 100;
  }

  function buildMatches(rows, metricCol, lower, upper, groups, statsFields, categoryCol) {
    return rows
      .filter((r) => typeof r[metricCol] === "number")
      .filter((r) => (lower === null || r[metricCol] >= lower) && (upper === null || r[metricCol] <= upper))
      .map((r) => ({
        yValue: r[metricCol],
        row: r,
        category: orEmpty(r[categoryCol]),
        statistic: statisticFor(r, metricCol, groups, statsFields),
        group: groups.get(groupKeyFor(r, statsFields)) || null,
      }));
  }

  function sortMatches(matches, sortField, sortDir) {
    const factor = sortDir === "desc" ? -1 : 1;
    const sorted = [...matches].sort((a, b) => {
      let av, bv;
      if (sortField === "category") {
        av = a.category;
        bv = b.category;
        return factor * String(av).localeCompare(String(bv));
      }
      if (sortField === "statistic") {
        av = a.statistic === null ? -Infinity : a.statistic;
        bv = b.statistic === null ? -Infinity : b.statistic;
      } else {
        av = a.yValue;
        bv = b.yValue;
      }
      return factor * (av - bv);
    });
    return sorted;
  }

  // ---------------------------------------------------------------------
  // Statistics detail panel: persistent, scrollable, clickable detail
  // section. The detail list always comes from the exact same `group`
  // object used to compute the displayed percentage (built once in
  // renderSideExamples / computeGroups), never recomputed from the full
  // dataset.
  // ---------------------------------------------------------------------

  const statsDetailState = { left: null, right: null };

  function closeStatsDetail(side) {
    statsDetailState[side] = null;
    renderStatsDetailPanel(side);
  }

  function closeAllStatsDetails() {
    closeStatsDetail("left");
    closeStatsDetail("right");
  }

  function openStatsDetail(side, info) {
    statsDetailState[side] = info;
    renderStatsDetailPanel(side);
  }

  function detailRowFields(row, metricCol) {
    return [
      ["English baseline", orEmpty(row["English baseline"])],
      ["model", orEmpty(row.model_name)],
      ["condition", orEmpty(row._condition_label)],
      ["lang", orEmpty(row.lang)],
      ["construction lang", orEmpty(row.construction_lang)],
      ["positive strategy", orEmpty(row.pos_strategy)],
      ["negative strategy", orEmpty(row.neg_strategy)],
      ["positive sentence", orEmpty(row.positive_sentence)],
      ["negative sentence", orEmpty(row.negative_sentence)],
      ["y-value", typeof row[metricCol] === "number" ? row[metricCol].toFixed(4) : ""],
    ];
  }

  function buildDetailRowsTable(rowsList, metricCol) {
    if (!rowsList.length) {
      const p = document.createElement("p");
      p.textContent = "(none)";
      return p;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "stats-detail-scroll";
    const table = document.createElement("table");
    table.className = "example-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    detailRowFields(rowsList[0], metricCol).forEach(([label]) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rowsList.forEach((row) => {
      const tr = document.createElement("tr");
      detailRowFields(row, metricCol).forEach(([, value]) => {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  function renderStatsDetailPanel(side) {
    const container = el(`${side}-stats-detail`);
    const info = statsDetailState[side];
    container.innerHTML = "";
    if (!info) {
      container.style.display = "none";
      return;
    }
    container.style.display = "block";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "stats-detail-close";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => closeStatsDetail(side));
    container.appendChild(closeBtn);

    const heading = document.createElement("h5");
    heading.textContent = `Comparison: ${info.sideTitle}`;
    container.appendChild(heading);

    const groupingHeading = document.createElement("p");
    const groupingLabel = document.createElement("b");
    groupingLabel.textContent = "Statistics grouping:";
    groupingHeading.appendChild(groupingLabel);
    container.appendChild(groupingHeading);
    info.statsFields.forEach((f) => {
      const p = document.createElement("p");
      p.textContent = `${f} = ${orEmpty(info.groupValues[f])}`;
      container.appendChild(p);
    });

    const statP = document.createElement("p");
    const statLabel = document.createElement("b");
    statLabel.textContent = "Statistics: ";
    statP.appendChild(statLabel);
    statP.appendChild(
      document.createTextNode(
        `${info.statistic.toFixed(1)}% (${info.group.inRangeRows.length} / ${info.group.validRows.length})`
      )
    );
    container.appendChild(statP);

    const inHeading = document.createElement("h5");
    inHeading.textContent = `In range (${info.group.inRangeRows.length})`;
    container.appendChild(inHeading);
    container.appendChild(buildDetailRowsTable(info.group.inRangeRows, info.metricCol));

    const outHeading = document.createElement("h5");
    outHeading.textContent = `Out of range (${info.group.outRangeRows.length})`;
    container.appendChild(outHeading);
    container.appendChild(buildDetailRowsTable(info.group.outRangeRows, info.metricCol));
  }

  function renderExampleTable(side, matches, metricCol, statsThreshold, state) {
    if (!matches.length) {
      const p = document.createElement("p");
      p.textContent = "No matching examples.";
      return p;
    }

    const table = document.createElement("table");
    table.className = "example-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["y-value", "category", "model", "statistics", "positive_sentence", "negative_sentence"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    matches.forEach(({ yValue, row, category, statistic, group }) => {
      const tr = document.createElement("tr");

      const cells = [
        yValue.toFixed(4),
        category,
        orEmpty(row.model_name),
        null, // statistics cell built separately below
        orEmpty(row.positive_sentence),
        orEmpty(row.negative_sentence),
      ];

      cells.forEach((text, idx) => {
        const td = document.createElement("td");
        if (idx === 3) {
          td.className = "stat-cell";
          if (statistic === null) {
            td.textContent = "—";
          } else {
            td.textContent = `${statistic.toFixed(1)}%`;
            td.classList.add("stat-cell-clickable");
            if (statsThreshold !== null && statistic >= statsThreshold) {
              td.classList.add("stat-high");
              tr.classList.add("stat-high-row");
            }
            const groupKey = groupKeyFor(row, state.statsFields);
            td.addEventListener("click", () => {
              const current = statsDetailState[side];
              if (current && current.metricCol === metricCol && current.groupKey === groupKey) {
                closeStatsDetail(side);
                return;
              }
              openStatsDetail(side, {
                sideTitle: sideTitle(state, side),
                statsFields: state.statsFields,
                groupValues: Object.fromEntries(state.statsFields.map((f) => [f, row[f]])),
                groupKey,
                metricCol,
                group,
                statistic,
              });
            });
          }
        } else {
          td.textContent = text;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function populateCategoryFilterOptions(side, matches) {
    const select = el(`${side}-category-filter`);
    const current = tableState[side].categoryFilter;
    const categories = Array.from(new Set(matches.map((m) => m.category))).sort();
    select.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "All";
    select.appendChild(allOpt);
    categories.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      select.appendChild(opt);
    });
    select.value = categories.includes(current) ? current : "";
    tableState[side].categoryFilter = select.value;
  }

  function renderSideExamples(side, state, rows) {
    const container = el(`${side}-example-list-container`);
    container.innerHTML = "";
    el(`${side}-examples-title`).textContent = `Matching examples: ${sideTitle(state, side)}`;

    if (!rows.length) {
      const p = document.createElement("p");
      p.textContent = "No matching examples.";
      container.appendChild(p);
      populateCategoryFilterOptions(side, []);
      return;
    }

    const categoryCol = xColForSide(state, side);
    const ts = tableState[side];

    // One category-filter/sort control set per section, shared across both
    // diff_comparison sub-tables: build every sub-table's raw match list
    // first, populate the category dropdown from their union, then apply
    // the (single) category filter + sort to each.
    const metricSpecs =
      state.metric === "diff_comparison"
        ? Object.values(store.manifest.diff_metric_columns).map((spec) => [spec.column, `${spec.label} matches`])
        : [[state.metric, null]];

    const rawByMetric = metricSpecs.map(([metricCol]) => {
      const groups = computeGroups(rows, metricCol, state.statsFields, state.thresholdLower, state.thresholdUpper);
      return buildMatches(rows, metricCol, state.thresholdLower, state.thresholdUpper, groups, state.statsFields, categoryCol);
    });

    const unionMatches = [].concat(...rawByMetric);
    populateCategoryFilterOptions(side, unionMatches);

    metricSpecs.forEach(([metricCol, heading], idx) => {
      if (heading) {
        const h = document.createElement("h5");
        h.textContent = heading;
        container.appendChild(h);
      }
      let matches = rawByMetric[idx];
      if (ts.categoryFilter) matches = matches.filter((m) => m.category === ts.categoryFilter);
      matches = sortMatches(matches, ts.sortField, ts.sortDir);
      container.appendChild(renderExampleTable(side, matches, metricCol, state.statsThreshold, state));
    });
  }

  function renderExamples(precomputed) {
    if (!store.activeRows.length) {
      ["left", "right"].forEach((side) => {
        const container = el(`${side}-example-list-container`);
        container.innerHTML = "";
        const p = document.createElement("p");
        p.textContent = "No data loaded.";
        container.appendChild(p);
      });
      return;
    }

    const state = precomputed ? precomputed.state : getState();
    const baseFiltered = precomputed ? null : applyBaseFilters(store.activeRows, state);
    const leftRows = precomputed ? precomputed.leftRows : sideRows(baseFiltered, state, "left");
    const rightRows = precomputed ? precomputed.rightRows : sideRows(baseFiltered, state, "right");

    renderSideExamples("left", state, leftRows);
    renderSideExamples("right", state, rightRows);
  }

  // ---------------------------------------------------------------------
  // Top-level refresh: determine which chunks the current control state
  // needs, load them (lazily -- only what's missing), then render.
  // ---------------------------------------------------------------------

  async function refreshAll() {
    const state = getState();
    const paths = requiredChunkPaths(state);
    const seq = ++store.requestSeq;

    try {
      await ensureChunksLoaded(paths);
    } catch (err) {
      return; // error already shown via showDataError()
    }
    if (seq !== store.requestSeq) return; // superseded by a newer control change

    refreshGlossTagLabels(state);
    const precomputed = renderGraphs();
    renderExamples(precomputed);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
