/**
 * build.js — PATCHED VERSION
 * ✔ Keeps original logic
 * ✔ Keeps TMDB fallback
 * ✔ Fixes "No meta found"
 */

import fs from "fs";
import path from "path";

// =======================
// CONFIG
// =======================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const META_DIR = path.join(OUT_DIR, "meta", "series");

// =======================
// TVMAZE RATE LIMIT FIX
// =======================
const TVMAZE_DELAY_MS = 150;
const TVMAZE_MAX_RETRIES = 5;
let lastTvmazeCall = 0;

async function fetchJSON(url, retries = TVMAZE_MAX_RETRIES) {
  try {
    if (url.includes("api.tvmaze.com")) {
      const now = Date.now();
      const wait = Math.max(0, TVMAZE_DELAY_MS - (now - lastTvmazeCall));
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastTvmazeCall = Date.now();
    }

    const res = await fetch(url, { cache: "no-store" });

    if (res.status === 429) {
      if (retries <= 0) return null;
      const backoff = (TVMAZE_MAX_RETRIES - retries + 1) * 500;
      await new Promise(r => setTimeout(r, backoff));
      return fetchJSON(url, retries - 1);
    }

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// =======================
// HELPERS
// =======================
function cleanHTML(s) {
  return s ? s.replace(/<[^>]+>/g, "").trim() : "";
}

function pickDate(ep) {
  if (ep?.airdate && ep.airdate !== "0000-00-00") return ep.airdate;
  if (ep?.airstamp) return ep.airstamp.slice(0, 10);
  return null;
}

// =======================
// FILTERS (UNCHANGED)
// =======================
function isSports(show) {
  const t = (show.type || "").toLowerCase();
  if (t === "sports") return true;
  return (show.genres || []).some(g => (g || "").toLowerCase() === "sports");
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

function isForeign(show) {
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const c =
    (show?.network?.country?.code ||
     show?.webChannel?.country?.code ||
     "").toUpperCase();

  if (!c) return false;
  return !allowed.includes(c);
}

function isBlockedWebChannel(show) {
  const name = (show?.webChannel?.name || "").toLowerCase();
  return name === "iqiyi";
}

function isYouTubeShow(show) {
  const name = (show?.webChannel?.name || "").toLowerCase();
  return name.includes("youtube");
}

function filterLastNDays(episodes, n, todayStr) {
  const today = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - (n - 1));
  return episodes.filter(ep => {
    const d = pickDate(ep);
    if (!d || d > todayStr) return false;
    const dt = new Date(d);
    return dt >= start && dt <= today;
  });
}

// =======================
// TMDB → TVMAZE (UNCHANGED)
// =======================
async function tmdbToTvmazeByImdb(imdbId) {
  if (!imdbId) return null;
  const lookup = await fetchJSON(
    `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`
  );
  if (!lookup?.id) return null;
  return fetchJSON(`https://api.tvmaze.com/shows/${lookup.id}?embed=episodes`);
}

// =======================
// DEDUPE
// =======================
function dedupeEpisodes(list) {
  const m = new Map();
  for (const e of list || []) if (e?.id) m.set(e.id, e);
  return [...m.values()];
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const showMap = new Map();

  // --- ORIGINAL DISCOVERY LOGIC (UNCHANGED)
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    for (const url of [
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`,
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`,
      `https://api.tvmaze.com/schedule/full?date=${dateStr}`,
    ]) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;

      for (const ep of list) {
        const show = ep?.show || ep?._embedded?.show;
        if (!show?.id) continue;

        if (
          isNews(show) ||
          isSports(show) ||
          isForeign(show) ||
          isBlockedWebChannel(show) ||
          isYouTubeShow(show)
        ) continue;

        const cur = showMap.get(show.id);
        if (!cur) showMap.set(show.id, { show, episodes: [ep] });
        else cur.episodes.push(ep);
      }
    }
  }

  // --- TMDB ENRICHMENT (UNCHANGED)
  for (const entry of showMap.values()) {
    const imdb = entry.show?.externals?.imdb;
    if (!imdb) continue;
    if (entry.show._embedded?.episodes?.length) continue;

    const detail = await tmdbToTvmazeByImdb(imdb);
    if (detail?._embedded?.episodes?.length) {
      entry.show = detail;
      entry.episodes.push(...detail._embedded.episodes);
    }
  }

  // =======================
  // BUILD CATALOG
  // =======================
  const catalog = [];

  for (const entry of showMap.values()) {
    entry.episodes = dedupeEpisodes(entry.episodes);
    const recent = filterLastNDays(entry.episodes, 10, todayStr);
    if (!recent.length) continue;

    catalog.push({
      id: `tvmaze:${entry.show.id}`,
      type: "series",
      name: entry.show.name,
      description: cleanHTML(entry.show.summary),
      poster: entry.show.image?.medium || null,
      background: entry.show.image?.original || null,
    });
  }

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas: catalog }, null, 2)
  );

  // =======================
  // WRITE META (FIXED)
  // =======================
for (const entry of showMap.values()) {
  const videos = dedupeEpisodes(entry.episodes)
    .sort((a, b) => (pickDate(a) || "").localeCompare(pickDate(b) || ""))
    .map(ep => ({
      id: `tvmaze:${ep.id}`,
      title: ep.name,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate,
      overview: cleanHTML(ep.summary),
    }));

  fs.writeFileSync(
    path.join(META_DIR, `tvmaze_${entry.show.id}.json`), // ✅ FIX
    JSON.stringify(
      {
        meta: {
          id: `tvmaze:${entry.show.id}`,
          type: "series",
          name: entry.show.name,
          description: cleanHTML(entry.show.summary),
          poster: entry.show.image?.original || entry.show.image?.medium || null,
          background: entry.show.image?.original || null,
          videos,
        },
      },
      null,
      2
    )
  );



  }

  console.log("Build complete:", catalog.length, "shows");
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
