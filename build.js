function isNews(show) {
  const type = (show.type || "").toLowerCase();
  const genres = show.genres || [];
  const name = (show.name || "").toLowerCase();

  // keywords commonly used in news/talk shows
  const newsKeywords = [
    "news", "morning", "early start", "gma", "politicsnation", "700 club", "today"
  ];

  return (
    // TVmaze type field
    type === "news" ||

    // genres field (TVmaze or TMDB)
    genres.some(g => ["news", "talk show"].includes(g.toLowerCase())) ||

    // name/title keywords
    newsKeywords.some(k => name.includes(k))
  );
}