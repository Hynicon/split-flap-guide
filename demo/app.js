"use strict";
// Split-flap app. The same files are served by the display itself (plain HTTP on its own
// network, changes need the admin key) and by the relay server (HTTPS, behind a sign-in).
// Both offer the same API: /api/status, /api/config, /api/show, /api/rehome, /api/tokens.

const PLATFORMS = [["tiktok", "TikTok"], ["instagram", "Instagram"], ["facebook", "Facebook"]];
const MODES = [
  ["cycle", "Followers", "Each platform in turn"],
  ["single", "One platform", "Just one count"],
  ["random", "Words", "Random from your list"],
  ["text", "Message", "The text below"],
  ["clock", "Clock", "The time"],
  ["date", "Date", "Day and month"],
  ["weather", "Weather", "Temperature outside"],
  ["countdown", "Countdown", "Time left"],
  ["mix", "Mix", "Your rotation"],
  ["off", "Blank", "All flaps blank"],
];
const MIX_NAMES = { followers: "Followers", random: "Random word", text: "Message", clock: "Clock", date: "Date", weather: "Weather", countdown: "Countdown" };
const ZONES = [
  ["UTC", "UTC0"],
  ["Lisbon", "WET0WEST,M3.5.0/1,M10.5.0"],
  ["London", "GMT0BST,M3.5.0/1,M10.5.0"],
  ["Madrid, Paris, Berlin", "CET-1CEST,M3.5.0,M10.5.0/3"],
  ["New York", "EST5EDT,M3.2.0,M11.1.0"],
  ["Chicago", "CST6CDT,M3.2.0,M11.1.0"],
  ["Denver", "MST7MDT,M3.2.0,M11.1.0"],
  ["Phoenix", "MST7"],
  ["Los Angeles", "PST8PDT,M3.2.0,M11.1.0"],
  ["São Paulo", "<-03>3"],
];
const MAX_WORDS = 100, MAX_WORD_BYTES = 32, MAX_TEXT_BYTES = 64, MAX_MIX = 8, MAX_PRESETS = 12;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const bytes = (s) => new TextEncoder().encode(s).length;

let cfg = null;      // the display's settings, with our unconfirmed edits applied
let status = null;
let viaServer = false;
let saving = 0;      // saves in flight: don't overwrite the form with older settings meanwhile

// ---- storage that may be blocked ----
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
};

// ---- toast ----
function toast(msg, isError) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = "toast"; }, isError ? 7000 : 3000);
}

// ---- API ----
async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": $("#admin-key").value },
    body: JSON.stringify(body),
  };
  let res;
  try { res = await fetch(path, opts); } catch (e) { throw new Error("No connection"); }
  if (res.status === 401 && viaServer) { location.href = "/login"; throw new Error("Signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Apply a change: show it at once, send it, and put things back if the display refuses it.
async function save(patch, done) {
  if (!cfg) return toast("The display's settings haven't loaded yet", true);
  for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(patch)))) {
    if (key === "platforms") for (const id in value) Object.assign(cfg.platforms[id], value[id]);
    else cfg[key] = value;
  }
  render();
  saving++;
  try {
    const r = await api("/api/config", patch);
    if (done) toast(r.queued ? `${done}. The display is offline: it will pick this up when it reconnects.` : done);
    else if (r.queued) toast("Saved. The display is offline: it will pick this up when it reconnects.");
    soon();
  } catch (e) {
    toast(e.message, true);
    saving--;
    await loadConfig();
    return;
  }
  saving--;
}

// ---- what the flaps can show (same rules as foldToFlaps in firmware/common/charset.cpp) ----
const OWN_FLAPS = "ÃÇÉÁ";
function fold(text) {
  return [...text].map((ch) => {
    let c = ch.toUpperCase();
    if (c.length !== 1) return " ";
    if (OWN_FLAPS.includes(c)) return c;
    c = c.normalize("NFD")[0];
    return /[A-Z0-9. ]/.test(c) ? c : " ";
  }).join("");
}
const units = () => (cfg && cfg.units) || 9;
// What a text turns into on the display, and whether part of it is lost.
function shown(text) {
  const all = fold(text).trim();
  return { text: all.slice(0, units()).trimEnd(), cut: all.length > units(), changed: all !== text.trim().toUpperCase() };
}
function explain(text) {
  if (!text.trim()) return "";
  const s = shown(text);
  if (!s.text) return "None of these characters are on the flaps.";
  if (s.cut) return `Too long for ${units()} flaps. Only “${s.text}” will show.`;
  if (s.changed) return `Shows as “${s.text}”. The flaps have A–Z, 0–9, Ã Ç É Á and a full stop.`;
  return "";
}

// ---- the board ----
// The logo flaps arrive as U+E000 (Instagram), U+E001 (Facebook) and U+E002 (TikTok).
const LOGOS = {
  "": ["Instagram", '<rect x="2" y="2" width="20" height="20" rx="5.5" fill="none" stroke="currentColor" stroke-width="2"/>'
    + '<circle cx="12" cy="12" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.4" cy="6.6" r="1.3" fill="currentColor"/>'],
  "": ["Facebook", '<path fill="currentColor" d="M12 1.5a10.5 10.5 0 0 0-1.6 20.9v-7.6H7.8V12h2.6V9.9c0-2.6 1.6-4 3.9-4 1.1 0 2.3.2 2.3.2v2.5h-1.3c-1.3 0-1.7.8-1.7 1.6V12h2.9l-.5 2.8h-2.4v7.6A10.5 10.5 0 0 0 12 1.5z"/>'],
  "": ["TikTok", '<path fill="currentColor" d="M12.6 2h3.2c.3 2.4 1.9 4.1 4.4 4.4v3.3c-1.6 0-3.1-.5-4.4-1.4v6.6a6.1 6.1 0 1 1-6.1-6.1c.3 0 .6 0 .9.1v3.4a2.8 2.8 0 1 0 2 2.6z"/>'],
};
let lastFrame = null;
function drawFlap(s, ch) {
  if (LOGOS[ch]) s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${LOGOS[ch][1]}</svg>`;
  else s.textContent = ch;
}
function renderFrame(frame) {
  const chars = [...(frame ?? " ".repeat(units()))];
  const key = chars.join("");
  if (key === lastFrame) return;
  lastFrame = key;
  // The demo (demo.js, not part of the display's files) flips each flap through the drum instead.
  if (window.splitflapDemo) window.splitflapDemo.flipTo(chars, drawFlap);
  else $("#frame").replaceChildren(...chars.map((ch) => { const s = el("span"); drawFlap(s, ch); return s; }));
  const text = chars.map((ch) => (LOGOS[ch] ? ` ${LOGOS[ch][0]} ` : ch)).join("").replace(/\s+/g, " ").trim();
  $("#frame").setAttribute("aria-label", `Current display: ${text || "blank"}`);
}

const ago = (epoch) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - epoch));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
// Times in the server's time zone when it has one (the phone may be elsewhere), else the phone's.
const fmtTime = (epoch) => {
  if (!epoch) return "never";
  const tz = viaServer && status && status.server && status.server.time_zone;
  try { if (tz) return new Date(epoch * 1000).toLocaleString(undefined, { timeZone: tz }); } catch (e) { /* unknown zone */ }
  return new Date(epoch * 1000).toLocaleString();
};
const fmtCount = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString());

let shownError = 0;
function renderStatus() {
  const s = status, link = $("#link"), note = [];
  if (!s) return;
  const dev = s.device;
  if (!viaServer) { link.textContent = "On this network"; link.className = "link on"; }
  else if (dev.online) { link.textContent = "Display online"; link.className = "link on"; }
  else if (!dev.last_seen) { link.textContent = "Waiting for the display"; link.className = "link off"; }
  else { link.textContent = `Display offline · seen ${ago(dev.last_seen)}`; link.className = "link off"; }

  const notice = $("#notice");
  if (viaServer && !dev.known) {
    notice.hidden = false;
    notice.textContent = "The display has not connected to this server yet. On the display's own page, open Settings and enter this server's address and the device token.";
  } else notice.hidden = true;

  renderFrame(s.display ? s.display.frame : null);
  if (viaServer && dev.known && !dev.online) note.push("Showing what the display last reported");
  if (viaServer && dev.pending) note.push(`${dev.pending} change${dev.pending > 1 ? "s" : ""} waiting for the display`);
  if (s.display && s.display.quiet) note.push("Quiet hours: the flaps stay still");
  if (s.bus && s.bus.present) {
    const missing = s.bus.present.filter((ok) => !ok).length;
    if (missing) note.push(`${missing} of ${s.bus.units} units not answering`);
  }
  $("#frame-note").textContent = note.join(" · ");

  // A change the display refused (for example, sent while it was offline).
  const err = viaServer && dev.errors && dev.errors[dev.errors.length - 1];
  if (err && err.at > shownError) {
    if (shownError) toast(`The display refused a change: ${err.error}`, true);
    shownError = err.at;
    if (!saving) loadConfig();
  } else if (!shownError) shownError = 1;

  renderPlatforms();
  renderDevice();
}

function renderDevice() {
  const s = status, rows = [];
  if (!s || !s.wifi) { $("#device").replaceChildren(); return; }
  const up = `${Math.floor(s.uptime_s / 3600)} h ${Math.floor((s.uptime_s % 3600) / 60)} min`;
  const found = s.bus.present.filter(Boolean).length;
  const missing = s.bus.present.map((ok, i) => (ok ? null : `0x${(16 + i).toString(16)}`)).filter(Boolean);
  rows.push(["Wi-Fi", `${s.wifi.ssid} (${s.wifi.rssi} dBm)`], ["Address", s.wifi.ip], ["Running for", up],
    ["Last restart", s.reset_reason.replace(/_/g, " ")], ["Free memory", `${Math.round(s.free_heap / 1024)} KB`],
    ["Units answering", `${found} of ${s.bus.units}` + (missing.length ? `, missing ${missing.join(", ")}` : "")]);
  if (s.bus.error) rows.push(["Last bus error", s.bus.error]);
  if (!s.time) rows.push(["Clock", "not set yet"]);
  $("#device").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
}

// ---- connecting each platform: the steps for its free developer app, then one button ----
const CONNECT = {
  instagram: {
    id: "Instagram app ID", secret: "Instagram app secret",
    steps: [
      'You need an Instagram <b>Professional</b> account (Business or Creator): Instagram → Settings → Account type.',
      'At <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com/apps</a>, create an app, add the <b>Instagram</b> product and choose <b>API setup with Instagram login</b>.',
      'Under <b>App roles → Roles</b>, add your Instagram account as an <b>Instagram Tester</b>, then accept the invite in Instagram (Settings → Apps and websites → Tester invites).',
      'In <b>Business login settings</b>, add the redirect address below as an OAuth redirect URI.',
      'Copy the <b>Instagram app ID</b> and <b>Instagram app secret</b> into the fields below, save, then press Connect.',
    ],
  },
  facebook: {
    id: "App ID", secret: "App secret",
    steps: [
      'The count comes from a Facebook <b>Page</b> you manage. Personal profiles have no follower count in the API.',
      'At <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com/apps</a>, use the same or another app and add <b>Facebook Login</b>.',
      'In Facebook Login’s settings, add the redirect address below to <b>Valid OAuth redirect URIs</b>.',
      'Copy the <b>App ID</b> and <b>App secret</b> from <b>App settings → Basic</b> into the fields below, save, then press Connect.',
      'When Facebook asks, allow <b>pages_show_list</b> and <b>pages_read_engagement</b> and select your Page.',
    ],
  },
  tiktok: {
    id: "Client key", secret: "Client secret",
    steps: [
      'At <a href="https://developers.tiktok.com" target="_blank" rel="noopener">developers.tiktok.com</a>, create an app and add <b>Login Kit</b> for the <b>Web</b>.',
      'Add the redirect address below as a redirect URI.',
      'Add the scopes <b>user.info.basic</b> and <b>user.info.stats</b> (the follower count is in the second).',
      'Under <b>Sandbox</b>, add your TikTok account as a target user.',
      'Copy the <b>Client key</b> and <b>Client secret</b> into the fields below, save, then press Connect. If TikTok won’t grant the follower count without an app review, set the count to “A number I type” instead.',
    ],
  },
};
let integrations = null;

function connectSection(id, name) {
  const c = CONNECT[id];
  return `
    <details class="connect">
      <summary>Connect ${name}</summary>
      <ol class="steps">${c.steps.map((t) => `<li>${t}</li>`).join("")}</ol>
      <div class="connect-server">
        <label>Redirect address
          <span class="inline"><input class="redirect token" readonly aria-label="Redirect address for ${name}"><button type="button" class="quiet copy">Copy</button></span></label>
        <form class="app-creds">
          <label>${c.id} <input name="app_id" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
          <label>${c.secret} <input name="app_secret" type="password" autocomplete="off" placeholder="not set"></label>
          <button type="submit" class="quiet wide">Save</button>
        </form>
        <a class="button connect-go" href="/oauth/${id}/start">Connect ${name}</a>
        <p class="hint last"></p>
      </div>
      <p class="hint connect-local">Connecting needs the app server, which gives ${name} a secure address to come back to. Without it, run <code>python -m auth ${id}</code> from <code>tools/</code> on a PC, or paste a token below.</p>
    </details>`;
}

function renderIntegrations() {
  for (const [id, name] of PLATFORMS) {
    const card = $(`#p-${id}`), info = integrations && integrations[id];
    card.querySelector(".connect-server").hidden = !viaServer;
    card.querySelector(".connect-local").hidden = viaServer;
    if (!info) continue;
    card.querySelector(".redirect").value = info.redirect_uri;
    const f = card.querySelector(".app-creds").elements;
    if (f.app_id !== document.activeElement) f.app_id.value = info.app_id;
    f.app_secret.placeholder = info.secret_set ? "saved (leave empty to keep)" : "not set";
    const go = card.querySelector(".connect-go"), ready = info.app_id && info.secret_set;
    go.classList.toggle("disabled", !ready);
    go.setAttribute("aria-disabled", !ready);
    const last = card.querySelector(".last"), l = info.last;
    if (!l) { last.textContent = ready ? "" : "Save the app's ID and secret first."; last.className = "hint last"; continue; }
    last.textContent = l.ok
      ? `Connected ${l.account || name}${l.followers != null ? `, ${fmtCount(l.followers)} followers` : ""} · ${ago(l.at)}${l.message ? `. ${l.message}` : ""}`
      : `Didn’t connect: ${l.message}`;
    last.className = "hint last " + (l.ok ? "ok" : "bad");
  }
}
async function loadIntegrations() {
  try { integrations = await api("/api/integrations"); renderIntegrations(); } catch (e) { /* shown by refresh */ }
}

// ---- followers ----
function buildPlatforms() {
  $("#platforms").replaceChildren(...PLATFORMS.map(([id, name]) => {
    const card = el("div", { className: "card platform", id: `p-${id}` });
    card.innerHTML = `
      <span class="name">${name}</span><span class="count">—</span><span class="state"></span>
      <div class="controls">
        <label class="check"><input type="checkbox" data-p="enabled"> Show ${name}</label>
        <div class="field"><label for="src-${id}">Count comes from</label>
          <select id="src-${id}" data-p="source"><option value="api">${name} (automatic)</option><option value="manual">A number I type</option></select></div>
        <div class="field" data-manual><label for="man-${id}">Followers</label>
          <input id="man-${id}" type="number" inputmode="numeric" min="0" data-p="manual_count"></div>
      </div>${connectSection(id, name)}`;
    card.querySelector(".copy").addEventListener("click", async () => {
      const v = card.querySelector(".redirect");
      try { await navigator.clipboard.writeText(v.value); toast("Copied"); } catch (e) { v.select(); }
    });
    card.querySelector(".app-creds").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      try {
        await api("/api/integrations", { platform: id, app_id: f.app_id.value.trim(), app_secret: f.app_secret.value.trim() });
        f.app_secret.value = "";
        toast("Saved. Now press Connect.");
        loadIntegrations();
      } catch (e) { toast(e.message, true); }
    });
    card.querySelector(".connect-go").addEventListener("click", (ev) => {
      if (ev.currentTarget.classList.contains("disabled")) { ev.preventDefault(); toast("Save the app's ID and secret first.", true); }
    });
    card.addEventListener("change", (ev) => {
      const key = ev.target.dataset.p;
      if (!key || !cfg) return;
      const value = key === "enabled" ? ev.target.checked : key === "manual_count" ? Math.max(0, Math.floor(Number(ev.target.value) || 0)) : ev.target.value;
      save({ platforms: { [id]: { [key]: value } } });
    });
    return card;
  }));
}

function renderPlatforms() {
  for (const [id] of PLATFORMS) {
    const card = $(`#p-${id}`), c = cfg && cfg.platforms[id], p = status && status.platforms && status.platforms[id];
    if (c) {
      for (const input of card.querySelectorAll("[data-p]")) {
        if (input === document.activeElement) continue;
        if (input.type === "checkbox") input.checked = c[input.dataset.p];
        else input.value = c[input.dataset.p];
      }
      card.querySelector("[data-manual]").hidden = c.source !== "manual";
    }
    const state = card.querySelector(".state");
    card.querySelector(".count").textContent = fmtCount(p && p.count);
    if (!p) { state.textContent = ""; continue; }
    let text, cls = "";
    if (c && !c.enabled) text = "Not shown";
    else if (p.source === "manual") text = "Typed in by hand";
    else if (p.status === "ok") { text = `Updated ${p.last_ok ? ago(p.last_ok) : "just now"}`; cls = "ok"; }
    else if (p.status === "rate_limited") { text = "Rate limited: trying again later"; cls = "warn"; }
    else if (p.token && p.token.needs_reauth) { text = "Sign-in expired: send new tokens"; cls = "bad"; }
    else if (p.token && !p.token.access) { text = viaServer ? "Not connected yet: open Connect below" : "No token yet: see below"; cls = "warn"; }
    else { text = p.error || "Not fetched yet"; cls = "bad"; }
    state.textContent = text;
    state.className = `state ${cls}`;
  }
}

// ---- settings controls bound by data-cfg ----
function fillControls() {
  for (const input of $$("[data-cfg]")) {
    if (input === document.activeElement) continue;
    const v = cfg[input.dataset.cfg];
    if (input.type === "checkbox") input.checked = !!v;
    else if (input.id !== "timezone") input.value = v;
  }
  const zone = $("#timezone");
  if (zone !== document.activeElement && $("#tz-custom") !== document.activeElement) {
    const known = ZONES.some(([, tz]) => tz === cfg.timezone);
    zone.value = known ? cfg.timezone : "custom";
    $("#tz-custom-row").hidden = known;
    $("#tz-custom").value = cfg.timezone;
  }
}

document.addEventListener("change", (ev) => {
  const input = ev.target, key = input.dataset && input.dataset.cfg;
  if (!key || !cfg) return;
  if (key === "timezone") {
    if (input.value === "custom") { $("#tz-custom-row").hidden = false; $("#tz-custom").focus(); return; }
    $("#tz-custom-row").hidden = true;
    return save({ timezone: input.value });
  }
  if (input.type === "checkbox") return save({ [key]: input.checked });
  if (input.type === "number" || input.dataset.type === "number") {
    const n = Number(input.value), min = Number(input.min), max = Number(input.max);
    if (!Number.isInteger(n) || (input.min && n < min) || (input.max && n > max)) {
      toast(input.min && input.max ? `Enter a whole number from ${min} to ${max}` : `Enter a whole number${input.min ? ` of at least ${min}` : ""}`, true);
      input.value = cfg[key];
      return;
    }
    return save({ [key]: n });
  }
  if (input.type === "time" && !input.value) { input.value = cfg[key]; return; }
  save({ [key]: input.value });
});
$("#tz-custom").addEventListener("change", (ev) => { if (ev.target.value.trim()) save({ timezone: ev.target.value.trim() }); });

// ---- Show tab ----
function buildModes() {
  $("#modes").replaceChildren(...MODES.map(([id, name, sub]) => {
    const b = el("button", { type: "button" }, name, el("small", { textContent: sub }));
    b.dataset.mode = id;
    b.addEventListener("click", () => save({ mode: id }));
    return b;
  }));
}
$("#single").addEventListener("change", (ev) => save({ single: ev.target.value }));

const message = $("#message");
message.addEventListener("input", () => {
  const over = bytes(message.value) > MAX_TEXT_BYTES;
  $("#message-hint").textContent = over ? "That message is too long to store." : explain(message.value);
  $("#message-hint").className = "hint" + (over || shown(message.value).cut ? " warn" : "");
});
async function showText(text) {
  if (!cfg) return toast("The display's settings haven't loaded yet", true);
  cfg.mode = "text"; cfg.text = text;
  render();
  saving++;
  try {
    const r = await api("/api/show", { text, align: cfg.text_align });
    toast(r.queued ? "The display is offline: it will show this when it reconnects." : `Showing “${shown(text).text}”`);
    soon();
  } catch (e) { toast(e.message, true); saving--; await loadConfig(); return; }
  saving--;
}
$("#message-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!message.value.trim()) return toast("Type a message first. For an empty display, choose Blank.", true);
  if (bytes(message.value) > MAX_TEXT_BYTES) return toast("That message is too long to store.", true);
  showText(message.value.trim());
});

let removing = false;
function renderPresets() {
  const list = cfg.presets || [];
  $("#presets").className = "chips" + (removing ? " removing" : "");
  $("#presets").replaceChildren(...list.map((text, i) => {
    const b = el("button", { type: "button", textContent: text });
    if (removing) b.setAttribute("aria-label", `Remove ${text}`);
    b.addEventListener("click", () => {
      if (!removing) return showText(text);
      save({ presets: list.filter((_, j) => j !== i) }, `Removed “${text}”`);
    });
    return b;
  }));
  $("#presets-empty").hidden = list.length > 0;
  $("#preset-edit").hidden = !list.length;
  if (!list.length) removing = false;
  $("#preset-edit").setAttribute("aria-pressed", removing);
  $("#preset-edit").textContent = removing ? "Done" : "Remove…";
}
$("#preset-edit").addEventListener("click", () => { removing = !removing; renderPresets(); });
$("#preset-save").addEventListener("click", () => {
  const text = message.value.trim(), list = (cfg && cfg.presets) || [];
  if (!cfg) return toast("The display's settings haven't loaded yet", true);
  if (!text) return toast("Type the message above first.", true);
  if (bytes(text) > MAX_TEXT_BYTES) return toast("That message is too long to store.", true);
  if (list.includes(text)) return toast("That message is already saved.", true);
  if (list.length >= MAX_PRESETS) return toast(`There is room for ${MAX_PRESETS} saved messages. Remove one first.`, true);
  save({ presets: [...list, text] }, "Message saved");
});

// ---- countdown ----
const cdForm = $("#countdown-form");
function syncCountdownFields() {
  const once = cdForm.elements.repeat.value === "once";
  cdForm.querySelectorAll("[data-cd]").forEach((l) => { l.hidden = l.dataset.cd !== (once ? "once" : "daily"); });
}
cdForm.elements.repeat.addEventListener("change", syncCountdownFields);
function renderCountdown() {
  const f = cdForm.elements, at = cfg.countdown_at || "";
  if (cdForm.contains(document.activeElement)) return;
  f.label.value = cfg.countdown_label || "";
  f.done.value = cfg.countdown_done || "";
  if (at.includes("T")) { f.repeat.value = "once"; f.when.value = at; } else { f.repeat.value = "daily"; f.time.value = at; }
  syncCountdownFields();
}
cdForm.elements.label.addEventListener("input", () => {
  const e = explain(cdForm.elements.label.value);
  $("#countdown-hint").textContent = e || "Shows the label and the time left, such as CLOSE 25M or XMAS 12D. Choose Countdown above, or add it to the Mix.";
});
cdForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = cdForm.elements, once = f.repeat.value === "once";
  const at = once ? f.when.value.slice(0, 16) : f.time.value;
  if (!at) return toast(once ? "Choose the date and time." : "Choose the time.", true);
  save({ countdown_label: f.label.value.trim(), countdown_at: at, countdown_done: once ? f.done.value.trim() : "" }, "Countdown saved");
});
$("#countdown-go").addEventListener("click", () => {
  if (!cfg || !cfg.countdown_at) return toast("Save a time or date first.", true);
  save({ mode: "countdown" }, "Showing the countdown");
});

// ---- weather ----
const wForm = $("#weather-form");
function renderWeather() {
  const f = wForm.elements;
  if (!wForm.contains(document.activeElement)) {
    f.lat.value = cfg.weather_lat === "" ? "" : cfg.weather_lat;
    f.lon.value = cfg.weather_lon === "" ? "" : cfg.weather_lon;
    f.unit.value = cfg.weather_unit || "c";
  }
  const w = status && status.weather, line = $("#weather-state");
  if (cfg.weather_lat === "") line.textContent = "No location yet: the Weather mode stays blank.";
  else if (w && w.temp != null) line.textContent = `Now ${Math.round(w.temp)}°${(w.unit || "c").toUpperCase()}, updated ${w.last_ok ? ago(w.last_ok) : "just now"}.`;
  else if (w && !w.wanted) line.textContent = "The display fetches the weather while Weather is the mode or in the Mix.";
  else if (w && w.error) line.textContent = `Not fetched yet: ${w.error}`;
  else line.textContent = "";
}
$("#w-here").hidden = !(window.isSecureContext && navigator.geolocation);
$("#w-here").addEventListener("click", () => {
  navigator.geolocation.getCurrentPosition((pos) => {
    wForm.elements.lat.value = pos.coords.latitude.toFixed(4);
    wForm.elements.lon.value = pos.coords.longitude.toFixed(4);
    toast("Location filled in. Press Save.");
  }, (err) => toast(`Couldn't get the location: ${err.message}`, true), { timeout: 15000 });
});
wForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = wForm.elements, lat = Number(f.lat.value.replace(",", ".")), lon = Number(f.lon.value.replace(",", "."));
  if (!f.lat.value.trim() || !f.lon.value.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return toast("Enter a latitude from -90 to 90 and a longitude from -180 to 180.", true);
  }
  save({ weather_lat: lat, weather_lon: lon, weather_unit: f.unit.value }, "Weather location saved");
});
$("#w-off").addEventListener("click", () => save({ weather_lat: "", weather_lon: "" }, "Weather switched off"));

// ---- Words tab ----
function renderWords() {
  const list = cfg.words || [];
  $("#words").replaceChildren(...list.map((word, i) => {
    const s = shown(word), label = el("span", { className: "grow", textContent: word });
    if (s.cut || s.changed) label.append(el("small", { textContent: s.text ? `shows as ${s.text}` : "nothing to show" }));
    const remove = el("button", { type: "button", className: "icon remove", textContent: "×" });
    remove.setAttribute("aria-label", `Remove ${word}`);
    remove.addEventListener("click", () => save({ words: list.filter((_, j) => j !== i) }));
    return el("li", {}, label, remove);
  }));
  $("#words-count").textContent = list.length ? `${list.length} of ${MAX_WORDS} words` : "No words yet. With an empty list the display stays blank in Words.";
  $("#words-go").hidden = cfg.mode === "random";
}
const word = $("#word");
word.addEventListener("input", () => { $("#word-hint").textContent = explain(word.value); $("#word-hint").className = "hint" + (shown(word.value).cut ? " warn" : ""); });
$("#word-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!cfg) return toast("The display's settings haven't loaded yet", true);
  const text = word.value.trim(), list = cfg.words || [];
  if (!text) return;
  if (bytes(text) > MAX_WORD_BYTES) return toast("That is too long for the list. Keep each entry short.", true);
  if (!shown(text).text) return toast("None of these characters are on the flaps.", true);
  if (list.some((w) => fold(w).trim() === fold(text).trim())) return toast("That word is already in the list.", true);
  if (list.length >= MAX_WORDS) return toast(`The list holds ${MAX_WORDS} words. Remove one first.`, true);
  word.value = "";
  $("#word-hint").textContent = "";
  save({ words: [...list, text] });
  word.focus();
});
$("#words-go").addEventListener("click", () => save({ mode: "random" }, "Showing random words"));

// ---- Mix tab ----
function renderMix() {
  const list = cfg.mix || [];
  const put = (next) => save({ mix: next });
  $("#mix").replaceChildren(...list.map((item, i) => {
    const secs = el("input", { type: "number", inputMode: "numeric", min: 20, max: 3600, value: item.seconds });
    secs.setAttribute("aria-label", `Seconds for ${MIX_NAMES[item.kind]}`);
    secs.addEventListener("change", () => {
      const n = Number(secs.value);
      if (!Number.isInteger(n) || n < 20 || n > 3600) { toast("Enter a whole number from 20 to 3600", true); secs.value = item.seconds; return; }
      put(list.map((m, j) => (j === i ? { ...m, seconds: n } : m)));
    });
    const move = (label, text, to) => {
      const b = el("button", { type: "button", className: "icon", textContent: text, disabled: to < 0 || to >= list.length });
      b.setAttribute("aria-label", `Move ${MIX_NAMES[item.kind]} ${label}`);
      b.addEventListener("click", () => { const next = [...list]; [next[i], next[to]] = [next[to], next[i]]; put(next); });
      return b;
    };
    const remove = el("button", { type: "button", className: "icon remove", textContent: "×" });
    remove.setAttribute("aria-label", `Remove ${MIX_NAMES[item.kind]}`);
    remove.addEventListener("click", () => put(list.filter((_, j) => j !== i)));
    const name = el("span", { className: "grow", textContent: MIX_NAMES[item.kind] });
    if (item.kind === "followers") name.append(el("small", { textContent: "each platform" }));
    if (item.kind === "random" && !(cfg.words || []).length) name.append(el("small", { textContent: "skipped: no words" }));
    if (item.kind === "text" && !cfg.text) name.append(el("small", { textContent: "blank: no message set" }));
    return el("li", {}, name, el("span", { className: "unit" }, secs, "s"), move("up", "↑", i - 1), move("down", "↓", i + 1), remove);
  }));
  $("#mix-empty").hidden = list.length > 0;
  $("#mix-go").hidden = cfg.mode === "mix" || !list.length;
}
$("#mix-add").addEventListener("click", () => {
  if (!cfg) return toast("The display's settings haven't loaded yet", true);
  const list = cfg.mix || [];
  if (list.length >= MAX_MIX) return toast(`The mix holds ${MAX_MIX} entries. Remove one first.`, true);
  save({ mix: [...list, { kind: $("#mix-kind").value, seconds: 30 }] });
});
$("#mix-go").addEventListener("click", () => save({ mode: "mix" }, "Showing the mix"));

// ---- render everything that depends on the settings ----
function render() {
  if (!cfg) return;
  for (const b of $$("#modes button")) b.setAttribute("aria-pressed", b.dataset.mode === cfg.mode);
  $("#single-row").hidden = cfg.mode !== "single";
  if ($("#single") !== document.activeElement) $("#single").value = cfg.single;
  if (message !== document.activeElement && !message.value) message.value = cfg.text || "";
  fillControls();
  renderPresets();
  renderWords();
  renderMix();
  renderCountdown();
  renderWeather();
  renderPlatforms();
  if (!viaServer) {
    const f = $("#remote-form").elements;
    if (f.remote_url !== document.activeElement) f.remote_url.value = cfg.remote_url || "";
    $("#remote-state").textContent = cfg.remote_url ? (cfg.remote_token_set ? "A device token is stored." : "No device token stored yet: the display can't connect without one.") : "";
  }
}

// ---- tokens ----
const tokenForm = $("#token-form");
function syncTokenFields() {
  const platform = tokenForm.elements.platform.value;
  tokenForm.querySelectorAll("[data-for]").forEach((l) => { l.hidden = l.dataset.for !== platform; });
}
tokenForm.elements.platform.addEventListener("change", syncTokenFields);
syncTokenFields();
tokenForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = tokenForm.elements, body = { platform: f.platform.value };
  for (const name of ["access_token", "page_id", "refresh_token", "client_key", "client_secret"]) {
    if (f[name].value && !f[name].closest("label").hidden) body[name] = f[name].value.trim();
  }
  try {
    const r = await api("/api/tokens", body);
    toast(r.queued ? "The display is offline: the token waits here until it reconnects." : "Token sent. The display is fetching the count.");
    const platform = f.platform.value;
    tokenForm.reset();
    f.platform.value = platform;
    syncTokenFields();
    setTimeout(refresh, 4000);
  } catch (e) { toast(e.message, true); }
});
$("#clear-token").addEventListener("click", async () => {
  const platform = tokenForm.elements.platform.value;
  if (!confirm(`Delete the stored ${platform} tokens from the display?`)) return;
  try { await api("/api/tokens", { platform, clear: true }); toast("Tokens cleared"); soon(); } catch (e) { toast(e.message, true); }
});

$("#rehome").addEventListener("click", async () => {
  try { const r = await api("/api/rehome", {}); toast(r.queued ? "The display is offline: it will re-home when it reconnects." : "Re-homing all units"); }
  catch (e) { toast(e.message, true); }
});

// ---- on the display's own page only: admin key and the app server ----
const keyInput = $("#admin-key");
keyInput.value = store.get("adminKey");
keyInput.addEventListener("change", () => store.set("adminKey", keyInput.value));
$("#remote-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target.elements, patch = { remote_url: f.remote_url.value.trim() };
  if (f.remote_token.value) patch.remote_token = f.remote_token.value.trim();
  f.remote_token.value = "";
  save(patch, patch.remote_url ? "Saved. The display connects within a few seconds." : "App server switched off");
});

// ---- on the server only: its name, time zone, your account, people and the device token ----
let server = null, meInfo = null;
function renderAccount() {
  if (!meInfo) return;
  const a = $("#account-form").elements;
  if (document.activeElement !== a.username) a.username.value = meInfo.username;
  $("#account-env").hidden = !meInfo.env;
  for (const f of a) f.disabled = meInfo.env;
}
async function loadMe() {
  try { meInfo = await api("/api/me"); renderAccount(); } catch (e) { /* shown by refresh */ }
}
function renderServer() {
  if (!server) return;
  const s = $("#server-form").elements;
  if (document.activeElement !== s.display_name) s.display_name.value = server.display_name;
  if (document.activeElement !== s.time_zone) s.time_zone.value = server.time_zone;
  $("#dtoken-state").textContent = server.device_token_from_env ? "The device token is set by the DEVICE_TOKEN variable on the server."
    : server.device_token_set ? "A device token is set. Making a new one disconnects the display until you enter the new one there."
    : "No device token yet. Make one, then enter it on the display.";
  $("#dtoken-make").hidden = server.device_token_from_env;
}
async function loadServer() {
  try { server = await api("/api/server"); renderServer(); } catch (e) { /* shown by refresh */ }
}

async function loadUsers() {
  let list;
  try { list = (await api("/api/users")).users; } catch (e) { return; }
  $("#users").replaceChildren(...list.map((u) => {
    const name = el("span", { className: "grow", textContent: u.username });
    name.append(el("small", { textContent: u.env ? "admin · set by APP_PASSWORD" : u.you ? `${u.role} · you` : u.role }));
    const li = el("li", { className: "user" }, name);
    if (u.env) return li;
    const role = el("select", {}, el("option", { value: "staff", textContent: "Staff" }), el("option", { value: "admin", textContent: "Admin" }));
    role.value = u.role;
    role.setAttribute("aria-label", `Role of ${u.username}`);
    role.addEventListener("change", async () => {
      try { await api(`/api/users/${encodeURIComponent(u.username)}`, { role: role.value }); toast(`${u.username} is now ${role.value}`); }
      catch (e) { toast(e.message, true); }
      loadUsers();
      refresh();
    });
    const reset = el("button", { type: "button", className: "quiet", textContent: "New password" });
    const remove = el("button", { type: "button", className: "icon remove", textContent: "×" });
    remove.setAttribute("aria-label", `Remove ${u.username}`);
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove ${u.username}? They are signed out straight away.`)) return;
      try {
        const res = await fetch(`/api/users/${encodeURIComponent(u.username)}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        toast(`Removed ${u.username}`);
      } catch (e) { toast(e.message, true); }
      loadUsers();
    });
    const pw = el("form", { className: "inline user-pw", hidden: true },
      el("input", { type: "password", name: "password", minLength: 12, autocomplete: "new-password", placeholder: "New password, 12+ characters" }),
      el("button", { type: "submit", textContent: "Set" }));
    reset.addEventListener("click", () => { pw.hidden = !pw.hidden; if (!pw.hidden) pw.elements.password.focus(); });
    pw.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await api(`/api/users/${encodeURIComponent(u.username)}`, { password: pw.elements.password.value });
        toast(`New password set. ${u.username} has to sign in again.`);
        pw.hidden = true;
        pw.reset();
      } catch (e) { toast(e.message, true); }
    });
    if (u.you) li.append(role);  // your own password: under Your account; removing yourself would lock you out
    else li.append(role, reset, remove, pw);
    return li;
  }));
}
$("#user-add").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    await api("/api/users", { username: f.username.value.trim(), password: f.password.value, role: f.role.value });
    toast(`Added ${f.username.value.trim()}`);
    ev.target.reset();
    loadUsers();
  } catch (e) { toast(e.message, true); }
});
function nameBoard(s) {
  const name = (viaServer && s.server && s.server.name) || "Split-Flap";
  $(".board-top h1").textContent = name;
  document.title = name;
}
$("#server-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    server = await api("/api/server", { display_name: f.display_name.value.trim(), time_zone: f.time_zone.value.trim() });
    renderServer();
    toast("Saved");
    refresh();
  } catch (e) { toast(e.message, true); }
});
$("#account-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements, body = { username: f.username.value.trim(), current_password: f.current_password.value };
  if (f.new_password.value) body.new_password = f.new_password.value;
  try {
    meInfo = await api("/api/me", body);
    f.current_password.value = f.new_password.value = "";
    renderAccount();
    toast(meInfo.signed_out_others ? "Saved. Your other phones need to sign in again." : "Saved");
  } catch (e) { toast(e.message, true); }
});
$("#dtoken-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    const r = await api("/api/server/device-token", { current_password: f.current_password.value });
    f.current_password.value = "";
    $("#dtoken-value").value = r.device_token;
    $("#dtoken-new").hidden = false;
    loadServer();
  } catch (e) { toast(e.message, true); }
});
$("#dtoken-copy").addEventListener("click", async () => {
  const v = $("#dtoken-value");
  try { await navigator.clipboard.writeText(v.value); toast("Copied"); } catch (e) { v.select(); }
});
try { $("#tz-list").replaceChildren(...Intl.supportedValuesOf("timeZone").map((z) => el("option", { value: z }))); } catch (e) { /* older browser: type it */ }

// ---- tabs ----
function openTab(name) {
  if (!$(`#tab-${name}`)) name = "now";
  for (const b of $$(".tabs button")) {
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  for (const s of $$("main > section")) s.hidden = s.id !== `tab-${name}`;
  store.set("tab", name);
  scrollTo(0, 0);
}
for (const b of $$(".tabs button")) b.addEventListener("click", () => openTab(b.dataset.tab));

// ---- loading and refreshing ----
async function loadConfig() {
  try {
    const c = await api("/api/config");
    if (saving) return;  // an edit of ours is on its way; this answer may predate it
    cfg = c;
    render();
    if (!viaServer && !c.admin_key_set) toast("No admin key is set on the display. Hold BOOT while powering it on to set one.", true);
  } catch (e) {
    if (!cfg && !(viaServer && status && !status.device.known)) toast(`Couldn't load the settings: ${e.message}`, true);
  }
}

let failures = 0;
async function refresh() {
  try {
    status = await api("/api/status");
    failures = 0;
    const wasServer = viaServer;
    viaServer = status.via === "server";
    if (!status.device) status.device = { online: true, known: true };
    $("#local-only").hidden = viaServer;
    $("#logout").hidden = !viaServer;
    $("#server-only").hidden = !viaServer;
    const role = viaServer && status.me ? status.me.role : "admin";
    if (document.body.dataset.role !== role) {
      document.body.dataset.role = role;
      if (role === "staff" && ["followers"].includes(store.get("tab"))) openTab("now");
      if (viaServer && role === "admin") { loadServer(); loadUsers(); loadIntegrations(); }
    }
    nameBoard(status);
    renderStatus();
    if (!cfg || wasServer !== viaServer) { loadConfig(); renderIntegrations(); }
    if (viaServer && !meInfo) loadMe();
  } catch (e) {
    if (++failures >= 2) {
      $("#link").textContent = viaServer ? "Can't reach the server" : "Can't reach the display";
      $("#link").className = "link off";
    }
  }
}
// After a change: look again once the display has had time to act on it.
function soon() { setTimeout(refresh, 700); setTimeout(refresh, 2500); }

let ticks = 0;
setInterval(() => {
  if (document.hidden) return;
  refresh();
  // Pick up changes made on another phone, unless something here is being edited.
  if (++ticks % 8 === 0 && !saving && !["INPUT", "SELECT"].includes(document.activeElement.tagName)) loadConfig();
}, 4000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); loadConfig(); } });

$("#timezone").replaceChildren(...ZONES.map(([name, tz]) => el("option", { value: tz, textContent: name })), el("option", { value: "custom", textContent: "Other…" }));
buildModes();
buildPlatforms();
openTab(store.get("tab") || "now");
{
  const back = new URLSearchParams(location.search).get("connected");
  if (back) {
    history.replaceState(null, "", "/");
    openTab("followers");
    api("/api/integrations").then((info) => {
      integrations = info;
      renderIntegrations();
      const l = info[back] && info[back].last, card = $(`#p-${back}`);
      if (card) { card.querySelector("details.connect").open = true; card.scrollIntoView({ block: "start" }); }
      if (l) toast(l.ok ? `Connected ${l.account || back}` : `Didn’t connect: ${l.message}`, !l.ok);
    }).catch(() => {});
  }
}
refresh();

// Home-screen install and a cached shell. Needs HTTPS, so it is active on the relay server only.
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
