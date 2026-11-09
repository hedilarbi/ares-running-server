const mongoose = require('mongoose');

const GroupChallengeSchema = new mongoose.Schema(
  {
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
      index: true,
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    // 'individuel': each participant works toward goalValue (e.g. 30 km in 7 days).
    // 'collectif': all participants contribute to a single group total (e.g. 500 km in 1 month).
    mode: {
      type: String,
      enum: ['individuel', 'collectif'],
      default: 'individuel',
    },
    goalType: {
      type: String,
      enum: ['distance', 'nb_courses'],
      required: true,
      default: 'distance',
    },
    // Metres when goalType === 'distance', run count when goalType === 'nb_courses'.
    goalValue: {
      type: Number,
      required: true,
      min: 1,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    // For collective challenges, tracks the total across all enrolled members.
    collectiveProgressValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    collectiveCountedRuns: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Run' }],
      default: [],
    },
    participantCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

GroupChallengeSchema.index({ group: 1, endDate: -1 });

module.exports =
  mongoose.models.GroupChallenge ||
  mongoose.model('GroupChallenge', GroupChallengeSchema);

