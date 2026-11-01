import { drawBars, fitCanvas } from "./charts.js";
import { download, fit, recapImage } from "./exports.js";
import { duration, durationLabel, number } from "./format.js";
import { LANGUAGES, browserLanguage, language, setLanguage, t } from "./i18n.js";
import { DEFAULT_WEIGHT, RECORD_DURATIONS, Ride } from "./ride.js";
import { DRAWINGS, SUPPORT } from "./route.js";
import { HeartRateMonitor, Trainer } from "./sensors.js";
import { ZONES, zoneIndex, zoneTimes } from "./zones.js";

const HOLD_TIME = 1500;  // ms, the same as the ring animation in style.css
const BUCKET = 5;        // seconds of riding behind each bar of the live chart
const LIVE_BARS = 120;   // 10 minutes of 5-second bars
const MAX_BARS = 120;    // whole-ride charts merge bars to never draw more than this
const COLUMN_MIN = 240;  // px, narrowest column when resizing the live cards
const CARD_MIN = 100;    // px, lowest live card, unless its stylesheet asks for more
const SLIDE_TIME = 250;  // ms a card or the bubble takes to slide to its new place
const DEFAULT_FTP = 200; // W, until the rider enters their own
const DRAWINGS_SHOWN = 8; // drawings offered for the route, besides the one supporting Wattamax

const $ = (id) => document.getElementById(id);
const css = getComputedStyle(document.documentElement);
const wide = matchMedia("(min-width: 901px), (orientation: landscape)");  // the live cards are only resized and moved in two columns
// iPadOS passes for a Mac, but a Mac has no touch screen
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const color = (name) => css.getPropertyValue(`--${name}`).trim();
const ZONE_COLORS = ZONES.map((_, i) => color(`z${i + 1}`));

let trainer = null;
let heart = null;  // the heart rate strap, from the moment the person asks to connect one
let ride = new Ride();
let reconnecting = false;
let heartLost = false;  // the strap dropped and is reconnecting on its own, or can be picked again
let wakeLock = null;
let message = "";  // the key of an error to show in the bubble until the next connection attempt
let bluetooth = Boolean(navigator.bluetooth);  // false too once Chrome says there is no adapter or Bluetooth is blocked

// Settings are remembered by this browser only, and nothing is remembered if storage is blocked
const load = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } };

// Weight and FTP start at typical values. Clicking a field once keeps its value as the rider's own,
// since it may well be theirs. What depends on them stays hidden if the rider empties a field.
const settings = { weight: $("weight"), ftp: $("ftp") };
const defaults = { weight: DEFAULT_WEIGHT, ftp: DEFAULT_FTP };
for (const [name, input] of Object.entries(settings)) {
  const saved = load(name);
  input.value = saved ?? defaults[name];
  input.classList.toggle("default", saved === null);
  input.addEventListener("focus", () => { input.classList.remove("default"); save(name, input.value); });
  input.addEventListener("input", () => { save(name, input.value); ride.weight = weight(); render(); });
}
const weight = () => Number(settings.weight.value) || null;
const ftp = () => Number(settings.ftp.value) || null;
const colorOf = (watts) => (ftp() ? ZONE_COLORS[zoneIndex(watts, ftp())] : color("accent"));

let autoPause = load("autoPause") !== "off";
function setAutoPause(on) {
  autoPause = ride.autoPause = on;
  $("autopause").setAttribute("aria-checked", on);
  save("autoPause", on ? "on" : "off");
}

let chartMode = load("chart") === "10min" ? "10min" : "all";
function setChartMode(mode) {
  chartMode = mode;
  for (const button of document.querySelectorAll("[data-chart]")) button.setAttribute("aria-pressed", button.dataset.chart === mode);
  save("chart", mode);
  render();
}

// The summary's rows: the max power, then the best effort on each duration
const recordLabels = () => [t("maxRow"), ...RECORD_DURATIONS.map(durationLabel)];

// One row per duration: rolling average and session record live, best effort in the summary
function buildRows(id, labels) {
  $(id).innerHTML = labels.map((label) => `<li><span class="label">${label}</span>`
    + '<span class="bar"><span class="ghost"></span><span class="fill"></span></span><span class="watts"></span><span class="record"></span></li>').join("");
}

// `rows` holds, per duration, the watts to draw and the record behind them (null when there's none yet).
// The longest bar fills its track, with the record as a grey bar behind it.
function fillRows(id, rows) {
  const top = Math.max(1, ...rows.flatMap((r) => [r.value ?? 0, r.record ?? 0]));
  $(id).querySelectorAll("li").forEach((li, i) => {
    const { value, record } = rows[i];
    const [ghost, fill] = li.querySelectorAll(".bar span");
    ghost.style.width = `${(record ?? 0) / top * 100}%`;
    fill.style.width = `${(value ?? 0) / top * 100}%`;
    fill.style.background = value === null ? "" : colorOf(value);
    li.querySelector(".watts").textContent = value === null ? "–" : number(value);
    li.querySelector(".record").textContent = record === null ? "" : number(record);
  });
}

// The whole ride, merged into at most MAX_BARS bars of a whole number of 5-second slices.
// Under 10 minutes it is drawn like the 10-minute chart, so the first bars don't fill the width.
function rideBars() {
  if (ride.time < LIVE_BARS * BUCKET) return lastBars();
  const size = Math.max(BUCKET, Math.ceil(ride.time / MAX_BARS / BUCKET) * BUCKET);
  const bars = ride.powerBuckets(size);
  return { bars, slots: bars.length };
}

// The last 10 minutes fill up from the left, then scroll
function lastBars() {
  const first = Math.max(0, Math.floor(ride.time / BUCKET) - (LIVE_BARS - 1));
  return { bars: ride.powerBuckets(BUCKET, first * BUCKET), slots: LIVE_BARS };
}

function drawChart(canvas, { bars, slots }) {
  const { ctx, box } = fitCanvas(canvas);
  drawBars(ctx, box, bars, Math.max(slots, 1), colorOf, { grid: color("track"), label: color("tertiary") });
}

function renderStatus(text, dot) {
  $("status").textContent = text;
  $("status-dot").className = `dot ${dot}`;
  $("status-pill").disabled = $("connect").hidden || $("connect").disabled;
}

// What the bubble over the app says, and how it's marked: info, start, pause or error
function bubble() {
  if (message) return [t(message), "error"];
  if (!trainer?.active) return [t("wakeTrainer"), "info"];
  if (reconnecting) return [t("reconnecting"), "error"];
  if (ride.state === "waiting") return [t("pedalToStart"), "start"];
  if (ride.state === "paused") return [t("paused"), "pause"];
  return ["", ""];
}

// A power figure takes the colour of its zone, named under it in the same colour
function zoneOf(watts) {
  if (!ftp()) return { color: "", name: "" };
  const zone = zoneIndex(watts, ftp());
  return { color: ZONE_COLORS[zone], name: `Z${zone + 1} ${t(`zone${zone + 1}`)}` };
}

function renderZone(figure, label, { color, name }) {
  $(figure).style.color = $(label).style.color = color;
  $(label).textContent = name;
  $(label).hidden = !name;
}

function renderLive() {
  const power = ride.displayPower;
  $("power").textContent = number(power);
  $("avg-power").textContent = number(ride.averagePower);
  $("max-power").textContent = number(ride.maxPower);
  $("cadence").textContent = number(ride.cadence);
  $("avg-cadence").textContent = number(ride.averageCadence);
  $("speed").textContent = number(ride.speed, 1);
  $("avg-speed").textContent = number(ride.averageSpeed, 1);
  $("distance").textContent = number(ride.distance, 2);
  $("duration").textContent = duration(ride.time);
  renderZone("power", "zone", zoneOf(power));
  $("wkg-box").hidden = !weight();
  if (weight()) {
    $("wkg").textContent = number(power / weight(), 1);
    $("avg-wkg").textContent = number(ride.averagePower / weight(), 1);
  }
  // The heart rate shows once a strap is connected, and a dash while it's lost
  $("heart-box").hidden = !heart?.active;
  $("heart-rate").textContent = ride.heartRate === null ? "–" : number(ride.heartRate);
  $("avg-heart-rate").textContent = ride.averageHeartRate === null ? "–" : number(ride.averageHeartRate);
  fillRows("rolling", RECORD_DURATIONS.map((d) => ({ value: ride.average(d), record: ride.records.get(d) ?? null })));

  const beating = ride.heartRate !== null;
  $("heart-connect").classList.toggle("on", beating);
  $("heart-connect").disabled = !bluetooth || (heart !== null && !heartLost);
  $("heart-connect").title = $("heart-connect").ariaLabel = t(beating ? "heartConnected" : "connectHeart");
  if (!trainer?.active) renderStatus(t("notConnected"), "");
  else if (reconnecting) renderStatus(t("disconnected"), "lost");
  else renderStatus(trainer.name, "on");
  const [text, kind] = bubble();
  $("bubble-text").textContent = text;
  $("bubble").hidden = !text;
  $("bubble").dataset.kind = kind;
  $("bubble-mark").setAttribute("href", `#mark-${kind}`);
  document.body.dataset.state = reconnecting ? "paused" : ride.state;

  drawChart($("live-chart"), chartMode === "all" ? rideBars() : lastBars());
}

// Everything the summary shows, which the PNG recap draws the same way
function summaryView() {
  const summary = ride.summary();
  const times = ftp() ? zoneTimes(ride.samples, ftp()) : [];
  const total = times.reduce((a, b) => a + b, 0) || 1;
  return {
    date: ride.startedAt.toLocaleString(language, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    power: number(summary.power),
    cadence: number(summary.cadence),
    speed: number(summary.speed, 1),
    zone: zoneOf(summary.power),
    wkg: weight() ? number(summary.power / weight(), 1) : "",
    // Each zone's share of the ride, and its time written without the leading zero hours and minutes
    zones: times.map((t, i) => ({ share: t / total, color: ZONE_COLORS[i], time: duration(t).replace(/^0:0?/, "") })),
    distance: number(summary.distance, 2),
    duration: duration(summary.time),
    elapsed: duration(summary.elapsed),
    calories: number(summary.calories),
    records: [summary.maxPower, ...RECORD_DURATIONS.map((d) => ride.records.get(d) ?? null)],
    heartRate: summary.heartRate === null ? null : { average: number(summary.heartRate), max: number(summary.maxHeartRate) },
    bars: rideBars(),
  };
}

function renderSummary() {
  const view = summaryView();
  $("s-power").textContent = view.power;
  renderZone("s-power", "s-zone", view.zone);
  $("s-wkg-box").hidden = !view.wkg;
  $("s-wkg").textContent = view.wkg;
  $("s-cadence").textContent = view.cadence;
  $("s-speed").textContent = view.speed;
  $("s-heart-box").hidden = !view.heartRate;
  if (view.heartRate) {
    $("s-heart-rate").textContent = view.heartRate.average;
    $("s-max-heart-rate").textContent = view.heartRate.max;
  }
  $("s-distance").textContent = view.distance;
  $("s-duration").textContent = view.duration;
  $("s-elapsed").textContent = view.elapsed;
  $("s-calories").textContent = view.calories;
  fillRows("records", view.records.map((value) => ({ value, record: null })));
  drawChart($("summary-chart"), view.bars);

  $("zones-box").hidden = !view.zones.length;
  $("zone-bar").innerHTML = view.zones.map((z) => `<span style="flex: ${z.share}; background: ${z.color}"></span>`).join("");
  $("zone-legend").innerHTML = view.zones.map((z, i) => `<li><i style="background: ${z.color}"></i>Z${i + 1} <strong>${z.time}</strong></li>`).join("");
  renderStatus(view.date, "");
}

const render = () => ($("summary").hidden ? renderLive() : renderSummary());

// A live card resizes from its corners that touch another card. Sideways moves the border between
// the two columns; up and down moves the border between the card and the one above or below it,
// by sharing the column's height between them. Grips depend on where the cards are, so they're
// placed again once a card is dropped.
function placeGrips() {
  const live = $("live");
  for (const grip of live.querySelectorAll(".grip")) grip.remove();
  for (const card of live.querySelectorAll(".card")) addGrips(live, card);
}

// A card can't go below its own min-height, so a resize stops there rather than push the column
// out of the window
const lowest = (card) => Math.max(CARD_MIN, parseFloat(getComputedStyle(card).minHeight));

function addGrips(live, card) {
  const column = card.parentElement;
  const inSide = column.classList.contains("side");
  const [top, bottom] = column.querySelectorAll(":scope > .card");
  // Corners, then edges, where "" leaves out a side: an edge only moves the border it lies on
  for (const v of ["top", "bottom", ""]) for (const h of ["left", "right", ""]) {
    const x = h !== "" && (h === "right") === inSide;
    const y = v !== "" && (v === "bottom") === (card === top);
    if (!x && !y) continue;
    const grip = document.createElement("span");
    grip.className = `grip ${v} ${h}`;
    grip.style.cursor = x && y ? ((v === "top") === (h === "left") ? "nwse-resize" : "nesw-resize") : x ? "ew-resize" : "ns-resize";
    let start;
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      start = { x: event.clientX, y: event.clientY, column: live.querySelector(".column").offsetWidth, top: top.offsetHeight, bottom: bottom.offsetHeight, topMin: lowest(top), bottomMin: lowest(bottom) };
    });
    grip.addEventListener("pointermove", (event) => {
      if (!grip.hasPointerCapture(event.pointerId)) return;
      if (x) {
        const widest = live.clientWidth - parseFloat(getComputedStyle(live).columnGap) - COLUMN_MIN;
        live.style.setProperty("--column", `${Math.min(Math.max(start.column - (event.clientX - start.x), COLUMN_MIN), widest)}px`);
      }
      if (y) {
        const total = start.top + start.bottom;
        const height = Math.min(Math.max(start.top + event.clientY - start.y, start.topMin), total - start.bottomMin);
        top.style.flex = `${height} 1 ${height}px`;
        bottom.style.flex = `${total - height} 1 ${total - height}px`;
      }
    });
    card.append(grip);
  }
}

// Pressing a live card lifts it out of its place, which stays empty, and the card follows the
// pointer at its own size. Passing over another card slides that card into the empty place, and
// dropping the card moves it into the place left empty. Sizes stay with the places, so a card
// takes the size of the place it lands in. While dragging, the card only moves by `translate`,
// and the slides only animate `transform`, so the page isn't laid out again on every frame.
function makeMovable(card) {
  let start = null;  // where the pointer pressed the card, while it's dragged
  let slot;          // the empty place the card will land in
  card.addEventListener("pointerdown", (event) => {
    if (!wide.matches || event.button !== 0 || event.target.closest(".grip, button")) return;
    const box = card.getBoundingClientRect();
    slot = document.createElement("div");
    slot.className = "slot";
    // The same padding as the card, so its place keeps the same share of the column
    slot.style.cssText = `flex: ${card.style.flex}; padding: ${getComputedStyle(card).padding}`;
    card.replaceWith(slot);
    Object.assign(card.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    card.classList.add("dragged");
    // Out of the columns, so it doesn't count among their children; still in #live for its styles
    $("live").append(card);
    card.setPointerCapture(event.pointerId);
    start = { x: event.clientX, y: event.clientY };
  });
  card.addEventListener("pointermove", (event) => {
    if (!start) return;
    card.style.translate = `${event.clientX - start.x}px ${event.clientY - start.y}px`;
    // A card still sliding is skipped, or it would be found under the pointer on its way out and swapped back
    const other = document.elementsFromPoint(event.clientX, event.clientY)
      .find((el) => el !== card && el.matches("#live .card") && !el.getAnimations().length);
    if (!other) return;
    const from = other.getBoundingClientRect();
    swap(slot, other);
    slide(other, from);
  });
  const drop = () => {
    if (!start) return;
    start = null;
    const from = card.getBoundingClientRect();
    card.classList.remove("dragged");
    Object.assign(card.style, { left: "", top: "", width: "", height: "", translate: "", flex: slot.style.flex });
    slot.replaceWith(card);
    placeGrips();
    slide(card, from);
  };
  card.addEventListener("pointerup", drop);
  card.addEventListener("pointercancel", drop);
}

// Swaps two elements of the columns, and their sizes with them
function swap(a, b) {
  const mark = document.createComment("");
  a.replaceWith(mark);
  b.replaceWith(a);
  mark.replaceWith(b);
  [a.style.flex, b.style.flex] = [b.style.flex, a.style.flex];
}

// The element is drawn at its former box, then eased into its new one
function slide(el, from) {
  const to = el.getBoundingClientRect();
  const back = `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  el.animate([{ transform: back }, { transform: "none" }], { duration: SLIDE_TIME, easing: "ease-out" });
}

// The bubble's button docks it, small, in the header; clicking it there brings it back. It stays
// docked whatever it says next.
function toggleDock() {
  const bubble = $("bubble");
  const from = bubble.getBoundingClientRect();
  const docked = bubble.classList.toggle("docked");
  if (docked) document.querySelector(".top h1").after(bubble);
  else document.body.append(bubble);
  slide(bubble, from);
}

// A drawing of the route as an SVG line, in a box fitted to it, with y going down
function drawingSvg(points) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [left, top] = [Math.min(...xs), Math.max(...ys)];
  const [width, height] = [Math.max(...xs) - left, top - Math.min(...ys)];
  const scale = 100 / Math.max(width, height);
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${((x - left) * scale).toFixed(1)} ${((top - y) * scale).toFixed(1)}`).join("");
  return `<svg viewBox="-3 -3 ${width * scale + 6} ${height * scale + 6}" aria-hidden="true"><path d="${d}"></path></svg>`;
}

// Up to DRAWINGS_SHOWN of the other drawings, picked anew for each ride and in a random order, so
// the choice stays short and changes from one ride to the next
function pickDrawings() {
  const others = [...$("drawings").children].slice(1);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  others.forEach((tile, i) => {
    tile.hidden = i >= DRAWINGS_SHOWN;
    $("drawings").append(tile);
  });
}

// Every flag loads with the page and stays loaded: the host makes the browser check a file again
// each time it's shown, which held the next flag back after a click
const FLAGS = Object.fromEntries(LANGUAGES.map((code) => [code, Object.assign(new Image(), { src: `assets/flags/${code}.svg` })]));

// The page in another language, with its flag and its own address. The record rows' first label
// is a word.
function showLanguage(code) {
  setLanguage(code);
  history.replaceState(null, "", `/${code}`);
  $("flag").src = FLAGS[code].src;
  $("language").title = t("language");
  buildRows("records", recordLabels());
  render();
}

// Hold-to-confirm: the action runs once the button has been held for HOLD_TIME while its ring fills.
// It replaces confirmation dialogs for actions that can't be undone.
function onHold(button, action) {
  let timer = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    button.classList.remove("holding");
  };
  const start = (event) => {
    event.preventDefault();
    if (timer) return;
    button.classList.add("holding");
    timer = setTimeout(() => { cancel(); action(); }, HOLD_TIME);
  };
  button.addEventListener("pointerdown", start);
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) button.addEventListener(type, cancel);
  button.addEventListener("keydown", (event) => { if ((event.key === " " || event.key === "Enter") && !event.repeat) start(event); });
  button.addEventListener("keyup", (event) => { if (event.key === " " || event.key === "Enter") cancel(); });
}

async function keepScreenOn() {
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* not critical: the ride still records */ }
}

async function connect() {
  message = "";
  $("connect").disabled = true;
  trainer = new Trainer(
    (values) => { ride.update(values); renderLive(); },
    (connected) => { reconnecting = !connected; if (!connected) ride.pause(); renderLive(); },
  );
  try {
    await trainer.connect();
  } catch {
    // Without a device, the person closed the picker without choosing one. Chrome says so with a
    // NotFoundError, Bluefy with another error, so the device tells it rather than the error.
    if (trainer.device) message = "connectFailed";
  } finally {
    $("connect").disabled = false;
  }
  if (trainer.active) {
    $("connect").hidden = true;
    $("stop").hidden = false;
    keepScreenOn();
  }
  renderLive();
}

// The strap can be connected at any time before the end of the ride, and stays connected until then.
// If it drops, the button picks it again, in case reconnecting on its own doesn't work.
async function connectHeart() {
  message = "";
  heart?.disconnect();
  heartLost = false;
  heart = new HeartRateMonitor(
    ({ heartRate }) => { ride.heartRate = heartRate; renderLive(); },
    (connected) => { heartLost = !connected; if (!connected) ride.heartRate = null; renderLive(); },
  );
  renderLive();
  try {
    await heart.connect();
  } catch {
    if (heart.device) message = "heartFailed";
    heart = null;
  }
  renderLive();
}

function finish() {
  trainer.disconnect();
  heart?.disconnect();
  reconnecting = false;
  heartLost = false;
  wakeLock?.release();
  if (ride.time < 1) {
    reset();
    message = "noData";
    renderLive();
    return;
  }
  $("live").hidden = true;
  $("summary").hidden = false;
  document.body.dataset.screen = "summary";
  document.body.dataset.state = "";
  renderSummary();
}

function reset() {
  trainer = null;
  heart = null;
  ride = new Ride();
  ride.autoPause = autoPause;
  ride.weight = weight();
  message = "";
  $("summary").hidden = true;
  $("live").hidden = false;
  document.body.dataset.screen = "live";
  $("connect").hidden = false;
  $("stop").hidden = true;
  $("drawings").querySelector(".saved")?.classList.remove("saved");
  pickDrawings();
  renderLive();
}

function fileName(extension) {
  const d = ride.startedAt;
  const pad = (n) => String(n).padStart(2, "0");
  return `wattamax_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.${extension}`;
}

$("connect").addEventListener("click", connect);
$("status-pill").addEventListener("click", () => $("connect").click());
$("heart-connect").addEventListener("click", connectHeart);
$("about-open").addEventListener("click", () => $("about").showModal());
$("export-open").addEventListener("click", () => $("export").showModal());
// A window closes from its cross, or from a click beside it. That click lands on the dialog itself,
// like one in its padding, so its position tells them apart. The press must start beside it too, so
// selecting text and letting go outside keeps it open. Bluefy ignores closedby="any".
for (const dialog of document.querySelectorAll("dialog")) {
  const beside = (event) => {
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return event.target === dialog && !(left <= event.clientX && event.clientX <= right && top <= event.clientY && event.clientY <= bottom);
  };
  let pressedBeside = false;
  dialog.querySelector(".close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("pointerdown", (event) => { pressedBeside = beside(event); });
  dialog.addEventListener("click", (event) => { if (pressedBeside && beside(event)) dialog.close(); });
}
onHold($("stop"), finish);
onHold($("restart"), reset);
$("autopause").addEventListener("click", () => setAutoPause(!autoPause));
// Each click goes to the next language, which this browser then keeps
$("language").addEventListener("click", () => {
  showLanguage(LANGUAGES[(LANGUAGES.indexOf(language) + 1) % LANGUAGES.length]);
  save("language", language);
});
// Only its button takes clicks in the middle of the page, and all of it once docked
$("bubble").addEventListener("click", toggleDock);
for (const button of document.querySelectorAll("[data-chart]")) button.addEventListener("click", () => setChartMode(button.dataset.chart));
// Browsers on iPhone and iPad, Bluefy included, ignore download links, so the file goes
// through the share sheet, where "Enregistrer dans Fichiers" keeps it
const saveFile = (blob, name) => ios ? navigator.share({ files: [new File([blob], name, { type: blob.type })] }) : download(blob, name);

// The export window's drawings: the one that supports Wattamax first, across the whole width, then
// the others. A click saves the ride's file following that drawing, and marks it as the one saved.
for (const name of [SUPPORT, ...Object.keys(DRAWINGS).filter((name) => name !== SUPPORT)]) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.dataset.i18nLabel = "downloadDrawing";
  tile.innerHTML = drawingSvg(DRAWINGS[name]) + (name === SUPPORT ? '<span data-i18n="supportDrawing"></span>' : "");
  tile.classList.toggle("support", name === SUPPORT);
  tile.addEventListener("click", async () => {
    await saveFile(await fit(ride, name), fileName("fit"));
    $("drawings").querySelector(".saved")?.classList.remove("saved");
    tile.classList.add("saved");
  });
  $("drawings").append(tile);
}
// The drawings on one row if they fit at --tile each, else on two even rows: eight go four and four
new ResizeObserver(() => {
  const grid = $("drawings");
  const style = getComputedStyle(grid);
  const gap = parseFloat(style.columnGap);
  const fit = Math.max(1, Math.floor((grid.clientWidth + gap) / (parseFloat(style.getPropertyValue("--tile")) + gap)));
  const drawings = Math.min(DRAWINGS_SHOWN, grid.children.length - 1);
  grid.style.setProperty("--columns", fit >= drawings ? drawings : Math.ceil(drawings / 2));
}).observe($("drawings"));
$("png").addEventListener("click", async () => saveFile(await recapImage(summaryView(), recordLabels(), colorOf), fileName("png")));

// A chart is drawn again whenever its size changes: the window, or a card resized or moved
const resizes = new ResizeObserver(render);
for (const canvas of document.querySelectorAll("canvas")) resizes.observe(canvas);

// iPhone and iPad only show a button's :active state, its press, on a page listening to touches
document.addEventListener("touchstart", () => {}, { passive: true });

// Ask before closing the tab during a ride or on its summary, so a ride isn't lost before it's downloaded
addEventListener("beforeunload", (event) => {
  if (ride.time > 0) event.preventDefault();
});

// The browser drops the wake lock when the tab is hidden; take it back when the person returns
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && trainer?.active && (!wakeLock || wakeLock.released)) keepScreenOn();
});

buildRows("rolling", RECORD_DURATIONS.map(durationLabel));
placeGrips();
for (const card of $("live").querySelectorAll(".card")) makeMovable(card);
setAutoPause(autoPause);
setChartMode(chartMode);
// The address the page opened at is its own page for Google, so it doesn't take the languages for
// copies of wattamax.com. Google opens wattamax.com in English, so /en is a copy of it.
const address = location.pathname.slice(1);
document.head.append(Object.assign(document.createElement("link"), { rel: "canonical", href: `https://wattamax.com/${LANGUAGES.includes(address) && address !== "en" ? address : ""}` }));
// The language in the address first, as a link or a search result picked it, then the one this
// browser kept, then the browser's own
showLanguage([address, load("language")].find((code) => LANGUAGES.includes(code)) ?? browserLanguage());
reset();
// What to do without Web Bluetooth, told for the browser at hand
function noBluetoothMessage() {
  if (navigator.bluetooth) return "bluetoothBlocked";
  const agent = navigator.userAgent;
  if (ios) return "bluetoothIos";
  if (navigator.brave) return "bluetoothBrave";
  if (/Firefox\//.test(agent)) return "bluetoothFirefox";
  if (!/Chrome|Chromium/.test(agent) && /Safari/.test(agent)) return "bluetoothSafari";
  if (/Linux/.test(agent) && !/Android/.test(agent)) return "bluetoothLinux";
  return "bluetoothOther";
}

function noBluetooth() {
  bluetooth = false;
  $("connect").disabled = true;
  message = noBluetoothMessage();
  renderLive();
}

// Without an adapter, or when Bluetooth is blocked, requestDevice fails at once with the same NotFoundError
// as a closed picker, so connecting would silently do nothing. Bluefy may not have getAvailability.
if (!bluetooth) noBluetooth();
else navigator.bluetooth.getAvailability?.().then((available) => { if (!available) noBluetooth(); });
