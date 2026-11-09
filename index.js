const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// Register models first
require('./src/models/User');
require('./src/models/Run');
require('./src/models/Badge');
require('./src/models/UserBadge');
require('./src/models/Defi');
require('./src/models/UserDefi');
require('./src/models/Group');
require('./src/models/GroupMember');
require('./src/models/GroupRunContribution');
require('./src/models/GroupPost');
require('./src/models/GroupPostComment');
require('./src/models/GroupChallenge');
require('./src/models/GroupChallengeParticipant');
require('./src/models/GroupReport');
require('./src/models/Notification');

const connectDB = require('./src/db');
const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const userRoutes = require('./src/routes/user');
const runRoutes = require('./src/routes/runs');
const defiRoutes = require('./src/routes/defis');
const groupRoutes = require('./src/routes/groups');
const notificationRoutes = require('./src/routes/notifications');

const app = express();
const PORT = process.env.PORT || 5001;

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Enable CORS (configurable via CORS_ORIGINS in production)
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors(
    allowedOrigins.length > 0
      ? {
          origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) {
              return callback(null, true);
            }
            return callback(new Error('Origine non autorisée par CORS'));
          },
          credentials: true,
        }
      : undefined,
  ),
);

// Body parser configuration
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Ensure MongoDB is connected before handling API requests (vital on serverless/Vercel)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    res.status(503).json({ error: 'Service de base de données temporairement indisponible.' });
  }
});

// Set up routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/runs', runRoutes);
app.use('/api/defis', defiRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/notifications', notificationRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ARES Running API is running.' });
});

// Connect to Database and start server when run directly
const startServer = async () => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

if (require.main === module) {
  startServer();
}

module.exports = app;
