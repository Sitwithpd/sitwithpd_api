import { Router } from 'express';
import {
  getTeamMembers,
  getTeamMembersAdmin,
  getTeamMemberById,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
} from '../controllers/team.controller';
import { authenticate, adminOnly } from '../middleware/auth.middleware';
import { uploadImage } from '../middleware/upload.middleware';

const router = Router();

router.get('/admin/all', authenticate, adminOnly, getTeamMembersAdmin);

router.get('/', getTeamMembers);
router.get('/:id', getTeamMemberById);

router.post('/', authenticate, adminOnly, uploadImage.single('photo'), createTeamMember);
router.patch('/:id', authenticate, adminOnly, uploadImage.single('photo'), updateTeamMember);
router.delete('/:id', authenticate, adminOnly, deleteTeamMember);

export default router;
