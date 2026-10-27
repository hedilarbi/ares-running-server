const mongoose = require('mongoose');

const UserBadgeSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    badge: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Badge',
      required: true,
    },
    unlockedAt: { type: Date, default: Date.now },
    // The run whose stats crossed the badge's criteria threshold, if any.
    sourceRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Run',
      default: null,
    },
    // XP actually paid for this badge, so deleting the badge can take it back
    // even after its reward was edited.
    xpAwarded: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

UserBadgeSchema.index({ user: 1, badge: 1 }, { unique: true });
UserBadgeSchema.index({ user: 1, sourceRun: 1 });

module.exports = mongoose.models.UserBadge || mongoose.model('UserBadge', UserBadgeSchema);
