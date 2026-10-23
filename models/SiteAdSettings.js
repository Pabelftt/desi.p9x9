const mongoose = require("mongoose");

const siteAdSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "site" },
    popunder: { type: Boolean, required: true, default: true },
    socialBar: { type: Boolean, required: true, default: true },
    videoRedirect: { type: Boolean, required: true, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.models.DesiSiteAdSettings ||
  mongoose.model("DesiSiteAdSettings", siteAdSettingsSchema);
