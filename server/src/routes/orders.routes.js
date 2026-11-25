import { Router } from 'express';
import { create, list, get, cancel } from '../controllers/orders.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// All order routes require authentication and the CUSTOMER role
router.use(requireAuth, requireRole('CUSTOMER'));

router.post('/', create);
router.get('/', list);
router.get('/:id', get);
router.post('/:id/cancel', cancel);

export default router;
