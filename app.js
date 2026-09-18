// Skanmatik-Log — просмотр логов с компактными двойными ползунками фильтров.
// Обороты: 1000–8000 (два ползунка + ручные поля).
// Педаль/Дроссель: 0–100% (двойной ползунок без полей ввода, источник — по колонкам в логе).

const $ = (id) => document.getElementById(id);

const state = {
  headers: [],
  rows: [],          // { raw: [], rpm: number|null, pedal: number|null, throttle: number|null, time: number }
  colRpm: -1,
  colPedal: -1,
  colThrottle: -1,
  thrSource: "auto", // auto | pedal | throttle
  filtered: [],
};

const RPM_MIN = 1000;
const RPM_MAX = 8000;

const el = {
  fileInput: $("fileInput"),
  fileInfo: $("fileInfo"),
  detectedInfo: $("detectedInfo"),
  rpmEnabled: $("rpmEnabled"),
  rpmMin: $("rpmMin"),
  rpmMax: $("rpmMax"),
  rpmMinNum: $("rpmMinNum"),
  rpmMaxNum: $("rpmMaxNum"),
  rpmLabel: $("rpmLabel"),
  rpmFill: $("rpmFill"),
  rpmReset: $("rpmReset"),
  thrEnabled: $("thrEnabled"),
  thrTitle: $("thrTitle"),
  thrMin: $("thrMin"),
  thrMax: $("thrMax"),
  thrLabel: $("thrLabel"),
  thrFill: $("thrFill"),
  thrReset: $("thrReset"),
  thrHint: $("thrHint"),
  thrSourceRow: $("thrSourceRow"),
  thrSeg: $("thrSeg"),
  statTotal: $("statTotal"),
  statFiltered: $("statFiltered"),
  statCut: $("statCut"),
  resetAll: $("resetAll"),
  chart: $("chart"),
  legend: $("legend"),
  gridHead: $("gridHead"),
  gridBody: $("gridBody"),
  tableFoot: $("tableFoot"),
  demoBtn: $("demoBtn"),
};

function norm(s) {
  return String(s ?? "").trim().toLowerCase().replace(/["'\s_\-]+/g, "");
}

function detectColumns(headers) {
  const rpmKeys = ["rpm", "обороты", "обмин", "об/мин", "engine speed", "enginespeed", "n", "rpmx"];
  const pedalKeys = ["pedal", "педаль", "акселератор", "accelerator", "app", "accpedal", "ped", "газ"];
  const thrKeys = ["throttle", "дроссель", "tps", "заслонка", "thr", "дроссельнаязаслонка"];

  let colRpm = -1, colPedal = -1, colThrottle = -1;
  headers.forEach((h, i) => {
    const n = norm(h);
    // обороты: точное совпадение приоритетно, иначе подстрока
    if (colRpm < 0 && (n === "rpm" || n.includes("rpm") || n.includes("обороты") || n.includes("обмин"))) colRpm = i;
    if (colPedal < 0 && (n.includes("pedal") || n.includes("педаль") || n === "app" || n.includes("accelerator") || n.includes("аксел"))) colPedal = i;
    if (colThrottle < 0 && (n.includes("throttle") || n.includes("дроссель") || n === "tps" || n.includes("заслон") || n === "thr")) colThrottle = i;
  });

  // Не даём педали и дросселю указывать на одну колонку
  if (colPedal >= 0 && colPedal === colThrottle) {
    const h = norm(headers[colPedal]);
    if (h.includes("pedal") || h.includes("педаль") || h.includes("accel") || h.includes("аксел") || h === "app") {
      colThrottle = -1;
    } else {
      colPedal = -1;
    }
  }
  return { colRpm, colPedal, colThrottle };
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { headers: [], data: [] };
  const first = lines[0];
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : /,\s*,/.test(first) || first.includes(",") ? "," : first.includes("\t") ? "\t" : ";";
  const split = (line) => line.split(delim).map((c) => c.trim());
  const headers = split(lines[0]);
  const data = lines.slice(1).map(split);
  return { headers, data };
}

function buildRows(headers, data) {
  const { colRpm, colPedal, colThrottle } = detectColumns(headers);
  state.colRpm = colRpm;
  state.colPedal = colPedal;
  state.colThrottle = colThrottle;

  state.rows = data.map((r, idx) => ({
    raw: r,
    idx,
    rpm: colRpm >= 0 ? toNum(r[colRpm]) : null,
    pedal: colPedal >= 0 ? toNum(r[colPedal]) : null,
    throttle: colThrottle >= 0 ? toNum(r[colThrottle]) : null,
  }));
}

// Какой источник сейчас активен для второго фильтра
function activeThrSource() {
  if (state.thrSource === "pedal" && state.colPedal >= 0) return "pedal";
  if (state.thrSource === "throttle" && state.colThrottle >= 0) return "throttle";
  // auto: педаль приоритетнее, иначе дроссель
  if (state.colPedal >= 0) return "pedal";
  if (state.colThrottle >= 0) return "throttle";
  return null;
}

function activeThrValue(row) {
  const src = activeThrSource();
  if (src === "pedal") return row.pedal;
  if (src === "throttle") return row.throttle;
  return null;
}

function refreshThrUI() {
  const src = activeThrSource();
  const both = state.colPedal >= 0 && state.colThrottle >= 0;

  el.thrSourceRow.hidden = !both;
  if (both) {
    el.thrSeg.querySelectorAll("button").forEach((b) => {
      const want = state.thrSource === "auto" ? (src === b.dataset.src) : (state.thrSource === b.dataset.src);
      b.classList.toggle("active", want);
    });
  }

  if (src === "pedal") {
    el.thrTitle.textContent = "Педаль, %";
    const col = state.headers[state.colPedal] ?? "";
    el.thrHint.textContent = `Источник: колонка «${col}» из лога.`;
  } else if (src === "throttle") {
    el.thrTitle.textContent = "Дроссель, %";
    const col = state.headers[state.colThrottle] ?? "";
    el.thrHint.textContent = `Источник: колонка «${col}» из лога.`;
  } else {
    el.thrTitle.textContent = "Педаль / Дроссель, %";
    el.thrHint.textContent = "В логе нет колонки педали или дросселя — фильтр не применяется.";
  }

  const names = [];
  if (state.colRpm >= 0) names.push(`обороты: «${state.headers[state.colRpm]}»`);
  if (state.colPedal >= 0) names.push(`педаль: «${state.headers[state.colPedal]}»`);
  if (state.colThrottle >= 0) names.push(`дроссель: «${state.headers[state.colThrottle]}»`);
  el.detectedInfo.textContent = names.length ? "Найдено: " + names.join(" · ") : "Колонки оборотов/педали/дросселя не распознаны.";
}

function clampRpm(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(RPM_MAX, Math.max(RPM_MIN, n));
}

function syncRpmUI(from) {
  let lo = clampRpm(el.rpmMin.value, RPM_MIN);
  let hi = clampRpm(el.rpmMax.value, RPM_MAX);
  if (lo > hi) {
    if (from === "min") hi = lo;
    else if (from === "max") lo = hi;
    else if (from === "minNum") hi = lo;
    else if (from === "maxNum") lo = hi;
    else { const t = lo; lo = Math.min(lo, hi); hi = Math.max(t, hi); }
  }
  el.rpmMin.value = lo;
  el.rpmMax.value = hi;
  if (from !== "minNum" && from !== "maxNum") {
    el.rpmMinNum.value = lo;
    el.rpmMaxNum.value = hi;
  } else if (from === "minNum") {
    el.rpmMin.value = lo; el.rpmMax.value = hi; el.rpmMaxNum.value = hi;
  } else if (from === "maxNum") {
    el.rpmMin.value = lo; el.rpmMax.value = hi; el.rpmMinNum.value = lo;
  }
  el.rpmLabel.textContent = `${lo} – ${hi}`;
  paintFill(el.rpmFill, lo, hi, RPM_MIN, RPM_MAX);
}

function syncThrUI() {
  let lo = Math.round(Number(el.thrMin.value));
  let hi = Math.round(Number(el.thrMax.value));
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = 100;
  lo = Math.min(100, Math.max(0, lo));
  hi = Math.min(100, Math.max(0, hi));
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  // держим ползунки согласованными без схлопывания
  el.thrMin.value = lo;
  el.thrMax.value = hi;
  el.thrLabel.textContent = `${lo} – ${hi}`;
  paintFill(el.thrFill, lo, hi, 0, 100);
}

function paintFill(fillEl, lo, hi, min, max) {
  const p1 = ((lo - min) / (max - min)) * 100;
  const p2 = ((hi - min) / (max - min)) * 100;
  fillEl.style.left = p1 + "%";
  fillEl.style.width = Math.max(0, p2 - p1) + "%";
}

function getFilters() {
  return {
    rpmOn: el.rpmEnabled.checked && state.colRpm >= 0,
    rpmLo: clampRpm(el.rpmMin.value, RPM_MIN),
    rpmHi: clampRpm(el.rpmMax.value, RPM_MAX),
    thrOn: el.thrEnabled.checked && activeThrSource() !== null,
    thrLo: Math.min(100, Math.max(0, Math.round(Number(el.thrMin.value) || 0))),
    thrHi: Math.min(100, Math.max(0, Math.round(Number(el.thrMax.value) || 100))),
  };
}

function applyFilters() {
  const f = getFilters();
  const lo = Math.min(f.rpmLo, f.rpmHi);
  const hi = Math.max(f.rpmLo, f.rpmHi);
  const tLo = Math.min(f.thrLo, f.thrHi);
  const tHi = Math.max(f.thrLo, f.thrHi);

  state.filtered = state.rows.filter((r) => {
    if (f.rpmOn) {
      if (r.rpm === null || r.rpm < lo || r.rpm > hi) return false;
    }
    if (f.thrOn) {
      const v = activeThrValue(r);
      if (v === null || v < tLo || v > tHi) return false;
    }
    return true;
  });

  el.statTotal.textContent = state.rows.length;
  el.statFiltered.textContent = state.filtered.length;
  el.statCut.textContent = state.rows.length - state.filtered.length;

  renderTable(f);
  renderChart(f);
}

function rowPasses(row, f) {
  const lo = Math.min(f.rpmLo, f.rpmHi);
  const hi = Math.max(f.rpmLo, f.rpmHi);
  const tLo = Math.min(f.thrLo, f.thrHi);
  const tHi = Math.max(f.thrLo, f.thrHi);
  if (f.rpmOn && (row.rpm === null || row.rpm < lo || row.rpm > hi)) return false;
  if (f.thrOn) {
    const v = activeThrValue(row);
    if (v === null || v < tLo || v > tHi) return false;
  }
  return true;
}

function renderTable(f) {
  el.gridHead.innerHTML = "";
  el.gridBody.innerHTML = "";
  if (!state.headers.length) {
    el.tableFoot.textContent = "Загрузите CSV-лог.";
    return;
  }
  state.headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    el.gridHead.appendChild(th);
  });
  const MAX = 500;
  const show = state.filtered.slice(0, MAX);
  const frag = document.createDocumentFragment();
  show.forEach((r) => {
    const tr = document.createElement("tr");
    r.raw.forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  });
  el.gridBody.appendChild(frag);
  el.tableFoot.textContent = `Показано ${show.length} из ${state.filtered.length} подходящих строк (всего ${state.rows.length}). Таблица ограничена первыми ${MAX}.`;
}

function renderChart(f) {
  const canvas = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 700;
  const h = 260;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const data = state.filtered.slice(0, 2000);
  el.legend.innerHTML = "";

  if (!data.length || state.colRpm < 0) {
    ctx.fillStyle = "#9aa7b8";
    ctx.font = "12px sans-serif";
    ctx.fillText(!state.rows.length ? "Загрузите лог, чтобы увидеть график." : "Нет данных после фильтров или нет колонки оборотов.", 14, 30);
    return;
  }

  const rpms = data.map((r) => r.rpm ?? 0);
  const thrs = data.map((r) => activeThrValue(r) ?? 0);
  const maxRpm = Math.max(RPM_MAX, ...rpms);
  const pad = { l: 44, r: 44, t: 12, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  // сетка
  ctx.strokeStyle = "#223041";
  ctx.fillStyle = "#7d8ba0";
  ctx.font = "10px sans-serif";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    const val = Math.round(maxRpm - (maxRpm * i) / 4);
    ctx.fillText(String(val), 6, y + 3);
    const pct = 100 - (100 * i) / 4;
    ctx.fillText(pct + "%", w - pad.r + 6, y + 3);
  }

  const x = (i) => pad.l + (data.length <= 1 ? 0 : (iw * i) / (data.length - 1));
  const yRpm = (v) => pad.t + ih - (ih * v) / maxRpm;
  const yThr = (v) => pad.t + ih - (ih * Math.min(100, Math.max(0, v))) / 100;

  // отсеянные точки фоном
  const cut = state.rows.filter((r) => !rowPasses(r, f)).slice(0, 2000);
  ctx.fillStyle = "rgba(150,160,175,0.25)";
  cut.forEach((r) => {
    const i = r.idx % Math.max(1, state.rows.length) / Math.max(1, state.rows.length) * data.length;
    void i;
  });

  // линия оборотов
  ctx.strokeStyle = "#3fa9f5";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  rpms.forEach((v, i) => {
    const px = x(i), py = yRpm(v);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // линия педали/дросселя
  if (activeThrSource()) {
    ctx.strokeStyle = "#22c58b";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    thrs.forEach((v, i) => {
      const px = x(i), py = yThr(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  const src = activeThrSource();
  el.legend.innerHTML =
    `<span><i class="dot" style="background:#3fa9f5"></i>Обороты, об/мин</span>` +
    (src === "pedal" ? `<span><i class="dot" style="background:#22c58b"></i>Педаль, %</span>` :
     src === "throttle" ? `<span><i class="dot" style="background:#22c58b"></i>Дроссель, %</span>` : "") +
    `<span>Точек: ${data.length}</span>`;
}

function loadText(text, name) {
  const { headers, data } = parseCSV(text);
  if (!headers.length) {
    el.fileInfo.textContent = "Не удалось распознать файл.";
    return;
  }
  state.headers = headers;
  state.thrSource = "auto";
  buildRows(headers, data);
  el.fileInfo.textContent = `${name} — строк: ${data.length}, колонок: ${headers.length}`;
  refreshThrUI();
  syncRpmUI();
  syncThrUI();
  applyFilters();
}

function demoLog(kind) {
  // Генерируем демо: время, rpm 800–8200, педаль и дроссель 0–100
  const headers = kind === "throttle"
    ? ["time", "rpm", "throttle", "speed"]
    : ["time", "rpm", "pedal", "speed"];
  let out = headers.join(";") + "\n";
  for (let i = 0; i < 600; i++) {
    const rpm = Math.round(800 + 7400 * Math.abs(Math.sin(i / 60)) + Math.random() * 250);
    const load = Math.round(50 + 50 * Math.sin(i / 45 + 1));
    const pct = Math.min(100, Math.max(0, load + Math.round((Math.random() - 0.5) * 12)));
    const speed = Math.round(rpm / 110 + Math.random() * 3);
    out += `${(i * 0.1).toFixed(1)};${rpm};${pct};${speed}\n`;
  }
  return out;
}

// ===== события =====
el.fileInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => loadText(String(rd.result || ""), f.name);
  rd.readAsText(f, "windows-1251");
});

el.demoBtn.addEventListener("click", () => {
  // Чередуем демо с педалью/дроселем, чтобы показать авто-переключение
  const hasPedal = state.colPedal >= 0;
  const kind = hasPedal ? "throttle" : "pedal";
  loadText(demoLog(kind), kind === "pedal" ? "демо-лог (педаль).csv" : "демо-лог (дроссель).csv");
});

el.rpmMin.addEventListener("input", () => { syncRpmUI("min"); applyFilters(); });
el.rpmMax.addEventListener("input", () => { syncRpmUI("max"); applyFilters(); });
el.rpmMinNum.addEventListener("change", () => { el.rpmMin.value = clampRpm(el.rpmMinNum.value, RPM_MIN); syncRpmUI("min"); applyFilters(); });
el.rpmMaxNum.addEventListener("change", () => { el.rpmMax.value = clampRpm(el.rpmMaxNum.value, RPM_MAX); syncRpmUI("max"); applyFilters(); });
el.rpmReset.addEventListener("click", () => {
  el.rpmMin.value = RPM_MIN; el.rpmMax.value = RPM_MAX;
  el.rpmMinNum.value = RPM_MIN; el.rpmMaxNum.value = RPM_MAX;
  syncRpmUI(); applyFilters();
});
el.rpmEnabled.addEventListener("change", applyFilters);

el.thrMin.addEventListener("input", () => { syncThrUI(); applyFilters(); });
el.thrMax.addEventListener("input", () => { syncThrUI(); applyFilters(); });
el.thrReset.addEventListener("click", () => { el.thrMin.value = 0; el.thrMax.value = 100; syncThrUI(); applyFilters(); });
el.thrEnabled.addEventListener("change", applyFilters);

el.thrSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.thrSource = btn.dataset.src;
  refreshThrUI();
  applyFilters();
});

el.resetAll.addEventListener("click", () => {
  el.rpmMin.value = RPM_MIN; el.rpmMax.value = RPM_MAX;
  el.rpmMinNum.value = RPM_MIN; el.rpmMaxNum.value = RPM_MAX;
  el.thrMin.value = 0; el.thrMax.value = 100;
  el.rpmEnabled.checked = true;
  el.thrEnabled.checked = true;
  state.thrSource = "auto";
  syncRpmUI(); syncThrUI(); refreshThrUI(); applyFilters();
});

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("tab-chart").classList.toggle("hidden", t.dataset.tab !== "chart");
    $("tab-table").classList.toggle("hidden", t.dataset.tab !== "table");
    if (t.dataset.tab === "chart") renderChart(getFilters());
  });
});

window.addEventListener("resize", () => renderChart(getFilters()));

// старт с демо (педаль), чтобы сразу было видно оба фильтра
loadText(demoLog("pedal"), "демо-лог (педаль).csv");
