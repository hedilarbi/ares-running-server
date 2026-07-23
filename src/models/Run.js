const mongoose = require('mongoose');

const RoutePointSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    timestamp: { type: Number, required: true },
    speed: { type: Number, default: null, min: 0 },
    accuracy: { type: Number, default: null, min: 0 },
    altitude: { type: Number, default: null },
  },
  { _id: false },
);

const PhotoMetadataSchema = new mongoose.Schema(
  {
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const PhotoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    path: { type: String, required: true },
    metadata: { type: PhotoMetadataSchema, required: true },
  },
  { _id: false },
);

const RunSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    clientRunId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    durationSeconds: { type: Number, required: true, min: 1 },
    distanceMetres: { type: Number, required: true, min: 0 },
    averageSpeedMps: { type: Number, required: true, min: 0 },
    maxSpeedMps: { type: Number, required: true, min: 0 },
    averagePaceSecondsPerKm: { type: Number, required: true, min: 0 },
    caloriesKcal: { type: Number, required: true, min: 0 },
    routePoints: {
      type: [RoutePointSchema],
      required: true,
    },
    photo: { type: PhotoSchema, default: null },
  },
  { timestamps: true },
);

RunSchema.index({ user: 1, clientRunId: 1 }, { unique: true });
RunSchema.index({ user: 1, startedAt: -1 });

module.exports = mongoose.models.Run || mongoose.model('Run', RunSchema);
