const mongoose = require('mongoose');

const GroupChallengeParticipantSchema = new mongoose.Schema(
  {
    challenge: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GroupChallenge',
      required: true,
      index: true,
    },
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
    progressValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['en_cours', 'termine'],
      default: 'en_cours',
    },
    // Guarantees a run is counted only once in the same challenge.
    countedRuns: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Run' }],
      default: [],
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

GroupChallengeParticipantSchema.index({ challenge: 1, user: 1 }, { unique: true });
GroupChallengeParticipantSchema.index({ user: 1, status: 1 });

module.exports =
  mongoose.models.GroupChallengeParticipant ||
  mongoose.model('GroupChallengeParticipant', GroupChallengeParticipantSchema);

