// GitHub Actions Metrics Table
//
// On a repo's Actions list page, fetches each visible run's page (server-rendered,
// same-origin, session cookies) and extracts step-summary tables whose header row
// is `param | value` or `metric | value`. Aggregates them into one runs-by-metrics
// comparison table injected above the run list.
(() => {
  "use strict";

  const PANEL_ID = "gamt-panel";
  const FETCH_CONCURRENCY = 4;

  // ---------- storage (chrome.storage.local, with in-memory shim for page-context testing)

  const rawStorage =
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : (() => {
          const mem = {};
          return {
            get: async (keys) => {
              const out = {};
              for (const k of Array.isArray(keys) ? keys : [keys]) if (k in mem) out[k] = mem[k];
              return out;
            },
            set: async (obj) => Object.assign(mem, obj),
            remove: async (keys) => {
              for (const k of Array.isArray(keys) ? keys : [keys]) delete mem[k];
            },
          };
        })();

  // After the extension is reloaded/updated, content scripts already injected in open
  // tabs lose their chrome.* bridge ("Extension context invalidated"). Swallow those
  // errors here and let the lifecycle guard below retire this instance.
  const storage = {
    get: async (keys) => {
      try {
        return await rawStorage.get(keys);
      } catch {
        return {};
      }
    },
    set: async (obj) => {
      try {
        await rawStorage.set(obj);
      } catch {
        /* context gone — nothing to persist to */
      }
    },
    remove: async (keys) => {
      try {
        await rawStorage.remove(keys);
      } catch {
        /* context gone */
      }
    },
  };

  const contextAlive = () =>
    typeof chrome === "undefined" || !chrome.runtime || !!chrome.runtime.id;

  const cacheKey = (repo, runId) => `gamt:run:v2:${repo}#${runId}`;
  const settingsKey = (repo) => `gamt:settings:${repo}`;

  async function loadSettings(repo) {
    const got = await storage.get(settingsKey(repo));
    return Object.assign(
      {
        headlineOnly: true,
        numericOnly: true,
        filter: "",
        overrides: {},
        open: true,
        sortKey: "",
        sortDir: 1,
      },
      got[settingsKey(repo)] || {}
    );
  }

  const saveSettings = (repo, s) => storage.set({ [settingsKey(repo)]: s });

  // ---------- page detection & run collection

  function currentRepo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/actions(\/workflows\/[^/]+)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  }

  function collectRuns() {
    const runs = new Map();
    for (const a of document.querySelectorAll('a[href*="/actions/runs/"]')) {
      if (a.closest(`#${PANEL_ID}`)) continue;
      const m = (a.getAttribute("href") || "").match(/^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/);
      if (!m) continue;
      const title = a.textContent.trim();
      if (!title || runs.has(m[1])) continue;
      // status lives on the run row's icon aria-label; stay inside the row container
      let status = "";
      const row = a.closest("li") || a.closest('[class*="Box-row"]') || a.parentElement?.parentElement;
      const icon = row?.querySelector('svg[aria-label], [role="img"][aria-label]');
      if (icon) status = icon.getAttribute("aria-label") || "";
      const branchEl = row?.querySelector(".branch-name");
      runs.set(m[1], {
        id: m[1],
        title,
        url: location.origin + m[0],
        status,
        branch: branchEl?.textContent.trim() || "",
        branchUrl: branchEl?.closest("a")?.href || branchEl?.href || "",
        date: row?.querySelector("relative-time[datetime], time[datetime]")?.getAttribute("datetime") || "",
      });
    }
    return [...runs.values()];
  }

  const isTerminal = (status) => /success|fail|cancel|skip|completed|neutral|timed.out/i.test(status);

  // ---------- run-page summary parsing

  // Contract: a step-summary table whose header row is exactly [param|metric, value].
  // Bold (**…**) metric rows mark the headline metrics — record them.
  function parseSummary(doc) {
    const out = { params: {}, metrics: {}, bold: [] };
    let found = false;
    for (const table of doc.querySelectorAll("table")) {
      const head = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim().toLowerCase());
      if (head.length !== 2 || head[1] !== "value" || (head[0] !== "param" && head[0] !== "metric")) continue;
      const isParam = head[0] === "param";
      const dst = isParam ? out.params : out.metrics;
      for (const tr of table.querySelectorAll("tbody tr")) {
        if (tr.cells.length < 2) continue;
        const key = tr.cells[0].textContent.trim();
        dst[key] = tr.cells[1].textContent.trim();
        if (!isParam && tr.cells[0].querySelector("strong, b")) out.bold.push(key);
      }
      found = true;
    }
    return found ? out : null;
  }

  async function fetchRunSummary(run) {
    try {
      const res = await fetch(run.url, { credentials: "include" });
      if (!res.ok) return null;
      return parseSummary(new DOMParser().parseFromString(await res.text(), "text/html"));
    } catch {
      return null;
    }
  }

  async function getRunData(repo, run, force) {
    const key = cacheKey(repo, run.id);
    if (!force) {
      const got = await storage.get(key);
      if (got[key]) return got[key];
    }
    const summary = await fetchRunSummary(run);
    const data = {
      params: summary?.params || {},
      metrics: summary?.metrics || {},
      bold: summary?.bold || [],
      hasSummary: !!summary,
    };
    // summaries are written at the end of the run — immutable once the run is terminal
    if (summary || isTerminal(run.status)) await storage.set({ [key]: data });
    return data;
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i]);
        }
      })
    );
    return out;
  }

  // ---------- column selection & formatting

  // Fallback headline heuristic when the summary bolds nothing: task-level keys only.
  const isHeadlineKey = (key) => {
    const seg = key.split(".");
    return seg.length <= 2 || seg[0] === seg[1];
  };

  function selectMetricColumns(allKeys, settings, rows) {
    if (settings.filter.trim()) {
      let match;
      try {
        const re = new RegExp(settings.filter.trim(), "i");
        match = (k) => re.test(k);
      } catch {
        const needle = settings.filter.trim().toLowerCase();
        match = (k) => k.toLowerCase().includes(needle);
      }
      return allKeys.filter(match);
    }
    const isNumericCol = (k) =>
      rows.some((r) => {
        const v = r.data.metrics[k];
        return v !== undefined && v.trim() !== "" && Number.isFinite(Number(v));
      });
    // headline = bold (**…**) in any run's summary; heuristic fallback if nothing is bolded
    const bold = new Set(rows.flatMap((r) => r.data.bold || []));
    const isHeadline = bold.size ? (k) => bold.has(k) : isHeadlineKey;
    return allKeys.filter(
      (k) => (!settings.headlineOnly || isHeadline(k)) && (!settings.numericOnly || isNumericCol(k))
    );
  }

  // `mmlu.mmlu.acc,none` -> `mmlu acc,none` (full key stays in the tooltip)
  function columnLabel(key) {
    const seg = key.split(".");
    return seg.length >= 2 && seg[0] === seg[1] ? [seg[0], ...seg.slice(2)].join(" ") : key;
  }

  function formatValue(v) {
    if (/^-?\d*\.\d{5,}$/.test(v.trim())) return String(Math.round(Number(v) * 1e4) / 1e4);
    return v;
  }

  // ISO timestamp -> "2026-07-28 09:38" in local time
  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // GitHub octicons (check-circle-fill, x-circle-fill, circle-slash, dot-fill)
  const ICONS = {
    success:
      '<svg viewBox="0 0 16 16" width="16" height="16" class="gamt-icon-success" aria-hidden="true"><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z"/></svg>',
    failure:
      '<svg viewBox="0 0 16 16" width="16" height="16" class="gamt-icon-danger" aria-hidden="true"><path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/></svg>',
    cancelled:
      '<svg viewBox="0 0 16 16" width="16" height="16" class="gamt-icon-muted" aria-hidden="true"><path d="M2.344 2.343h-.001a8 8 0 0 1 11.314 11.314A8.002 8.002 0 0 1 .234 10.089a8 8 0 0 1 2.11-7.746Zm1.06 10.253a6.5 6.5 0 0 0 8.16.826L3.081 3.98a6.5 6.5 0 0 0 .323 8.616Zm9.212-9.21a6.5 6.5 0 0 0-8.615-.323L12.29 12.5a6.5 6.5 0 0 0 .325-8.612Z"/></svg>',
    running:
      '<svg viewBox="0 0 16 16" width="16" height="16" class="gamt-icon-attention" aria-hidden="true"><path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>',
    unknown:
      '<svg viewBox="0 0 16 16" width="16" height="16" class="gamt-icon-muted" aria-hidden="true"><path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>',
  };

  function statusIcon(status) {
    const kind = /success/i.test(status)
      ? "success"
      : /fail|timed.out/i.test(status)
        ? "failure"
        : /cancel|skip/i.test(status)
          ? "cancelled"
          : /progress|running|queued|waiting|pending/i.test(status)
            ? "running"
            : "unknown";
    const span = el("span", { class: "gamt-status", title: status || "unknown" });
    span.innerHTML = ICONS[kind];
    return span;
  }

  // ---------- rendering

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.appendChild(c);
    return node;
  }

  // Per-column show/hide overrides (from the columns dropdown) win over the toggles/filter.
  // Param overrides are namespaced "param:<key>" so they can't collide with metric keys.
  function effectiveColumns(rows, settings) {
    const paramKeys = [...new Set(rows.flatMap((r) => Object.keys(r.data.params)))].sort();
    const allMetricKeys = [...new Set(rows.flatMap((r) => Object.keys(r.data.metrics)))].sort();
    const base = new Set(selectMetricColumns(allMetricKeys, settings, rows));
    const ov = settings.overrides || {};
    // fixed columns (branch/date/avg) are hideable too, via "col:" override keys
    const FIXED = ["branch", "date", "avg"];
    const show = Object.fromEntries(FIXED.map((k) => [k, ov[`col:${k}`] ?? true]));
    return {
      allMetricKeys,
      show,
      paramKeys: paramKeys.filter((k) => ov[`param:${k}`] ?? true),
      metricKeys: allMetricKeys.filter((k) => ov[k] ?? base.has(k)),
      items: [
        ...FIXED.map((k) => ({ key: `col:${k}`, label: k, group: "basic", included: show[k] })),
        ...paramKeys.map((k) => ({ key: `param:${k}`, label: k, group: "params", included: ov[`param:${k}`] ?? true })),
        ...allMetricKeys.map((k) => ({ key: k, label: k, group: "metrics", included: ov[k] ?? base.has(k) })),
      ],
    };
  }

  function buildTable(rows, settings, onSort) {
    const { paramKeys, allMetricKeys, metricKeys, show } = effectiveColumns(rows, settings);

    // per-run mean over the visible numeric metric values
    const avg = new Map();
    for (const r of rows) {
      const nums = metricKeys
        .map((k) => r.data.metrics[k])
        .filter((v) => v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)))
        .map(Number);
      avg.set(r.run.id, nums.length ? { mean: nums.reduce((a, b) => a + b, 0) / nums.length, n: nums.length } : null);
    }

    if (settings.sortKey) {
      const get = (r) =>
        settings.sortKey === "run"
          ? r.run.title.toLowerCase()
          : settings.sortKey === "branch"
            ? r.run.branch.toLowerCase() || undefined
            : settings.sortKey === "date"
              ? r.run.date || undefined
              : settings.sortKey === "avg"
              ? avg.get(r.run.id)?.mean
              : r.data.metrics[settings.sortKey] ?? r.data.params[settings.sortKey];
      rows = [...rows].sort((a, b) => {
        const [va, vb] = [get(a), get(b)];
        if (va === undefined) return 1;
        if (vb === undefined) return -1;
        const [na, nb] = [Number(va), Number(vb)];
        const cmp = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(va).localeCompare(String(vb));
        return cmp * settings.sortDir;
      });
    }

    const th = (key, label, cls) =>
      el("th", {
        text: label + (settings.sortKey === key ? (settings.sortDir === 1 ? " ▲" : " ▼") : ""),
        title: key === "run" ? "sort by run name" : key,
        class: cls || "",
        onclick: () => onSort(key),
      });

    const header = el("tr", {}, [
      th("run", "run", "gamt-sticky-col"),
      ...(show.branch ? [th("branch", "branch")] : []),
      ...(show.date ? [th("date", "date", "gamt-date")] : []),
      ...(show.avg ? [th("avg", "avg", "gamt-avg")] : []),
      ...paramKeys.map((k) => th(k, k, "gamt-param")),
      ...metricKeys.map((k) => th(k, columnLabel(k))),
    ]);

    const body = rows.map(({ run, data }) => {
      const a = avg.get(run.id);
      return el("tr", {}, [
        el("td", { class: "gamt-sticky-col" }, [
          // flex goes on an inner wrapper — flex on the td itself breaks table-cell layout
          el("span", { class: "gamt-run-cell" }, [
            statusIcon(run.status),
            el("a", { class: "gamt-run-link", href: run.url, text: run.title, title: run.title }),
          ]),
        ]),
        ...(show.branch
          ? [
              el(
                "td",
                { class: "gamt-branch" },
                run.branch
                  ? [el("a", { href: run.branchUrl || run.url, text: run.branch, title: run.branch })]
                  : []
              ),
            ]
          : []),
        ...(show.date ? [el("td", { class: "gamt-date", text: formatDate(run.date), title: run.date })] : []),
        ...(show.avg
          ? [
              el("td", {
                class: "gamt-avg",
                text: a ? String(Math.round(a.mean * 1e4) / 1e4) : "",
                title: a ? `mean of ${a.n} visible metric values (${a.mean})` : "",
              }),
            ]
          : []),
        ...paramKeys.map((k) => el("td", { class: "gamt-param", text: data.params[k] ?? "", title: data.params[k] ?? "" })),
        ...metricKeys.map((k) => {
          const v = data.metrics[k];
          return el("td", { text: v === undefined ? "" : formatValue(v), title: v === undefined ? "" : `${k} = ${v}` });
        }),
      ]);
    });

    const note =
      metricKeys.length < allMetricKeys.length
        ? `${metricKeys.length}/${allMetricKeys.length} metric columns shown`
        : `${allMetricKeys.length} metric columns`;
    return { table: el("table", { class: "gamt-table" }, [el("thead", {}, [header]), el("tbody", {}, body)]), note };
  }

  // Dropdown listing every column, included first then by name, with show/hide checkboxes.
  // The list is (re)built on open so items don't jump around while being toggled.
  function buildColumnsDropdown(repo, settings, rerender, getColumns) {
    const menu = el("div", { class: "gamt-menu" });
    const dropdown = el("details", { class: "gamt-dropdown" }, [
      el("summary", { class: "gamt-dropdown-btn", text: "columns ▾" }),
      menu,
    ]);

    function buildMenu() {
      const items = getColumns().items;
      const sections = ["basic", "params", "metrics"]
        .map((group) => {
          const groupItems = items
            .filter((i) => i.group === group)
            .sort((a, b) => b.included - a.included || a.label.localeCompare(b.label));
          if (!groupItems.length) return null;
          return el("div", { class: "gamt-menu-section" }, [
            el("div", { class: "gamt-menu-section-title", text: group }),
            ...groupItems.map((item) =>
              el("label", { class: "gamt-menu-item", "data-label": item.label.toLowerCase() }, [
                el("input", {
                  type: "checkbox",
                  ...(item.included ? { checked: "" } : {}),
                  onchange: (e) => {
                    settings.overrides = { ...settings.overrides, [item.key]: e.target.checked };
                    saveSettings(repo, settings);
                    rerender(false);
                  },
                }),
                el("span", { text: item.label, title: item.label }),
              ])
            ),
          ]);
        })
        .filter(Boolean);
      const list = el("div", { class: "gamt-menu-list" }, sections);
      const search = el("input", {
        class: "gamt-menu-search",
        type: "text",
        placeholder: "search columns",
        oninput: (e) => {
          const needle = e.target.value.toLowerCase();
          for (const section of list.children) {
            let any = false;
            for (const item of section.querySelectorAll(".gamt-menu-item")) {
              item.hidden = !item.dataset.label.includes(needle);
              any = any || !item.hidden;
            }
            section.hidden = !any;
          }
        },
      });
      const reset = el("button", {
        class: "gamt-refresh",
        type: "button",
        text: "reset overrides",
        onclick: () => {
          settings.overrides = {};
          saveSettings(repo, settings);
          rerender(false);
          buildMenu();
        },
      });
      menu.replaceChildren(el("div", { class: "gamt-menu-head" }, [search, reset]), list);
    }

    dropdown.addEventListener("toggle", () => {
      if (dropdown.open) buildMenu();
    });
    return dropdown;
  }

  function buildPanel(repo, settings, rerender, getColumns) {
    const panel = el("details", { id: PANEL_ID, class: "gamt-panel" });
    if (settings.open) panel.setAttribute("open", "");
    panel.addEventListener("toggle", () => {
      settings.open = panel.open;
      saveSettings(repo, settings);
    });

    const checkbox = (label, key) =>
      el("label", { class: "gamt-ctl" }, [
        el("input", {
          type: "checkbox",
          ...(settings[key] ? { checked: "" } : {}),
          onchange: (e) => {
            settings[key] = e.target.checked;
            saveSettings(repo, settings);
            rerender(false);
          },
        }),
        el("span", { text: label }),
      ]);

    let debounce;
    const controls = el("div", { class: "gamt-controls" }, [
      checkbox("headline only", "headlineOnly"),
      checkbox("numeric only", "numericOnly"),
      buildColumnsDropdown(repo, settings, rerender, getColumns),
      el("input", {
        class: "gamt-filter",
        type: "text",
        placeholder: "filter columns (regex, overrides toggles)",
        value: settings.filter,
        oninput: (e) => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            settings.filter = e.target.value;
            saveSettings(repo, settings);
            rerender(false);
          }, 300);
        },
      }),
      el("button", { class: "gamt-refresh", type: "button", text: "↻ refresh", onclick: () => rerender(true) }),
      el("span", { class: "gamt-note" }),
    ]);

    panel.append(
      el("summary", { class: "gamt-summary", text: "Run metrics" }),
      controls,
      el("div", { class: "gamt-scroll" })
    );
    return panel;
  }

  // ---------- orchestration

  let lastPageKey = "";
  let building = false;

  async function init(force) {
    if (!contextAlive()) {
      // a newer copy of this script owns the page now — retire quietly
      clearInterval(pollTimer);
      return;
    }
    const repo = currentRepo();
    if (!repo) {
      document.getElementById(PANEL_ID)?.remove();
      lastPageKey = "";
      return;
    }
    const runs = collectRuns();
    const pageKey = `${location.pathname}?${new URLSearchParams(location.search)}|${runs.map((r) => r.id + r.status).join(",")}`;
    if (!force && pageKey === lastPageKey) return;
    if (!runs.length || building) return;
    building = true;
    lastPageKey = pageKey;

    try {
      const settings = await loadSettings(repo);
      document.getElementById(PANEL_ID)?.remove();

      let rows = runs.map((run) => ({ run, data: { params: {}, metrics: {}, hasSummary: false } }));

      const rerender = (refetch) => {
        if (refetch) {
          init.refetch = true;
          lastPageKey = "";
          init(true);
          return;
        }
        const { table, note } = buildTable(rows, settings, (key) => {
          // cycle: ascending -> descending -> unsorted
          if (settings.sortKey !== key) {
            settings.sortKey = key;
            settings.sortDir = 1;
          } else if (settings.sortDir === 1) {
            settings.sortDir = -1;
          } else {
            settings.sortKey = "";
            settings.sortDir = 1;
          }
          saveSettings(repo, settings);
          rerender(false);
        });
        const scroll = panel.querySelector(".gamt-scroll");
        scroll.replaceChildren(table);
        panel.querySelector(".gamt-note").textContent = note;
        panel.querySelector(".gamt-summary").textContent = `Run metrics — ${rows.length} runs`;
      };

      const panel = buildPanel(repo, settings, rerender, () => effectiveColumns(rows, settings));
      const main = document.querySelector("main") || document.body;
      main.prepend(panel);
      panel.querySelector(".gamt-note").textContent = "loading…";
      rerender(false);

      const forceFetch = init.refetch === true;
      init.refetch = false;
      await mapLimit(runs, FETCH_CONCURRENCY, async (run) => {
        const data = await getRunData(repo, run, forceFetch);
        const row = rows.find((r) => r.run.id === run.id);
        if (row) row.data = data;
        rerender(false);
      });
    } finally {
      building = false;
    }
  }

  // GitHub soft-navigates (Turbo); also poll cheaply for list updates the events miss.
  document.addEventListener("turbo:load", () => init(false));
  document.addEventListener("turbo:render", () => init(false));
  window.addEventListener("popstate", () => init(false));
  const pollTimer = setInterval(() => init(false), 3000);
  init(false);
})();
