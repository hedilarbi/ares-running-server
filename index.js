const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// Register models first
require('./src/models/User');
require('./src/models/Run');

const connectDB = require('./src/db');
const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const userRoutes = require('./src/routes/user');
const runRoutes = require('./src/routes/runs');

const app = express();
const PORT = process.env.PORT || 5001;

// Enable CORS
app.use(cors());

// Body parser configuration
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Set up routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/runs', runRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ARES Running API is running.' });
});

// Connect to Database and start server
const startServer = async () => {
  await connectDB();

  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

startServer();
