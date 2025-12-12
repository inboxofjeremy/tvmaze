// build.js — Final: schedule + episodesbydate + updates + TMDB discovery (adds missing shows)
// ESM / Node 20 compatible

import fs from "fs";
import path from "path";

const TMDB_API_KEY = process.env.TMDB_API_KEY || "944017b839d3c040bdd2574083e4c1bc";
const DAYS_BACK = 10;

const CATALOG_DIR = "./catalog/series";
const META_DIR = "./meta/series";

function log(...args) { console.log(...args); }

// =========================
// Helpers
// =========================
async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      log(`fetch failed ${res.status} ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    log(`fetch error ${url} -> ${err && err.message}`);
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function dedupeEpisodes(list) {
  const map = new Map();
  for (const ep of list || []) {
    if (!ep?.id) continue;
    map.set(ep.id, ep);
  }
  return Array.from(map.values());
}

// =========================
// Filters (kept as you asked — Option B streaming fix included)
// =========================
function isSports(show) {
  if (!show) return false;
  const t = (show.type || "").toLowerCase();
  if (t === "sports") return true;
  const genres = show.genres || [];
  return genres.some((g) => (g || "").toLowerCase() === "sports");
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

// Option B: allow English-language streaming originals when no network country present
function isForeign(show) {
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const netCountry = show?.network?.country?.code || null;
  const webCountry = show?.webChannel?.country?.code || null;

  if (netCountry) {
    return !allowed.includes((netCountry || "").toUpperCase());
  }

  // If there is a webChannel and the show's language is English, treat as NOT foreign (allow)
  if (show?.webChannel && (show.language || "").toLowerCase() === "english") {
    return false;
  }

  // conservative: if no country info and not an English webChannel, treat as foreign
  return true;
}

function isBlocked(show) {
  return isSports(show) || isNews(show) || isForeign(show);
}

// =========================
// Date helpers
// =========================
function todayStrUTC() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function inLastNDays(dateStr, n, todayStr) {
  if (!dateStr) return false;
  if (dateStr > todayStr) return false;
  const d = new Date(dateStr);
  const today = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - (n - 1));
  return d >= start && d <= today;
}

// =========================
// TVMaze -> primary discovery: schedule endpoints (US/web/full)
// =========================
async function collectFromSchedules(showMap, todayStr) {
  log("Collecting schedules...");
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

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

        // apply filters now
        if (isBlocked(show)) continue;

        const cur = showMap.get(show.id);
        if (!cur) showMap.set(show.id, { show, episodes: [ep] });
        else cur.episodes.push(ep);
      }
    }
  }
  log("After schedules, showMap size:", showMap.size);
}

// =========================
// episodesbydate fallback for shows discovered in generic schedule listing
// (this handles cases where schedule feed omitted episodes)
// =========================
async function episodesByDateFallback(showMap, todayStr) {
  log("Running episodesbydate fallback for shows in generic schedule...");
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const generic = await fetchJSON(`https://api.tvmaze.com/schedule?date=${dateStr}`);
    if (!Array.isArray(generic)) continue;

    for (const ep of generic) {
      const show = ep?.show;
      if (!show?.id) continue;
      if (showMap.has(show.id)) continue; // already collected

      if (isBlocked(show)) continue;

      const eps = await fetchJSON(`https://api.tvmaze.com/shows/${show.id}/episodesbydate?date=${dateStr}`);
      if (Array.isArray(eps) && eps.length) {
        showMap.set(show.id, { show, episodes: eps });
        log(`episodesbydate added show ${show.id} (${show.name}) for ${dateStr}`);
      }
    }
  }
  log("After episodesbydate fallback, showMap size:", showMap.size);
}

// =========================
// TVMaze updates/shows fallback — catches streaming/batch-drop shows
// (adds shows that changed recently)
 // docs: https://www.tvmaze.com/api#show-updates
// =========================
async function tvmazeUpdatesFallback(showMap, todayStr) {
  log("Running TVMaze updates/shows fallback...");
  // /updates/shows returns an object where keys are show ids and values are timestamps
  const updates = await fetchJSON(`https://api.tvmaze.com/updates/shows`);
  if (!updates || typeof updates !== "object") {
    log("No updates result or invalid");
    return;
  }

  // iterate keys (they can be many). We'll only examine those that changed in last DAYS_BACK.
  const cutoff = new Date(todayStr);
  cutoff.setDate(cutoff.getDate() - (DAYS_BACK - 1));
  let added = 0;

  for (const k of Object.keys(updates)) {
    try {
      const ts = new Date(updates[k] * 1000); // updates returns unix timestamp
      if (ts < cutoff) continue; // not recent

      const tvmazeId = Number(k);
      if (showMap.has(tvmazeId)) continue;

      const detail = await fetchJSON(`https://api.tvmaze.com/shows/${tvmazeId}?embed=episodes`);
      if (!detail?.id) continue;
      if (isBlocked(detail)) continue;

      // only include if it actually has episodes in last DAYS_BACK window
      const eps = detail._embedded?.episodes || [];
      const recent = eps.filter((e) => {
        const pd = pickDate(e);
        return inLastNDays(pd, DAYS_BACK, todayStr);
      });
      if (!recent.length) continue;

      showMap.set(detail.id, { show: detail, episodes: recent });
      added++;
      log(`updates added show ${detail.id} (${detail.name})`);
    } catch (err) {
      // keep going on errors
    }
  }

  log(`TVMaze updates pass added ${added} shows; showMap size: ${showMap.size}`);
}

// =========================
// TMDB discovery pass that can ADD shows not previously known
// - For each recent-date (day) we call TMDB discover for TV (first_air_date on that day)
// - For each TMDB show, get external_ids -> imdb -> tvmaze lookup -> fetch episodes
// - Add only if TVMaze shows have episodes in the last DAYS_BACK days and pass filters
// =========================
async function tmdbDiscoveryAddMissing(showMap, todayStr) {
  log("Running TMDB discovery pass to add missing shows...");

  // We'll iterate through the DAYS_BACK window and use TMDB discover with first_air_date filter for each day.
  // Note: TMDB discover returns page results; we will request first page only to avoid long runs — you can increase pages if desired.
  let foundAdded = 0;

  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    // Discover TV shows with first_air_date on dateStr
    const discoverUrl =
      `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}` +
      `&language=en-US&sort_by=first_air_date.desc&first_air_date.gte=${dateStr}&first_air_date.lte=${dateStr}&page=1`;

    const discover = await fetchJSON(discoverUrl);
    const results = discover?.results || [];
    if (!results.length) continue;

    for (const tm of results) {
      try {
        // get external ids to retrieve imdb
        const ext = await fetchJSON(`https://api.themoviedb.org/3/tv/${tm.id}/external_ids?api_key=${TMDB_API_KEY}`);
        const imdb = ext?.imdb_id;
        if (!imdb) continue;

        // lookup tvmaze by imdb
        const tmLookup = await fetchJSON(`https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdb)}`);
        if (!tmLookup?.id) continue;

        if (showMap.has(tmLookup.id)) continue; // already present

        // fetch show with episodes
        const detail = await fetchJSON(`https://api.tvmaze.com/shows/${tmLookup.id}?embed=episodes`);
        if (!detail?.id) continue;

        if (isBlocked(detail)) {
          log(`TMDB->TVMaze skipped blocked show ${detail.id} (${detail.name})`);
          continue;
        }

        // only add if TVMaze episodes include at least one in last DAYS_BACK days (uses pickDate)
        const eps = detail._embedded?.episodes || [];
        const recent = eps.filter((e) => {
          const pd = pickDate(e);
          return inLastNDays(pd, DAYS_BACK, todayStr);
        });
        if (!recent.length) {
          continue;
        }

        showMap.set(detail.id, { show: detail, episodes: eps });
        foundAdded++;
        log(`TMDB discovery added show ${detail.id} (${detail.name}) via TMDB id ${tm.id}`);
      } catch (err) {
        // continue on error
      }
    }
  }

  log(`TMDB discovery pass added ${foundAdded} shows`);
}

// =========================
// Enrich known shows that lack embedded episodes via TMDB/IMDB lookup
// (this provides episodes detail for shows already in showMap but with no full episodes)
// =========================
async function enrichExistingShows(showMap, todayStr) {
  log("Enriching shows that lack embedded episodes...");
  const keys = Array.from(showMap.keys());
  for (const sid of keys) {
    const entry = showMap.get(sid);
    if (!entry) continue;
    const show = entry.show;

    // if we already have embedded episodes, normalize them into entry.episodes
    if (show._embedded?.episodes && Array.isArray(show._embedded.episodes) && show._embedded.episodes.length) {
      entry.episodes = dedupeEpisodes([...(entry.episodes || []), ...show._embedded.episodes]);
      continue;
    }

    // attempt TMDB/IMDB->TVMaze enrichment if externals.imdb exists
    const imdb = show?.externals?.imdb;
    if (!imdb) continue;

    try {
      const lookup = await fetchJSON(`https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdb)}`);
      if (!lookup?.id) continue;
      const detail = await fetchJSON(`https://api.tvmaze.com/shows/${lookup.id}?embed=episodes`);
      if (detail?.id && detail._embedded?.episodes?.length) {
        entry.episodes = dedupeEpisodes([...(entry.episodes || []), ...detail._embedded.episodes]);
        entry.show = detail;
        log(`Enriched show ${detail.id} (${detail.name}) via IMDB->TVMaze`);
      }
    } catch (err) {
      // ignore and continue
    }
  }
}

// =========================
// Finalize catalog + write files (apply filters AGAIN before writing)
// =========================
function finalizeAndWrite(showMap, todayStr) {
  log("Finalizing catalog and writing files...");
  ensureDir(CATALOG_DIR);
  ensureDir(META_DIR);

  const catalog = [];

  for (const [id, entry] of showMap.entries()) {
    const show = entry.show;
    const episodes = dedupeEpisodes(entry.episodes || []);

    // Re-apply filters on the final show object (defensive)
    if (isBlocked(show)) continue;

    // Only include shows that actually have an episode in the last DAYS_BACK days
    const recent = episodes.filter((ep) => inLastNDays(pickDate(ep), DAYS_BACK, todayStr));
    if (!recent.length) continue;

    const latestDate = recent
      .map((e) => pickDate(e))
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

    // build meta videos (sorted)
    const unique = episodes.slice().sort((a, b) => {
      const da = pickDate(a) || "";
      const db = pickDate(b) || "";
      return da.localeCompare(db);
    });

    const videos = unique.map((ep) => ({
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
      },
    };

    const filename = `tvmaze:${show.id}.json`;
    fs.writeFileSync(path.join(META_DIR, filename), JSON.stringify(metaObj, null, 2));
  }

  // sort by latestDate desc
  catalog.sort((a, b) => (b.latestDate || "").localeCompare(a.latestDate || ""));

  fs.writeFileSync(path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"), JSON.stringify({ metas: catalog, ts: Date.now() }, null, 2));
  log("Wrote catalog with", catalog.length, "entries");
}

// =========================
// Main
// =========================
export default async function build() {
  const todayStr = todayStrUTC();
  const showMap = new Map();

  // 1) schedules
  await collectFromSchedules(showMap, todayStr);

  // 2) episodesByDate fallback for shows discovered in generic schedule
  await episodesByDateFallback(showMap, todayStr);

  // 3) TVMaze updates (catch streaming/batch drops) — adds shows if they have recent episodes
  await tvmazeUpdatesFallback(showMap, todayStr);

  // 4) TMDB discovery pass — can add shows not previously known (adds only if TVMaze confirms recent episodes)
  await tmdbDiscoveryAddMissing(showMap, todayStr);

  // 5) enrich existing shows with embedded episodes via IMDB->TVMaze lookup if needed
  await enrichExistingShows(showMap, todayStr);

  // 6) finalize and write files (filters applied again)
  finalizeAndWrite(showMap, todayStr);

  log("Build complete");
}

// If run directly (node build.js)
if (typeof process !== "undefined" && process.argv && process.argv[1] && process.argv[1].endsWith("build.js")) {
  build().catch((err) => {
    console.error("Build failed:", err && (err.stack || err));
    process.exit(1);
  });
}
