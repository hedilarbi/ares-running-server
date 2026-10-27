const mongoose = require('mongoose');

const UserDefiSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    defi: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Defi',
      required: true,
    },
    periodId: { type: String, required: true },
    progressValue: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['en_cours', 'termine', 'echoue'],
      default: 'en_cours',
    },
    joinedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    // Runs already added to progressValue: a retried reward pass skips them.
    countedRuns: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Run' }],
      default: [],
    },
    // The run that completed the défi (null when an admin change completed it).
    completedByRun: { type: mongoose.Schema.Types.ObjectId, ref: 'Run', default: null },
    xpAwarded: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

UserDefiSchema.index({ user: 1, defi: 1, periodId: 1 }, { unique: true });
UserDefiSchema.index({ user: 1, completedByRun: 1 });

module.exports = mongoose.models.UserDefi || mongoose.model('UserDefi', UserDefiSchema);
