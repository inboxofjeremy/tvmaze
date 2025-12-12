// build.js (ES module) — FINAL VERSION
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
// FILTERS — UNCHANGED
// =======================
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
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const c =
    (show?.network?.country?.code ||
      show?.webChannel?.country?.code ||
      "").toUpperCase();
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

// =======================
// TMDB Fallback
// =======================
async function tmdbToTvmazeByImdb(imdbId) {
  if (!imdbId) return null;

  const lookup = await fetchJSON(
    `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`
  );
  if (!lookup?.id) return null;

  const detail = await fetchJSON(
    `https://api.tvmaze.com/shows/${lookup.id}?embed=episodes`
  );
  return detail || null;
}

// =======================
// DEDUPE
// =======================
function dedupeEpisodes(episodes) {
  const map = new Map();
  for (const ep of episodes || []) {
    if (!ep?.id) continue;
    map.set(ep.id, ep);
  }
  return [...map.values()];
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

  const showMap = new Map();

  // =====================================
  // 1) Collect from all schedule endpoints
  // =====================================
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

        if (isNews(show)) continue;
        if (isSports(show)) continue;
        if (isForeign(show)) continue;

        if (!showMap.has(show.id))
          showMap.set(show.id, { show, episodes: [ep] });
        else showMap.get(show.id).episodes.push(ep);
      }
    }
  }

  // ===========================================================
  // 2) Fallback #1: episodesbydate for ANY missing-from-schedule
  // ===========================================================
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);

    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${day}`;

    // generic schedule: very broad list of episodes
    const generic = await fetchJSON(
      `https://api.tvmaze.com/schedule?date=${dateStr}`
    );
    if (!Array.isArray(generic)) continue;

    for (const ep of generic) {
      const show = ep?.show;
      if (!show?.id) continue;

      if (showMap.has(show.id)) continue; // skip—we already collected it

      if (isNews(show)) continue;
      if (isSports(show)) continue;
      if (isForeign(show)) continue;

      // Try episodesbydate for this date
      const eps = await fetchJSON(
        `https://api.tvmaze.com/shows/${show.id}/episodesbydate?date=${dateStr}`
      );

      if (Array.isArray(eps) && eps.length) {
        showMap.set(show.id, { show, episodes: eps });
      }
    }
  }

  // =============================================================
  // 3) Fallback #2: TMDB → IMDB → TVMaze (if episodes still missing)
  // =============================================================
  const keys = [...showMap.keys()];
  for (const showId of keys) {
    const entry = showMap.get(showId);
    const show = entry.show;

    const hasEmbed =
      show?._embedded?.episodes &&
      Array.isArray(show._embedded.episodes) &&
      show._embedded.episodes.length;

    if (hasEmbed) {
      entry.episodes = dedupeEpisodes([
        ...(entry.episodes || []),
        ...show._embedded.episodes,
      ]);
      continue;
    }

    const imdb = show?.externals?.imdb;
    if (!imdb) continue;

    const detail = await tmdbToTvmazeByImdb(imdb);
    if (detail?._embedded?.episodes?.length) {
      entry.episodes = dedupeEpisodes([
        ...(entry.episodes || []),
        ...detail._embedded.episodes,
      ]);
      entry.show = detail;
    }
  }

  // ============================
  // 4) Build catalog output
  // ============================
  const catalog = [];

  for (const [id, entry] of showMap.entries()) {
    const episodes = entry.episodes || [];
    const recent = filterLastNDays(episodes, 10, todayStr);
    if (!recent.length) continue;

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
      poster:
        entry.show.image?.medium || entry.show.image?.original || null,
      background: entry.show.image?.original || null,
      latestDate,
    });
  }

  catalog.sort((a, b) =>
    (b.latestDate || "").localeCompare(a.latestDate || "")
  );

  // ============================
  // 5) Write catalog + meta files
  // ============================
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas: catalog, ts: Date.now() }, null, 2)
  );

  fs.mkdirSync(META_DIR, { recursive: true });

  for (const [id, entry] of showMap.entries()) {
    const show = entry.show;

    const unique = dedupeEpisodes(entry.episodes || []);
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
        poster:
          show.image?.original || show.image?.medium || null,
        background: show.image?.original || null,
        videos,
      },
    };

    const filename = `tvmaze:${show.id}.json`;
    fs.writeFileSync(
      path.join(META_DIR, filename),
      JSON.stringify(metaObj, null, 2)
    );
  }

  console.log("Build complete — catalog count:", catalog.length);
}

// run it
build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
