import fs from "fs";

// CONFIG
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";

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

// Filters
function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

function isSportsShow(show) {
  return (show.type || "").trim().toLowerCase() === "sports";
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

// TMDB fallback
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

// MAIN BUILD
async function build() {
  // Today
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const showMap = new Map();

  // 1) SCHEDULE ENDPOINTS
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

        if (isNews(show) || isSportsShow(show) || looksLikeSports(show)) continue;
        if (isForeign(show)) continue;

        const cur = showMap.get(show.id);
        if (!cur) showMap.set(show.id, { show, episodes: [ep] });
        else cur.episodes.push(ep);
      }
    }
  }

  // 2) EPISODESBYDATE FALLBACK
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);

    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${day}`;

    const generic = await fetchJSON(
      `https://api.tvmaze.com/schedule?date=${dateStr}`
    );

    if (!Array.isArray(generic)) continue;

    for (const ep of generic) {
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

  // 3) TMDB FALLBACK
  for (const [id, info] of showMap.entries()) {
    const imdb = info.show.externals?.imdb;
    if (!imdb) continue;

    const detail = await tmdbFallback(imdb);
    if (detail && detail._embedded?.episodes?.length > 0) {
      info.episodes = [
        ...(info.episodes || []),
        ...detail._embedded.episodes,
      ];
    }
  }

  // FINAL LIST
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
        latestDate,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.latestDate.localeCompare(a.latestDate));

  // WRITE CATALOG
  fs.mkdirSync("./catalog/series", { recursive: true });
  fs.writeFileSync(
    "./catalog/series/tvmaze_weekly_schedule.json",
    JSON.stringify({ metas: finalList, ts: Date.now() }, null, 2)
  );

  // WRITE META FILES
  fs.mkdirSync("./meta/series", { recursive: true });

  for (const v of showMap.values()) {
    const show = v.show;

    const epList = (v.episodes || []).map((ep) => ({
      id: `tvmaze:${ep.id}`,
      title: ep.name || `Episode ${ep.number}`,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate || null,
      overview: cleanHTML(ep.summary),
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
            videos: epList,
          },
        },
        null,
        2
      )
    );
  }
}

build();
