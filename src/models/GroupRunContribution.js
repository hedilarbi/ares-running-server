const mongoose = require('mongoose');

const GroupRunContributionSchema = new mongoose.Schema(
  {
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    run: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Run',
      required: true,
      index: true,
    },
    distanceMetres: {
      type: Number,
      required: true,
      min: 0,
    },
    durationSeconds: {
      type: Number,
      required: true,
      min: 0,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    // YYYY-MM-DD in APP_TIMEZONE, used to compute regularity (distinct active days).
    localDay: {
      type: String,
      required: true,
    },
    // ISO week ("2026-W45") and month ("2026-11") in APP_TIMEZONE for fast period queries.
    weekPeriodId: {
      type: String,
      required: true,
      index: true,
    },
    monthPeriodId: {
      type: String,
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

// Guarantees a run is counted at most once per group.
GroupRunContributionSchema.index({ group: 1, run: 1 }, { unique: true });
GroupRunContributionSchema.index({ group: 1, weekPeriodId: 1, user: 1 });
GroupRunContributionSchema.index({ group: 1, monthPeriodId: 1, user: 1 });

module.exports =
  mongoose.models.GroupRunContribution ||
  mongoose.model('GroupRunContribution', GroupRunContributionSchema);

