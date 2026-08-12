// routes/googleAuth.route.js
const { Router } = require('express');
const { googleAuthController } = require('../controllers/googleAuthController');

const router = Router();

// POST /api/auth/google
// Body: { credential: string }  <- the GIS ID token from the frontend
router.post('/google', googleAuthController);

module.exports = router;