// routes/verification.js - COMPLETE VERSION
const express = require("express");
const router = express.Router();
const multer = require("multer");
const cloudinary = require("../config/cloudinary");
const Verification = require("../models/Verification");

// Configure multer
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Helper function to upload to Cloudinary
const uploadToCloudinary = (fileBuffer, filename) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "farm-verifications",
        resource_type: "image",
        public_id: `verification_${Date.now()}_${filename}`,
        transformation: [
          { width: 1024, height: 1024, crop: "limit" },
          { quality: "auto:good" },
        ],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    uploadStream.end(fileBuffer);
  });
};

// ============================================
// 1. SUBMIT VERIFICATION REQUEST (MODIFIED)
// ============================================
router.post("/submit", upload.array("photos", 3), async (req, res) => {
  try {
    const {
      userId,
      cropName,
      fullName,
      phone,
      village,
      taluk,
      district,
      quantity,
      variety,
      moisture,
      willDry,
      location,
      
    } = req.body;

    // Validate required fields
    if (!userId || !cropName || !req.files || req.files.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        message: "Missing required fields: userId, cropName, or photos",
      });
    }

    // CHECK: Does user already have a pending request?
    const existingPendingRequest = await Verification.findOne({
      userId,
      status: 'pending'
    });

    if (existingPendingRequest) {
      return res.status(409).json({
        statusCode: 409,
        message: "You already have a pending verification request. Please wait for review.",
        data: {
          existingRequestId: existingPendingRequest._id,
          status: existingPendingRequest.status,
          createdAt: existingPendingRequest.createdAt
        }
      });
    }

    // Parse location
    const parsedLocation = JSON.parse(location);
    if (!parsedLocation || !parsedLocation.lat || !parsedLocation.lng) {
      return res.status(400).json({
        statusCode: 400,
        message: "Invalid location data",
      });
    }

    console.log(`Processing ${req.files.length} photos for user ${userId}`);

    // Upload all photos to Cloudinary
    const uploadPromises = req.files.map((file, index) =>
      uploadToCloudinary(file.buffer, `${userId}_${index}`)
    );

    const cloudinaryResults = await Promise.all(uploadPromises);
    
    const photos = cloudinaryResults.map((result) => ({
      url: result.secure_url,
      status: 'pending'
    }));

    console.log("Photos uploaded to Cloudinary:", photos);

    // Create verification document
    const verification = new Verification({
      userId,
      cropName,
      fullName,
      phone,
      village,
      taluk,
      district,
      quantity,
      variety,
      moisture,
      willDry,
      photos,
      location: {
        type: "Point",
        coordinates: [parsedLocation.lng, parsedLocation.lat],
      },
    });

    await verification.save();

    console.log("Verification saved to MongoDB:", verification._id);

    res.status(200).json({
      statusCode: 200,
      message: "Verification submitted successfully",
      data: {
        id: verification._id,
        userId: verification.userId,
        photos: verification.photos,
        status: verification.status,
        createdAt: verification.createdAt,
      },
    });
  } catch (error) {
    console.error("Verification submission error:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Failed to submit verification",
      error: error.message,
    });
  }
});


router.get("/admin/pending", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const pendingRequests = await Verification.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalCount = await Verification.countDocuments({ status: 'pending' });

    res.json({
      statusCode: 200,
      message: "Pending requests fetched successfully",
      data: {
        requests: pendingRequests,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / parseInt(limit)),
          totalRequests: totalCount,
          requestsPerPage: parseInt(limit)
        }
      }
    });
  } catch (error) {
    console.error("Error fetching pending requests:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Error fetching pending requests",
      error: error.message,
    });
  }
});

// ============================================
// 3. REVIEW INDIVIDUAL IMAGES
// ============================================
router.patch("/:id/review-images", async (req, res) => {
  try {
    const { id } = req.params;
    const { approvedPhotoIds } = req.body; // Array of photo _id strings

    if (!approvedPhotoIds || !Array.isArray(approvedPhotoIds)) {
      return res.status(400).json({
        statusCode: 400,
        message: "approvedPhotoIds must be an array",
      });
    }

    // Find verification request
    const verification = await Verification.findById(id);
    
    if (!verification) {
      return res.status(404).json({
        statusCode: 404,
        message: "Verification request not found",
      });
    }

    // Check if already finalized
    if (verification.status !== 'pending') {
      return res.status(400).json({
        statusCode: 400,
        message: `Cannot review images. Request is already ${verification.status}`,
      });
    }

    // Update photo statuses
    verification.photos.forEach(photo => {
      if (approvedPhotoIds.includes(photo._id.toString())) {
        photo.status = 'approved';
      } else {
        photo.status = 'rejected';
      }
    });

    await verification.save();

    const approvedCount = verification.photos.filter(p => p.status === 'approved').length;
    const rejectedCount = verification.photos.filter(p => p.status === 'rejected').length;

    res.json({
      statusCode: 200,
      message: "Image review completed successfully",
      data: {
        id: verification._id,
        photos: verification.photos,
        summary: {
          total: verification.photos.length,
          approved: approvedCount,
          rejected: rejectedCount
        }
      }
    });

  } catch (error) {
    console.error("Error reviewing images:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Error reviewing images",
      error: error.message,
    });
  }
});

// ============================================
// 4. FINALIZE VERIFICATION DECISION
// ============================================
// Update the finalize route to accept locationType

router.patch("/:id/finalize", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason, reviewedBy, locationType } = req.body; // 🆕 Added locationType

    // Validate status
    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        statusCode: 400,
        message: "Status must be 'approved' or 'rejected'",
      });
    }

    // If rejecting, reason is required
    if (status === 'rejected' && !rejectionReason) {
      return res.status(400).json({
        statusCode: 400,
        message: "Rejection reason is required when rejecting a request",
      });
    }

    // 🆕 If approving, locationType is required
    if (status === 'approved' && !locationType) {
      return res.status(400).json({
        statusCode: 400,
        message: "locationType (farm/village) is required when approving a request",
      });
    }

    // Validate locationType if provided
    if (locationType && !['farm', 'village'].includes(locationType)) {
      return res.status(400).json({
        statusCode: 400,
        message: "locationType must be 'farm' or 'village'",
      });
    }

    // Find verification request
    const verification = await Verification.findById(id);
    
    if (!verification) {
      return res.status(404).json({
        statusCode: 404,
        message: "Verification request not found",
      });
    }

    // Check if already finalized
    if (verification.status !== 'pending') {
      return res.status(400).json({
        statusCode: 400,
        message: `Request is already ${verification.status}`,
      });
    }

    // If approving, check if at least one photo is approved
    if (status === 'approved') {
      const approvedPhotos = verification.photos.filter(p => p.status === 'approved');
      
      if (approvedPhotos.length === 0) {
        return res.status(400).json({
          statusCode: 400,
          message: "Cannot approve request. At least one photo must be approved first.",
        });
      }
    }

    // Update verification status
    verification.status = status;
    verification.reviewedAt = new Date();
    
    if (reviewedBy) {
      verification.reviewedBy = reviewedBy;
    }
    
    if (status === 'rejected') {
      verification.rejectionReason = rejectionReason;
    }

    // 🆕 Set location type when approving
    if (status === 'approved' && locationType) {
      verification.location.locationType = locationType;
    }

    await verification.save();

    res.json({
      statusCode: 200,
      message: `Verification request ${status} successfully`,
      data: {
        id: verification._id,
        userId: verification.userId,
        status: verification.status,
        rejectionReason: verification.rejectionReason,
        reviewedAt: verification.reviewedAt,
        reviewedBy: verification.reviewedBy,
        locationType: verification.location.locationType, // 🆕 Return location type
        photos: verification.photos
      }
    });

  } catch (error) {
    console.error("Error finalizing verification:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Error finalizing verification",
      error: error.message,
    });
  }
});

// Add this NEW route after the finalize route

// ============================================
// 4.5 UPDATE LOCATION TYPE (ADMIN)
// ============================================
router.patch("/:id/update-location-type", async (req, res) => {
  try {
    const { id } = req.params;
    const { locationType } = req.body;

    // Validate locationType
    if (!locationType || !['farm', 'village'].includes(locationType)) {
      return res.status(400).json({
        statusCode: 400,
        message: "locationType must be 'farm' or 'village'",
      });
    }

    // Find verification request
    const verification = await Verification.findById(id);
    
    if (!verification) {
      return res.status(404).json({
        statusCode: 404,
        message: "Verification request not found",
      });
    }

    // Update location type
    verification.location.locationType = locationType;
    await verification.save();

    res.json({
      statusCode: 200,
      message: "Location type updated successfully",
      data: {
        id: verification._id,
        locationType: verification.location.locationType,
        coordinates: verification.location.coordinates
      }
    });

  } catch (error) {
    console.error("Error updating location type:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Error updating location type",
      error: error.message,
    });
  }
});
// ============================================
// 5. GET VERIFICATION BY ID (EXISTING - ENHANCED)
// ============================================
router.get("/:id", async (req, res) => {
  try {
    const verification = await Verification.findById(req.params.id);
    if (!verification) {
      return res.status(404).json({
        statusCode: 404,
        message: "Verification not found",
      });
    }

    // 🆕 Add photo summary
    const photoSummary = {
      total: verification.photos.length,
      approved: verification.photos.filter(p => p.status === 'approved').length,
      rejected: verification.photos.filter(p => p.status === 'rejected').length,
      pending: verification.photos.filter(p => p.status === 'pending').length
    };

    res.json({
      statusCode: 200,
      data: {
        ...verification.toObject(),
        photoSummary
      }
    });
  } catch (error) {
    res.status(500).json({
      statusCode: 500,
      message: "Error fetching verification",
      error: error.message,
    });
  }
});

// ============================================
// 6. GET USER'S VERIFICATIONS (EXISTING - ENHANCED)
// ============================================
router.get("/user/:userId", async (req, res) => {
  try {
    const verifications = await Verification.find({
      userId: req.params.userId,
    }).sort({ createdAt: -1 });

    // 🆕 Add summary for each verification
    const enhancedVerifications = verifications.map(v => {
      const photoSummary = {
        total: v.photos.length,
        approved: v.photos.filter(p => p.status === 'approved').length,
        rejected: v.photos.filter(p => p.status === 'rejected').length,
        pending: v.photos.filter(p => p.status === 'pending').length
      };

      return {
        ...v.toObject(),
        photoSummary
      };
    });

    res.json({
      statusCode: 200,
      data: enhancedVerifications,
    });
  } catch (error) {
    res.status(500).json({
      statusCode: 500,
      message: "Error fetching verifications",
      error: error.message,
    });
  }
});

// ============================================
// 7. GET USER'S CURRENT STATUS (NEW)
// ============================================
router.get("/user/:userId/current-status", async (req, res) => {
  try {
    const { userId } = req.params;

    // Find most recent verification
    const latestVerification = await Verification.findOne({ userId })
      .sort({ createdAt: -1 });

    if (!latestVerification) {
      return res.json({
        statusCode: 200,
        message: "No verification requests found",
        data: {
          hasVerification: false,
          canSubmit: true
        }
      });
    }

    const photoSummary = {
      total: latestVerification.photos.length,
      approved: latestVerification.photos.filter(p => p.status === 'approved').length,
      rejected: latestVerification.photos.filter(p => p.status === 'rejected').length,
      pending: latestVerification.photos.filter(p => p.status === 'pending').length
    };

    res.json({
      statusCode: 200,
      message: "Current status fetched successfully",
      data: {
        hasVerification: true,
        canSubmit: latestVerification.status !== 'pending',
        verification: {
          id: latestVerification._id,
          status: latestVerification.status,
          rejectionReason: latestVerification.rejectionReason,
          photoSummary,
          createdAt: latestVerification.createdAt,
          reviewedAt: latestVerification.reviewedAt
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      statusCode: 500,
      message: "Error fetching current status",
      error: error.message,
    });
  }
});

// ============================================
// GET /api/verifications/admin/:status?page=1&limit=100
// Supported statuses: pending | approved | rejected
// Optional query filters: district, taluk, userId, fromDate, toDate
// ============================================
router.get("/admin/:status", async (req, res) => {
  try {
    const { status } = req.params;
    const allowed = ["pending", "approved", "rejected"];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        statusCode: 400,
        message: `Invalid status. Allowed: ${allowed.join(", ")}`,
      });
    }

    // pagination
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.max(1, parseInt(req.query.limit || "10", 10));
    const skip = (page - 1) * limit;

    // optional filters
    const { district, taluk, userId, fromDate, toDate } = req.query;
    const query = { status };

    if (district) query.district = String(district);
    if (taluk) query.taluk = String(taluk);
    if (userId) query.userId = String(userId);

    // date range filter on createdAt (if provided)
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) {
        const f = new Date(String(fromDate));
        if (!isNaN(f.getTime())) query.createdAt.$gte = f;
      }
      if (toDate) {
        const t = new Date(String(toDate));
        if (!isNaN(t.getTime())) query.createdAt.$lte = t;
      }
      // remove createdAt if empty (invalid dates)
      if (Object.keys(query.createdAt).length === 0) delete query.createdAt;
    }

    // fetch total and paginated documents
    const [totalCount, requests] = await Promise.all([
      Verification.countDocuments(query),
      Verification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    // enrich with photoSummary to match front-end expectations
    const enriched = requests.map((v) => {
      const photoSummary = {
        total: Array.isArray(v.photos) ? v.photos.length : 0,
        approved: Array.isArray(v.photos) ? v.photos.filter(p => p.status === "approved").length : 0,
        rejected: Array.isArray(v.photos) ? v.photos.filter(p => p.status === "rejected").length : 0,
        pending: Array.isArray(v.photos) ? v.photos.filter(p => p.status === "pending").length : 0,
      };
      return {
        ...v,
        photoSummary,
      };
    });

    res.json({
      statusCode: 200,
      message: `${status.charAt(0).toUpperCase() + status.slice(1)} requests fetched successfully`,
      data: {
        requests: enriched,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit),
          totalRequests: totalCount,
          requestsPerPage: limit,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching admin verifications by status:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Error fetching requests",
      error: error.message,
    });
  }
});


module.exports = router;