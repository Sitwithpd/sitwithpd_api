import { CHAT_FRONTEND_PATHS } from '../../config/chat';
import { ChatLink, ChatSafetyCheckResult, ChatSafetyKind } from '../../types/chat.types';

const CRISIS_PATTERNS: RegExp[] = [
  /\b(kill|hurt|harm)\s+(myself|me)\b/i,
  /\b(suicid(e|al)|self[\s-]?harm)\b/i,
  /\b(end|take)\s+my\s+life\b/i,
  /\b(want|going)\s+to\s+die\b/i,
  /\bdon'?t\s+want\s+to\s+(live|be\s+alive)\b/i,
  /\b(harm|hurt)\s+(someone|others|another\s+person)\b/i,
];

const ACCOUNT_PERSONAL_PATTERNS: RegExp[] = [
  /\bmy\s+(camp|registration|booking|consultation|payment|purchase|program|account|order|enrollment)\b/i,
  /\b(where|what)\s+is\s+my\s+(camp|registration|booking|consultation|payment|purchase|program)\b/i,
  /\b(status\s+of\s+my|did\s+my\s+payment|have\s+i\s+paid|my\s+payment\s+status)\b/i,
  /\b(show|check|view)\s+my\s+(dashboard|registrations?|bookings?|payments?|purchases?)\b/i,
];

/** Pending client/admin review before launch. */
const CRISIS_RESPONSE = `I'm not able to help with crisis or emergency situations.

If you are in immediate danger, or worried about someone else, contact your local emergency services or a trusted professional right away.

For platform help only (not urgent mental health support), you can reach our team through the Contact page.`;

const ACCOUNT_GUEST_RESPONSE = `That question is about your personal account, registration, or payment status. To protect your privacy, I can't access account details while you're signed out.

Please sign in and open your dashboard to see your programs, camp registrations, and consultations. If something still looks wrong after signing in, contact our support team.`;

export function detectCrisisMessage(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return CRISIS_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectAccountPersonalMessage(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return ACCOUNT_PERSONAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function checkMessageSafety(
  message: string,
  options: { isAuthenticated: boolean }
): ChatSafetyCheckResult {
  if (detectCrisisMessage(message)) {
    return {
      kind: 'crisis',
      content: CRISIS_RESPONSE,
      links: [
        { label: 'Contact support', path: CHAT_FRONTEND_PATHS.contact },
        { label: 'Browse programs', path: CHAT_FRONTEND_PATHS.programs },
      ],
    };
  }

  if (!options.isAuthenticated && detectAccountPersonalMessage(message)) {
    return {
      kind: 'account_personal',
      content: ACCOUNT_GUEST_RESPONSE,
      requiresAuth: true,
      loginPath: CHAT_FRONTEND_PATHS.login,
      links: [
        { label: 'Sign in', path: CHAT_FRONTEND_PATHS.login },
        { label: 'Contact support', path: CHAT_FRONTEND_PATHS.contact },
      ],
    };
  }

  return { kind: 'none' };
}

export function buildSafetyOrchestratorMetadata(kind: ChatSafetyKind): {
  crisis?: boolean;
  requiresAuth?: boolean;
} {
  if (kind === 'crisis') return { crisis: true };
  if (kind === 'account_personal') return { requiresAuth: true };
  return {};
}
