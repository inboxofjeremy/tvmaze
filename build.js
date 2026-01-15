/**
 * build.js — Stremio static catalog (IMDb-based)
 * GitHub Pages ONLY
 */

import fs from "fs";
import path from "path";

// =======================
// CONFIG
// =======================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");

// =======================
// TVMAZE RATE LIMIT
// =======================
const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

async function fetchJSON(url) {
  try {
    if (url.includes("api.tvmaze.com")) {
      const wait = Math.max(0, TVMAZE_DELAY_MS - (Date.now() - lastTvmazeCall));
      if (wait) await new Promise(r => setTimeout(r, wait));
      lastTvmazeCall = Date.now();
    }

    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// =======================
// HELPERS
// =======================
const cleanHTML = s => s ? s.replace(/<[^>]+>/g, "").trim() : "";

function pickDate(ep) {
  return ep?.airdate && ep.airdate !== "0000-00-00"
    ? ep.airdate
    : ep?.airstamp?.slice(0, 10) || null;
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
// FILTERS (UNCHANGED)
// =======================
function isSports(show) {
  return (show.type || "").toLowerCase() === "sports" ||
    (show.genres || []).some(g => g?.toLowerCase() === "sports");
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

function isForeign(show) {
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const c =
    show?.network?.country?.code ||
    show?.webChannel?.country?.code ||
    "";
  return c && !allowed.includes(c.toUpperCase());
}

function isBlockedWebChannel(show) {
  return (show?.webChannel?.name || "").toLowerCase() === "iqiyi";
}

function isYouTubeShow(show) {
  return (show?.webChannel?.name || "").toLowerCase().includes("youtube");
}

// =======================
// TMDB ENRICHMENT
// =======================
async function tmdbFromImdb(imdb) {
  const url = `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const data = await fetchJSON(url);
  return data?.tv_results?.[0] || null;
}

async function tmdbExternalIds(tmdbId) {
  const url = `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
  return await fetchJSON(url);
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const showMap = new Map();

  // --- DISCOVER SCHEDULE (last 10 days)
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    for (const url of [
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`,
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`,
      `https://api.tvmaze.com/schedule/full?date=${dateStr}`
    ]) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;

      for (const ep of list) {
        const show = ep.show || ep._embedded?.show;
        if (!show?.id) continue;

        if (
          isNews(show) ||
          isSports(show) ||
          isForeign(show) ||
          isBlockedWebChannel(show) ||
          isYouTubeShow(show)
        ) continue;

        if (!showMap.has(show.id)) {
          showMap.set(show.id, { show, episodes: [ep] });
        } else {
          showMap.get(show.id).episodes.push(ep);
        }
      }
    }
  }

  // =======================
  // ENRICH IMDb IDs
  // =======================
  for (const entry of showMap.values()) {
    let imdb = entry.show.externals?.imdb;

    // Try TMDB via IMDb
    if (!imdb) continue;

    const tmdb = await tmdbFromImdb(imdb);
    if (tmdb?.id) {
      const ext = await tmdbExternalIds(tmdb.id);
      if (ext?.imdb_id) imdb = ext.imdb_id;
    }

    entry.imdb = imdb;
  }

  // =======================
  // BUILD STREMIO CATALOG
  // =======================
  const metas = [];

  for (const entry of showMap.values()) {
    if (!entry.imdb) continue;

    const recent = filterLastNDays(entry.episodes, 10, todayStr);
    if (!recent.length) continue;

    const videos = recent.map(ep => ({
      id: `${entry.imdb}:${ep.season}:${ep.number}`,
      title: ep.name,
      season: ep.season,
      episode: ep.number,
      released: pickDate(ep),
      overview: cleanHTML(ep.summary)
    }));

    metas.push({
      id: entry.imdb,
      type: "series",
      name: entry.show.name,
      description: cleanHTML(entry.show.summary),
      poster: entry.show.image?.original || entry.show.image?.medium || null,
      background: entry.show.image?.original || null,
      videos
    });

    console.log("Added:", entry.show.name, entry.imdb);
  }

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length, "shows");
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
