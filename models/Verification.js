// models/Verification.js
const mongoose = require('mongoose');

const verificationSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  cropId: { type: String, required: true },
  cropName: { type: String, required: true },
  fullName: String,
  phone: String,
  village: String,
  taluk: String,
  district: String,
  quantity: String,
  variety: String,
  moisture: String,
  willDry: String,
  
  // Photos with individual approval status
  photos: [{
    url: { type: String, required: true },
    status: { 
      type: String, 
      enum: ['pending', 'approved', 'rejected'], 
      default: 'pending' 
    },
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true }
  }],
  
  // Location - locationType is OPTIONAL now, set by admin later
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }, // [lng, lat]
    locationType: { 
      type: String, 
      enum: ['farm', 'village'], 
      required: false
    }
  },
  
  // Overall verification status
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending' 
  },
  
  // 🔄 CHANGED: Rejection reason with predefined options
  rejectionReason: { 
    type: String,
    enum: [
      'poor_photo_quality',           // Photos are blurry or unclear
      'face_not_visible',             // Face not clearly visible in photos
      'incorrect_location',           // Location doesn't match farm/village
      'insufficient_photos',          // Not enough photos provided
      'duplicate_request',            // User already has pending/approved request
      'crop_mismatch',                // Crop in photo doesn't match declared crop
      'fake_or_manipulated',          // Photos appear fake or edited
      'incomplete_information',       // Missing required information
      'suspicious_activity',          // Potentially fraudulent activity detected
      'other'                         // Other reasons (can add notes separately)
    ]
  },
  
  // 🆕 ADDED: Optional additional notes for rejection (if reason is 'other' or needs explanation)
  rejectionNotes: { type: String },
  
  // Review metadata
  reviewedAt: { type: Date },
  reviewedBy: { type: String },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Indexes
verificationSchema.index({ location: '2dsphere' });
verificationSchema.index({ userId: 1 });
verificationSchema.index({ cropId: 1 });
verificationSchema.index({ status: 1 });

// Update timestamp before saving
verificationSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Verification', verificationSchema);