const mongoose = require('mongoose');

const GroupPostSchema = new mongoose.Schema(
  {
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
      required: true,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    run: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Run',
      default: null,
      index: true,
    },
    caption: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    photoUrl: {
      type: String,
      default: '',
    },
    // Detailed GPS route remains hidden by default per privacy rules (Section 5 & 9).
    showRoute: {
      type: Boolean,
      default: false,
    },
    likes: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    likeCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    commentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

// A run is only shared once per group (sparse so posts without a run don't collide).
GroupPostSchema.index(
  { group: 1, run: 1 },
  { unique: true, partialFilterExpression: { run: { $type: 'objectId' } } },
);
GroupPostSchema.index({ group: 1, createdAt: -1 });

module.exports = mongoose.models.GroupPost || mongoose.model('GroupPost', GroupPostSchema);

