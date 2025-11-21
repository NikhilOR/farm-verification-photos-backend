// models/Verification.js
const mongoose = require('mongoose');

// Helper function to generate requestId
const generateRequestId = () => {
  const year = new Date().getFullYear();
  const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `OR-REQ-${year}-${randomPart}`;
};

const verificationSchema = new mongoose.Schema({
    requestId: { 
    type: String, 
    unique: true,
    required: true,
    default: generateRequestId
  },
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
verificationSchema.index({ requestId: 1 });

// Update timestamp before saving
verificationSchema.pre('save', async function(next) {
  this.updatedAt = Date.now();
  
  // Only generate requestId for new documents
  if (this.isNew && !this.requestId) {
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;
    
    while (!isUnique && attempts < maxAttempts) {
      const newRequestId = generateRequestId();
      const existing = await mongoose.model('Verification').findOne({ requestId: newRequestId });
      if (!existing) {
        this.requestId = newRequestId;
        isUnique = true;
      }
      attempts++;
    }
    
    if (!isUnique) {
      return next(new Error('Failed to generate unique requestId'));
    }
  }
  
  next();
});

module.exports = mongoose.model('Verification', verificationSchema);