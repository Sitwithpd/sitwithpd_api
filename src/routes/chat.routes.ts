import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { body, param } from 'express-validator';
import { getChatMaxMessagesPerHourGuest } from '../config/chat';
import {
  createChatSessionHandler,
  getChatConfig,
  getChatSessionHandler,
  postChatMessageHandler,
} from '../controllers/chat.controller';
import {
  assertChatFeatureAvailable,
  optionalAuthenticate,
  requireChatSession,
} from '../middleware/chat.middleware';
import { validate } from '../middleware/validate.middleware';

const router = Router();

const chatGuestMessageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: getChatMaxMessagesPerHourGuest(),
  message: {
    success: false,
    message: 'Too many chat messages. Please try again in a little while.',
  },
  skip: (req) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return true;
    const cookieName = process.env.JWT_COOKIE_NAME || 'access_token';
    return Boolean(req.cookies?.[cookieName]);
  },
});

router.use(assertChatFeatureAvailable);

router.get('/config', getChatConfig);

router.post('/sessions', optionalAuthenticate, createChatSessionHandler);

router.get(
  '/sessions/:sessionId',
  optionalAuthenticate,
  param('sessionId').trim().notEmpty().withMessage('Session id is required.'),
  validate,
  requireChatSession,
  getChatSessionHandler
);

router.post(
  '/sessions/:sessionId/messages',
  chatGuestMessageLimiter,
  optionalAuthenticate,
  param('sessionId').trim().notEmpty().withMessage('Session id is required.'),
  body('message').optional().isString(),
  body('stream').optional().isBoolean(),
  validate,
  requireChatSession,
  postChatMessageHandler
);

export default router;
