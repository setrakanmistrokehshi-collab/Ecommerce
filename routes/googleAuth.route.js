// routes/googleAuth.route.js
import { Router } from 'express';
import { googleAuthController } from '../controllers/googleAuthController.js';
 
const router = Router();
 
// POST /api/auth/google
// Body: { credential: string }  <- the GIS ID token from the frontend
router.post('/google', googleAuthController);
 
export default router;
 