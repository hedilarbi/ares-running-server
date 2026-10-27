const mongoose = require('mongoose');

const DefiImageMetadataSchema = new mongoose.Schema(
  {
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const DefiImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    path: { type: String, required: true },
    metadata: { type: DefiImageMetadataSchema, required: true },
  },
  { _id: false },
);

const DefiSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    kind: {
      type: String,
      enum: ['individuel', 'amis', 'clubs'],
      default: 'individuel',
    },
    goalType: {
      type: String,
      enum: ['distance', 'nb_courses', 'vitesse', 'custom'],
      required: true,
    },
    // Target to reach: metres for 'distance', a count for 'nb_courses', m/s for 'vitesse'.
    goalValue: { type: Number, required: true, min: 0 },
    image: { type: DefiImageSchema, required: true },
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
    period: {
      type: String,
      enum: ['quotidien', 'hebdomadaire', 'mensuel'],
      required: true,
      default: 'quotidien'
    },
    xpReward: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

DefiSchema.index({ isActive: 1 });

module.exports = mongoose.models.Defi || mongoose.model('Defi', DefiSchema);
