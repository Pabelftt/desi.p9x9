require('dotenv').config();

const express = require('express');
const ejs = require('ejs');
const cors = require('cors');
const mongoose = require('mongoose');
const setUrlMiddleware = require('./middleware');
const axios = require('axios');
const crypto = require('node:crypto');
const webpush = require('web-push');
const PushSubscription = require('./models/PushSubscription');
const SiteAdSettings = require('./models/SiteAdSettings');
const {
  clearSessionCookie,
  createToken,
  isAdmin,
  safeEqual,
  setSessionCookie
} = require('./lib/adminAuth');

const app = express();
const requestLimits = new Map();

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
const DEFAULT_AD_SETTINGS = { popunder: true, socialBar: true, videoRedirect: true };

function rateLimit(key, windowMs, maximum) {
  const now = Date.now();
  const current = requestLimits.get(key);
  if (!current || current.resetAt <= now) {
    requestLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= maximum) return false;
  current.count += 1;
  return true;
}

function currentAdSettings(settings) {
  return settings
    ? {
        popunder: settings.popunder,
        socialBar: settings.socialBar,
        videoRedirect: settings.videoRedirect ?? DEFAULT_AD_SETTINGS.videoRedirect,
        popunderSrc: process.env.POPUNDER_SCRIPT_URL || '',
        socialBarSrc: process.env.SOCIAL_BAR_SCRIPT_URL || ''
      }
    : {
        ...DEFAULT_AD_SETTINGS,
        popunderSrc: process.env.POPUNDER_SCRIPT_URL || '',
        socialBarSrc: process.env.SOCIAL_BAR_SCRIPT_URL || ''
      };
}

function configuredVapidKeys() {
  const publicKey = process.env.NEXT_PUBLIC_WEB_PUSH_PUBLIC_KEY || '';
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY || '';
  const contactEmail = process.env.WEB_PUSH_CONTACT_EMAIL || '';
  try {
    const publicBytes = Buffer.from(publicKey, 'base64url');
    const privateBytes = Buffer.from(privateKey, 'base64url');
    if (
      !/^[A-Za-z0-9_-]+$/.test(publicKey) ||
      !/^[A-Za-z0-9_-]+$/.test(privateKey) ||
      publicBytes.length !== 65 ||
      publicBytes[0] !== 4 ||
      privateBytes.length !== 32 ||
      !contactEmail.includes('@')
    ) return null;

    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    if (!ecdh.getPublicKey(null, 'uncompressed').equals(publicBytes)) return null;
    return { publicKey, privateKey, contactEmail };
  } catch {
    return null;
  }
}

function validPushKey(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').length === expectedLength;
  } catch {
    return false;
  }
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

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
app.get('/admin', async (req, res) => {
  if (!isAdmin(req)) {
    return res.render('admin', { isAdmin: false, error: '' });
  }
  try {
    const [storedSettings, subscriberCount] = await Promise.all([
      SiteAdSettings.findOne({ key: 'site' }).lean(),
      PushSubscription.countDocuments()
    ]);
    res.set('Cache-Control', 'no-store');
    return res.render('admin', {
      isAdmin: true,
      settings: currentAdSettings(storedSettings),
      subscriberCount
    });
  } catch (error) {
    console.error('Unable to load admin controls:', error);
    return res.status(500).send('Admin controls could not be loaded.');
  }
});

app.post('/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(`admin-login:${ip}`, 60_000, 10)) {
    return res.status(429).render('admin', {
      isAdmin: false,
      error: 'Too many login attempts. Please wait a minute.'
    });
  }

  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const configuredUsername = process.env.ADMIN_USERNAME || '';
  const configuredPassword = process.env.ADMIN_PASSWORD || '';
  const secret = process.env.ADMIN_SESSION_SECRET || '';

  if (!configuredUsername || !configuredPassword || secret.length < 32) {
    return res.status(503).render('admin', {
      isAdmin: false,
      error: 'Admin login is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and a 32-character ADMIN_SESSION_SECRET.'
    });
  }
  if (!safeEqual(username, configuredUsername) || !safeEqual(password, configuredPassword)) {
    return res.status(401).render('admin', {
      isAdmin: false,
      error: 'Username or password is incorrect.'
    });
  }

  try {
    setSessionCookie(res, createToken());
    return res.redirect(303, '/admin');
  } catch (error) {
    console.error('Unable to create admin session:', error);
    return res.status(503).render('admin', {
      isAdmin: false,
      error: 'Admin login is not configured. Check ADMIN_SESSION_SECRET.'
    });
  }
});

app.get('/admin/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect(303, '/admin');
});

app.get('/api/ads', async (req, res) => {
  try {
    const settings = await SiteAdSettings.findOne({ key: 'site' }).lean();
    res.set('Cache-Control', 'no-store');
    res.json(currentAdSettings(settings));
  } catch (error) {
    console.error('Unable to load ad settings:', error);
    res.status(500).json({ error: 'Ad settings could not be loaded.' });
  }
});

app.patch('/api/admin/ads', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { type, enabled } = req.body || {};
  if (!['popunder', 'socialBar', 'videoRedirect'].includes(type) || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Invalid ad setting.' });
  }
  try {
    const settings = await SiteAdSettings.findOneAndUpdate(
      { key: 'site' },
      { $set: { [type]: enabled } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
    res.set('Cache-Control', 'no-store');
    res.json(currentAdSettings(settings));
  } catch (error) {
    console.error('Unable to update ad settings:', error);
    res.status(500).json({ error: 'Ad settings could not be saved.' });
  }
});

app.get('/api/notifications/config', (req, res) => {
  const keys = configuredVapidKeys();
  res.set('Cache-Control', 'no-store');
  res.json({ publicKey: keys ? keys.publicKey : null });
});

app.post('/api/notifications/subscribe', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(`push-subscribe:${ip}`, 60_000, 10)) {
    return res.status(429).json({ error: 'Too many subscription requests.' });
  }
  const body = req.body || {};
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    parsedEndpoint = null;
  }
  if (
    !parsedEndpoint ||
    parsedEndpoint.protocol !== 'https:' ||
    parsedEndpoint.username ||
    parsedEndpoint.password ||
    endpoint.length > 2048 ||
    !validPushKey(body.keys && body.keys.p256dh, 65) ||
    !validPushKey(body.keys && body.keys.auth, 16) ||
    (body.expirationTime != null &&
      (!Number.isFinite(body.expirationTime) || body.expirationTime <= 0))
  ) {
    return res.status(400).json({ error: 'Invalid push subscription.' });
  }
  try {
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        $set: {
          keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
          expirationTime: body.expirationTime ?? null
        }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true });
  } catch (error) {
    if (error.code === 11000) return res.json({ ok: true });
    console.error('Failed to save push subscription:', error);
    res.status(500).json({ error: 'Subscription could not be saved.' });
  }
});

app.post('/api/notifications/unsubscribe', async (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
  if (!endpoint || endpoint.length > 2048) {
    return res.status(400).json({ error: 'Invalid subscription endpoint.' });
  }
  try {
    await PushSubscription.deleteOne({ endpoint });
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to remove push subscription:', error);
    res.status(500).json({ error: 'Subscription could not be removed.' });
  }
});

app.get('/api/admin/notifications/movies', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const page = Number.parseInt(req.query.page, 10);
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  if (!Number.isSafeInteger(page) || page < 1) {
    return res.status(400).json({ error: 'Invalid page.' });
  }

  try {
    const filter = query
      ? { hadding: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
      : {};
    const pageSize = 40;
    const movies = await Movie.find(filter)
      .sort({ _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize + 1)
      .select('id hadding img')
      .lean();

    res.set('Cache-Control', 'private, no-store');
    res.json({
      items: movies.slice(0, pageSize).map((movie) => ({
        routeName: String(movie.id || ''),
        title: String(movie.hadding || ''),
        imageLink: String(movie.img || ''),
        description: String(movie.hadding || '')
      })).filter((movie) => movie.routeName && movie.title),
      page,
      hasMore: movies.length > pageSize
    });
  } catch (error) {
    console.error('Unable to load movie options for notifications:', error);
    res.status(500).json({ error: 'Unable to load movies.' });
  }
});

app.post('/api/admin/notifications/send', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(`push-send:${ip}`, 60_000, 5)) {
    return res.status(429).json({ error: 'Too many notification sends. Please wait.' });
  }

  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 80) : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 200) : '';
  const requestedPath = typeof req.body?.url === 'string' ? req.body.url.trim() : '/';
  const requestedImage = typeof req.body?.imageUrl === 'string' ? req.body.imageUrl.trim() : '';
  if (!title || !body) {
    return res.status(400).json({ error: 'A notification title and message are required.' });
  }
  let redirectPath = requestedPath;
  if (requestedPath.startsWith('/')) {
    if (requestedPath.startsWith('//') || requestedPath.includes('\\')) {
      return res.status(400).json({ error: 'Enter a link on this site, such as / or /movie/video-id.' });
    }
  } else {
    try {
      const redirectUrl = new URL(requestedPath);
      if (
        !['http:', 'https:'].includes(redirectUrl.protocol) ||
        redirectUrl.username ||
        redirectUrl.password ||
        redirectUrl.hostname.toLowerCase() !== req.hostname.toLowerCase() ||
        redirectUrl.pathname.startsWith('//') ||
        redirectUrl.pathname.includes('\\')
      ) {
        return res.status(400).json({ error: 'Enter a link on this site, such as / or /movie/video-id.' });
      }
      redirectPath = `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
    } catch {
      return res.status(400).json({ error: 'Enter a valid link on this site.' });
    }
  }
  let imageUrl = '';
  if (requestedImage) {
    if (requestedImage.length > 2048) {
      return res.status(400).json({ error: 'Image URL is too long.' });
    }
    let image;
    try {
      image = new URL(requestedImage);
    } catch {
      return res.status(400).json({ error: 'Enter a valid HTTPS image URL.' });
    }
    if (
      image.protocol !== 'https:' ||
      image.username ||
      image.password
    ) {
      return res.status(400).json({ error: 'Enter a valid HTTPS image URL.' });
    }
    imageUrl = image.href;
  }

  const keys = configuredVapidKeys();
  if (!keys) {
    return res.status(503).json({ error: 'Matching Web Push VAPID keys and contact email are not configured.' });
  }

  try {
    webpush.setVapidDetails(`mailto:${keys.contactEmail}`, keys.publicKey, keys.privateKey);
    const total = await PushSubscription.countDocuments();
    const cursor = PushSubscription.find({}).select('endpoint keys').lean().cursor({ batchSize: 50 });
    let sent = 0;
    let failed = 0;
    const expired = [];
    let batch = [];

    async function sendBatch(subscriptions) {
      const results = await Promise.allSettled(subscriptions.map((subscription) =>
        webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          JSON.stringify({
            title,
            body,
            url: redirectPath,
            ...(imageUrl ? { image: imageUrl, icon: imageUrl } : {})
          }),
          { TTL: 3600 }
        )
      ));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          sent += 1;
        } else {
          failed += 1;
          const statusCode = result.reason?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            expired.push(subscriptions[index].endpoint);
          } else {
            console.error('Push delivery failed:', statusCode || 'unknown');
          }
        }
      });
    }

    for await (const subscription of cursor) {
      batch.push(subscription);
      if (batch.length === 10) {
        await sendBatch(batch);
        batch = [];
      }
    }
    if (batch.length) await sendBatch(batch);
    if (expired.length) await PushSubscription.deleteMany({ endpoint: { $in: expired } });

    res.json({ ok: true, total, sent, failed });
  } catch (error) {
    console.error('Notification delivery failed:', error);
    res.status(500).json({ error: 'Notification delivery failed.' });
  }
});

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
    const [data, storedSettings] = await Promise.all([
      Movie.findOne({ id }),
      SiteAdSettings.findOne({ key: 'site' }).lean()
    ]);
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
      smartLink: currentAdSettings(storedSettings).videoRedirect ? res.locals.smartLink : '',
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

    const settings = await SiteAdSettings.findOne({ key: 'site' }).lean();
    if (!currentAdSettings(settings).videoRedirect) return res.json({ redirectUrl: null });
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
if (require.main === module) {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}
module.exports = app;