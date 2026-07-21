const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is not defined in the environment variables.');
    }
    
    await mongoose.connect(uri);
    console.log('MongoDB connected successfully.');
    
    // Seed admin user
    await seedAdmin();
  } catch (error) {
    console.error('Database connection failed:', error.message);
    process.exit(1);
  }
};

const seedAdmin = async () => {
  const User = mongoose.model('User');
  try {
    const adminEmail = 'admin@gmail.com';
    const adminExists = await User.findOne({ email: adminEmail });
    
    if (!adminExists) {
      const hashedPassword = await bcrypt.hash('12312312', 10);
      const adminUser = new User({
        email: adminEmail,
        password: hashedPassword,
        role: 'admin',
        name: 'Ares Admin',
        isVerified: true,
      });
      
      await adminUser.save();
      console.log('Default admin user seeded successfully (admin@gmail.com / 12312312).');
    } else {
      console.log('Admin user already exists.');
    }
  } catch (error) {
    console.error('Error seeding admin user:', error.message);
  }
};

module.exports = connectDB;
