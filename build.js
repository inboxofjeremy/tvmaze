import fs from "fs";
import path from "path";

const OUT_DIR = "./catalog";
const META_DIR = "./meta";

const TMDB_KEY = process.env.TMDB_API_KEY || "PUT_YOUR_TMDB_KEY_HERE";
const MAX_DAYS = 7;

/* ======================================================
FILTERS (UNCHANGED except streaming-original fix)
====================================================== */

function isSports(show) {
const g = (show.genres || []).join(" ").toLowerCase();
const n = (show.name || "").toLowerCase();
return g.includes("sports") || n.includes("sports");
}

function isNews(show) {
const t = (show.type || "").toLowerCase();
const g = (show.genres || []).join(" ").toLowerCase();
return t === "news" || g.includes("news");
}

function isTalkShow(show) {
const g = (show.genres || []).join(" ").toLowerCase();
return g.includes("talk show") || g.includes("talk-show");
}

/* 🔑 FIXED — Option B */
function isForeign(show) {
const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];

const netCountry = show?.network?.country?.code || null;
const webCountry = show?.webChannel?.country?.code || null;

if (netCountry) {
return !allowed.includes(netCountry.toUpperCase());
}

// allow English streaming originals
if (show?.webChannel && show.language === "English") {
return false;
}

return true;
}

function isBlocked(show) {
return (
isSports(show) ||
isNews(show) ||
isTalkShow(show) ||
isForeign(show)
);
}

/* ======================================================
HELPERS
====================================================== */

async function fetchJSON(url) {
const res = await fetch(url);
if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`);
return res.json();
}

function ensureDir(dir) {
fs.mkdirSync(dir, { recursive: true });
}

/* ======================================================
STEP 1 — TVMAZE SCHEDULES
====================================================== */

async function collectSchedules() {
const showMap = new Map();

for (let d = 0; d < MAX_DAYS; d++) {
const date = new Date(Date.now() + d * 86400000)
.toISOString()
.slice(0, 10);


const eps = await fetchJSON(
  `https://api.tvmaze.com/schedule?date=${date}`
);

for (const ep of eps) {
  const show = ep.show;
  if (!show || isBlocked(show)) continue;

  const id = show.id;
  if (!showMap.has(id)) {
    showMap.set(id, {
      show,
      episodes: []
    });
  }

  showMap.get(id).episodes.push(ep);
}


}

return showMap;
}

/* ======================================================
STEP 2 — TMDB FALLBACK (ONLY IF NO EPISODES)
====================================================== */

async function tmdbFallback(showMap) {
for (const entry of showMap.values()) {
if (entry.episodes.length > 0) continue;

const imdb =
  entry.show.externals?.imdb ||
  entry.show.externals?.thetvdb ||
  null;

if (!imdb) continue;

let tmdb;
try {
  tmdb = await fetchJSON(
    `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_KEY}&external_source=imdb_id`
  );
} catch {
  continue;
}

const tv = tmdb.tv_results?.[0];
if (!tv) continue;

try {
  const season = await fetchJSON(
    `https://api.themoviedb.org/3/tv/${tv.id}?api_key=${TMDB_KEY}`
  );

  for (const s of season.seasons || []) {
    const eps = await fetchJSON(
      `https://api.themoviedb.org/3/tv/${tv.id}/season/${s.season_number}?api_key=${TMDB_KEY}`
    );

    for (const e of eps.episodes || []) {
      entry.episodes.push({
        id: `tmdb:${tv.id}:${s.season_number}:${e.episode_number}`,
        season: s.season_number,
        number: e.episode_number,
        airdate: e.air_date,
        name: e.name,
        summary: e.overview || ""
      });
    }
  }
} catch {}


}
}

/* ======================================================
STEP 3 — WRITE FILES
====================================================== */

function writeFiles(showMap) {
ensureDir(OUT_DIR);
ensureDir(META_DIR);

const catalog = [];

for (const { show, episodes } of showMap.values()) {
if (episodes.length === 0) continue;


const id = `tvmaze:${show.id}`;

catalog.push({
  id,
  type: "series",
  name: show.name,
  poster: show.image?.medium || null
});

fs.writeFileSync(
  path.join(META_DIR, `${id}.json`),
  JSON.stringify(
    {
      id,
      type: "series",
      name: show.name,
      description: show.summary || "",
      episodes
    },
    null,
    2
  )
);


}

fs.writeFileSync(
path.join(OUT_DIR, "series.json"),
JSON.stringify({ metas: catalog }, null, 2)
);
}

/* ======================================================
RUN
====================================================== */

(async function build() {
console.log("Collecting schedules...");
const showMap = await collectSchedules();

console.log("TMDB fallback for empty shows...");
await tmdbFallback(showMap);

console.log("Writing files...");
writeFiles(showMap);

console.log("DONE");
})();
