import fs from "fs";
import path from "path";

// CONFIG
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";   // your key
const OUTPUT_DIR = "./";

// Helpers
async function fetchJSON(url) {
  try {
    const r = await fetch(url);
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

// ==========================
// FILTERS
// ==========================
function isNews(show) {
  const type = (show.type || "").toLowerCase();
  const genres = show.genres || [];
  
  // Combine all text fields for keyword search
  const name = (show.name || "").toLowerCase();
  const summary = (show.summary || "").toLowerCase();
  const description = (show.description || "").toLowerCase();

  // Keywords with original casing for reference
  const newsKeywords = [
    "News", "Talk Show", "Morning", "Early Start", "GMA", "PoliticsNation", "700 Club", "Today"
  ];

  // Convert keywords to lowercase for case-insensitive search
  const keywordMatch = newsKeywords.some(k => 
    name.includes(k.toLowerCase()) ||
    summary.includes(k.toLowerCase()) ||
    description.includes(k.toLowerCase())
  );

  // Check type, genres, or keywords
  return (
    type === "news" ||
    genres.some(g => g.toLowerCase() === "news" || g.toLowerCase() === "talk show") ||
    keywordMatch
  );
}

function isSportsShow(show) {
  const type = (show.type || "").toLowerCase();
  const genres = show.genres || [];
  const name = (show.name || "").toLowerCase();
  return (
    type === "sports" ||
    genres.some(g => g.toLowerCase() === "sports") ||
    name.includes("football") ||
    name.includes("soccer")
  );
}

function looksLikeSports(show) {
  const name = (show.name || "").toLowerCase();
  const network = (show.network?.name || "").toLowerCase();
  const sportsKeywords = ["football", "soccer", "basketball", "nfl", "nhl"];
  const sportsNetworks = ["espn", "abc", "nbc sports", "fox sports"];
  return (
    sportsKeywords.some((k) => name.includes(k)) ||
    sportsNetworks.some((n) => network.includes(n))
  );
}

function isForeign(show) {
  const allowedCountries = ["US", "GB", "CA", "AU", "NZ", "IE"];
  const c = show?.network?.country?.code;
  if (!c) return true;
  return !allowedCountries.includes(c);
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

// ==========================
// TMDB FALLBACK
// ==========================
async function tmdbFallback(imdbId) {
  if (!imdbId) return null;

  const tm = await fetchJSON(
    `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`
  );
  if (!tm?.id) return null;

  const detail = await fetchJSON(
    `https://api.tvmaze.com/shows/${tm.id}?embed=episodes`
  );

  return detail || null;
}

// ==========================
// MAIN BUILD PROCESS
// ==========================
async function build() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const showMap = new Map();

  // 1) Schedule endpoints
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);

    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${day}`;

    const a = await fetchJSON(`https://api.tvmaze.com/schedule?country=US&date=${dateStr}`);
    const b = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${dateStr}`);
    const c = await fetchJSON(`https://api.tvmaze.com/schedule/full?date=${dateStr}`);

    for (const list of [a, b, c]) {
      if (!Array.isArray(list)) continue;

      for (const ep of list) {
        const show = ep?.show || ep?._embedded?.show;
        if (!show?.id) continue;

        // APPLY NEWS/SPORTS/FILTER
        if (isNews(show) || isSportsShow(show) || looksLikeSports(show)) continue;
        if (isForeign(show)) continue;

        const cur = showMap.get(show.id);
        if (!cur) showMap.set(show.id, { show, episodes: [ep] });
        else cur.episodes.push(ep);
      }
    }
  }

  // 2) episodesByDate fallback
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);

    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${day}`;

    const list = await fetchJSON(`https://api.tvmaze.com/schedule?date=${dateStr}`);
    if (!Array.isArray(list)) continue;

    for (const ep of list) {
      const show = ep?.show;
      if (!show?.id) continue;
      if (!showMap.has(show.id)) {
        const ep2 = await fetchJSON(
          `https://api.tvmaze.com/shows/${show.id}/episodesbydate?date=${dateStr}`
        );

        if (Array.isArray(ep2) && ep2.length > 0) {
          showMap.set(show.id, { show, episodes: ep2 });
        }
      }
    }
  }

  // 3) TMDB fallback for missing episodes
  for (const [id, info] of showMap.entries()) {
    const imdb = info.show.externals?.imdb;
    if (!imdb) continue;

    const detail = await tmdbFallback(imdb);
    if (detail && detail._embedded?.episodes?.length > 0) {
      const existing = info.episodes || [];
      const combined = [...existing, ...detail._embedded.episodes];

      // DEDUPLICATE episodes by ID
      const combinedMap = new Map();
      for (const ep of combined) {
        if (!ep?.id) continue;
        combinedMap.set(ep.id, ep);
      }
      info.episodes = [...combinedMap.values()];

      // Apply NEWS/SPORTS filter after TMDB fallback
      if (isNews(info.show) || isSportsShow(info.show)) {
        showMap.delete(id);
      }
    }
  }

  // Final list
  const finalList = [...showMap.values()]
    .map((v) => {
      const recent = filterLastNDays(v.episodes, 10, todayStr);
      if (!recent.length) return null;

      const latestDate = recent
        .map((e) => pickDate(e))
        .filter(Boolean)
        .sort()
        .reverse()[0];

      return {
        id: `tvmaze:${v.show.id}`,
        type: "series",
        name: v.show.name,
        description: cleanHTML(v.show.summary),
        poster: v.show.image?.medium || v.show.image?.original || null,
        background: v.show.image?.original || null,
        latestDate
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.latestDate.localeCompare(a.latestDate));

  // Write catalog
  fs.mkdirSync("./catalog/series", { recursive: true });
  fs.writeFileSync(
    "./catalog/series/tvmaze_weekly_schedule.json",
    JSON.stringify({ metas: finalList, ts: Date.now() }, null, 2)
  );

  // Write meta files
  fs.mkdirSync("./meta/series", { recursive: true });

  for (const v of showMap.values()) {
    const show = v.show;

    // Deduplicate episodes by ID
    const uniqueMap = new Map();
    for (const ep of v.episodes || []) {
      if (!ep?.id) continue;
      uniqueMap.set(ep.id, ep);
    }

    const eps = [...uniqueMap.values()].map((ep) => ({
      id: `tvmaze:${ep.id}`,
      title: ep.name || `Episode ${ep.number}`,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate || null,
      overview: cleanHTML(ep.summary)
    }));

    fs.writeFileSync(
      `./meta/series/tvmaze:${show.id}.json`,
      JSON.stringify(
        {
          meta: {
            id: `tvmaze:${show.id}`,
            type: "series",
            name: show.name,
            description: cleanHTML(show.summary),
            poster: show.image?.original || show.image?.medium || null,
            background: show.image?.original || null,
            videos: eps
          }
        },
        null,
        2
      )
    );
  }
}

build();