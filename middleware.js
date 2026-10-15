// middleware.js
module.exports = function(req, res, next) {
  // আগের সমস্ত logic থাকছে কিন্তু global variable নয়
  res.locals.url = `https://${req.headers.host}`;
  res.locals.hadding = "BD Viral Link, Bangladeshi Viral Video";
  res.locals.author = "Pabel Islan";
  res.locals.movieName = "Viral Link";
  res.locals.img = "https://i.postimg.cc/KzKbCSqs/1768441412180.png";
  res.locals.description = "প্রথমবার ভিডিও চালাতে Continue চাপলে নির্ধারিত smart link-এ যাবেন।";
  res.locals.moreWebsite = "https://p9x9.com";
  res.locals.telegramLink = (process.env.TELEGRAM_URL || "https://telegram.p9x9.com/telegram").trim();
  res.locals.downloadLink = (process.env.DOWNLOAD_LINK_URL || "https://auctionr.org/4/93a942816b667574bfb9c03daa56b8c0").trim();
  res.locals.keywords = "Bangla Sex Video, Bangladeshi Sex Video, Viral Link, Tiktoker Viral Link, Bhabi Sex, Vabi Sex";
  res.locals.smartLink = (process.env.SMART_LINK_URL || "").trim();

  next();
};