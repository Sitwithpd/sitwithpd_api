import { Router } from 'express';
import { body } from 'express-validator';
import { submitContact } from '../controllers/contact.controller';
import { validate } from '../middleware/validate.middleware';
import {
  CONTACT_FULL_NAME_MAX,
  CONTACT_MESSAGE_MAX,
  CONTACT_MESSAGE_MIN,
  CONTACT_PHONE_MAX,
} from '../services/contact.service';

const normalizeEmailOpts = { gmail_remove_subaddress: false };

const router = Router();

router.post(
  '/',
  [
    body('fullName')
      .trim()
      .notEmpty()
      .withMessage('Full name is required.')
      .isLength({ max: CONTACT_FULL_NAME_MAX }),
    body('email').isEmail().normalizeEmail(normalizeEmailOpts).withMessage('Valid email is required.'),
    body('phone').optional({ values: 'null' }).trim().isLength({ max: CONTACT_PHONE_MAX }),
    body('message')
      .trim()
      .notEmpty()
      .withMessage('Message is required.')
      .isLength({ min: CONTACT_MESSAGE_MIN, max: CONTACT_MESSAGE_MAX }),
    body('source').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }),
    body('website').optional().isString(),
    body('company').optional().isString(),
  ],
  validate,
  submitContact
);

export default router;
