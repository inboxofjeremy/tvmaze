// build.js — FINAL FIX: adds TMDB discovery that can add missing TVMaze shows
import fs from "fs";
import path from "path";

// ========== CONFIG ==========
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc"; // unchanged
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const META_DIR = path.join(OUT_DIR, "meta", "series");

const TMDB_DISCOVER_PAGES = 3; // how many TMDB pages to try (increase if you want more coverage)
const TMDB_CONCURRENCY = 5; // concurrency for TMDB -> tvmaze lookups

// ========== HELPERS ==========
async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.warn(`fetch failed ${res.status} ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`fetch error ${url} -> ${err && err.message}`);
    return null;
  }
}

function cleanHTML(s) {
  return s ? s.replace(/<[^>]+>/g, "").trim() : "";
}

function pickDate(ep) {
  if (ep?.airdate && ep.airdate !== "0000-00-00") return ep.airdate;
  if (ep?.airstamp) return ep.airstamp.slice(0, 10);
  return null;
}

// ========== FILTERS (UNCHANGED) ==========
function isSports(show) {
  if (!show) return false;
  const t = (show.type || "").toLowerCase();
  if (t === "sports") return true;
  const genres = show.genres || [];
  for (const g of genres) if ((g || "").toLowerCase() === "sports") return true;
  return false;
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

function isForeign(show) {
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const c = (show?.network?.country?.code || show?.webChannel?.country?.code || "").toUpperCase();
  if (!c) return true;
  return !allowed.includes(c);
}

function filterLastNDays(episodes, n, todayStr) {
  const today = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - (n - 1));
  return episodes.filter((ep) => {
    const dateStr = pickDate(ep);
    if (!dateStr) return false;
    if (dateStr > todayStr) return false;
    const d = new Date(dateStr);
    return d >= start && d <= today;
  });
}

// ========== DEDUPE ==========
function dedupeEpisodes(episodes) {
  const map = new Map();
  for (const ep of episodes || []) {
    if (!ep?.id) continue;
    map.set(ep.id, ep);
  }
  return [...map.values()];
}

// ========== TMDB -> TVMAZE HELPERS ==========
async function tmdbGetExternal(imdbOrTmdbId, byTmdbId = true) {
  try {
    if (!imdbOrTmdbId) return null;
    if (byTmdbId) {
      const ext = await fetchJSON(`https://api.themoviedb.org/3/tv/${imdbOrTmdbId}/external_ids?api_key=${TMDB_API_KEY}`);
      return ext || null;
    } else {
      return null;
    }
  } catch {
    return null;
  }
}

async function tmdbDiscoverRecentTV(pages = TMDB_DISCOVER_PAGES) {
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&language=en-US&sort_by=first_air_date.desc&page=${page}`;
    const json = await fetchJSON(url);
    if (!json?.results?.length) break;
    results.push(...json.results);
    if (page >= json.total_pages) break;
  }
  return results;
}

async function lookupTvmazeByImdb(imdbId) {
  if (!imdbId) return null;
  const tm = await fetchJSON(`https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`);
  return tm || null;
}

async function fetchTvmazeShowWithEpisodes(tvmazeId) {
  if (!tvmazeId) return null;
  const detail = await fetchJSON(`https://api.tvmaze.com/shows/${tvmazeId}?embed=episodes`);
  return detail || null;
}

// ========== CONCURRENCY MAP ==========
// Small concurrency utility used for TMDB discovery -> tvmaze work
async function pMap(list, fn, concurrency = TMDB_CONCURRENCY) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array(concurrency).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= list.length) break;
      try { out[idx] = await fn(list[idx], idx); } catch (e) { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

// ========== MAIN BUILD ==========
async function build() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const showMap = new Map(); // tvmazeId -> { show, episodes[] }

  // 1) Schedule endpoints (US / web / full)
  console.log("Step 1: collect schedule endpoints");
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${day}`;

    const endpoints = [
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`,
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`,
      `https://api.tvmaze.com/schedule/full?date=${dateStr}`,
    ];

    for (const url of endpoints) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;
      for (const ep of list) {
        const show = ep?.show || ep?._embedded?.show;
        if (!show?.id) continue;

        if (isNews(show)) { /* skip */ continue; }
        if (isSports(show)) { /* skip */ continue; }
        if (isForeign(show)) { /* skip */ continue; }

        if (!showMap.has(show.id)) showMap.set(show.id, { show, episodes: [ep] });
        else showMap.get(show.id).episodes.push(ep);
      }
    }
  }
  console.log("After schedules, showMap size:", showMap.size);

  // 2) Generic schedule list + episodesbydate fallback for shows not yet in showMap
  console.log("Step 2: generic schedule + per-show episodesbydate fallback");
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${day}`;

    const generic = await fetchJSON(`https://api.tvmaze.com/schedule?date=${dateStr}`);
    if (!Array.isArray(generic)) continue;

    for (const ep of generic) {
      const show = ep?.show;
      if (!show?.id) continue;
      if (showMap.has(show.id)) continue;

      if (isNews(show)) continue;
      if (isSports(show)) continue;
      if (isForeign(show)) continue;

      // attempt episodesbydate for this show + date
      const eps = await fetchJSON(`https://api.tvmaze.com/shows/${show.id}/episodesbydate?date=${dateStr}`);
      if (Array.isArray(eps) && eps.length) {
        showMap.set(show.id, { show, episodes: eps });
        console.log(`episodesbydate added show ${show.id} (${show.name}) for ${dateStr}`);
      }
    }
  }
  console.log("After episodesbydate fallback, showMap size:", showMap.size);

  // 3) TMDB DISCOVERY PASS: discover recent TMDB TV shows and add them if TVMaze has recent episodes
  // This is the step that adds shows that never appeared in schedule endpoints
  console.log("Step 3: TMDB discovery pass to add missing shows");
  const tmdbList = await tmdbDiscoverRecentTV(TMDB_DISCOVER_PAGES);
  console.log("TMDB discover returned", (tmdbList && tmdbList.length) || 0, "items");

  // Map over tmdbList with concurrency to resolve to TVMaze shows and add if recent episodes exist
  await pMap(tmdbList, async (tm) => {
    if (!tm?.id) return null;
    // get external ids
    const ext = await tmdbGetExternal(tm.id, true);
    const imdb = ext?.imdb_id;
    if (!imdb) return null;

    // lookup tvmaze by imdb
    const tmmaze = await lookupTvmazeByImdb(imdb);
    if (!tmmaze?.id) return null;

    // if already present, skip (we will enrich later)
    if (showMap.has(tmmaze.id)) return null;

    // fetch full show with episodes
    const detail = await fetchTvmazeShowWithEpisodes(tmmaze.id);
    if (!detail?.id) return null;

    // apply filters: news/sports/foreign same as main flow
    if (isNews(detail)) return null;
    if (isSports(detail)) return null;
    if (isForeign(detail)) return null;

    // find if it has episodes in last 10 days (use pickDate logic)
    const eps = detail._embedded?.episodes || [];
    const recent = filterLastNDays(eps, 10, todayStr);
    if (!recent.length) {
      // not a recent-show; skip
      return null;
    }

    // add to showMap with full episodes
    showMap.set(detail.id, { show: detail, episodes: eps });
    console.log(`TMDB fallback added show ${detail.id} (${detail.name}) via TMDB id ${tm.id}`);
    return null;
  }, TMDB_CONCURRENCY);

  console.log("After TMDB discovery pass, showMap size:", showMap.size);

  // 4) ENRICH existing shows with embedded episodes via TMDB/IMDB if needed
  // (for shows that were previously added but do not have embedded episodes)
  console.log("Step 4: Enrich shows that lack embedded episodes using IMDB->TVMaze lookup");
  const existingKeys = [...showMap.keys()];
  for (const sid of existingKeys) {
    const entry = showMap.get(sid);
    const show = entry.show;
    const hasEmbed = show?._embedded?.episodes && Array.isArray(show._embedded.episodes) && show._embedded.episodes.length;
    if (hasEmbed) {
      entry.episodes = dedupeEpisodes([ ...(entry.episodes || []), ...show._embedded.episodes ]);
      continue;
    }
    const imdb = show?.externals?.imdb;
    if (!imdb) continue;
    const detail = await tmdbToTvmazeByImdb(imdb);
    if (detail && detail._embedded?.episodes?.length) {
      entry.episodes = dedupeEpisodes([ ...(entry.episodes || []), ...detail._embedded.episodes ]);
      entry.show = detail;
      console.log(`Enriched show ${sid} (${detail.name}) with embedded episodes via IMDB fallback`);
    }
  }

  // 5) Finalize catalog entries: include only shows with episodes in last 10 days
  console.log("Step 5: finalizing catalog entries");
  const catalog = [];
  for (const [id, entry] of showMap.entries()) {
    const episodes = entry.episodes || [];
    const recent = filterLastNDays(episodes, 10, todayStr);
    if (!recent.length) {
      // skip shows without any recent episodes
      continue;
    }

    // dedupe episodes and sort
    const deduped = dedupeEpisodes(episodes);
    deduped.sort((a,b) => {
      const da = pickDate(a) || "";
      const db = pickDate(b) || "";
      return da.localeCompare(db);
    });
    entry.episodes = deduped;

    const latestDate = recent
      .map(e => pickDate(e))
      .filter(Boolean)
      .sort()
      .reverse()[0];

    catalog.push({
      id: `tvmaze:${entry.show.id}`,
      type: "series",
      name: entry.show.name,
      description: cleanHTML(entry.show.summary),
      poster: entry.show.image?.medium || entry.show.image?.original || null,
      background: entry.show.image?.original || null,
      latestDate,
    });
  }

  catalog.sort((a,b) => (b.latestDate || "").localeCompare(a.latestDate || ""));

  // 6) write catalog and per-show metas
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"), JSON.stringify({ metas: catalog, ts: Date.now() }, null, 2));
  console.log("Wrote catalog with", catalog.length, "entries");

  fs.mkdirSync(META_DIR, { recursive: true });
  for (const [id, entry] of showMap.entries()) {
    const show = entry.show;
    const unique = dedupeEpisodes(entry.episodes || []);
    unique.sort((a,b) => (pickDate(a)||"").localeCompare(pickDate(b)||""));
    const videos = unique.map(ep => ({
      id: `tvmaze:${ep.id}`,
      title: ep.name || `Episode ${ep.number}`,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate || null,
      overview: cleanHTML(ep.summary),
    }));
    const metaObj = {
      meta: {
        id: `tvmaze:${show.id}`,
        type: "series",
        name: show.name,
        description: cleanHTML(show.summary),
        poster: show.image?.original || show.image?.medium || null,
        background: show.image?.original || null,
        videos,
      }
    };
    fs.writeFileSync(path.join(META_DIR, `tvmaze:${show.id}.json`), JSON.stringify(metaObj, null, 2));
  }

  console.log("Build complete — catalog count:", catalog.length);
}

// run
build().catch(err => {
  console.error("Build failed:", err && (err.stack || err));
  process.exit(1);
});
