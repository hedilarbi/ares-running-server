const mongoose = require('mongoose');

const BadgeImageMetadataSchema = new mongoose.Schema(
  {
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const BadgeImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    path: { type: String, required: true },
    metadata: { type: BadgeImageMetadataSchema, required: true },
  },
  { _id: false },
);

const BadgeSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    label: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    // Uploaded visual for the badge (rendered as-is, no color/emoji fallback).
    image: { type: BadgeImageSchema, required: true },
    category: {
      type: String,
      enum: ['distance', 'frequence', 'vitesse', 'social', 'special'],
      default: 'special',
    },
    // How the badge is awarded. 'manuel' means an admin grants it by hand.
    criteriaType: {
      type: String,
      enum: ['distance_totale', 'nb_courses', 'distance_course', 'vitesse_max', 'manuel'],
      required: true,
    },
    criteriaThreshold: { type: Number, default: 0, min: 0 },
    conditionConfig: {
      isPerRun: { type: Boolean, default: false },
      timeConstraint: { 
        type: String,
        enum: ['none', 'before_8am', 'after_8pm'],
        default: 'none'
      },
      durationMinutes: { type: Number, min: 0 },
      consecutiveDays: { type: Number, min: 0 },
      uniqueLocations: { type: Number, min: 0 },
      beatPrevious: { type: Boolean, default: false },
      ranking: {
        type: String,
        enum: ['none', 'top_100_city', 'top_10_city', 'top_1_city', 'top_10_country'],
        default: 'none'
      }
    },
    xpReward: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Badge || mongoose.model('Badge', BadgeSchema);
