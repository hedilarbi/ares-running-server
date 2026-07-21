const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// Register models
require('./src/models/User');

const connectDB = require('./src/db');
const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

const PORT = 3005;
const BASE_URL = `http://localhost:${PORT}`;

const runVerification = async () => {
  let server;
  try {
    console.log('Connecting to database...');
    await connectDB();
    
    console.log('Starting verification server on port', PORT);
    server = app.listen(PORT);
    
    const User = mongoose.model('User');
    
    // Clean up previous runs
    console.log('Cleaning up previous test accounts...');
    await User.deleteMany({ email: { $in: ['test@runner.com', 'firebase@runner.com'] } });

    console.log('\n--- VERIFICATION START ---');

    // 1. Test Register
    console.log('\n1. Testing User Registration (POST /api/auth/register)...');
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@runner.com', password: 'password123' })
    });
    const regData = await regRes.json();
    console.log('Register Response:', regRes.status, regData);
    if (regRes.status !== 201) throw new Error('Registration failed');

    // Retrieve OTP directly from Database (mimicking checking user email inbox)
    const testUser = await User.findOne({ email: 'test@runner.com' });
    const otpCode = testUser.otpCode;
    console.log(`Found OTP in DB for test@runner.com: ${otpCode}`);

    // 2. Test OTP Verification
    console.log('\n2. Testing OTP Verification (POST /api/auth/verify-otp)...');
    const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@runner.com', otpCode })
    });
    const verifyData = await verifyRes.json();
    console.log('Verify OTP Response:', verifyRes.status, verifyData);
    if (verifyRes.status !== 200) throw new Error('OTP verification failed');
    const userToken = verifyData.token;
    const userId = verifyData.user.id;

    // 3. Test User Login
    console.log('\n3. Testing User Login (POST /api/auth/login)...');
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@runner.com', password: 'password123' })
    });
    const loginData = await loginRes.json();
    console.log('Login Response:', loginRes.status, loginData);
    if (loginRes.status !== 200) throw new Error('Login failed');

    // 4. Test Firebase Social Login Mock
    console.log('\n4. Testing Firebase Mock Login (POST /api/auth/firebase-login)...');
    const fbRes = await fetch(`${BASE_URL}/api/auth/firebase-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        idToken: 'mock-token', 
        email: 'firebase@runner.com', 
        name: 'Firebase Runner', 
        photo: 'http://photo.url' 
      })
    });
    const fbData = await fbRes.json();
    console.log('Firebase Login Response:', fbRes.status, fbData);
    if (fbRes.status !== 200) throw new Error('Firebase login failed');

    // 5. Test Profile Setup (PUT /api/auth/profile-setup)
    console.log('\n5. Testing Profile Setup (PUT /api/auth/profile-setup)...');
    const setupRes = await fetch(`${BASE_URL}/api/auth/profile-setup`, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({
        name: 'Oussema Runner',
        sex: 'Homme',
        dateOfBirth: '1998-03-14',
        height: 178,
        weight: 72,
        city: 'Tunis',
        country: 'Tunisie',
        photo: 'data:image/png;base64,mockedbase64imagedatashouldgohere'
      })
    });
    const setupData = await setupRes.json();
    console.log('Profile Setup Response:', setupRes.status, setupData);
    if (setupRes.status !== 200) throw new Error('Profile setup failed');

    // 6. Test Admin Login
    console.log('\n6. Testing Admin Login (POST /api/admin/login)...');
    const adminLoginRes = await fetch(`${BASE_URL}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@gmail.com', password: '12312312' })
    });
    const adminLoginData = await adminLoginRes.json();
    console.log('Admin Login Response:', adminLoginRes.status, adminLoginData);
    if (adminLoginRes.status !== 200) throw new Error('Admin login failed');
    const adminToken = adminLoginData.token;

    // 7. Test Admin User List
    console.log('\n7. Testing Admin Fetch User List (GET /api/admin/users)...');
    const usersListRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const usersListData = await usersListRes.json();
    console.log('Admin User List Response:', usersListRes.status, `Found ${usersListData.users.length} users.`);
    if (usersListRes.status !== 200) throw new Error('Fetch users list failed');

    // 8. Test Admin Single User Detail
    console.log('\n8. Testing Admin Fetch User Details (GET /api/admin/users/:id)...');
    const userDetailRes = await fetch(`${BASE_URL}/api/admin/users/${userId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const userDetailData = await userDetailRes.json();
    console.log('Admin User Details Response:', userDetailRes.status, userDetailData);
    if (userDetailRes.status !== 200) throw new Error('Fetch user details failed');

    console.log('\n✅ ALL BACKEND API VERIFICATIONS COMPLETED SUCCESSFULLY!');
  } catch (error) {
    console.error('\n❌ VERIFICATION FAILED:', error.message);
  } finally {
    if (server) {
      console.log('\nStopping verification server...');
      server.close();
    }
    console.log('Disconnecting from database...');
    await mongoose.disconnect();
    console.log('Done.');
  }
};

runVerification();
