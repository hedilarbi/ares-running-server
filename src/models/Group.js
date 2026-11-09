const mongoose = require('mongoose');

const GroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    photo: {
      type: String,
      default: '',
    },
    photoStoragePath: {
      type: String,
      default: '',
    },
    type: {
      type: String,
      enum: ['club', 'amis'],
      required: true,
      default: 'club',
    },
    city: {
      type: String,
      default: '',
      trim: true,
    },
    governorate: {
      type: String,
      default: '',
      trim: true,
    },
    country: {
      type: String,
      default: 'Tunisie',
      trim: true,
    },
    privacy: {
      type: String,
      enum: ['public', 'private'],
      default: 'public',
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    memberCount: {
      type: Number,
      default: 1,
      min: 0,
    },
    totalDistanceMetres: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalRunsCount: {
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

GroupSchema.index({ isActive: 1, city: 1 });
GroupSchema.index({ isActive: 1, governorate: 1 });
GroupSchema.index({ isActive: 1, country: 1 });
GroupSchema.index({ name: 1 });

module.exports = mongoose.models.Group || mongoose.model('Group', GroupSchema);

