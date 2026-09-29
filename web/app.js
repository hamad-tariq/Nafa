// Fund Board: hash-routed views over the prices embedded in the page.
const main = document.getElementById("main");
const RANGES = [["1M", 30], ["3M", 91], ["6M", 182], ["1Y", 365], ["All", 0]];
const MAX_PICK = 8;
const S = {data: null, history: {}, version: null, token: "", status: null, updating: false,
           slots: new Map(), pick: [], watch: new Set(load("fb.watch", [])), range: 30, more: false,
           lead: {basis: "both", q: ""}};

function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

// ---------- helpers
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  e.append(...kids.flat(Infinity).filter(k => k != null && k !== false));  // strings become text nodes
  return e;
}
const NS = "http://www.w3.org/2000/svg";
const ICONS = {
  arrow: "M5 12h14M13 6l6 6-6 6", back: "M19 12H5M11 18l-6-6 6-6", chev: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14", check: "M5 12.5l4.5 4.5L19 7", x: "M7 7l10 10M17 7L7 17",
  star: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  columns: "M4 5h16v14H4zM9.5 5v14M14.5 5v14",
  link: "M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1",
  rank: "M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11", bars: "M4 20h16M7 16v-4M12 16V8M17 16v-7",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
};
function icon(name) {
  const svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
const pct = v => v == null ? "—" : `${v.toFixed(2)}%`;
const signed = v => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const day = (s, o = {day: "numeric", month: "short", year: "numeric"}) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", o);
const dm = s => day(s, {day: "numeric", month: "short"});
const delta = v => v == null ? h("span", {class: "muted"}, "—")  // arrow + sign, so direction never relies on color
  : h("span", {class: v > 0 ? "up num" : v < 0 ? "down num" : "num"}, `${v > 0 ? "▲" : v < 0 ? "▼" : "■"} ${signed(v)}`);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const rgba = (hex, a) => `rgba(${hex.replace("#", "").match(/../g).map(x => parseInt(x, 16)).join(",")},${a})`;
const enc = encodeURIComponent;
const fundHref = f => "#/fund/" + enc(f);
const catHref = c => "#/funds?cat=" + enc(c);
const compareHref = list => "#/compare" + (list.length ? "?" + list.map(f => "f=" + enc(f)).join("&") : "");
const funds = () => S.data.funds;
const byName = name => funds().find(f => f.fund === name);
const categories = () => [...new Set(funds().map(f => f.category))];
const peerGroups = () => [...new Set(funds().map(f => f.peer))];  // category + return basis, for fair rankings
const best = (list, k) => list.filter(r => r[k] != null).sort((a, b) => b[k] - a[k])[0];
const leaders = () => peerGroups().map(p => best(funds().filter(f => f.peer === p), "fytd")).filter(Boolean);
const basis = r => r.ann ? "Per year" : "Absolute";
const hist = name => S.history[name] || [];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fyStart = () => { const d = new Date(S.data.asof + "T00:00:00"); return `1 Jul ${d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1}`; };
const cyStart = () => `1 Jan ${S.data.asof.slice(0, 4)}`;
const by = (k, dir) => (a, b) => {
  const x = a[k], y = b[k];
  if (x == null) return y == null ? 0 : 1;  // blanks always last
  if (y == null) return -1;
  return (x < y ? -1 : x > y ? 1 : 0) * dir;
};
function openMethod() {  // the "How these figures are calculated" notes in the footer
  const d = document.getElementById("method");
  d.open = true;
  d.scrollIntoView({behavior: "smooth", block: "center"});
}

function readPage(doc) {  // the server puts the prices and a short-lived token for its API into the page
  const boot = JSON.parse(doc.getElementById("data").textContent);
  S.data = boot.summary;
  S.history = boot.history;
  S.version = boot.version;
  S.token = doc.querySelector('meta[name="board-token"]').content;
}
async function reloadPage() {  // fresh prices and token without a full page reload
  const r = await fetch("/?t=" + Date.now(), {cache: "no-store"});
  readPage(new DOMParser().parseFromString(await r.text(), "text/html"));
}
async function api(path, opts = {}, retry = true) {
  const r = await fetch(path, {...opts, headers: {"X-Board": S.token}});
  if (r.status === 404 && retry) {  // the token expired (tab left open for hours): get a new one and retry
    await reloadPage();
    return api(path, opts, false);
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
function slot(f) {  // a fund keeps its chart color until it leaves the comparison
  if (!S.slots.has(f)) {
    const used = new Set(S.slots.values());
    S.slots.set(f, [1, 2, 3, 4, 5, 6, 7, 8].find(s => !used.has(s)) || 8);
  }
  return S.slots.get(f);
}
const swatch = f => h("i", {class: "swatch", style: `background:var(--s${slot(f)})`});
function togglePick(f) {  // the comparison list, shared by the funds table, fund pages and the compare view
  if (S.pick.includes(f)) { S.pick = S.pick.filter(x => x !== f); S.slots.delete(f); return true; }
  if (S.pick.length >= MAX_PICK) return false;
  S.pick.push(f);
  slot(f);
  return true;
}

// ---------- metrics: one definition shared by the table, fund page and comparison
const M = {
  category: {label: "Category", fmt: v => v},
  basis: {label: "Returns shown", fmt: (v, r) => basis(r)},
  nav: {label: "NAV", fmt: v => v == null ? "—" : v.toFixed(4), tip: "Price of one unit"},
  move: {label: "Last move", fmt: v => delta(v), tip: "Total return since the previous price"},
  mtd: {label: "MTD", tip: "Return so far this month"},
  fytd: {label: "FYTD", tip: "Return since 1 July, the start of the fiscal year"},
  cytd: {label: "CYTD", tip: "Return since 1 January"},
  fy0: {label: () => "FY" + S.data.fy[0], tip: "Return over the whole fiscal year"},
  fy1: {label: () => "FY" + S.data.fy[1], tip: "Return over the whole fiscal year"},
  cagr: {label: "Since launch", tip: "Average yearly return since the fund started (funds at least a year old)"},
  r1y: {label: "1 year", tip: "Return over the last 12 months of collected prices"},
  vol: {label: "Volatility", tip: "How much it swings in a typical year. Higher means a bumpier ride"},
  max_dd: {label: "Max drawdown", tip: "Worst fall from a high, in the history collected so far"},
  dd: {label: "Below peak", tip: "How far it sits under its highest point today"},
  entry_load: {label: "Entry load", tip: "Extra you pay on top of NAV when you buy"},
  exit_load: {label: "Exit load", tip: "Deducted from NAV when you sell"},
  loads: {label: "Entry / exit load", sort: "entry_load", fmt: (v, r) => `${pct(r.entry_load)} / ${pct(r.exit_load)}`,
          tip: "Extra paid on top of NAV when you buy / deducted when you sell"},
  risk: {label: "Price risk", sort: "vol", tip: "Volatility: how much the price swings in a typical year",
         fmt: (v, r) => r.ann ? h("span", {class: "muted"}, "Not calculated", h("small", {class: "subtle"}, "not useful for cash funds")) : pct(r.vol)},
  rank: {label: "Rank", fmt: (v, r) => v == null ? "—" : `${v} of ${r.n_cat}`, tip: "Position among its category peers by FYTD return"},
};
const label = k => typeof M[k].label === "function" ? M[k].label() : M[k].label;
const show = (k, r) => (M[k].fmt || pct)(r[k], r);
const fyKeys = () => S.data.fy.map((_, i) => "fy" + i);
function why(k, r) {  // what a blank means, so a missing value never reads as zero
  if (k.endsWith("load")) return "Not reported";
  if (["vol", "max_dd", "dd"].includes(k)) return r.ann ? "Not useful for cash funds" : "Not enough history";
  if (k === "r1y") return "Needs a year of prices";
  if (k === "cagr") return "Under a year old";
  if (/^fy\d$/.test(k)) return r.launch ? `Not available · launched ${day(r.launch, {month: "short", year: "numeric"})}` : "Not available";
  return "—";
}
const cell = (k, r) => r[k] != null || !M[k].tip ? show(k, r) : h("span", {class: "na"}, why(k, r));  // no tip: a label, never blank

// ---------- charts
const layout = extra => ({
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: {family: css("--font-body"), size: 13, color: css("--ink-2")},
  hoverlabel: {bgcolor: css("--card"), bordercolor: css("--rule-strong"), font: {family: css("--font-body"), color: css("--ink")}},
  ...extra,
});
const axis = extra => ({gridcolor: css("--rule"), linecolor: css("--rule-strong"), zerolinecolor: css("--rule-strong"), automargin: true, ...extra});
const CONFIG = {displayModeBar: false, responsive: true};
const DASH = ["solid", "dash", "dot", "dashdot", "longdash", "solid", "dash", "dot"];  // lines differ by more than color

function growthChart(el, series, fill) {  // series: [{name, color, dash, points: [[date, index], ...]}], rebased to 100
  const end = new Date(S.data.asof + "T00:00:00");
  const start = S.range ? new Date(end - S.range * 864e5) : null;
  const traces = [];
  for (const s of series) {
    const pts = s.points.filter(p => !start || new Date(p[0] + "T00:00:00") >= start);
    if (pts.length < 2) continue;
    traces.push({type: "scatter", mode: "lines", name: s.name, x: pts.map(p => p[0]), y: pts.map(p => 100 * p[1] / pts[0][1]),
                 line: {color: s.color, width: 2.25, dash: s.dash || "solid"}, hovertemplate: "%{y:.2f}",
                 ...(fill && {fill: "tozeroy", fillcolor: rgba(s.color, 0.1)})});
  }
  const ys = traces.flatMap(t => t.y), lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.12 || 0.5;
  Plotly.react(el, traces, layout({
    hovermode: "x unified", showlegend: traces.length > 1, legend: {orientation: "h", x: 0, y: 1.02, yanchor: "bottom"},
    margin: {l: 8, r: 12, t: traces.length > 1 ? 36 : 8, b: 32},
    xaxis: axis({showgrid: false, showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: css("--rule-strong"), spikedash: "solid", spikesnap: "cursor"}),
    yaxis: axis(fill && ys.length ? {range: [lo - pad, hi + pad]} : {}),  // a filled area would otherwise pull the axis to 0
  }), CONFIG);
  return traces;
}

function spark(points) {  // last ~3 months of total return as a small line
  const cut = new Date(new Date(S.data.asof + "T00:00:00") - 91 * 864e5);
  const ys = points.filter(p => new Date(p[0] + "T00:00:00") >= cut).map(p => p[1]);
  if (ys.length < 2) return h("span", {class: "spark"});
  const lo = Math.min(...ys), hi = Math.max(...ys), W = 200, H = 36;
  const d = ys.map((y, i) => `${i ? "L" : "M"}${(i / (ys.length - 1) * W).toFixed(1)},${(H - 3 - (hi === lo ? 0.5 : (y - lo) / (hi - lo)) * (H - 6)).toFixed(1)}`).join("");
  const svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function seg(name, options, current, onpick) {  // a row of pressed/unpressed buttons; options: [[label, value]]
  const g = h("div", {class: "seg", role: "group", "aria-label": name});
  const draw = cur => g.replaceChildren(...options.map(([l, v]) =>
    h("button", {type: "button", "aria-pressed": String(cur === v), onclick: () => { draw(v); onpick(v); }}, l)));
  draw(current);
  return g;
}

function chartCard({sub, series, height, fill = false}) {  // "Growth of 100" with range buttons and a date inspector
  const chart = h("div", {class: "chart", style: `height:${height}px`}), empty = h("div", {class: "chart-empty"});
  const span = h("p", {class: "readout"}), cursor = h("div", {class: "cursor", "aria-live": "polite"});
  const from = h("span", {class: "range-edge"}), to = h("span", {class: "range-edge"});
  const slider = h("input", {type: "range", class: "slider", min: "0", max: "0", value: "0", "aria-label": "Inspect a price date",
    oninput: () => inspect(+slider.value)});
  const inspector = h("div", {class: "inspect"}, h("span", {class: "inspect-label"}, "Inspect date"), from, slider, to);
  let traces = [], dates = [];
  const valueAt = (t, d) => { let v = null; for (let i = 0; i < t.x.length && t.x[i] <= d; i++) v = t.y[i]; return v; };
  function inspect(i) {
    const d = dates[i], many = traces.length > 1;
    cursor.replaceChildren(
      h("span", {class: "cursor-title"}, many ? "Shared date" : "Selected date"), h("span", {class: "cursor-date num"}, day(d)),
      h("span", {class: "cursor-values"}, traces.map(t => {
        const v = valueAt(t, d);
        return h("span", {class: "cursor-value"}, many && h("i", {class: "swatch", style: `background:${t.line.color}`}), many ? t.name : "Index value",
          h("b", {class: "num"}, v == null ? "—" : v.toFixed(2)), v != null && delta(v - 100));
      })));
    Plotly.relayout(chart, {shapes: [{type: "line", xref: "x", yref: "paper", x0: d, x1: d, y0: 0, y1: 1, line: {color: css("--muted"), width: 1, dash: "dot"}}]});
  }
  function draw() {
    traces = growthChart(chart, series(), fill);
    dates = [...new Set(traces.flatMap(t => t.x))].sort();
    empty.textContent = traces.length ? "" : "Not enough prices in this range yet. Try a longer range.";
    inspector.hidden = cursor.hidden = !dates.length;
    span.replaceChildren(...(dates.length ? [
      h("span", {}, h("b", {}, `${dm(dates[0])} – ${day(dates.at(-1))}`), ` · ${plural(dates.length, "collected price")}`),
      h("span", {class: "muted"}, `Index: 100 on ${dm(dates[0])}`)] : []));
    if (!dates.length) return;
    slider.max = String(dates.length - 1);
    slider.value = String(dates.length - 1);
    from.textContent = dm(dates[0]);
    to.textContent = dm(dates.at(-1));
    inspect(dates.length - 1);
  }
  const card = h("section", {class: "card chart-card"},
    h("div", {class: "card-head"}, h("div", {}, h("h2", {}, "Growth of 100"), h("p", {class: "sub"}, sub)),
      seg("Time range", RANGES, S.range, d => { S.range = d; draw(); })),
    span, h("div", {class: "chart-box"}, chart, empty), inspector, cursor,
    h("p", {class: "hint"}, "Drag the slider or use the arrow keys to step through the collected price dates. Only collected history is shown."));
  return [card, draw];
}

function starButton(fund, withText = false) {
  const b = h("button", {type: "button", class: withText ? "btn" : "icon-btn star"});
  const paint = () => {
    const on = S.watch.has(fund);
    b.setAttribute("aria-pressed", String(on));
    b.replaceChildren(icon("star"), withText ? (on ? "In your funds" : "Add to your funds") : "");
    if (!withText) b.setAttribute("aria-label", on ? `Remove ${fund} from your funds` : `Add ${fund} to your funds`);
  };
  b.addEventListener("click", e => {
    e.stopPropagation();
    S.watch.has(fund) ? S.watch.delete(fund) : S.watch.add(fund);
    save("fb.watch", [...S.watch]);
    paint();
  });
  paint();
  return b;
}

const band = (kind, head, text, extra) => h("div", {class: "band " + kind, role: "note"}, icon("info"), h("p", {}, h("b", {}, head), " ", text), extra);
const list = items => h("ul", {class: "insights"}, (items.length ? items : ["Not enough history yet. Check back after a few more prices."]).map(t => h("li", {}, t)));
const field = (text, control, cls = "") => h("label", {class: "field " + cls}, h("span", {class: "field-label"}, text), control);
const searchBox = props => h("span", {class: "search"}, icon("search"), h("input", {type: "search", ...props}));

// ---------- views
function watchBox(mine) {  // "Your funds" beside the day's headline
  return h("aside", {class: "card watch-box", "aria-label": "Your funds"},
    h("div", {class: "watch-head"}, h("h2", {}, "Your funds"), icon("star")),
    mine.length
      ? [h("ul", {class: "watch-list"}, mine.map(f => h("li", {}, h("a", {href: fundHref(f.fund)},
            h("span", {class: "wl-name"}, f.fund), h("span", {class: "wl-cat"}, `FYTD ${pct(f.fytd)} · ${basis(f).toLowerCase()}`),
            spark(hist(f.fund)), h("span", {class: "wl-nav num"}, f.nav.toFixed(4)), h("span", {class: "wl-move"}, delta(f.move)))))),
         h("div", {class: "watch-foot"},
           mine.length > 1 ? h("a", {class: "link", href: compareHref(mine.slice(0, MAX_PICK).map(f => f.fund))}, "Compare them") : h("span"),
           h("span", {class: "sub"}, "Saved in this browser."))]
      : [h("p", {class: "watch-copy"}, "Star funds you want to follow. Their latest move and a 3-month trend will appear here."),
         h("a", {class: "btn primary", href: "#/funds"}, "Browse funds"),
         h("p", {class: "sub"}, "Your list is saved in this browser.")]);
}

function viewToday() {
  const mk = funds().filter(f => !f.ann && f.move != null);
  const up = mk.filter(f => f.move > 0).length, down = mk.filter(f => f.move < 0).length, flat = mk.length - up - down;
  const mm = funds().filter(f => f.ann && /money/i.test(f.category)).sort(by("fytd", -1));
  const cash = best(mm, "mtd");
  const fig = t => h("span", {class: "fig"}, t);

  const breadth = mk.length > 0 && h("div", {class: "breadth", role: "img", "aria-label": `${up} rose, ${flat} unchanged, ${down} fell`},
    h("p", {class: "breadth-key"}, h("span", {}, h("b", {}, up), " rose"), flat > 0 && h("span", {}, h("b", {}, flat), " unchanged"),
      h("span", {}, h("b", {}, down), " fell")),
    h("div", {class: "breadth-bar"},
      h("span", {class: "b-up", style: `flex-grow:${up}`}), h("span", {class: "b-flat", style: `flex-grow:${flat}`}),
      h("span", {class: "b-down", style: `flex-grow:${down}`})));
  const hero = h("section", {class: "hero"},
    h("div", {class: "hero-main"},
      h("p", {class: "dateline"}, day(S.data.asof, {weekday: "long", day: "numeric", month: "long", year: "numeric"}), h("span", {class: "sep"}, "/"),
        "Latest reported fund prices"),
      h("h1", {class: "headline"}, mk.length
        ? [fig(up >= down ? up : down), " of ", fig(mk.length), ` market-linked funds ${up >= down ? "rose" : "fell"} since the last price.`]
        : "Today's fund prices."),
      cash && h("p", {class: "yield"}, "Cash funds pay up to ", h("strong", {class: "num"}, pct(cash.mtd)), " a year.",
        h("span", {class: "yield-note"}, `${cash.fund}, this month, annualized. Per-year and absolute returns use different bases.`)),
      h("div", {class: "hero-foot"}, breadth,
        mm.length > 1 && h("a", {class: "btn primary", href: compareHref(mm.slice(0, MAX_PICK).map(f => f.fund))}, `Compare ${mm.length} money market funds`, icon("arrow")))),
    watchBox([...S.watch].map(byName).filter(Boolean)));

  const strip = h("div", {class: "basis-strip"}, icon("info"),
    h("p", {}, h("b", {}, "Compare within a category. "),
      "Money market and income returns are annualized; market-linked returns are absolute. The leaders below aren't one cross-category ranking."),
    h("details", {class: "method"}, h("summary", {}, "Method & coverage"),
      h("div", {class: "method-pop"},
        h("p", {}, h("b", {}, "Coverage. "), `${plural(S.data.dates, "price date")} collected since ${day(S.data.since)}. History varies by fund.`),
        h("p", {}, h("b", {}, "Growth and risk. "), "Built from a total-return index rebuilt from each fund's reported FYTD return, so dividend payouts don't look like losses."),
        h("p", {}, h("b", {}, "Ranks. "), "Only among funds in the same category that quote returns the same way."))));

  const tops = leaders(), lead = S.lead, host = h("div", {class: "leaders"});
  const col = (cls, title, sub, pill, rows) => h("div", {class: "lcol " + cls},
    h("div", {class: "lcol-head"}, h("div", {}, h("h3", {}, title), h("p", {class: "sub"}, sub)), h("span", {class: "basis-pill"}, pill)),
    h("div", {class: "lrow lhead", "aria-hidden": "true"}, h("span", {}, "Category"), h("span", {}, "Leader"), h("span", {}, "FYTD"), h("span")),
    rows.length
      ? h("ul", {class: "leader-list"}, rows.map(r => h("li", {},
          h("a", {class: "lrow", href: catHref(r.category), "aria-label": `${r.peer}: ${r.fund} leads at ${pct(r.fytd)} FYTD. See the category.`},
            h("span", {class: "l-cat"}, r.peer), h("span", {class: "l-fund"}, r.fund),
            h("span", {class: "l-val num " + (r.fytd < 0 ? "down" : "up")}, pct(r.fytd)), icon("chev")))))
      : h("p", {class: "sub l-none"}, "No category matches your search."));
  const paintLeaders = () => {
    const q = lead.q.trim().toLowerCase(), rows = tops.filter(r => `${r.peer} ${r.fund}`.toLowerCase().includes(q));
    host.dataset.cols = lead.basis === "both" ? "2" : "1";
    host.replaceChildren(...[
      lead.basis !== "abs" && col("per-year", "Income and cash", "Annualized rates · FYTD", "Per year", rows.filter(r => r.ann)),
      lead.basis !== "ann" && col("absolute", "Market-linked", "Absolute returns · FYTD", "Absolute", rows.filter(r => !r.ann))].filter(Boolean));
  };
  paintLeaders();

  main.replaceChildren(
    hero,
    strip,
    h("section", {class: "section"},
      h("div", {class: "leaders-head"},
        h("div", {}, h("h2", {class: "display"}, "Find a fund by category"),
          h("p", {class: "sub"}, "Category leaders for this fiscal year. Compare only within the same return basis.")),
        h("div", {class: "leader-tools"},
          seg("Return basis", [["Both bases", "both"], ["Per year", "ann"], ["Absolute", "abs"]], lead.basis, v => { lead.basis = v; paintLeaders(); }),
          field("Find a category", searchBox({placeholder: "e.g. Equity", value: lead.q, oninput: e => { lead.q = e.target.value; paintLeaders(); }})))),
      host),
    h("section", {class: "context"},
      h("h2", {}, "Today's context"),
      h("div", {class: "context-body"},
        h("div", {}, h("h3", {}, "If you're already invested"), list(S.data.insights.active)),
        h("div", {}, h("h3", {}, "If you're choosing a fund"), list(S.data.insights.new)))));
}

function viewFunds(params) {
  const st = {cat: params.get("cat") || "", q: "", sort: params.get("sort") || "", dir: -1, basis: params.get("basis") || ""};
  if (!categories().includes(st.cat)) st.cat = "";
  if (!["ann", "abs"].includes(st.basis)) st.basis = "";
  const [fyA, ...fyRest] = fyKeys();
  const baseCols = ["nav", "move", "mtd", "fytd", "cytd", fyA, "loads", "risk", "rank"].filter(Boolean);
  const moreCols = [...fyRest, "cagr", "r1y", "max_dd"];
  const inBasis = f => !st.basis || (st.basis === "ann") === f.ann;
  const cats = () => categories().filter(c => funds().some(f => f.category === c && inBasis(f)));
  const count = c => funds().filter(f => inBasis(f) && (!c || f.category === c)).length;
  const basisHost = h("div", {class: "basis-cards", role: "group", "aria-label": "Return basis"});
  const chips = h("div", {class: "chips", role: "group", "aria-label": "Category"});
  const select = h("select", {onchange: e => { st.cat = e.target.value; update(); }});
  const host = h("div", {class: "table-wrap"}), shown = h("p", {class: "hint"}), tray = h("div", {class: "tray", hidden: ""});
  const moreBtn = h("button", {type: "button", class: "btn", onclick: () => { S.more = !S.more; update(); }});
  const sortBy = k => { st.dir = st.sort === k ? -st.dir : (k === "fund" ? 1 : -1); st.sort = k; update(); };
  const th = (k, text, cls, sub) => {
    const key = M[k]?.sort || k;
    return h("th", {class: cls, title: M[k]?.tip, "aria-sort": st.sort === key ? (st.dir < 0 ? "descending" : "ascending") : null},
      h("button", {type: "button", class: "th-btn", onclick: () => sortBy(key)}, text, st.sort === key ? (st.dir < 0 ? " ↓" : " ↑") : "",
        sub && h("small", {}, sub)));
  };
  const colSub = (k, rows) => {
    if (k === "nav") {  // the most common price date among the rows shown
      const n = {};
      for (const r of rows) n[r.date] = (n[r.date] || 0) + 1;
      const d = Object.keys(n).sort((a, b) => n[b] - n[a])[0];
      return d && dm(d);
    }
    if (k === "move") return "since previous";
    if (k === "rank") return "in category";
    if (k === "risk") return "volatility";
    if (k === "cagr") return "per year";
    if (["mtd", "fytd", "cytd", "r1y"].includes(k) || /^fy\d$/.test(k)) {
      const a = rows.filter(r => r.ann).length;
      return a === rows.length ? "per year" : a ? "" : "absolute";
    }
    return "";
  };
  const pickBtn = f => {
    const on = S.pick.includes(f);
    return h("button", {type: "button", class: "icon-btn add", "aria-pressed": String(on),
      "aria-label": on ? `Remove ${f} from the comparison` : `Add ${f} to the comparison`,
      onclick: e => { e.stopPropagation(); if (togglePick(f)) update(); else paintTray(`Compare up to ${MAX_PICK} funds at a time.`); }},
      icon(on ? "check" : "plus"));
  };
  const basisCard = (v, title, copy) => h("button", {type: "button", class: "basis-card", "aria-pressed": String(st.basis === v),
    onclick: () => { st.basis = st.basis === v ? "" : v; if (!cats().includes(st.cat)) st.cat = ""; update(); }},
    h("span", {class: "basis-title"}, h("i", {class: "dot"}), title), h("span", {class: "basis-copy"}, copy),
    h("span", {class: "basis-n num"}, plural(funds().filter(f => (v === "ann") === f.ann).length, "fund")));

  function paintTray(warn = "") {
    tray.hidden = !S.pick.length;
    tray.replaceChildren(
      h("span", {class: "tray-check"}, icon("check")),
      h("p", {class: "tray-count"}, h("b", {}, `${S.pick.length} of ${MAX_PICK} selected`), h("span", {}, warn || "Selections stay with you as you browse")),
      h("div", {class: "picks"}, S.pick.map(f => h("span", {class: "pick"}, swatch(f), f,
        h("button", {type: "button", "aria-label": `Remove ${f}`, onclick: () => { togglePick(f); update(); }}, icon("x"))))),
      h("a", {class: "btn primary", href: compareHref(S.pick)}, S.pick.length > 1 ? `Compare ${S.pick.length} funds` : "Compare", icon("arrow")));
  }

  function update() {
    const p = new URLSearchParams();
    if (st.basis) p.set("basis", st.basis);
    if (st.cat) p.set("cat", st.cat);
    if (st.sort) p.set("sort", st.sort);
    history.replaceState(null, "", "#/funds" + (p.toString() ? "?" + p : ""));
    basisHost.replaceChildren(basisCard("ann", "Annualized", "Shown per year · money market and income funds"),
      basisCard("abs", "Market-linked", "Absolute return · compare within each category"));
    chips.replaceChildren(...["", ...cats()].map(c => h("button", {type: "button", class: "chip", "aria-pressed": String(st.cat === c),
      onclick: () => { st.cat = c; update(); }}, c || "All funds", h("span", {class: "chip-n"}, String(count(c))))));
    select.replaceChildren(...["", ...cats()].map(c => h("option", {value: c, selected: st.cat === c ? "" : null}, `${c || "All funds"} · ${count(c)}`)));
    moreBtn.setAttribute("aria-pressed", String(S.more));
    moreBtn.replaceChildren(icon("columns"), S.more ? "Fewer measures" : "More measures", !S.more && h("span", {class: "chip-n"}, "+" + moreCols.length));
    const cols = S.more ? [...baseCols, ...moreCols] : baseCols;
    let rows = funds().filter(f => inBasis(f) && (!st.cat || f.category === st.cat) && f.fund.toLowerCase().includes(st.q));
    if (st.sort) rows = [...rows].sort(by(st.sort, st.dir));
    shown.replaceChildren(h("b", {}, plural(rows.length, "fund") + " shown"), ` · ${funds().length} in total`);
    const span = cols.length + 3, body = [];
    let group;
    for (const r of rows) {
      if (!st.sort && r.category !== group) {
        group = r.category;
        const members = rows.filter(f => f.category === group), ann = members.filter(f => f.ann).length;
        const note = ann === members.length ? "Annualized returns · ranked within category" : ann ? "Mixed: check each fund's basis" : "Absolute returns · ranked within category";
        body.push(h("tr", {class: "group"}, h("td", {colspan: span},
          h("span", {class: "group-in"}, h("b", {}, group), h("small", {}, note), h("small", {class: "group-n num"}, plural(members.length, "fund"))))));
      }
      body.push(h("tr", {class: S.pick.includes(r.fund) ? "is-selected" : null, onclick: e => { if (!e.target.closest("a, button")) location.hash = fundHref(r.fund); }},
        h("td", {class: "star-col"}, starButton(r.fund)),
        h("td", {class: "name-col"}, h("a", {href: fundHref(r.fund)}, r.fund),
          h("span", {class: "tag"}, `${r.category} · ${basis(r).toLowerCase()}`)),
        cols.map(k => h("td", {class: "num"}, show(k, r))),
        h("td", {class: "pick-col"}, pickBtn(r.fund))));
    }
    if (!rows.length) body.push(h("tr", {}, h("td", {colspan: span, class: "name-col"}, "No funds match. Clear the search or pick another category.")));
    host.replaceChildren(h("table", {class: "funds-table"}, h("thead", {}, h("tr", {}, h("th", {class: "star-col"}, h("span", {class: "sr"}, "Your funds")),
      th("fund", "Fund", "name-col"), cols.map(k => th(k, label(k), null, colSub(k, rows))), h("th", {class: "pick-col"}, "Compare"))), h("tbody", {}, body)));
    paintTray();
  }

  main.replaceChildren(
    h("div", {class: "page-head"},
      h("div", {}, h("h1", {}, "Find a fund"),
        h("p", {class: "lede"}, `Browse ${funds().length} funds, understand what each return means, and follow the ones you hold.`)),
      basisHost),
    band("", "Start with the return basis.", "Money market and income funds show an annualized rate. Other categories show absolute returns. " +
      "Compare funds within the same category: an annualized rate and an absolute return aren't like for like.",
      h("button", {type: "button", class: "link band-link", onclick: openMethod}, "How returns are calculated")),
    h("div", {class: "filters"},
      field("Search all funds", searchBox({placeholder: "Try a fund name", oninput: e => { st.q = e.target.value.toLowerCase(); update(); }}), "grow"),
      field("Category", select, "cat-select"),
      moreBtn),
    h("div", {class: "chip-row"}, h("span", {class: "chip-label"}, "Category"), chips),
    h("div", {class: "table-meta"}, shown, h("p", {class: "hint"}, "Select a column to sort · ☆ adds to your funds · + adds to a comparison")),
    tray,
    h("div", {class: "card flush"}, host));
  update();
}

function viewFund(name) {
  const r = byName(name);
  if (!r) {
    main.replaceChildren(h("div", {class: "empty-card", style: "margin-top:40px"}, h("h1", {}, "Fund not found"),
      h("p", {}, `"${name}" isn't in the latest prices.`), h("a", {class: "btn", href: "#/funds"}, "See all funds")));
    return;
  }
  const per = r.ann ? "per year" : "absolute";
  const peers = funds().filter(f => f.peer === r.peer).sort(by("fytd", -1));
  const others = peers.filter(p => p.fund !== r.fund);
  const pts = hist(r.fund);
  const [card, draw] = chartCard({sub: "Reconstructed total-return index, dividends included. Not the fund's NAV.",
    series: () => [{name: r.fund, color: css("--ledger"), points: pts}], height: 340, fill: true});
  const stat = (k, title, sub) => h("div", {class: "stat"},
    h("dt", {}, title, h("span", {class: "tip", role: "img", "aria-label": M[k].tip, title: M[k].tip}, icon("info"))),
    h("dd", {class: "num"}, show(k, r)), h("dd", {class: "stat-sub"}, sub));
  const fact = (k, title, note) => [h("dt", {}, title, h("small", {}, note)), h("dd", {class: "num"}, cell(k, r))];

  const peerTable = h("div", {class: "card flush"}, h("div", {class: "table-wrap"}, h("table", {class: "peer-table"},
    h("thead", {}, h("tr", {},
      h("th", {class: "name-col"}, "Fund"), h("th", {}, "FYTD", h("small", {}, per)), h("th", {}, "MTD", h("small", {}, per)),
      h("th", {}, "Entry load"), h("th", {}, "Rank"), h("th", {}, h("span", {class: "sr"}, "Compare")))),
    h("tbody", {}, peers.map(p => h("tr", {class: p === r ? "me" : null, onclick: e => { if (p !== r && !e.target.closest("a, button")) location.hash = fundHref(p.fund); }},
      h("td", {class: "name-col"}, p === r ? [h("b", {}, p.fund), h("span", {class: "tag"}, "This fund")] : h("a", {href: fundHref(p.fund)}, p.fund)),
      h("td", {class: "num"}, pct(p.fytd)), h("td", {class: "num"}, pct(p.mtd)), h("td", {class: "num"}, pct(p.entry_load)), h("td", {class: "num"}, show("rank", p)),
      h("td", {}, p === r ? h("span", {class: "pill small"}, "Selected")
        : h("a", {class: "btn small", href: compareHref([r.fund, p.fund])}, "Compare with this fund"))))))));

  main.replaceChildren(
    h("a", {class: "back", href: "#/funds"}, icon("back"), "All funds"),
    h("p", {class: "crumbs"}, h("a", {href: catHref(r.category)}, r.category), h("span", {"aria-hidden": "true"}, "/"),
      r.ann ? "Returns shown per year" : "Absolute returns"),
    h("h1", {class: "fund-name"}, r.fund),
    h("div", {class: "fund-bar"},
      h("p", {class: "fund-line"}, h("span", {class: "big num"}, r.nav.toFixed(4)), h("span", {class: "muted"}, `NAV · ${day(r.date)}`), delta(r.move),
        r.prev_date && h("span", {class: "muted"}, `since ${dm(r.prev_date)}`)),
      h("div", {class: "actions"}, starButton(r.fund, true),
        others.length > 0 && h("a", {class: "btn primary", href: compareHref([r.fund, ...others.slice(0, 3).map(p => p.fund)])}, "Compare with peers", icon("arrow")))),
    h("ul", {class: "fund-meta"},
      h("li", {}, icon("rank"), h("b", {}, show("rank", r)), ` by FYTD within ${r.peer}`),
      h("li", {}, icon("bars"), r.ann ? "Annualized · figures quoted per year" : "Absolute · figures show the actual change"),
      pts.length > 0 && h("li", {}, icon("calendar"), `${plural(pts.length, "price date")} collected · ${dm(pts[0][0])} – ${day(pts.at(-1)[0])}`)),
    h("div", {class: "basis-block"},
      h("p", {class: "basis-note"}, r.ann
        ? ["Cash and income fund returns are annualized. FYTD ", h("b", {}, pct(r.fytd)), " here is a yearly rate, not what the fund earned since 1 July. Compare it within ", r.peer, "."]
        : ["Returns are absolute: FYTD ", h("b", {}, pct(r.fytd)), " is the actual change since 1 July. Compare it within ", r.peer, "."]),
      h("details", {class: "howto"}, h("summary", {}, "How to read this return"),
        h("p", {}, r.ann
          ? "Money market and income funds quote returns per year (the MUFAP convention). An FYTD of 10% means the fund has been earning at a yearly rate of 10% since 1 July, not that your money grew 10%. Compare it only with funds that also quote returns per year."
          : "Market-linked funds quote absolute returns. An FYTD of 5% means the fund's total return since 1 July is 5%, dividends included. Compare it with funds in the same category: equity, balanced and income funds carry very different risks."))),
    h("dl", {class: "stats"},
      stat("mtd", "Month to date", r.ann ? "per year" : "this month"),
      stat("fytd", "Fiscal year to date", `${per} · since ${fyStart()}`),
      stat("cytd", "Calendar year to date", `${per} · since ${cyStart()}`),
      fyKeys().map(k => stat(k, label(k), `${per} · full fiscal year`)),
      stat("rank", "Within category", `by FYTD · ${r.peer}`)),
    card,
    h("div", {class: "fund-lower"},
      h("section", {},
        h("div", {class: "section-head"},
          h("div", {}, h("h2", {class: "display-s"}, "Compare within the category"),
            h("p", {class: "sub"}, `${r.peer} · ${r.ann ? "annualized returns, all quoted per year" : "absolute returns"}`)),
          others.length > 0 && peers.length <= MAX_PICK && h("a", {class: "link", href: compareHref(peers.map(p => p.fund))}, `Compare all ${peers.length}`)),
        others.length ? peerTable : h("p", {class: "sub"}, "No other fund in this category quotes returns the same way, so there's no ranking."),
        others.length > 0 && h("p", {class: "hint"}, `Rank is by FYTD within ${r.peer}. ${r.ann ? "These figures are annualized, so don't compare them with funds that report absolute returns." : "Compare them only with funds that also report absolute returns."}`)),
      h("div", {class: "side-cards"},
        h("section", {class: "card side" + (r.ann ? " calm" : "")},
          h("h2", {}, "Risk measures"),
          r.ann && h("p", {class: "sub"}, "Volatility and drawdown aren't shown for this cash-like fund. Its price barely moves from day to day, so they say little. That doesn't make it risk-free."),
          h("dl", {class: "facts"}, fact("vol", "Volatility", "Typical yearly swing"), fact("max_dd", "Maximum drawdown", "Worst fall from a high"),
            !r.ann && fact("dd", "Below peak", "Distance under its high today"))),
        h("section", {class: "card side"},
          h("h2", {}, "Costs"), h("p", {class: "sub"}, "Loads change what you pay in and what you get back."),
          h("dl", {class: "facts"}, fact("entry_load", "Entry load", "Extra cost when buying"), fact("exit_load", "Exit load", "Deducted when selling"))),
        h("section", {class: "card side"},
          h("h2", {}, "Track record"),
          h("dl", {class: "facts"}, fact("cagr", "Since launch", r.ann ? "Per year, as reported" : "Average per year"),
            fact("r1y", "1 year", "Last 12 months of collected prices"),
            r.launch && [h("dt", {}, "Launched", h("small", {}, `${r.age} years ago`)), h("dd", {}, day(r.launch))])))));
  draw();
}

function viewCompare(params) {
  const fromUrl = params.getAll("f").filter(byName);
  S.pick = [...new Set(fromUrl.length ? fromUrl : S.pick.filter(byName))].slice(0, MAX_PICK);
  for (const k of [...S.slots.keys()]) if (!S.pick.includes(k)) S.slots.delete(k);
  S.pick.forEach(slot);
  const mine = [...S.watch].map(byName).filter(Boolean);

  function update(focus) {
    history.replaceState(null, "", compareHref(S.pick));
    render();
    if (focus) main.querySelector(".add-form input")?.focus();
  }
  const add = f => { if (byName(f) && !S.pick.includes(f) && togglePick(f)) update(true); };
  const addForm = () => {
    const input = h("input", {list: "fund-options", placeholder: "Search fund name", "aria-label": "Fund to add"});
    return h("form", {class: "add-form", onsubmit: e => { e.preventDefault(); add(input.value.trim()); }},
      h("span", {class: "search"}, icon("search"), input),
      h("button", {type: "submit", class: "btn primary square", "aria-label": "Add fund", disabled: S.pick.length >= MAX_PICK ? "" : null}, icon("plus")),
      h("datalist", {id: "fund-options"}, funds().filter(f => !S.pick.includes(f.fund)).map(f => h("option", {value: f.fund}))));
  };

  function render() {
    const rows = S.pick.map(byName), n = rows.length;
    const peersSet = new Set(rows.map(r => r.peer)), bases = new Set(rows.map(r => r.ann));
    const share = h("button", {type: "button", class: "btn", onclick: () => navigator.clipboard?.writeText(location.href)
      .then(() => { share.lastChild.textContent = "Link copied"; }, () => {})}, icon("link"), h("span", {}, "Share comparison"));
    const head = h("div", {class: "page-head"},
      h("div", {}, h("h1", {}, "Compare funds"),
        h("p", {class: "lede"}, !n ? "Start with funds you're considering. Add a category peer to compare price history and every measure side by side."
          : peersSet.size === 1 ? `${rows[0].peer} · all returns shown ${rows[0].ann ? "per year" : "as absolute returns"}`
          : `${plural(n, "fund")} across ${new Set(rows.map(r => r.category)).size} categories`)),
      h("div", {class: "actions"}, h("span", {class: "pill num"}, `${n} / ${MAX_PICK} funds selected`), n > 0 && share));
    let shared = [];
    if (n > 1) {
      const sets = S.pick.map(f => new Set(hist(f).map(p => p[0])));
      shared = [...sets[0]].filter(d => sets.every(s => s.has(d))).sort();
    }
    const stats = shared.length > 0 && h("span", {class: "band-stats"},
      h("span", {}, h("b", {class: "num"}, shared.length), " shared price dates"), h("span", {}, `${dm(shared[0])} – ${day(shared.at(-1))}`));
    const note = n < 2 ? band("", "Compare like with like.", "Money market and income returns are shown per year; other categories show absolute returns. FYTD figures across different bases aren't directly comparable.")
      : peersSet.size === 1 ? band("ok", "Like for like: same category, same return basis.", `All ${n} are ${rows[0].peer} funds quoting returns ${rows[0].ann ? "per year" : "as absolute returns"}.`, stats)
      : bases.size === 1 ? band("", "Same return basis, different categories.", "The figures line up, but these funds invest differently.", stats)
      : band("warn", "These funds quote returns differently.",
          `${rows.filter(r => r.ann).map(r => r.fund).join(", ")} show returns per year; ${rows.filter(r => !r.ann).map(r => r.fund).join(", ")} show absolute returns. Use the growth chart to compare them, not the FYTD figures.`, stats);

    if (!n) {
      const groups = [...(mine.length ? [["Your funds", mine]] : []),
                      ...peerGroups().map(p => [p, funds().filter(f => f.peer === p).sort(by("fytd", -1))])];
      let gi = mine.length ? 0 : Math.max(0, groups.findIndex(([p]) => /money/i.test(p)));
      const peerHost = h("div");
      const paintPeers = () => {
        const [title, list] = groups[gi], ann = list.filter(f => f.ann).length;
        const take = list.slice(0, MAX_PICK);
        peerHost.replaceChildren(
          h("p", {class: "sub"}, title === "Your funds" ? "The funds you've starred." : `All ${list.length} report ${ann ? "annualized" : "absolute"} returns. Add one or several.`),
          h("ul", {class: "peer-list"}, list.map(f => h("li", {},
            h("span", {class: "peer-name"}, h("a", {href: fundHref(f.fund)}, f.fund), h("small", {class: "num"}, `FYTD ${pct(f.fytd)} · rank ${show("rank", f)}`)),
            h("button", {type: "button", class: "peer-add", "aria-label": `Add ${f.fund} to the comparison`, onclick: () => add(f.fund)}, icon("plus"))))),
          h("div", {class: "peer-foot"}, h("small", {}, "Selected funds stay in this page's link."),
            h("button", {type: "button", class: "link", onclick: () => { take.forEach(f => togglePick(f.fund)); update(); }},
              take.length === list.length ? `Add all ${list.length}` : `Add the top ${take.length}`)));
      };
      const groupSelect = h("select", {"aria-label": "Suggested funds", onchange: e => { gi = +e.target.value; paintPeers(); }},
        groups.map(([p, l], i) => h("option", {value: String(i), selected: i === gi ? "" : null}, `${p} · ${l.length}`)));
      paintPeers();
      main.replaceChildren(head, note,
        h("div", {class: "cmp-empty"},
          h("section", {class: "card empty-box"},
            h("div", {class: "box-head"}, h("h2", {}, "Your comparison"), h("span", {class: "num muted"}, `0 of ${MAX_PICK} funds`)),
            h("div", {class: "empty-state"},
              h("span", {class: "badge"}, icon("plus")),
              h("h3", {class: "display"}, "Choose a fund to get started."),
              h("p", {}, "Your selected funds and their collected price history will appear here. Add one fund now, then build a peer comparison when you're ready."),
              h("ol", {class: "steps"}, h("li", {}, "Add a fund"), h("li", {}, "Check its return basis"), h("li", {}, "Explore its price history")),
              h("a", {class: "btn", href: "#/funds"}, "Browse all funds"))),
          h("section", {class: "card add-card"},
            h("h2", {}, "Add a fund"),
            h("p", {class: "field-label"}, "Search by fund name"), addForm(),
            h("p", {class: "sub"}, "Add funds one at a time, or start with the suggestions below."),
            h("div", {class: "peer-head"}, h("h3", {}, "Start with"), groupSelect),
            peerHost)),
        h("div", {class: "explain"},
          h("div", {}, h("h3", {}, "What the chart shows"),
            h("p", {}, "Growth of 100 uses a total-return index rebuilt from reported FYTD returns, so dividend payouts don't look like losses. It isn't the NAV, and it covers only the prices collected so far.")),
          h("div", {}, h("h3", {}, "Same basis: easier side by side"),
            h("p", {}, "Money market and income returns are shown per year. Pick funds from one category to compare their FYTD figures directly.")),
          h("div", {}, h("h3", {}, "Comparing different fund types?"),
            h("p", {}, "You can add any fund. Each fund's return basis stays visible, and the growth chart puts them on the same footing."))));
      return;
    }

    const suggest = funds().filter(f => peersSet.has(f.peer) && !S.pick.includes(f.fund)).sort(by("fytd", -1)).slice(0, 4);
    const [card, draw] = chartCard({sub: "Reconstructed total-return index, dividends included, rebased to 100 at the start of the range. Not NAV.",
      series: () => S.pick.map(f => ({name: f, color: css("--s" + slot(f)), dash: DASH[slot(f) - 1], points: hist(f)})), height: n <= 3 ? 360 : 400});
    const sections = [["Fund and pricing", ["category", "basis", "nav", "move"]],
                      ["Returns", ["mtd", "fytd", "cytd", ...fyKeys(), "cagr", "r1y"]],
                      ["Costs and risk", ["entry_load", "exit_load", "vol", "max_dd", "rank"]]];
    const table = h("table", {class: "cmp"},
      h("thead", {}, h("tr", {}, h("th", {}, "Measure"),
        rows.map(r => h("th", {}, h("span", {class: "cmp-fund"}, swatch(r.fund), h("a", {href: fundHref(r.fund)}, r.fund)))))),
      sections.map(([title, keys]) => h("tbody", {},
        h("tr", {class: "sect"}, h("th", {colspan: String(n + 1)}, title)),
        keys.map(k => h("tr", {}, h("th", {title: M[k].tip}, label(k)), rows.map(r => h("td", {class: M[k].tip ? "num" : null}, cell(k, r))))))));
    main.replaceChildren(head,
      h("div", {class: "picker"},
        h("div", {class: "picker-picks"}, h("p", {class: "field-label"}, `${plural(n, "selected fund")}`),
          h("div", {class: "picks"}, rows.map(r => h("span", {class: "pick"}, swatch(r.fund), h("a", {href: fundHref(r.fund)}, r.fund),
            h("button", {type: "button", "aria-label": `Remove ${r.fund}`, onclick: () => { togglePick(r.fund); update(); }}, icon("x")))))),
        h("div", {class: "picker-add"}, h("p", {class: "field-label"}, "Add a fund to compare"), addForm())),
      suggest.length > 0 && n < MAX_PICK && h("p", {class: "suggest"}, h("span", {class: "muted"}, "Add a peer:"),
        suggest.map(f => h("button", {type: "button", class: "btn small", onclick: () => add(f.fund)}, icon("plus"), f.fund))),
      note,
      h("div", {class: "cmp-grid" + (n <= 3 ? " side" : "")},
        card,
        h("section", {class: "measures"},
          h("h2", {}, "Compare the measures"),
          h("p", {class: "sub"}, "Aligned figures for each fund. A blank says why it's missing."),
          h("div", {class: "card flush"}, h("div", {class: "table-wrap"}, table)))));
    draw();
  }
  render();
}

// ---------- routing
function viewEmpty() {
  main.replaceChildren(h("div", {class: "empty-card", style: "margin-top:40px"},
    h("h1", {}, "No prices yet"),
    h("p", {}, "Load the price history to get started. The first load takes a few minutes."),
    h("button", {type: "button", class: "btn primary", id: "load-btn", onclick: updateNow}, "Load prices"),
    h("p", {class: "hint", id: "load-status", "aria-live": "polite"})));
  paintStatus();
}

function route() {
  document.getElementById("asof").textContent = S.data.asof ? `NAV as of ${day(S.data.asof)}` : "";
  if (!S.data.asof) return viewEmpty();
  const [path, qs] = location.hash.slice(1).split("?");
  const [view, arg] = (path || "/").split("/").filter(Boolean);
  const params = new URLSearchParams(qs || "");
  const current = view === "fund" ? "funds" : view || "today";
  if (view === "funds") viewFunds(params);
  else if (view === "fund") viewFund(decodeURIComponent(arg || ""));
  else if (view === "compare") viewCompare(params);
  else viewToday();
  for (const a of document.querySelectorAll("nav a"))
    a.dataset.view === current ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  document.querySelector('nav a[data-view="compare"]').href = compareHref(S.pick);  // Compare keeps your selection
  const title = view === "fund" ? decodeURIComponent(arg || "") : {funds: "Find a fund", compare: "Compare funds"}[view];
  document.title = title ? `${title} · Fund Board` : "Fund Board";
}

// ---------- price updates: manual button, automatic check when stale, live refresh when prices change
const STALE_MS = 30 * 60e3;  // look for new prices automatically when the last check is older than this
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000, rtf = new Intl.RelativeTimeFormat("en", {numeric: "auto"});
  if (s < 60) return "just now";
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
}

function paintStatus() {
  const st = S.status;
  if (!st) return;
  const busy = S.updating || st.updating;
  const wait = !busy && st.next_check && Date.parse(st.next_check) > Date.now();
  const share = st.left ? Math.round(100 * st.done / (st.done + st.left)) : null;
  const text = busy ? (share != null ? `Loading price history: ${share}% done` : "Looking for new prices…")
    : st.checked ? `Checked ${ago(st.checked)}` : "";
  const sync = document.getElementById("sync");
  sync.toggleAttribute("data-busy", busy);
  sync.toggleAttribute("data-problem", !!st.problem);
  document.getElementById("sync-text").textContent = text;
  document.getElementById("update-label").textContent = busy ? "Updating…" : "Update prices";
  for (const id of ["update-btn", "load-btn"]) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.disabled = busy || wait || st.problem === "setup";
    if (id === "load-btn") b.textContent = busy ? "Loading…" : "Load prices";
    b.title = wait ? `Checked recently. You can check again at ${new Date(st.next_check).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}.` : "";
  }
  const status = document.getElementById("load-status");
  if (status) status.textContent = busy ? text : "";
  const problem = {setup: "Price updates aren't set up on the server yet.",
                   failed: "The last price update didn't finish. It will try again shortly."}[st.problem] || "";
  const notice = document.getElementById("notice");
  notice.hidden = !problem;
  notice.textContent = problem;
}

async function refresh() {  // re-read prices when the data version moved on
  if (!S.status?.version || S.status.version === S.version) return;
  await reloadPage();
  route();
}

async function updateNow() {
  if (S.updating) return;
  S.updating = true;
  paintStatus();
  try {
    do {  // the server works in ~25 second steps; keep going until the history is loaded
      S.status = await api("/api/refresh", {method: "POST"});
      paintStatus();
      await refresh();  // show loaded history as it arrives
    } while (S.status.left && !S.status.problem);
    while (S.status.updating) {  // an update started elsewhere is running: wait for it
      await sleep(3000);
      S.status = await api("/api/status");
      paintStatus();
    }
  } catch {
    S.status = {...S.status, problem: "failed"};
  }
  S.updating = false;
  paintStatus();
  await refresh();
}

async function poll() {  // pick up prices updated elsewhere, and look for new ones when the last check is stale
  if (document.hidden || S.updating) return;
  try { S.status = await api("/api/status"); } catch { return; }
  paintStatus();
  await refresh();
  const st = S.status;
  if (st.problem !== "setup" && !st.updating && (!st.next_check || Date.parse(st.next_check) <= Date.now())
      && (!st.checked || Date.now() - Date.parse(st.checked) > STALE_MS)) updateNow();
}

function init() {
  readPage(document);
  document.getElementById("update-btn").addEventListener("click", updateNow);
  route();
  addEventListener("hashchange", () => { route(); scrollTo(0, 0); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", route);  // charts read colors at draw time
  document.addEventListener("visibilitychange", poll);
  setInterval(poll, 5 * 60e3);
  setInterval(paintStatus, 30e3);  // keeps "checked 5 minutes ago" current
  poll();
}
init();
