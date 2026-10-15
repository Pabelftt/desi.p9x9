require('dotenv').config();

const express = require('express');
const ejs = require('ejs');
const cors = require('cors');
const mongoose = require('mongoose');
const setUrlMiddleware = require('./middleware');
const axios = require('axios');

const app = express();

// ================= MIDDLEWARE =================
app.use(setUrlMiddleware); // safe
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public', {
  maxAge: 600000,
  etag: true,
  lastModified: true
}));

// ================= MongoDB =================
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  throw new Error('MONGO_URI must be set in the environment');
}
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ================= Schemas =================
const movieSchema = new mongoose.Schema({ id: String, hadding: String, img: String, play: String });
movieSchema.index({ hadding: "text" });
const Movie = mongoose.model('Movie', movieSchema);

const countSchema = new mongoose.Schema({ random: Number, count: Number });
const CountModel = mongoose.model('CountModel', countSchema);
const MOVIE_PAGE_SIZE = 20;
const BROWSER_CACHE_MAX_AGE_SECONDS = 600;

function setBrowserCacheHeaders(res, varyByCookie = false) {
  res.set('Cache-Control', `private, max-age=${BROWSER_CACHE_MAX_AGE_SECONDS}`);
  if (varyByCookie) res.vary('Cookie');
}

// ================= Utility =================
function hasSmartLinkFlowCookie(req, videoId) {
  const cookie = (req.headers.cookie || "")
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith("smartLinkFlow="));
  if (!cookie) return false;

  try {
    const flow = JSON.parse(decodeURIComponent(cookie.slice("smartLinkFlow=".length)));
    return flow.videoId === videoId && flow.pagePath === `/movie/${encodeURIComponent(videoId)}`;
  } catch (error) {
    return false;
  }
}

async function getCountDoc() {
  const doc = await CountModel.findOne();
  return {
    randomData: doc ? doc.random : 1,
    randomCount: doc ? doc.count : 0
  };
}

async function getMoviePage(query, skip = 0) {
  if (query) {
    const textFilter = { $text: { $search: query } };
    const hasTextMatches = await Movie.exists(textFilter);
    const filter = hasTextMatches
      ? textFilter
      : { hadding: { $regex: query.split(" ")[0], $options: "i" } };
    let request = Movie.find(filter);
    if (hasTextMatches) request = request.select({ score: { $meta: "textScore" } }).sort({ score: { $meta: "textScore" } });
    else request = request.sort({ _id: -1 });
    return request.skip(skip).limit(MOVIE_PAGE_SIZE + 1);
  }

  return Movie.find({})
    .sort({ _id: -1 })
    .skip(skip)
    .limit(MOVIE_PAGE_SIZE + 1);
}

// ================= ROUTES =================
app.get('/', async (req, res) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    let data = await getMoviePage(query);
    const hasMore = data.length > MOVIE_PAGE_SIZE;
    data = data.slice(0, MOVIE_PAGE_SIZE);
    if (!query) {
      for (let i = data.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [data[i], data[j]] = [data[j], data[i]];
      }
    }

    const latest = await Movie.find({}).sort({ _id: -1 }).limit(5).select("id hadding img");
    const { randomData, randomCount } = await getCountDoc();

    setBrowserCacheHeaders(res, true);
    res.render('index', {
      data,
      latest,
      query,
      hasMore,
      randomData,
      randomCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// ================= Movie Page =================
app.get('/movie/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const data = await Movie.findOne({ id });
    if (!data) return res.status(404).send("Not found");

    const suggested = await Movie.find({ id: { $ne: id } })
      .sort({ _id: -1 })
      .limit(MOVIE_PAGE_SIZE + 1);
    const hasMoreSuggested = suggested.length > MOVIE_PAGE_SIZE;
    const suggestedPage = suggested.slice(0, MOVIE_PAGE_SIZE);

    const dateArray = ["2025-11-22","2025-11-23","2025-11-24","2025-10-22","2025-11-20"];
    const date = dateArray[(parseInt(id) - 1) % dateArray.length];

    const { randomData, randomCount } = await getCountDoc();

    setBrowserCacheHeaders(res, true);
    res.render('movie', {
      data,
      suggested: suggestedPage,
      hasMoreSuggested,
      date,
      query: "",
      randomData,
      randomCount,
      smartLinkFlowCompleted: hasSmartLinkFlowCookie(req, id)
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post('/api/movies/:id/smart-link', async (req, res) => {
  try {
    const videoId = req.params.id;
    const movieExists = await Movie.exists({ id: videoId });
    if (!movieExists) return res.status(404).json({ error: "Video not found" });

    if (!res.locals.smartLink) return res.json({ redirectUrl: null });

    let redirectUrl;
    try {
      redirectUrl = new URL(res.locals.smartLink);
      if (redirectUrl.protocol !== "https:" && redirectUrl.protocol !== "http:") {
        return res.status(500).json({ error: "Smart link must use HTTP or HTTPS" });
      }
    } catch (error) {
      console.error("Invalid smart link URL:", error);
      return res.status(500).json({ error: "Smart link is invalid" });
    }

    const pagePath = `/movie/${encodeURIComponent(videoId)}`;
    res.cookie("smartLinkFlow", JSON.stringify({ videoId, pagePath }), {
      maxAge: 300000,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });
    res.json({ redirectUrl: redirectUrl.href });
  } catch (err) {
    console.error("Unable to create smart link flow:", err);
    res.status(500).json({ error: "Unable to continue to smart link" });
  }
});

// ================= Other routes =================
// (force-download, /api/count, /count POST, /api/suggested, sitemap.xml)
// এখানে একইভাবে getCountDoc() ব্যবহার করে null safe করুন

app.get('/api/suggested', async (req, res) => {
  try {
    const excludeId = typeof req.query.excludeId === "string" ? req.query.excludeId : "";
    const skip = Number.parseInt(req.query.skip, 10);
    if (!Number.isInteger(skip) || skip < 0) {
      return res.status(400).json({ error: "skip must be a non-negative integer" });
    }

    const videos = await Movie.find({ id: { $ne: excludeId } })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(MOVIE_PAGE_SIZE + 1);

    setBrowserCacheHeaders(res);
    res.json({
      movies: videos.slice(0, MOVIE_PAGE_SIZE),
      hasMore: videos.length > MOVIE_PAGE_SIZE
    });

  } catch (err) {
    console.error("Error loading suggested videos:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/movies', async (req, res) => {
  try {
    const skip = Number.parseInt(req.query.skip, 10);
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!Number.isInteger(skip) || skip < 0) {
      return res.status(400).json({ error: "skip must be a non-negative integer" });
    }

    const movies = await getMoviePage(query, skip);

    setBrowserCacheHeaders(res);
    res.json({
      movies: movies.slice(0, MOVIE_PAGE_SIZE),
      hasMore: movies.length > MOVIE_PAGE_SIZE
    });
  } catch (err) {
    console.error("Error loading movies:", err);
    res.status(500).json({ error: "Server error" });
  }
});



app.get("/force-download", async (req, res) => {
  try {
    const videoUrl = req.query.video;
    let name = req.query.name || "video";
    if (!videoUrl) return res.status(400).send("Invalid request");

    name = name.replace(/[^\w\d]/g, "_").substring(0, 40);

    const response = await axios({
      method: "GET",
      url: videoUrl,
      responseType: "stream"
    });

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${name}.mp4"`
    );
    res.setHeader("Content-Type", "video/mp4");

    response.data.pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).send("Download failed");
  }
});


// index.js



app.get('/api/count', async (req, res) => {
  
    let countDoc = await CountModel.findOne();
    console.log(
        `
          random = ${countDoc.random}
          count = ${countDoc.count}
        `
      )
      res.send(
          `
            random = ${countDoc.random}
            count = ${countDoc.count}
          `
        )
  
});

// ================= /count POST =================
app.post('/count', async (req, res) => {
  try {
    const count = req.body.count;

    // প্রথমে ডাটাবেস থেকে document নিন
    let doc = await CountModel.findOne();

    if (!doc) {
      // যদি document না থাকে, নতুন create করুন
      doc = new CountModel({ count: count, random: 1 });
    } else {
      // যদি document থাকে, update করুন
      doc.count = count;
      doc.random = doc.random + 1;

      // random 5 হলে আবার 1 থেকে শুরু হবে
      if (doc.random > 5) {
        doc.random = 1;
      }
    }

    await doc.save();

    res.send('Count updated successfully');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.get('/test', (req, res) => {
  res.send(`Custom add`);
});

// ================= Receive data from webs.p9x9.com (scraper-api) =================
app.post('/api/webs-p9x9-data', async (req, res) => {
  try {
    const body = req.body || {};

    const title = String(body.title || "").trim();
    if (!title) {
      return res.status(400).json({ success: false, message: "title is required" });
    }

    let routeName = String(body.routeName || "").toLowerCase().trim();
    if (!routeName) {
      routeName = title.toLowerCase().replace(/[^\w\s]/g, "").trim().replace(/\s+/g, "-");
    }

    // desi.p9x9.com এ শুধু প্রয়োজনীয় কয়েকটি field রাখা হলো
    const hadding = title;
    const img = String(body.imageLink || body.img || "").trim();
    const play = String(body.videoLink || body.video || body.play || "").trim();

    // Movie-এ id হলো unique key (upsert)
    const existing = await Movie.findOne({ id: routeName });
    if (existing) {
      existing.hadding = hadding;
      existing.img = img;
      existing.play = play;
      await existing.save();
    } else {
      await Movie.create({ id: routeName, hadding, img, play });
    }

    res.json({
      success: true,
      apiSuccess: true,
      message: "Data saved successfully",
      routeName
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});


// ===============================
// ✅ Dynamic XML Sitemap (Daily Updated)
// ===============================

app.get('/sitemap.xml', async (req, res) => {
  try {
    // 🔑 Use req.headers.host to get base URL dynamically
    const baseUrl = `https://${req.headers.host}`;

    const movies = await Movie.find({}).lean();
    console.log("Movies found:", movies.length);

    res.set('Content-Type', 'application/xml');

    const escapeXml = (unsafe) => {
      return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    };

    let urls = `
  <url>
    <loc>${escapeXml(baseUrl)}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
`;

    movies.forEach(movie => {
      try {
        if (movie.id && typeof movie.id === "string") {
          const safeUrl = escapeXml(`${baseUrl}/movie/${encodeURIComponent(movie.id.trim())}`);
          urls += `
  <url>
    <loc>${safeUrl}</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
`;
        } else {
          console.log("Skipping invalid movie ID:", movie.id);
        }
      } catch (e) {
        console.log("Error processing movie:", movie, e);
      }
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

    res.send(xml);

  } catch (error) {
    console.error("Sitemap error:", error);
    res.status(500).send("Error generating sitemap: " + error.message);
  }
});


// ================= Start Server =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));