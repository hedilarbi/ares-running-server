const mongoose = require('mongoose');

const RunCommentSchema = new mongoose.Schema(
  {
    run: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Run',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    text: { type: String, required: true, trim: true, minlength: 1, maxlength: 500 },
  },
  { timestamps: true },
);

// Comments of a run, oldest first, paginated by _id.
RunCommentSchema.index({ run: 1, _id: 1 });

module.exports = mongoose.models.RunComment || mongoose.model('RunComment', RunCommentSchema);
