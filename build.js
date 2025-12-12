// build.js
import fs from "fs";
import path from "path";

// ===== CONFIG =====
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc"; // your key
const OUT_DIR = "./";
const CATALOG_PATH = path.join(OUT_DIR, "catalog", "series");
const META_DIR = path.join(OUT_DIR, "meta", "series");

// ===== HELPERS =====
async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
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

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

function isSportsShow(show) {
  return (show.type || "").toLowerCase() === "sports";
}

function looksLikeSports(show) {
  const name = (show.name || "").toLowerCase();
  const network = (show.network?.name || "").toLowerCase();
  const sportsKeywords = ["football","soccer","basketball","nfl","nhl","mlb","ufc"];
  const sportsNetworks = ["espn","nbc sports","fox sports","sky sports","abc"];
  return sportsKeywords.some(k => name.includes(k)) || sportsNetworks.some(n => network.includes(n));
}

function isForeign(show) {
  // Allowed countries: US, GB, CA, AU, IE, NZ
  const allowed = ["US","GB","CA","AU","IE","NZ"];
  const c = show?.network?.country?.code || show?.webChannel?.country?.code || null;
  if (!c) return true; // conservative: if no country info, treat as foreign
  return !allowed.includes(c);
}

function filterLastNDays(episodes, n, todayStr) {
  const today = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - (n - 1));
  return episodes.filter(ep => {
    const dateStr = pickDate(ep);
    if (!dateStr) return false;
    if (dateStr > todayStr) return false;
    const d = new Date(dateStr);
    return d >= start && d <= today;
  });
}

// TMDB fallback: given IMDB id -> lookup TVMaze -> fetch show details
async function tmdbToTvmazeByImdb(imdbId) {
  if (!imdbId) return null;
  const tm = await fetchJSON(`https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`);
  if (!tm?.id) return null;
  const detail = await fetchJSON(`https://api.tvmaze.com/shows/${tm.id}?embed=episodes`);
  return detail || null;
}

// ===== BUILD =====
async function build() {
  // dates
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2,"0");
  const dd = String(now.getUTCDate()).padStart(2,"0");
  const todayStr = `${yyyy}-${mm}-${dd}`;

  // container
  const showMap = new Map(); // showId -> { show, episodes: [] }
  const excludedSports = new Set();

  // 1) collect from schedule endpoints for last 10 days
  for (let i=0;i<10;i++){
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth()+1).padStart(2,"0");
    const day = String(d.getUTCDate()).padStart(2,"0");
    const dateStr = `${y}-${m}-${day}`;

    const urls = [
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`,
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`,
      `https://api.tvmaze.com/schedule/full?date=${dateStr}`
    ];

    for (const url of urls) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;
      for (const ep of list) {
        const show = ep?.show || ep?._embedded?.show;
        if (!show?.id) continue;

        // filtering
        if (isSportsShow(show)) {
          excludedSports.add(show.id);
          continue;
        }
        if (isNews(show)) continue;
        if (looksLikeSports(show)) continue;
        if (isForeign(show)) continue;

        const cur = showMap.get(show.id);
        if (!cur) showMap.set(show.id, { show, episodes: [ep] });
        else cur.episodes.push(ep);
      }
    }
  }

  // 2) episodesByDate fallback: for shows not added yet (scan generic schedule per date)
  for (let i=0;i<10;i++){
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth()+1).padStart(2,"0");
    const day = String(d.getUTCDate()).padStart(2,"0");
    const dateStr = `${y}-${m}-${day}`;

    // use generic schedule (no country) to find potential missing shows
    const generic = await fetchJSON(`https://api.tvmaze.com/schedule?date=${dateStr}`);
    if (!Array.isArray(generic)) continue;

    for (const ep of generic) {
      const show = ep?.show;
      if (!show?.id) continue;
      if (showMap.has(show.id)) continue; // already have it

      // skip obvious rejects
      if (isNews(show) || isSportsShow(show) || looksLikeSports(show) || isForeign(show)) continue;

      // fetch episodes by date for that show
      const eps = await fetchJSON(`https://api.tvmaze.com/shows/${show.id}/episodesbydate?date=${dateStr}`);
      if (Array.isArray(eps) && eps.length) {
        showMap.set(show.id, { show, episodes: eps });
      }
    }
  }

  // 3) TMDB fallback: for any show that lacks enough episode detail, attempt IMDB -> TVMaze detail
  // We'll iterate over a copy of keys to avoid modifying during iteration
  const keys = Array.from(showMap.keys());
  for (const id of keys) {
    const entry = showMap.get(id);
    if (!entry) continue;
    // if we already have embedded episodes (from schedule or episodesbydate), skip detailed fetch
    if (entry.show && entry.show._embedded && entry.show._embedded.episodes && entry.show._embedded.episodes.length) {
      // nothing
    } else {
      // try using externals.imdb if present
      const imdb = entry.show?.externals?.imdb;
      if (imdb) {
        const detail = await tmdbToTvmazeByImdb(imdb);
        if (detail && detail._embedded?.episodes?.length) {
          // merge episodes
          entry.episodes = [...(entry.episodes||[]), ...detail._embedded.episodes];
          entry.show = detail;
        }
      }
    }
  }

  // 4) Build final catalog list (only include shows with episodes in last 10 days)
  const finalList = [];
  for (const [id, v] of showMap.entries()) {
    const recent = filterLastNDays(v.episodes || [], 10, todayStr);
    if (!recent.length) continue;
    const latestDate = recent.map(e => pickDate(e)).filter(Boolean).sort().reverse()[0];
    finalList.push({
      id: `tvmaze:${v.show.id}`,
      type: "series",
      name: v.show.name,
      description: cleanHTML(v.show.summary),
      poster: v.show.image?.medium || v.show.image?.original || null,
      background: v.show.image?.original || null,
      latestDate
    });
  }

  // sort newest first
  finalList.sort((a,b) => b.latestDate.localeCompare(a.latestDate));

  // === write files ===
  fs.mkdirSync(CATALOG_PATH, { recursive: true });
  fs.writeFileSync(path.join(CATALOG_PATH, "tvmaze_weekly_schedule.json"), JSON.stringify({ metas: finalList, ts: Date.now() }, null, 2));

  // write per-show meta files
  fs.mkdirSync(META_DIR, { recursive: true });

  for (const [id, v] of showMap.entries()) {
    const show = v.show;
    const eps = (v.episodes || []).map(ep => ({
      id: `tvmaze:${ep.id}`,
      title: ep.name || `Episode ${ep.number}`,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate || null,
      overview: cleanHTML(ep.summary)
    }));

    const meta = {
      meta: {
        id: `tvmaze:${show.id}`,
        type: "series",
        name: show.name,
        description: cleanHTML(show.summary),
        poster: show.image?.original || show.image?.medium || null,
        background: show.image?.original || null,
        videos: eps
      }
    };

    // filename: tvmaze:ID.json
    const filename = `tvmaze:${show.id}.json`;
    const filepath = path.join(META_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(meta, null, 2));
  }

  console.log("Build complete. catalog shows:", finalList.length);
}

// run
build().catch(err => {
  console.error("Build failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});