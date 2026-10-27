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
    // Seed starter défi catalog (badges are created by admins via the dashboard, since they require an uploaded image)
    await seedDefis();
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

const seedDefis = async () => {
  const Defi = mongoose.model('Defi');

  try {
    const existingDefis = await Defi.countDocuments();
    if (existingDefis === 0) {
      const now = new Date();
      const inDays = (days) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

      await Defi.insertMany([
        {
          title: 'Courir 20 km cette semaine',
          description: 'Cumulez 20 km de course sur les 7 prochains jours.',
          kind: 'individuel',
          goalType: 'distance',
          goalValue: 20_000,
          startAt: now,
          endAt: inDays(7),
          xpReward: 300,
        },
        {
          title: '3 courses cette semaine',
          description: 'Enregistrez 3 courses sur les 7 prochains jours.',
          kind: 'individuel',
          goalType: 'nb_courses',
          goalValue: 3,
          startAt: now,
          endAt: inDays(7),
          xpReward: 150,
        },
        {
          title: 'Courir 100 km dans le mois',
          description: 'Cumulez 100 km de course sur les 30 prochains jours.',
          kind: 'individuel',
          goalType: 'distance',
          goalValue: 100_000,
          startAt: now,
          endAt: inDays(30),
          xpReward: 800,
        },
      ]);
      console.log('Starter défi catalog seeded successfully.');
    }
  } catch (error) {
    console.error('Error seeding badges/défis catalog:', error.message);
  }
};

module.exports = connectDB;
