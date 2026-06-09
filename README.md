# VitaCore Backend API — v2.0 Production

Node.js/Express/MongoDB REST API powering the VitaCore Health Supplements e-commerce store.  
Designed to meet global safe-standards for e-commerce: OWASP Top 10, PCI DSS principles, GDPR-aligned.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| Framework | Express 4 |
| Database | MongoDB 7 (Mongoose 8) |
| Auth | JWT (access 15m + refresh 7d) + token versioning |
| Payments | Nomba (Nigerian payment gateway) |
| Email | Nodemailer (Brevo/SendGrid recommended in prod) |
| Cache / Rate-limit | Redis (ioredis) — graceful fallback to memory |
| Security | Helmet, CORS, express-rate-limit, express-validator |
| Logging | Winston (console + rotating file in production) |

---

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd vitacore-backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill all required fields (see Environment Variables below)

# 3. Seed the database (creates admin user + sample products)
npm run seed

# 4. Start dev server
npm run dev

# 5. Test health
curl http://localhost:3000/health
```

---

## Environment Variables

All required variables are validated at startup. The server refuses to start in production if any are missing.

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development` or `production` |
| `PORT` | No | Defaults to `3000` |
| `BASE_URL` | Yes | Full origin, e.g. `https://vitacore.ng` |
| `ALLOWED_ORIGINS` | Yes | Comma-separated CORS origins |
| `MONGODB_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | 64+ char random hex |
| `JWT_EXPIRES_IN` | No | Access token TTL, default `15m` |
| `JWT_REFRESH_SECRET` | Yes | 64+ char random hex (different from JWT_SECRET) |
| `JWT_REFRESH_EXPIRES_IN` | No | Refresh TTL, default `7d` |
| `NOMBA_CLIENT_ID` | Yes | From Nomba dashboard |
| `NOMBA_CLIENT_SECRET` | Yes | From Nomba dashboard |
| `NOMBA_ACCOUNT_ID` | Yes | From Nomba dashboard |
| `NOMBA_BASE_URL` | Yes | `https://api.nomba.com/v1` |
| `NOMBA_WEBHOOK_SECRET` | Prod only | Webhook HMAC secret from Nomba |
| `EMAIL_HOST` | Yes | SMTP host |
| `EMAIL_PORT` | No | Default `587` |
| `EMAIL_USER` | Yes | SMTP username |
| `EMAIL_PASS` | Yes | SMTP password or API key |
| `EMAIL_FROM_ADDRESS` | Yes | Sender address |
| `EMAIL_FROM_NAME` | No | Defaults to `VitaCore Health` |
| `REDIS_URL` | No | Redis connection URL. Falls back to memory if absent |
| `RATE_LIMIT_MAX` | No | Global API limit per 15 min, default `200` |
| `AUTH_RATE_LIMIT_MAX` | No | Auth endpoint limit per 15 min, default `10` |

---

## API Reference

### Auth  `/api/v1/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | — | Register new user |
| POST | `/login` | — | Login, returns access + refresh tokens |
| POST | `/refresh-token` | — | Rotate access token using refresh token |
| GET | `/verify-email/:token` | — | Verify email address |
| POST | `/forgot-password` | — | Request password reset email |
| POST | `/reset-password` | — | Reset password with token |
| GET | `/me` | ✅ | Get current user profile |
| POST | `/logout` | ✅ | Invalidate current session |
| POST | `/logout-all` | ✅ | Invalidate ALL sessions (bumps token version) |

### Products  `/api/v1/products`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | — | List products (filter, sort, paginate) |
| GET | `/:slug` | — | Get product by slug or ID |
| POST | `/:id/reviews` | ✅ | Submit a review (rate-limited: 10/day) |
| POST | `/` | Admin | Create product |
| PATCH | `/:id` | Admin | Update product |
| DELETE | `/:id` | Admin | Soft-delete product |

### Orders  `/api/v1/orders`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | ✅ | Current user's orders |
| GET | `/:id` | ✅ | Single order |
| POST | `/:id/cancel` | ✅ | Cancel a pending/paid order |
| GET | `/admin/all` | Admin | All orders with filters |
| PATCH | `/admin/:id/status` | Admin | Update order status |

### Payments  `/api/v1/payments`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/validate-promo` | — | Validate promo code |
| POST | `/checkout` | Optional | Initiate Nomba checkout |
| GET | `/:reference/status` | ✅ | Verify payment status |

### Users  `/api/v1/users`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/profile` | ✅ | Get profile |
| PATCH | `/profile` | ✅ | Update profile |
| PATCH | `/change-password` | ✅ | Change password |
| POST | `/addresses` | ✅ | Add address |
| DELETE | `/addresses/:id` | ✅ | Remove address |
| POST | `/wishlist/:productId` | ✅ | Toggle wishlist item |
| POST | `/newsletter` | ✅ | Subscribe/unsubscribe |

### Admin  `/api/v1/admin`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/dashboard` | Admin | Stats overview |
| GET | `/analytics/revenue` | Admin | Monthly revenue chart data |
| GET | `/analytics/top-products` | Admin | Top 10 by units sold |
| GET | `/analytics/categories` | Admin | Revenue by product category |
| GET | `/users` | Admin | All users (paginated) |
| PATCH | `/users/:id/status` | Admin | Activate/deactivate user |
| PATCH | `/products/:id/stock` | Admin | Update stock level |
| PATCH | `/products/:productId/reviews/:reviewId/visibility` | Admin | Hide/show a review |
| POST | `/orders/:id/notify-shipped` | Admin | Send shipping notification email |

### Webhooks  `/webhooks`

| Method | Path | Description |
|---|---|---|
| POST | `/nomba` | Nomba payment event handler (HMAC-verified) |

---

## Security Architecture

### Authentication & Session Management
- **Short-lived access tokens** (15 min) + **rotating refresh tokens** (7 days)
- **Token versioning**: bumping `tokenVersion` on password change or `/logout-all` instantly invalidates all existing sessions — no waiting for expiry
- **Token blocklist** (Redis-backed): logout immediately invalidates the current access token
- **Brute-force protection**: accounts lock for 2 hours after 5 failed login attempts

### Input Validation & Sanitisation
- All inputs validated with `express-validator` before touching the database
- `middleware/sanitize.js` strips MongoDB operator keys (`$`, `.`) from all request bodies — prevents NoSQL injection
- Query string length capped at 2048 chars

### Transport & Headers
- **Helmet** sets: `Strict-Transport-Security` (HSTS, preload), `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, Referrer Policy, Permissions Policy
- All API routes enforce CORS with an allowlist
- Body size capped at 10kb (100kb for webhooks only)

### Rate Limiting
- Global: 200 req / 15 min per IP
- Auth endpoints: 10 req / 15 min (only failed attempts count toward login limit)
- Payments: 5 req / 1 min
- Reviews: 10 / 24 hours per user+IP
- Webhooks: 100 req / 1 min
- With Redis: limits are shared across multiple instances (important for horizontal scaling)

### Payment Security
- Prices **always** recalculated server-side from the database — the frontend cannot influence the amount charged
- Nomba webhooks verified with HMAC-SHA512 + `timingSafeEqual` (prevents timing attacks)
- Webhook secret required in production; app refuses to process unsigned webhooks
- Stock decrements are atomic (findOneAndUpdate with stock check) preventing oversell

### Data Protection
- Passwords hashed with bcrypt (cost factor 12)
- Sensitive User fields (`password`, `tokenVersion`, `loginAttempts`, etc.) have `select: false` — never returned in queries by default
- `toSafeObject()` used on every user response — explicit whitelist of safe fields
- Forgot-password response is identical whether email exists or not (prevents user enumeration)

### Error Handling
- Centralised error handler (`middleware/errorHandler.js`) normalises Mongoose errors, JWT errors, and operator errors
- Stack traces only returned in development (`NODE_ENV !== 'production'`)
- Unexpected (non-operational) errors are fully logged server-side but return a generic message to the client

---

## Deployment Checklist

```
□ NODE_ENV=production
□ All required .env variables set
□ NOMBA_WEBHOOK_SECRET set and matching Nomba dashboard
□ JWT_SECRET and JWT_REFRESH_SECRET are each 64+ chars and unique
□ ADMIN_PASSWORD is strong and changed from default
□ ALLOWED_ORIGINS contains only your actual domains
□ REDIS_URL set (recommended for multi-instance deployments)
□ MongoDB Atlas: IP allowlist, least-privilege DB user, TLS enforced
□ TLS/HTTPS enforced at reverse proxy (Nginx/Caddy) or PaaS level
□ Log rotation configured (logger.js handles this in production)
□ /health and /ready endpoints accessible to load balancer
```

---

## Recommended Production Infrastructure

```
Browser → Cloudflare (DDoS/WAF) → Railway/Render → This API → MongoDB Atlas
                                                  ↘ Redis Cloud (rate limits + cache)
                                                  ↘ Brevo/SendGrid (email)
```

---

## Future Improvements (tracked)

- [ ] Promo codes: move to DB with per-user usage limits and expiry dates
- [ ] Image uploads: integrate Cloudinary/AWS S3 via multer
- [ ] Audit log: record all admin actions with actor + timestamp
- [ ] Two-factor authentication (TOTP)
- [ ] Order refund endpoint with Nomba refund API integration
- [ ] Cron job: cleanup stale pending orders (>2 hours)
- [ ] OpenAPI/Swagger documentation auto-generation
