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
app.use(express.static('public'));

// ================= MongoDB =================
const MONGO_URI = 'mongodb+srv://MyDatabase:Cp8rNCfi15IUC6uc@cluster0.kjbloky.mongodb.net/adultLink';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ================= Schemas =================
const movieSchema = new mongoose.Schema({ id: String, hadding: String, img: String, play: String });
movieSchema.index({ hadding: "text" });
const Movie = mongoose.model('Movie', movieSchema);

const countSchema = new mongoose.Schema({ random: Number, count: Number });
const CountModel = mongoose.model('CountModel', countSchema);

// ================= Utility =================
async function getCountDoc() {
  const doc = await CountModel.findOne();
  return {
    randomData: doc ? doc.random : 1,
    randomCount: doc ? doc.count : 0
  };
}

// ================= ROUTES =================
app.get('/', async (req, res) => {
  try {
    const query = req.query.q || "";
    let data;

    if (query) {
      data = await Movie.find({ $text: { $search: query } }, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } });
      if (!data.length) {
        data = await Movie.find({ hadding: { $regex: query.split(" ")[0], $options: "i" } });
      }
    } else {
      data = await Movie.find({});
      for (let i = data.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [data[i], data[j]] = [data[j], data[i]];
      }
    }

    const latest = await Movie.find({}).sort({ _id: -1 }).limit(5).select("id hadding");
    const { randomData, randomCount } = await getCountDoc();

    res.render('index', {
      data,
      latest,
      query,
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

    const suggested = await Movie.aggregate([
      { $match: { id: { $ne: id } } },
      { $sample: { size: 8 } }
    ]);

    const dateArray = ["2025-11-22","2025-11-23","2025-11-24","2025-10-22","2025-11-20"];
    const date = dateArray[(parseInt(id) - 1) % dateArray.length];

    const { randomData, randomCount } = await getCountDoc();

    res.render('movie', {
      data,
      suggested,
      date,
      query: "",
      randomData,
      randomCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// ================= Other routes =================
// (force-download, /api/count, /count POST, /api/suggested, sitemap.xml)
// এখানে একইভাবে getCountDoc() ব্যবহার করে null safe করুন

app.get('/api/suggested', async (req, res) => {
  try {
    const { excludeId, skip = 0 } = req.query;

    const videos = await Movie.aggregate([
      { $match: { id: { $ne: excludeId } } },
      { $skip: parseInt(skip) },
      { $limit: 8 }
    ]);

    res.json(videos);

  } catch (err) {
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

    if (!body.title) {
      return res.status(400).json({ success: false, message: "title is required" });
    }

    const title = String(body.title).trim();

    let routeName = (body.routeName || "").toLowerCase().trim();
    if (!routeName) {
      routeName = title.toLowerCase().replace(/[^\w\s]/g, "").trim().replace(/\s+/g, "-");
    }

    const hadding = title;
    const img = body.imageLink || body.img || "";
    const play = body.videoLink || body.video || body.play || "";

    if (!play) {
      return res.status(400).json({ success: false, message: "videoLink is required" });
    }

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