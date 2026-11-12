const mongoose = require('mongoose');

const GroupEventSchema = new mongoose.Schema(
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
      maxlength: 1000,
      default: '',
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    meetingPoint: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '',
    },
    targetDistanceKm: {
      type: Number,
      default: 0,
      min: 0,
    },
    targetPace: {
      type: String,
      trim: true,
      maxlength: 50,
      default: '',
    },
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
    participantCount: {
      type: Number,
      default: 1,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

GroupEventSchema.index({ group: 1, date: 1 });

module.exports = mongoose.models.GroupEvent || mongoose.model('GroupEvent', GroupEventSchema);

