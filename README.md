# Well-Being Platform — Backend API

Built with Node.js · TypeScript · Express · PostgreSQL · Prisma

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Set up the database
```bash
# Make sure PostgreSQL is running, then:
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate

# Seed with admin account + sample data
npm run db:seed
```

### 4. Run the server
```bash
npm run dev
```

Server runs at: `http://localhost:5000`
Health check: `http://localhost:5000/health`

---

## API Endpoints

### Auth — `/api/auth`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/register` | Public | Create account |
| POST | `/login` | Public | Login |
| GET | `/me` | User | Get current user |
| POST | `/forgot-password` | Public | Request password reset |
| POST | `/reset-password` | Public | Reset with token |

### Programs — `/api/programs`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Public | List all programs |
| GET | `/:id` | Public | Program detail |
| POST | `/` | Admin | Create program |
| PATCH | `/:id` | Admin | Update program |
| DELETE | `/:id` | Admin | Delete program |
| POST | `/:id/lessons` | Admin | Add lesson |
| PATCH | `/:id/lessons/:lessonId` | Admin | Update lesson |
| DELETE | `/:id/lessons/:lessonId` | Admin | Delete lesson |

### Camps — `/api/camps`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | Public | List upcoming camps (`tiers` hold pricing; responses omit camp-level `price`; `seatsTaken` / `seatsRemaining` count **confirmed + active payment holds** only) |
| GET | `/current` | Public | Next upcoming camp (same shape) |
| GET | `/:id` | Public | Camp detail |
| POST | `/:id/register` | User | Apply for camp (`tierId` required); creates `PENDING_PAYMENT` + `paymentExpiresAt` (~60 min) or resets an expired row — see **Camp registration lifecycle** below |
| GET | `/:id/my-registration` | User | Current user's registration for this camp (`status`, `paymentExpiresAt`, tier, payment) or `null` |
| POST | `/` | Admin | Create camp (pricing via **Create tier** only) |
| PATCH | `/:id` | Admin | Update camp (pricing via tier endpoints) |
| DELETE | `/:id` | Admin | Delete camp |
| GET | `/:id/participants` | Admin | Paginated registrants — **all** lifecycle statuses by default; optional `?status=` filter |

#### Camp registration lifecycle
- At most **one** `CampRegistration` row per user per camp.
- **Register:** `POST /api/camps/:id/register` sets `status` to `PENDING_PAYMENT` and `paymentExpiresAt` (checkout window). Capacity / tier caps count **confirmed** registrations plus **unexpired** `PENDING_PAYMENT` holds.
- **Pay:** `POST /api/payments/initialize` with `type: "CAMP"` and `itemId` = registration id **only while** the registration is still payable (within the window). Successful Paystack `charge.success` promotes the row to `CONFIRMED` when the charge timestamp falls inside that window; otherwise the payment is flagged for **manual refund** and the seat is **not** confirmed.
- **Expiry:** A background job (`processExpiredCampRegistrations`, every minute from `server.ts`) plus optional **`POST /api/internal/cron/camp-registration-expiry`** (Bearer `CRON_SECRET`) mark overdue holds `EXPIRED`, detach stale pending payments, and free inventory. The user may **register again** — the **same** row is reused and reset to `PENDING_PAYMENT` with a new deadline.

### Consultations — `/api/consultations`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/services` | Public | List services |
| GET | `/services/:id` | Public | Service detail |
| POST | `/book` | User | Book consultation |
| GET | `/my` | User | My bookings |
| GET | `/` | Admin | All bookings |
| PATCH | `/:id` | Admin | Update booking |
| POST | `/services` | Admin | Create service |
| PATCH | `/services/:id` | Admin | Update service |

### Payments — `/api/payments`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/initialize` | User | Start Paystack (`PROGRAM` / `CAMP` / `CONSULTATION`). For **`CAMP`**, `itemId` is the registration id and checkout is rejected once the hold expired or the application is already confirmed — see Camps lifecycle above |
| GET | `/verify/:reference` | Public | Check payment status |
| POST | `/webhook` | Paystack | Webhook handler |
| GET | `/` | Admin | All payment records |

### Dashboard — `/api/dashboard`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | User | Full dashboard data (`campRegistrations` expose `status`, `paymentExpiresAt`, and payment timestamps for “complete payment” UX) |
| GET | `/programs/:programId` | User | Access program content |

### Admin — `/api/admin`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/stats` | Admin | Platform stats |
| GET | `/users` | Admin | All users |
| GET | `/users/:id` | Admin | User detail |
| POST | `/chat/reindex` | Admin | Rebuild AI chat knowledge index (optional `?sourceType=PROGRAM`) |
| GET | `/chat/stats` | Admin | Chat chunk counts + usage summary |

### Chat — `/api/chat`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/config` | Public | Widget intro, disclaimers, suggested prompts |
| POST | `/sessions` | Public (+ optional JWT) | Create session; sets httpOnly cookies |
| GET | `/sessions/:sessionId` | Session cookies | Message history |
| POST | `/sessions/:sessionId/messages` | Session cookies | User message → AI reply (JSON or SSE with `"stream": true`) |

**First deploy:** run `npm run chat:reindex` (or `POST /api/admin/chat/reindex`) after setting `OPENAI_API_KEY` so RAG has indexed content.

---

## Payment Flow

Camp applications follow the same Paystack steps with an extra gate: **`POST /api/payments/initialize`** for `type: "CAMP"` only succeeds while the registration's **`paymentExpiresAt`** is still in the future (`PENDING_PAYMENT`). After Paystack succeeds, the webhook sets the registration to **`CONFIRMED`** when the charge time is within that window.

```
1. User clicks "Buy" / "Register" / "Book"
2. POST /api/payments/initialize  → returns Paystack authorization_url
3. Frontend redirects user to Paystack checkout page
4. User pays on Paystack
5. Paystack calls POST /api/payments/webhook (server-to-server)
6. Webhook verifies signature, fulfills purchase, sends confirmation email
7. Frontend calls GET /api/payments/verify/:reference to show result
```

---

## Seeded Admin Credentials
```
Email:    admin@wellbeing.com
Password: Admin@1234
```
Change these immediately in production.

---

## Folder Structure
```
src/
├── config/          # Prisma, Cloudinary, OpenAI/chat config
├── controllers/     # Route handler logic
├── data/            # Static chat platform knowledge (RAG policy doc)
├── middleware/      # Auth, error handling, file uploads
├── routes/          # Express route definitions
├── services/chat/   # RAG indexing, orchestration, safety
├── utils/           # Email service
├── types/           # TypeScript types
├── app.ts           # Express app
└── server.ts        # Entry point

prisma/
├── schema.prisma    # Database schema
└── seed.ts          # Seed data
```
