// build.js — FINAL, STABLE, PRODUCTION
// TVMaze weekly catalog with TMDB safety fallback
// Filters intentionally unchanged

import fs from "fs";
import path from "path";

// =======================
// CONFIG
// =======================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const DAYS_BACK = 10;

const ROOT = "./";
const CATALOG_DIR = path.join(ROOT, "catalog", "series");
const META_DIR = path.join(ROOT, "meta", "series");

// =======================
// HELPERS
// =======================
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function cleanHTML(str) {
  return str ? str.replace(/<[^>]+>/g, "").trim() : "";
}

function pickDate(ep) {
  if (ep?.airdate && ep.airdate !== "0000-00-00") return ep.airdate;
  if (ep?.airstamp) return ep.airstamp.slice(0, 10);
  return null;
}

function todayString() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// =======================
// FILTERS (LOCKED)
// =======================
function isSports(show) {
  const t = (show.type || "").toLowerCase();
  if (t === "sports") return true;
  for (const g of show.genres || []) {
    if ((g || "").toLowerCase() === "sports") return true;
  }
  return false;
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
    null;
  if (!c) return true;
  return !allowed.includes(c.toUpperCase());
}

function filterLastNDays(episodes, n, todayStr) {
  const end = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - (n - 1));

  return episodes.filter((ep) => {
    const d = pickDate(ep);
    if (!d || d > todayStr) return false;
    const dt = new Date(d);
    return dt >= start && dt <= end;
  });
}

// =======================
// DEDUPE
// =======================
function dedupeEpisodes(list) {
  const m = new Map();
  for (const ep of list || []) {
    if (ep?.id) m.set(ep.id, ep);
  }
  return [...m.values()];
}

// =======================
// TMDB → TVMAZE LOOKUP
// =======================
async function tmdbDiscoverFallback(dateStr) {
  const url =
    `https://api.themoviedb.org/3/discover/tv?` +
    `api_key=${TMDB_API_KEY}` +
    `&language=en-US` +
    `&with_original_language=en` +
    `&sort_by=first_air_date.desc` +
    `&first_air_date.gte=${dateStr}` +
    `&first_air_date.lte=${dateStr}`;

  const j = await fetchJSON(url);
  if (!j?.results) return [];

  return j.results;
}

async function imdbToTvmaze(imdbId) {
  if (!imdbId) return null;
  const lookup = await fetchJSON(
    `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`
  );
  if (!lookup?.id) return null;

  return await fetchJSON(
    `https://api.tvmaze.com/shows/${lookup.id}?embed=episodes`
  );
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const todayStr = todayString();
  const showMap = new Map();

  // -------------------------------------------------
  // 1) TVMAZE SCHEDULE ENDPOINTS (PRIMARY)
  // -------------------------------------------------
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const urls = [
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`,
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`,
      `https://api.tvmaze.com/schedule/full?date=${dateStr}`,
    ];

    for (const url of urls) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;

      for (const ep of list) {
        const show = ep?.show || ep?._embedded?.show;
        if (!show?.id) continue;

        if (isNews(show)) continue;
        if (isSports(show)) continue;
        if (isForeign(show)) continue;

        const cur = showMap.get(show.id);
        if (!cur) showMap.set(show.id, { show, episodes: [ep] });
        else cur.episodes.push(ep);
      }
    }
  }

  // -------------------------------------------------
  // 2) EPISODESBYDATE FALLBACK (KNOWN SHOWS)
  // -------------------------------------------------
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const sched = await fetchJSON(
      `https://api.tvmaze.com/schedule?date=${dateStr}`
    );
    if (!Array.isArray(sched)) continue;

    for (const ep of sched) {
      const show = ep?.show;
      if (!show?.id || showMap.has(show.id)) continue;

      if (isNews(show)) continue;
      if (isSports(show)) continue;
      if (isForeign(show)) continue;

      const eps = await fetchJSON(
        `https://api.tvmaze.com/shows/${show.id}/episodesbydate?date=${dateStr}`
      );

      if (Array.isArray(eps) && eps.length) {
        showMap.set(show.id, { show, episodes: eps });
      }
    }
  }

  // -------------------------------------------------
  // 3) TMDB DISCOVERY FALLBACK (MISSING SHOWS ONLY)
  // -------------------------------------------------
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const candidates = await tmdbDiscoverFallback(dateStr);

    for (const item of candidates) {
      const imdb = item?.external_ids?.imdb_id || item?.imdb_id;
      if (!imdb) continue;

      const detail = await imdbToTvmaze(imdb);
      if (!detail?.id || showMap.has(detail.id)) continue;

      if (isNews(detail)) continue;
      if (isSports(detail)) continue;
      if (isForeign(detail)) continue;

      const eps = detail._embedded?.episodes || [];
      const recent = filterLastNDays(eps, DAYS_BACK, todayStr);
      if (!recent.length) continue;

      showMap.set(detail.id, {
        show: detail,
        episodes: recent,
      });
    }
  }

  // -------------------------------------------------
  // 4) FINALIZE
  // -------------------------------------------------
  const catalog = [];

  for (const { show, episodes } of showMap.values()) {
    const unique = dedupeEpisodes(episodes);
    const recent = filterLastNDays(unique, DAYS_BACK, todayStr);
    if (!recent.length) continue;

    const latestDate = recent
      .map(pickDate)
      .filter(Boolean)
      .sort()
      .reverse()[0];

    catalog.push({
      id: `tvmaze:${show.id}`,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.medium || show.image?.original || null,
      background: show.image?.original || null,
      latestDate,
    });
  }

  catalog.sort((a, b) => b.latestDate.localeCompare(a.latestDate));

  // -------------------------------------------------
  // 5) WRITE FILES
  // -------------------------------------------------
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas: catalog, ts: Date.now() }, null, 2)
  );

  fs.mkdirSync(META_DIR, { recursive: true });

  for (const { show, episodes } of showMap.values()) {
    const vids = dedupeEpisodes(episodes).map((ep) => ({
      id: `tvmaze:${ep.id}`,
      title: ep.name,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate || null,
      overview: cleanHTML(ep.summary),
    }));

    fs.writeFileSync(
      path.join(META_DIR, `tvmaze:${show.id}.json`),
      JSON.stringify(
        {
          meta: {
            id: `tvmaze:${show.id}`,
            type: "series",
            name: show.name,
            description: cleanHTML(show.summary),
            poster: show.image?.original || show.image?.medium || null,
            background: show.image?.original || null,
            videos: vids,
          },
        },
        null,
        2
      )
    );
  }

  console.log("Build complete — shows:", catalog.length);
}

build().catch(console.error);
