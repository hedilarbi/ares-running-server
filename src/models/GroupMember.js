const mongoose = require('mongoose');

const GroupMemberSchema = new mongoose.Schema(
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
    role: {
      type: String,
      enum: ['admin', 'member'],
      default: 'member',
    },
    status: {
      type: String,
      enum: ['active', 'pending_request', 'invited'],
      default: 'active',
    },
    // Respects user privacy preferences: whether their valid GPS runs are
    // automatically counted in this group's totals and leaderboards.
    autoContributeKm: {
      type: Boolean,
      default: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

GroupMemberSchema.index({ group: 1, user: 1 }, { unique: true });
GroupMemberSchema.index({ user: 1, status: 1 });
GroupMemberSchema.index({ group: 1, status: 1 });

module.exports = mongoose.models.GroupMember || mongoose.model('GroupMember', GroupMemberSchema);

