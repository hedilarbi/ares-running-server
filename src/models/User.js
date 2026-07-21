const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true, 
    trim: true 
  },
  password: { 
    type: String, 
    required: true 
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  provider: {
    type: String,
    enum: ['email', 'google', 'apple'],
    default: 'email'
  },
  name: {
    type: String,
    default: ''
  },
  pseudo: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    match: /^[a-zA-Z0-9_.]+$/,
  },
  photo: { 
    type: String, 
    default: '' 
  }, // Base64 profile image
  sex: { 
    type: String, 
    enum: ['Homme', 'Femme', 'Autre', ''], 
    default: '' 
  },
  dateOfBirth: { 
    type: String, 
    default: '' 
  }, // YYYY-MM-DD
  height: { 
    type: Number, 
    default: 0 
  },
  weight: { 
    type: Number, 
    default: 0 
  },
  city: { 
    type: String, 
    default: '' 
  },
  governorate: {
    type: String,
    default: ''
  },
  country: { 
    type: String, 
    default: '' 
  },
  level: { 
    type: String, 
    default: 'Débutant' 
  },
  xp: { 
    type: Number, 
    default: 0 
  },
  
  // Verification fields
  isVerified: { 
    type: Boolean, 
    default: false 
  },
  otpCode: { 
    type: String, 
    default: '' 
  },
  otpExpiresAt: { 
    type: Date 
  },
  
  followers: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  following: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Avoid compiling model if it's already registered
module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
