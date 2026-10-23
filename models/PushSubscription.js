const mongoose = require("mongoose");

const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    },
    expirationTime: { type: Number, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.models.DesiPushSubscription ||
  mongoose.model("DesiPushSubscription", pushSubscriptionSchema);
