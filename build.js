// build.js (ES module)
// Final production-ready build script
import fs from "fs";
import path from "path";

// =======================
// CONFIG
// =======================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc"; // your key
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const META_DIR = path.join(OUT_DIR, "meta", "series");

// =======================
// HELPERS
// =======================
async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("fetchJSON error:", url, err && err.message);
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

// =======================
// FILTERS (A + C)
// =======================
// A + C: block if show.type === "Sports" OR show.genres includes "Sports"
function isSports(show) {
  if (!show) return false;
  const t = (show.type || "").toLowerCase();
  if (t === "sports") return true;
  const genres = show.genres || [];
  for (const g of genres) {
    if ((g || "").toLowerCase() === "sports") return true;
  }
  return false;
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

function isForeign(show) {
  // Allowed countries: US, GB, CA, AU, IE, NZ
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const c =
    (show?.network?.country?.code || show?.webChannel?.country?.code || "").toUpperCase() || null;
  if (!c) return true; // conservative: if no country, treat as foreign
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

// =======================
// TMDB -> TVMaze fallback via IMDB
// =======================
async function tmdbToTvmazeByImdb(imdbId) {
  if (!imdbId) return null;
  // lookup tvmaze by imdb id
  const lookup = await fetchJSON(
    `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`
  );
  if (!lookup?.id) return null;
  const detail = await fetchJSON(`https://api.tvmaze.com/shows/${lookup.id}?embed=episodes`);
  return detail || null;
}

// =======================
// DEDUP HELPERS
// =======================
function dedupeEpisodes(episodes) {
  const map = new Map();
  for (const ep of episodes || []) {
    if (!ep || !ep.id) continue;
    map.set(ep.id, ep);
  }
  return Array.from(map.values());
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const showMap = new Map(); // tvmaze showId -> { show, episodes: [] }

  // --- 1) Collect from TVMaze schedule endpoints (10 days)
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

        // filters: news, sports (A+C), foreign
        if (isNews(show)) continue;
        if (isSports(show)) continue;
        if (isForeign(show)) continue;

        const cur = showMap.get(show.id);
        if (!cur) showMap.set(show.id, { show, episodes: [ep] });
        else cur.episodes.push(ep);
      }
    }
  }

  // --- 2) episodesByDate fallback for shows missing from the schedule collection
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${day}`;

    const genericSchedule = await fetchJSON(`https://api.tvmaze.com/schedule?date=${dateStr}`);
    if (!Array.isArray(genericSchedule)) continue;

    for (const ep of genericSchedule) {
      const show = ep?.show;
      if (!show?.id) continue;
      if (showMap.has(show.id)) continue;

      // quick filters before making more calls
      if (isNews(show)) continue;
      if (isSports(show)) continue;
      if (isForeign(show)) continue;

      // fetch episodes by date for this show
      const eps = await fetchJSON(
        `https://api.tvmaze.com/shows/${show.id}/episodesbydate?date=${dateStr}`
      );
      if (Array.isArray(eps) && eps.length > 0) {
        showMap.set(show.id, { show, episodes: eps });
      }
    }
  }

  // --- 3) TMDB/IMDB -> TVMaze fallback for shows needing more detail
  // iterate over a snapshot of keys
  const keys = Array.from(showMap.keys());
  for (const showId of keys) {
    const entry = showMap.get(showId);
    if (!entry) continue;

    // if show already has embedded episodes, skip heavy lookup
    const hasEmbed = entry.show && entry.show._embedded && Array.isArray(entry.show._embedded.episodes) && entry.show._embedded.episodes.length;
    if (hasEmbed) {
      // merge embedded episodes into entry.episodes to normalize
      entry.episodes = [...(entry.episodes || []), ...(entry.show._embedded.episodes || [])];
      entry.episodes = dedupeEpisodes(entry.episodes);
      continue;
    }

    const imdb = entry.show?.externals?.imdb;
    if (!imdb) continue;

    const detail = await tmdbToTvmazeByImdb(imdb);
    if (detail && detail._embedded?.episodes?.length) {
      // merge episodes and update show detail
      entry.episodes = [...(entry.episodes || []), ...detail._embedded.episodes];
      entry.episodes = dedupeEpisodes(entry.episodes);
      entry.show = detail;
    }
  }

  // --- 4) Finalize catalog entries (only shows with episodes in last 10 days)
  const catalog = [];
  for (const [id, entry] of showMap.entries()) {
    const episodes = entry.episodes || [];
    const recent = filterLastNDays(episodes, 10, todayStr);
    if (!recent.length) continue;

    // dedupe episodes once more and sort by airdate
    const deduped = dedupeEpisodes(episodes);
    entry.episodes = deduped;

    const latestDate = recent
      .map((e) => pickDate(e))
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

  // sort newest first
  catalog.sort((a, b) => (b.latestDate || "").localeCompare(a.latestDate || ""));

  // --- 5) Write catalog and per-show meta files (one meta file per show)
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas: catalog, ts: Date.now() }, null, 2)
  );

  fs.mkdirSync(META_DIR, { recursive: true });

  for (const [id, entry] of showMap.entries()) {
    const show = entry.show;
    // dedupe episodes by id before making the meta
    const unique = dedupeEpisodes(entry.episodes || []);

    // sort episodes by airstamp/date ascending (optional)
    unique.sort((a, b) => {
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

  console.log("Build complete — catalog count:", catalog.length);
}

// run
build().catch((err) => {
  console.error("Build failed:", err && (err.stack || err));
  process.exit(1);
});