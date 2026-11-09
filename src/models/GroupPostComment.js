const mongoose = require('mongoose');

const GroupPostCommentSchema = new mongoose.Schema(
  {
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GroupPost',
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
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true },
);

GroupPostCommentSchema.index({ post: 1, _id: 1 });

module.exports =
  mongoose.models.GroupPostComment ||
  mongoose.model('GroupPostComment', GroupPostCommentSchema);

