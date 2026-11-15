"use strict";
// Demo of the phone app with a virtual split-flap display, all in the browser: no display, no
// server. Loaded before app.js by the demo page only (tools/make_demo.py builds it); it answers the
// app's /api/ calls itself and flips the board flap by flap, like the real drums.
// It follows the display's rules (firmware/master/src/logic and display/layout) closely, but it is a
// simulation: the real display is what counts.
(() => {
  const FLAPS = [" ", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZÃÇÉ0123456789Á.", "", "", ""];
  const LOGO = { tiktok: "", instagram: "", facebook: "" };
  const PLATFORMS = ["tiktok", "instagram", "facebook"];
  const MONTHS = {
    en: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
    pt: ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"],
  };
  const STAFF_KEYS = ["mode", "single", "text", "text_align", "words", "random_seconds", "presets", "mix",
    "countdown_label", "countdown_at", "countdown_done"];
  const STORE = "splitflap-demo-v1";

  const fresh = () => ({
    config: {
      platforms: {
        tiktok: { enabled: true, source: "manual", manual_count: 18400 },
        instagram: { enabled: true, source: "manual", manual_count: 5231 },
        facebook: { enabled: true, source: "manual", manual_count: 912 },
      },
      poll_minutes: 15, cycle_seconds: 20, units: 9, label_width: 2, label_logos: true, speed: 10,
      mode: "mix", single: "instagram", text: "OPEN TIL 9", text_align: "center",
      quiet_start: "00:00", quiet_end: "00:00", timezone: "UTC0", celebrate: false, milestone_step: 1000,
      random_seconds: 20,
      mix: [{ kind: "followers", seconds: 20 }, { kind: "random", seconds: 20 }, { kind: "clock", seconds: 20 },
        { kind: "weather", seconds: 20 }, { kind: "countdown", seconds: 20 }],
      clock_24h: true, date_lang: "en",
      words: ["TACOS", "BURRITO", "NACHOS", "CHURROS", "SALSA"], presets: ["OPEN", "SOLD OUT", "BACK SOON"],
      weather_lat: 38.72, weather_lon: -9.14, weather_unit: "c",
      countdown_label: "CLOSE", countdown_at: "21:00", countdown_done: "",
      remote_url: "", remote_token_set: true, admin_key_set: true,
    },
    role: "admin",
    name: "Split-Flap demo",
    users: [{ username: "demo", role: "admin", created: 0 }, { username: "maria", role: "staff", created: 0 }],
  });
  let db;
  try { db = JSON.parse(localStorage.getItem(STORE)) || fresh(); } catch (e) { db = fresh(); }
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(db)); } catch (e) { /* private mode */ } };
  const cfg = () => db.config;
  const started = Date.now();

  // ---- what the display would show (logic/rotation.cpp + display/layout.cpp, simplified) ----
  const fold = (text) => [...text.toUpperCase()].map((ch) => {
    if (FLAPS.includes(ch)) return ch;
    const base = ch.normalize("NFD")[0];
    return FLAPS.includes(base) ? base : " ";
  }).join("");
  const units = () => cfg().units;
  const blank = () => " ".repeat(units());
  function place(text, align = "center") {
    const t = fold(text).trim().slice(0, units()), pad = units() - t.length;
    if (align === "left") return t + " ".repeat(pad);
    if (align === "right") return " ".repeat(pad) + t;
    return " ".repeat(Math.floor(pad / 2)) + t + " ".repeat(pad - Math.floor(pad / 2));
  }
  const firstThatFits = (forms) => { const f = forms.find((x) => x && fold(x).length <= units()); return f ? place(f) : blank(); };
  function followers(p) {
    const c = cfg(), width = c.label_width;
    const label = c.label_logos ? LOGO[p] + " ".repeat(width - 1) : { tiktok: "TT", instagram: "IG", facebook: "FB" }[p].slice(0, width);
    const n = String(c.platforms[p].manual_count);
    const room = units() - width;
    return (label + (n.length <= room ? n.padStart(room) : abbreviate(Number(n), room))).slice(0, units());
  }
  function abbreviate(n, width) {
    for (const [div, suffix] of [[1e3, "K"], [1e6, "M"], [1e9, "B"]]) {
      for (const decimals of [2, 1, 0]) {
        const v = Math.floor((n / div) * 10 ** decimals) / 10 ** decimals;
        const s = v.toFixed(decimals) + suffix;
        if (v >= 1 && s.length <= width) return s.padStart(width);
      }
    }
    return " ".repeat(width);
  }
  function clock() {
    const d = new Date(), mm = String(d.getMinutes()).padStart(2, "0");
    if (cfg().clock_24h) { const hh = String(d.getHours()).padStart(2, "0"); return firstThatFits([`${hh} ${mm}`, `${hh}${mm}`]); }
    const h = d.getHours() % 12 || 12;
    return firstThatFits([`${h} ${mm} ${d.getHours() < 12 ? "AM" : "PM"}`, `${h} ${mm}`, `${h}${mm}`]);
  }
  function date() {
    const d = new Date(), m = MONTHS[cfg().date_lang][d.getMonth()];
    return firstThatFits([`${d.getDate()} ${m}`, `${d.getDate()}${m}`, m]);
  }
  // A pretend reading that drifts a little during the day.
  function reading() {
    const c = 17 + 3 * Math.sin(Date.now() / 3.6e6);
    return { c, f: c * 9 / 5 + 32, code: 3 };
  }
  function weather() {
    const c = cfg();
    if (c.weather_lat === "") return blank();
    const r = reading(), deg = Math.round(c.weather_unit === "f" ? r.f : r.c), n = `${Math.abs(deg)}${c.weather_unit.toUpperCase()}`;
    if (deg < 0) return firstThatFits([`${c.date_lang === "pt" ? "MENOS" : "MINUS"} ${n}`, `M${n}`]);
    return firstThatFits([`${c.date_lang === "pt" ? "NUVEM" : "CLOUD"} ${n}`, n]);
  }
  function countdown() {
    const c = cfg(), at = c.countdown_at;
    if (!at) return blank();
    let target;
    if (at.includes("T")) target = new Date(at);
    else {
      const [h, m] = at.split(":").map(Number);
      target = new Date();
      target.setHours(h, m, 0, 0);
      if (target <= new Date()) target.setDate(target.getDate() + 1);
    }
    const left = Math.floor((target - Date.now()) / 1000);
    if (left <= 0) return place(c.countdown_done || c.countdown_label);
    let full, brief;
    if (left >= 2 * 86400) { const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600); full = `${d}D${h ? `${h}H` : ""}`; brief = `${d}D`; }
    else if (left >= 3600) { const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60); full = `${h}H${String(m).padStart(2, "0")}M`; brief = `${h}H`; }
    else full = brief = `${Math.ceil(left / 60)}M`;
    const label = fold(c.countdown_label).trim();
    return firstThatFits([label && `${label} ${full}`, label && `${label} ${brief}`, full, brief]);
  }

  const show = { mode: null, started: 0, index: -1, word: "", platform: -1, left: 0, bag: [] };
  const enabled = () => PLATFORMS.filter((p) => cfg().platforms[p].enabled);
  function nextPlatform() {
    const on = enabled();
    if (!on.length) return null;
    for (let step = 1; step <= 3; step++) {
      const p = PLATFORMS[(show.platform + step + 3) % 3];
      if (on.includes(p)) { show.platform = PLATFORMS.indexOf(p); return p; }
    }
    return null;
  }
  function nextWord() {  // shuffle bag: every word once before any repeats
    const words = cfg().words;
    if (!words.length) { show.word = ""; return false; }
    show.bag = show.bag.filter((w) => words.includes(w));
    if (!show.bag.length) show.bag = [...words].sort(() => Math.random() - 0.5).filter((w, i, a) => a.length < 2 || i || w !== show.word);
    show.word = show.bag.shift();
    return true;
  }
  function frame() {
    const c = cfg(), now = Date.now() / 1000, mode = c.mode;
    let fresh = false;
    if (show.mode !== mode) { Object.assign(show, { mode, started: now, index: -1, left: 0 }); fresh = true; }
    const elapsed = now - show.started;
    if (mode === "off") return blank();
    if (mode === "text") return place(c.text, c.text_align);
    if (mode === "clock") return clock();
    if (mode === "date") return date();
    if (mode === "weather") return weather();
    if (mode === "countdown") return countdown();
    if (mode === "single") return followers(c.single);
    if (mode === "cycle") {
      if (fresh || elapsed >= c.cycle_seconds || !enabled().includes(PLATFORMS[show.platform])) {
        show.started = now;
        if (nextPlatform() === null) return blank();
      }
      return followers(PLATFORMS[show.platform]);
    }
    if (mode === "random") {
      if (fresh || elapsed >= c.random_seconds || !c.words.includes(show.word)) { show.started = now; nextWord(); }
      return show.word ? place(show.word, c.text_align) : blank();
    }
    const mix = c.mix;
    if (!mix.length) return blank();
    let item = mix[show.index];
    if (!item || elapsed >= item.seconds) {
      if (item && item.kind === "followers" && show.left > 0 && nextPlatform()) { show.left--; show.started = now; }
      else {
        let found = false;
        for (let i = 0; i < mix.length; i++) {
          show.index = (show.index + 1) % mix.length;
          item = mix[show.index];
          const usable = { followers: enabled().length > 0, random: c.words.length > 0 }[item.kind] ?? true;
          if (usable) { found = true; break; }
        }
        if (!found) return blank();
        show.started = now;
        if (item.kind === "followers") { show.left = enabled().length - 1; nextPlatform(); }
        else if (item.kind === "random") nextWord();
      }
    }
    const kind = mix[show.index].kind;
    return {
      followers: () => followers(PLATFORMS[show.platform]), random: () => place(show.word, c.text_align),
      text: () => place(c.text, c.text_align), clock, date, weather, countdown,
    }[kind]();
  }

  // ---- the API the app talks to ----
  function status() {
    const c = cfg(), now = Math.floor(Date.now() / 1000), platforms = {};
    for (const p of PLATFORMS) {
      platforms[p] = { enabled: c.platforms[p].enabled, source: c.platforms[p].source, count: c.platforms[p].manual_count,
        last_ok: now, status: "ok", error: "manual", failures: 0, next_fetch_in_s: 0,
        token: { access: "", refresh: "", expires_at: 0, refresh_expires_at: 0, needs_reauth: false } };
    }
    const r = reading();
    return {
      via: "server", me: { username: db.role === "admin" ? "demo" : "maria", role: db.role },
      server: { name: db.name, time_zone: "" },
      device: { online: true, last_seen: now, pending: 0, errors: [], known: true },
      uptime_s: Math.floor((Date.now() - started) / 1000) + 3600, reset_reason: "power_on", free_heap: 176000, time: now,
      wifi: { ssid: "demo-hotspot", rssi: -58, ip: "10.0.0.2" },
      display: { frame: frame(), quiet: false, busy: false },
      bus: { units: c.units, present: Array(c.units).fill(true), error: "" }, platforms,
      weather: { wanted: true, temp: c.weather_lat === "" ? null : Math.round((c.weather_unit === "f" ? r.f : r.c) * 10) / 10,
        code: r.code, unit: c.weather_unit, last_ok: now - 120, error: "" },
    };
  }

  function merge(patch) {
    const c = cfg();
    for (const [k, v] of Object.entries(patch)) {
      if (k === "platforms") for (const [p, f] of Object.entries(v)) Object.assign(c.platforms[p], f);
      else if (k === "mode" && v.includes(":")) [c.mode, c.single] = v.split(":");
      else c[k] = v;
    }
    if (patch.mix || patch.mode) show.mode = null;  // restart the rotation, like the display
  }
  function check(patch) {
    if (db.role !== "admin") {
      const extra = Object.keys(patch).find((k) => !STAFF_KEYS.includes(k));
      if (extra) return `Only an admin can change ${extra}.`;
    }
    for (const k of ["random_seconds", "cycle_seconds"]) {
      if (k in patch && (!Number.isInteger(patch[k]) || patch[k] < 20 || patch[k] > 3600)) return `${k} must be an integer 20..3600`;
    }
    if ("units" in patch && (!Number.isInteger(patch.units) || patch.units < 1 || patch.units > 16)) return "units must be an integer 1..16";
    if ("speed" in patch && (!Number.isInteger(patch.speed) || patch.speed < 1 || patch.speed > 12)) return "speed must be an integer 1..12";
    if ((patch.words || []).length > 100) return "words can hold at most 100 entries";
    if ((patch.mix || []).length > 8) return "mix can hold at most 8 entries";
    if ("weather_lat" in patch && patch.weather_lat !== "" && Math.abs(patch.weather_lat) > 90) return "weather_lat must be -90..90";
    return "";
  }
  const deny = () => db.role !== "admin" && [403, { error: "Only an admin can do this." }];

  function handle(method, path, body) {
    const c = cfg();
    if (path === "/api/status") return [200, status()];
    if (path === "/api/config") {
      if (method === "GET") return [200, JSON.parse(JSON.stringify(c))];
      const err = check(body);
      if (err) return [db.role !== "admin" && err.startsWith("Only") ? 403 : 400, { error: err }];
      merge(body); persist();
      return [200, { ok: true, queued: false }];
    }
    if (path === "/api/show") { merge({ mode: "text", text: body.text || "", ...(body.align ? { text_align: body.align } : {}) }); persist(); return [200, { ok: true, queued: false }]; }
    if (path === "/api/rehome") { if (deny()) return deny(); rehome(); return [200, { ok: true, queued: false }]; }
    if (path === "/api/tokens") return deny() || [400, { error: "The demo has no real accounts to connect." }];
    if (path === "/api/me") {
      const me = { username: db.role === "admin" ? "demo" : "maria", role: db.role, env: false, created: 0, you: true };
      if (method === "GET") return [200, me];
      return [400, { error: "Passwords can't be changed in the demo." }];
    }
    if (path === "/api/server") {
      if (deny()) return deny();
      if (method === "POST" && typeof body.display_name === "string") { db.name = body.display_name.trim() || "Split-Flap demo"; persist(); }
      return [200, { display_name: db.name, time_zone: "", device_token_from_env: false, device_token_set: true }];
    }
    if (path === "/api/server/device-token") return deny() || [200, { device_token: [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("") }];
    if (path === "/api/users") {
      if (deny()) return deny();
      if (method === "POST") {
        if (db.users.some((u) => u.username.toLowerCase() === String(body.username).toLowerCase())) return [409, { error: "That username is taken." }];
        if (!body.password || body.password.length < 12) return [400, { error: "The password needs at least 12 characters." }];
        db.users.push({ username: body.username, role: body.role || "staff", created: Date.now() / 1000 }); persist();
        return [200, {}];
      }
      const me = db.role === "admin" ? "demo" : "maria";
      return [200, { users: db.users.map((u) => ({ ...u, env: false, you: u.username === me })) }];
    }
    if (path.startsWith("/api/users/")) {
      if (deny()) return deny();
      const name = decodeURIComponent(path.slice(11)), user = db.users.find((u) => u.username.toLowerCase() === name.toLowerCase());
      if (!user) return [404, { error: "No such user." }];
      const admins = db.users.filter((u) => u.role === "admin").length;
      if (method === "DELETE") {
        if (user.role === "admin" && admins <= 1) return [400, { error: "There must be at least one admin." }];
        db.users = db.users.filter((u) => u !== user); persist(); return [200, { ok: true }];
      }
      if (body.role && user.role === "admin" && body.role !== "admin" && admins <= 1) return [400, { error: "There must be at least one admin." }];
      if (body.role) user.role = body.role;
      persist();
      return [200, user];
    }
    if (path === "/api/integrations") {
      if (deny()) return deny();
      if (method === "POST") return [400, { error: "The demo has no real accounts to connect." }];
      const out = {};
      for (const p of PLATFORMS) out[p] = { app_id: "", secret_set: false, redirect_uri: `https://your-server/oauth/${p}/callback`, last: null };
      return [200, out];
    }
    return [404, { error: "not found" }];
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, opts);
    let body = {};
    try { body = opts.body ? JSON.parse(opts.body) : {}; } catch (e) { /* not JSON */ }
    const [code, data] = handle((opts.method || "GET").toUpperCase(), url.pathname, body);
    await new Promise((r) => setTimeout(r, 80));
    return new Response(JSON.stringify(data), { status: code, headers: { "Content-Type": "application/json" } });
  };

  // ---- the board: every flap steps through the drum to its new character ----
  let cur = [], target = [], spans = [], draw = null, timer = null;
  function stepMs() { return 60000 / (cfg().speed * FLAPS.length); }  // one drum turn = 45 flaps
  function tick() {
    let moving = false;
    for (let i = 0; i < spans.length; i++) {
      if (cur[i] === target[i]) continue;
      cur[i] = (cur[i] + 1) % FLAPS.length;
      draw(spans[i], FLAPS[cur[i]]);
      spans[i].classList.remove("flip");
      void spans[i].offsetWidth;  // restart the animation
      spans[i].classList.add("flip");
      moving = true;
    }
    timer = moving ? setTimeout(tick, stepMs()) : null;
  }
  function flipTo(chars, drawFlap) {
    draw = drawFlap;
    const board = document.getElementById("frame");
    if (spans.length !== chars.length) {
      spans = chars.map(() => document.createElement("span"));
      board.replaceChildren(...spans);
      cur = chars.map(() => 0);
      spans.forEach((s) => draw(s, " "));
    }
    target = chars.map((ch) => Math.max(0, FLAPS.indexOf(ch)));
    if (!timer) tick();
  }
  function rehome() {  // every drum turns on to the blank flap, then on to its character again
    const keep = [...target];
    target = target.map(() => 0);
    if (!timer) tick();
    const wait = () => (timer ? setTimeout(wait, 200) : (target = keep, tick()));
    setTimeout(wait, 200);
  }
  window.splitflapDemo = { flipTo };

  // ---- the demo's own bits: a banner, the admin/staff switch, and what can't work here ----
  const style = document.createElement("style");
  style.textContent = `
    .demo-bar { background: #e9b61a; color: #1b1d1f; font-size: .875rem; padding: 8px 16px; display: flex; flex-wrap: wrap;
      gap: 6px 12px; align-items: center; justify-content: center; text-align: center; }
    .demo-bar b { font-weight: 800; }
    .demo-bar button { min-height: 32px; padding: 2px 10px; font-size: .8125rem; background: #1b1d1f; color: #fff; border-color: #1b1d1f; }
    .demo-bar button[aria-pressed="true"] { background: #fff; color: #1b1d1f; }
    .flaps span.flip { animation: demo-flip ${Math.round(60000 / (10 * 45))}ms ease-in; }
    @keyframes demo-flip { 0% { transform: perspective(200px) rotateX(-70deg); filter: brightness(.6); } 100% { transform: none; } }
    @media (prefers-reduced-motion: reduce) { .flaps span.flip { animation: none; } }`;
  document.head.append(style);
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("div");
    bar.className = "demo-bar";
    bar.innerHTML = `<span><b>Demo</b>: a virtual display in your browser. Nothing here controls a real one.</span>
      <span>View as <button type="button" data-role="admin">Admin</button> <button type="button" data-role="staff">Staff</button>
      <button type="button" data-reset>Start over</button></span>`;
    document.body.prepend(bar);
    const mark = () => bar.querySelectorAll("[data-role]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.role === db.role));
    mark();
    bar.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      if (b.dataset.reset !== undefined) { try { localStorage.removeItem(STORE); } catch (e) { /* private mode */ } location.reload(); return; }
      db.role = b.dataset.role; persist(); location.reload();
    });
  });
  // Connect would leave for the platform's login page, and signing out has nowhere to go.
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("a.connect-go")) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      window.toast("In the demo, Connect stops here. On your server it opens the platform's login page.");
    }
  }, true);
  document.addEventListener("submit", (ev) => {
    if (ev.target.id === "logout") { ev.preventDefault(); ev.stopImmediatePropagation(); window.toast("There's nothing to sign out of in the demo."); }
  }, true);
})();
