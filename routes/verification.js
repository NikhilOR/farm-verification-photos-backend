// routes/verification.js - REORGANIZED ROUTES IN CORRECT ORDER
const express = require("express");
const router = express.Router();
const multer = require("multer");
const axios = require("axios");
const cloudinary = require("../config/cloudinary");
const Verification = require("../models/Verification");
const mongoose = require('mongoose');

const escapeRegex = (str) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// 🆕 ADDED: Crop API configuration
const CROP_API_URL = process.env.CROP_API_URL || "https://markhet-internal-ngfs.onrender.com";

// 🆕 ADDED: Helper function to fetch crop data
async function fetchCropData(cropId) {
  try {
    const response = await axios.get(`${CROP_API_URL}/crop/get-crop-by-id/${cropId}`);
    if (response.data.code === 200) {
      return response.data.data;
    }
    throw new Error(response.data.message || "Failed to fetch crop data");
  } catch (error) {
    console.error("Error fetching crop data:", error.message);
    throw error;
  }
}


// Configure multer
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
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
// ROUTE ORDER (Most specific to least specific)
// ============================================

// ============================================
// 1. SUBMIT VERIFICATION REQUEST (Most specific POST route)
// ============================================
router.post("/submit", upload.array("photos", 3), async (req, res) => {
  try {
    const {
      cropId,
      location,
      fullName,
      phone,
      village,
      taluk,
      district,
      quantity,
      variety,
      moisture,
      willDry,
    } = req.body;

    if (!cropId || !req.files || req.files.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        message: "Missing required fields: cropId or photos",
      });
    }

    let cropData;
    try {
      cropData = await fetchCropData(cropId);
      console.log(`✅ Fetched crop data for cropId: ${cropId}`);
    } catch (error) {
      return res.status(404).json({
        statusCode: 404,
        message: "Crop not found or unable to fetch crop data",
        error: error.message,
      });
    }

    const userId = cropData.farm.user.id;
    const cropName = cropData.cropName;
    const farmData = cropData.farm;
    const userData = cropData.farm.user;

    console.log(`📍 Processing verification for userId: ${userId}, cropId: ${cropId}, cropName: ${cropName}`);

    const existingRequest = await Verification.findOne({ cropId }).sort({
      createdAt: -1,
    });

    if (existingRequest) {
      const status = existingRequest.status;

      if (status === "pending") {
        return res.status(409).json({
          statusCode: 409,
          message: "Your request is under review by the support team.",
          data: {
            existingRequestId: existingRequest._id,
            status: existingRequest.status,
            createdAt: existingRequest.createdAt,
            canSubmit: false,
          },
        });
      }

      if (status === "approved") {
        return res.status(409).json({
          statusCode: 409,
          message: "Cannot submit new request. You are already verified.",
          data: {
            existingRequestId: existingRequest._id,
            status: existingRequest.status,
            approvedAt: existingRequest.reviewedAt,
            canSubmit: false,
          },
        });
      }

      if (status === "rejected") {
        console.log(
          `User ${userId} has rejected request. Allowing new submission (will create new record).`
        );
      }
    }

    const parsedLocation = JSON.parse(location);
    if (!parsedLocation || !parsedLocation.lat || !parsedLocation.lng) {
      return res.status(400).json({
        statusCode: 400,
        message: "Invalid location data",
      });
    }

    console.log(`Processing ${req.files.length} photos for user ${userId}`);

    const uploadPromises = req.files.map((file, index) =>
      uploadToCloudinary(file.buffer, `${userId}_${cropId}_${index}`)
    );

    const cloudinaryResults = await Promise.all(uploadPromises);

    const photos = cloudinaryResults.map((result) => ({
      url: result.secure_url,
      status: "pending",
    }));

    console.log("Photos uploaded to Cloudinary:", photos);

    const verificationData = {
      userId: userId,
      cropId: cropId,
      cropName: cropName,
      fullName: fullName || userData.name || "",
      phone: phone || userData.mobileNumber?.replace("+91", "") || "",
      village: village || farmData.village || "",
      taluk: taluk || farmData.taluk || "",
      district: district || farmData.district || "",
      quantity: quantity || (cropData.quantity && cropData.measure 
        ? `${cropData.quantity} ${cropData.measure}` 
        : ""),
      variety: variety || cropData.maizeVariety || cropData.otherVarietyName || "",
      moisture: moisture || cropData.moisturePercent?.toString() || "",
      willDry: willDry || (cropData.willYouDryIt === true 
        ? "Yes" 
        : cropData.willYouDryIt === false 
        ? "No" 
        : ""),
    };

    const verification = new Verification({
      ...verificationData,
      photos,
      location: {
        type: "Point",
        coordinates: [parsedLocation.lng, parsedLocation.lat],
      },
      status: "pending",
    });

    await verification.save();

    console.log("✅ New verification created:", verification._id);

    if (existingRequest && existingRequest.status === "rejected") {
      console.log(
        `🔄 New request created for userId ${userId} after previous rejection (ID: ${existingRequest._id})`
      );
    }

    res.status(200).json({
      statusCode: 200,
      message: "Verification submitted successfully",
      data: {
        id: verification._id,
        userId: verification.userId,
        cropId: verification.cropId,
        cropName: verification.cropName,
        photos: verification.photos,
        status: verification.status,
        createdAt: verification.createdAt,
        isResubmission:
          existingRequest && existingRequest.status === "rejected",
      },
    });
  } catch (error) {
    console.error("❌ Verification submission error:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Failed to submit verification",
      error: error.message,
    });
  }
});

// ============================================
// 2. ADMIN ROUTE (Specific path with :status parameter)
// ============================================
router.get("/admin/:status", async (req, res) => {
  try {
    const { status } = req.params;
    const allowed = ["pending", "approved", "rejected", "all"];

    if (!allowed.includes(status)) {
      return res.status(400).json({
        statusCode: 400,
        message: `Invalid status. Allowed: ${allowed.join(", ")}`,
      });
    }

    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.max(
      1,
      Math.min(100, parseInt(req.query.limit || "10", 10))
    );
    const skip = (page - 1) * limit;

    const query = {};

    if (status !== "all") {
      query.status = status;
    }

    const {
      userId,
      cropId,
      phone,
      fullName,
      cropName,
      village,
      taluk,
      district,
      fromDate,
      toDate,
    } = req.query;

    if (userId) {
      query.userId = String(userId).trim();
    }

    if (cropId) {
      query.cropId = String(cropId).trim();
    }

    if (phone) {
      const escapedPhone = escapeRegex(String(phone).trim());
      query.phone = new RegExp(escapedPhone, "i");
    }

    if (fullName) {
      const escapedFullName = escapeRegex(String(fullName).trim());
      query.fullName = new RegExp(escapedFullName, "i");
    }

    if (cropName) {
      const escapedCropName = escapeRegex(String(cropName).trim());
      query.cropName = new RegExp(escapedCropName, "i");
    }

    if (village) {
      const escapedVillage = escapeRegex(String(village).trim());
      query.village = new RegExp(escapedVillage, "i");
    }

    if (taluk) {
      const escapedTaluk = escapeRegex(String(taluk).trim());
      query.taluk = new RegExp(escapedTaluk, "i");
    }

    if (district) {
      const escapedDistrict = escapeRegex(String(district).trim());
      query.district = new RegExp(escapedDistrict, "i");
    }

    if (fromDate || toDate) {
      query.createdAt = {};

      if (fromDate) {
        const f = new Date(String(fromDate));
        if (!isNaN(f.getTime())) {
          f.setUTCHours(0, 0, 0, 0);
          query.createdAt.$gte = f;
        }
      }

      if (toDate) {
        const t = new Date(String(toDate));
        if (!isNaN(t.getTime())) {
          t.setUTCHours(23, 59, 59, 999);
          query.createdAt.$lte = t;
        }
      }

      if (Object.keys(query.createdAt).length === 0) {
        delete query.createdAt;
      }
    }

    console.log('🔍 Applied Query Filters:', JSON.stringify(query, null, 2));

    const [totalCount, requests] = await Promise.all([
      Verification.countDocuments(query),
      Verification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    console.log(`✅ Found ${totalCount} total results, returning ${requests.length} on page ${page}`);

    const enriched = requests.map((v) => {
      const photoSummary = {
        total: Array.isArray(v.photos) ? v.photos.length : 0,
        approved: Array.isArray(v.photos)
          ? v.photos.filter((p) => p.status === "approved").length
          : 0,
        rejected: Array.isArray(v.photos)
          ? v.photos.filter((p) => p.status === "rejected").length
          : 0,
        pending: Array.isArray(v.photos)
          ? v.photos.filter((p) => p.status === "pending").length
          : 0,
      };

      return {
        ...v,
        photoSummary,
      };
    });

    const appliedFilters = {};
    if (userId) appliedFilters.userId = userId;
    if (cropId) appliedFilters.cropId = cropId;
    if (phone) appliedFilters.phone = phone;
    if (fullName) appliedFilters.fullName = fullName;
    if (cropName) appliedFilters.cropName = cropName;
    if (village) appliedFilters.village = village;
    if (taluk) appliedFilters.taluk = taluk;
    if (district) appliedFilters.district = district;
    if (fromDate) appliedFilters.fromDate = fromDate;
    if (toDate) appliedFilters.toDate = toDate;

    res.json({
      statusCode: 200,
      message: `${
        status === "all"
          ? "All"
          : status.charAt(0).toUpperCase() + status.slice(1)
      } requests fetched successfully`,
      data: {
        requests: enriched,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit),
          totalRequests: totalCount,
          requestsPerPage: limit,
          hasNextPage: page < Math.ceil(totalCount / limit),
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error("❌ Error fetching admin verifications:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Error fetching requests",
      error: error.message,
    });
  }
});

// ============================================
// 3. USER CURRENT STATUS (Specific multi-segment path)
// ============================================
router.get("/crop/:cropId/current-status", async (req, res) => {
  try {
    const { cropId } = req.params;

    const latestVerification = await Verification.findOne({ cropId }).sort({
      createdAt: -1,
    });

    if (!latestVerification) {
      return res.json({
        statusCode: 200,
        message: "No verification requests found",
        data: {
          hasVerification: false,
          canSubmit: true,
          status: null,
        },
      });
    }

    const photoSummary = {
      total: latestVerification.photos.length,
      approved: latestVerification.photos.filter((p) => p.status === "approved")
        .length,
      rejected: latestVerification.photos.filter((p) => p.status === "rejected")
        .length,
      pending: latestVerification.photos.filter((p) => p.status === "pending")
        .length,
    };

    let canSubmit = false;
    let blockMessage = null;

    switch (latestVerification.status) {
      case "pending":
        canSubmit = false;
        blockMessage = "Your request is under review by the support team.";
        break;

      case "approved":
        canSubmit = false;
        blockMessage = "Cannot submit new request. This crop is already verified.";
        break;

      case "rejected":
        canSubmit = true;
        blockMessage = null;
        break;

      default:
        canSubmit = false;
        blockMessage = "Unknown status. Please contact support.";
    }

    res.json({
      statusCode: 200,
      message: "Current status fetched successfully",
      data: {
        hasVerification: true,
        canSubmit: canSubmit,
        blockMessage: blockMessage,
        verification: {
          id: latestVerification._id,
          status: latestVerification.status,
          rejectionReason: latestVerification.rejectionReason,
          rejectionNotes: latestVerification.rejectionNotes,
          photoSummary,
          createdAt: latestVerification.createdAt,
          reviewedAt: latestVerification.reviewedAt,
        },
      },
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
// 4. USER VERIFICATIONS (Specific path)
// ============================================
router.get("/user/:userId", async (req, res) => {
  try {
    const verifications = await Verification.find({
      userId: req.params.userId,
    }).sort({ createdAt: -1 });

    const enhancedVerifications = verifications.map((v) => {
      const photoSummary = {
        total: v.photos.length,
        approved: v.photos.filter((p) => p.status === "approved").length,
        rejected: v.photos.filter((p) => p.status === "rejected").length,
        pending: v.photos.filter((p) => p.status === "pending").length,
      };

      return {
        ...v.toObject(),
        photoSummary,
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
// 5. REVIEW IMAGES (Specific action on :id)
// ============================================
router.patch("/:id/review-images", async (req, res) => {
  try {
    const { id } = req.params;
    const { approvedPhotoIds } = req.body;

    if (!approvedPhotoIds || !Array.isArray(approvedPhotoIds)) {
      return res.status(400).json({
        statusCode: 400,
        message: "approvedPhotoIds must be an array",
      });
    }

    const verification = await Verification.findById(id);

    if (!verification) {
      return res.status(404).json({
        statusCode: 404,
        message: "Verification request not found",
      });
    }

    if (verification.status !== "pending") {
      return res.status(400).json({
        statusCode: 400,
        message: `Cannot review images. Request is already ${verification.status}`,
      });
    }

    verification.photos.forEach((photo) => {
      if (approvedPhotoIds.includes(photo._id.toString())) {
        photo.status = "approved";
      } else {
        photo.status = "rejected";
      }
    });

    await verification.save();

    const approvedCount = verification.photos.filter(
      (p) => p.status === "approved"
    ).length;
    const rejectedCount = verification.photos.filter(
      (p) => p.status === "rejected"
    ).length;

    res.json({
      statusCode: 200,
      message: "Image review completed successfully",
      data: {
        id: verification._id,
        photos: verification.photos,
        summary: {
          total: verification.photos.length,
          approved: approvedCount,
          rejected: rejectedCount,
        },
      },
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
// 6. FINALIZE VERIFICATION (Specific action on :id)
// ============================================

router.patch("/:id/finalize", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason, rejectionNotes, reviewedBy, locationType } = req.body;

    if (!status || !["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        statusCode: 400,
        message: "Status must be 'approved' or 'rejected'",
      });
    }

    if (status === "rejected" && !rejectionReason) {
      return res.status(400).json({
        statusCode: 400,
        message: "Rejection reason is required when rejecting a request",
      });
    }

    const validRejectionReasons = [
      'poor_photo_quality',
      'face_not_visible',
      'incorrect_location',
      'insufficient_photos',
      'duplicate_request',
      'crop_mismatch',
      'fake_or_manipulated',
      'incomplete_information',
      'suspicious_activity',
      'other'
    ];

    if (status === "rejected" && !validRejectionReasons.includes(rejectionReason)) {
      return res.status(400).json({
        statusCode: 400,
        message: `Invalid rejection reason. Must be one of: ${validRejectionReasons.join(', ')}`,
      });
    }

    if (status === "approved" && !locationType) {
      return res.status(400).json({
        statusCode: 400,
        message:
          "locationType (farm/village) is required when approving a request",
      });
    }

    if (locationType && !["farm", "village"].includes(locationType)) {
      return res.status(400).json({
        statusCode: 400,
        message: "locationType must be 'farm' or 'village'",
      });
    }

    const verification = await Verification.findById(id);

    if (!verification) {
      return res.status(404).json({
        statusCode: 404,
        message: "Verification request not found",
      });
    }

    if (verification.status !== "pending") {
      return res.status(400).json({
        statusCode: 400,
        message: `Request is already ${verification.status}`,
      });
    }

    // Get approved photos
    const approvedPhotos = verification.photos.filter(
      (p) => p.status === "approved"
    );

    if (status === "approved" && approvedPhotos.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        message:
          "Cannot approve request. At least one photo must be approved first.",
      });
    }

    // Update verification status
    verification.status = status;
    verification.reviewedAt = new Date();

    if (reviewedBy) {
      verification.reviewedBy = reviewedBy;
    }

    if (status === "rejected") {
      verification.rejectionReason = rejectionReason;
      if (rejectionNotes) {
        verification.rejectionNotes = rejectionNotes;
      }
    }

    if (status === "approved" && locationType) {
      verification.location.locationType = locationType;
    }

    await verification.save();

    // 🆕 PATCH CROP API - Update images and location if there are approved photos
    let cropUpdateResult = null;
    if (approvedPhotos.length > 0) {
      try {
        const updatePayload = {
          images: approvedPhotos.map(photo => photo.url),
          coordinates: [
            verification.location.coordinates[0], // longitude
            verification.location.coordinates[1]  // latitude
          ]
        };

        console.log(`📤 Patching crop ${verification.cropId} with approved images and location:`, updatePayload);

        const cropUpdateResponse = await axios.patch(
          `${CROP_API_URL}/crop/${verification.cropId}/images-location`,
          updatePayload,
          {
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );

        cropUpdateResult = cropUpdateResponse.data;
        console.log(`✅ Successfully updated crop ${verification.cropId}:`, cropUpdateResult);

      } catch (cropUpdateError) {
        console.error(`❌ Error updating crop ${verification.cropId}:`, cropUpdateError.message);
        
        // Log the error but don't fail the entire finalization
        // The verification is still saved successfully
        console.warn(`⚠️ Verification finalized but crop update failed for cropId: ${verification.cropId}`);
      }
    }

    res.json({
      statusCode: 200,
      message: `Verification request ${status} successfully`,
      data: {
        id: verification._id,
        userId: verification.userId,
        cropId: verification.cropId,
        status: verification.status,
        rejectionReason: verification.rejectionReason,
        rejectionNotes: verification.rejectionNotes,
        reviewedAt: verification.reviewedAt,
        reviewedBy: verification.reviewedBy,
        locationType: verification.location.locationType,
        photos: verification.photos,
        cropUpdateResult: cropUpdateResult, // Include the crop API response
      },
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

// ============================================
// 7. UPDATE LOCATION TYPE (Specific action on :id)
// ============================================
router.patch("/:id/update-location-type", async (req, res) => {
  try {
    const { id } = req.params;
    const { locationType } = req.body;

    if (!locationType || !["farm", "village"].includes(locationType)) {
      return res.status(400).json({
        statusCode: 400,
        message: "locationType must be 'farm' or 'village'",
      });
    }

    const verification = await Verification.findById(id);

    if (!verification) {
      return res.status(404).json({
        statusCode: 404,
        message: "Verification request not found",
      });
    }

    verification.location.locationType = locationType;
    await verification.save();

    res.json({
      statusCode: 200,
      message: "Location type updated successfully",
      data: {
        id: verification._id,
        locationType: verification.location.locationType,
        coordinates: verification.location.coordinates,
      },
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
// 8. GET VERIFICATION BY ID (Generic :id route - MUST BE LAST)
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

    const photoSummary = {
      total: verification.photos.length,
      approved: verification.photos.filter((p) => p.status === "approved")
        .length,
      rejected: verification.photos.filter((p) => p.status === "rejected")
        .length,
      pending: verification.photos.filter((p) => p.status === "pending").length,
    };

    res.json({
      statusCode: 200,
      data: {
        ...verification.toObject(),
        photoSummary,
      },
    });
  } catch (error) {
    res.status(500).json({
      statusCode: 500,
      message: "Error fetching verification",
      error: error.message,
    });
  }
});

router.get('/crop/:cropId', async (req, res) => {
  try {
    const { cropId } = req.params;

    // Fetch verification data from MongoDB by cropId
    const verification = await Verification.findOne({ cropId: cropId });

    if (!verification) {
      return res.status(404).json({
        success: false,
        message: 'Verification not found for this crop ID'
      });
    }

    // Return verification data with photo details
    res.status(200).json({
      success: true,
      data: {
        // verification: verification,
        photos: verification.photos.map(photo => ({
          url: photo.url,
          status: photo.status,
          id: photo._id
        })),
        location: {
          type: verification.location.type,
          coordinates: verification.location.coordinates,
          locationType: verification.location.locationType || null
        },
        verificationStatus: verification.status,
      }
    });

  } catch (error) {
    console.error('Error fetching verification data:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching crop data',
      error: error.message
    });
  }
});



module.exports = router;