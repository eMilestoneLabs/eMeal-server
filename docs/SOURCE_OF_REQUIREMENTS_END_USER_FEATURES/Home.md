# **END USER FEATURES MASTER — Smart Meal & Attendance SaaS**

---

## **PRODUCT OVERVIEW**

The Smart Meal & Attendance Management platform helps any organization manage daily meal attendance and planning digitally. It serves hostels, schools, corporate cafeterias, factories, PGs, coaching institutes, communities, and event-based food systems.

**Core value propositions:**
1. Members mark meal attendance in seconds via mobile app
2. Admins get real-time dashboards with attendance analytics
3. QR codes enable fast, frictionless group joining — no manual user import
4. Event organizers manage guest meal counts for external events without requiring guest accounts
5. Exportable XLSX reports for payroll, compliance, and billing
6. Dynamic meal configuration — any institution can define their own meal schedule

---

## **USER ROLES**

| Role | Scope | Primary Capability |
|------|-------|-------------------|
| `student` | Group member | Mark meals, view history |
| `member` | Group member | Same as student |
| `guest` | Group member | Same as student  |
| `messManager` | Organization level | Full org management |
| `hostelManager` | Organization level | Full org management |
| `hostelAdmin` | Organization level | Full org management |
| `organizationManager` | Organization level | Full org management |
| `eventAdmin` | Event level | Create/manage events, view guests |
| `eventGuest` | Event session | Join event, select meal |

**Role groups** (Flutter routing):
- `isStudentGroup`: student, member, guest → StudentShell
- `isAdminGroup`: messManager, hostelManager, hostelAdmin, organizationManager → AdminShell
- `isEventGroup`: eventAdmin → EventAdminShell, eventGuest → EventGuestShell

---

## KEY WORKFLOWS (Step-by-Step)

### Workflow 1: New Organization Onboarding
1. Admin downloads app → taps "Admin/Manager" → signs up as hostelAdmin
2. Organization created automatically (slug = org name)
3. Admin taps "Create Group" → "Boys Hostel Block A", type: hostel
4. Admin configures meals: "Breakfast Tea 7-9 AM", "Lunch Rice 12-2 PM", "Dinner Ruti 7-9 PM"
5. Admin enables meal preferences: Veg, Chicken, Egg
6. Admin taps "Generate QR" → shares QR image via WhatsApp group
7. Students download app → scan QR → immediately joined to group
8. Students see meal schedule and can mark attendance next morning for Breakfast after 7 AM

### Workflow 2: Daily Meal Marking (Student)
1. Student opens app at 8 AM
2. App shows "Breakfast" card — "7:00–9:00 AM window" — OPEN
3. Student taps "Present" → selects "Veg" preference → confirms
4. Server validates: window open ✓, not blocked ✓, upserts record
5. Admin dashboard updates in real-time (WebSocket `attendance.marked.v1`)
6. Analytics queue job aggregates data asynchronously
7. At 9 AM window closes — subsequent marks return 423 error

### Workflow 3: Admin Override
1. Student forgot to mark attendance, messages admin
2. Admin → Attendance screen → filters by student + today's date
3. Admin taps "Override" for student's Breakfast record
4. Changes status: "Absent" → "Present"
5. System bypasses window check (admin override)
6. AuditLog records: `actorId=admin, targetId=attendance, markedBy=admin.id`
7. Student sees updated status in their attendance history

### Workflow 4: Monthly Report Export
1. Admin → Reports section
2. Selects: Group = "Boys Hostel", Date = "June 1–30 2026"
3. Taps "Export XLSX" → BullMQ export-queue job created
4. ExportWorker generates XLSX via exceljs (date, name, meal, status, preference columns)
5. File downloaded to device
6. Admin can also tap "Export for PDF" → Flutter generates formatted PDF client-side
7. Admin submits XLSX to hostel management for billing

### Workflow 5: Event Guest Management
1. Event admin creates "Annual Prize Giving Ceremony", 3 meal types: Veg/Chicken/Jain
2. Shares join code "EVT-ABC123" printed on invitation cards
3. Guest Mehra Ji opens app → taps "Event" → enters code → enters "Mehra Ji" + 2 adults + 1 child
4. System creates:
   Mehra Ji [Adult]
   Guest-2 [Adult]
   Guest-3 [Child]

5. Mehra Ji updates the party:

   - Mehra Ji → Adult, Attending, Meal Type: Veg
   - Guest-2 → Renamed to "Sunita Mehra" → Adult, Attending, Meal Type: Chicken
   - Guest-3 → Renamed to "Aarav Mehra" → Child, Attending, Meal Type: Veg

6. Final Party:

   - Mehra Ji [Adult][Attending][Veg]
   - Sunita Mehra [Adult][Attending][Chicken]
   - Aarav Mehra [Child][Attending][Veg]

7. Admin dashboard shows:

   - Total Attending: 3
   - Veg: 2
   - Chicken: 1

### Workflow 6: Vacation Mode
1. Student going home for Diwali holidays
2. Opens Settings → toggles "Vacation Mode ON"
3. Backend: `isVacationMode = true` on User record
4. Student excluded from daily expected attendance count
5. AttendanceReminderWorker: skips reminders for vacation users
6. Analytics: shows student as "on vacation" separately (not counted as absent)
7. On return: toggle "Vacation Mode OFF" → normal tracking resumes

---

## PERMISSIONS MATRIX

| Feature | student/member/guest | messManager/hostelManager/hostelAdmin/orgManager | eventAdmin | eventGuest |
|----------|----------|----------|----------|----------|
| Mark own attendance | ✅ | ✅ | ❌ | ❌ |
| View own attendance history | ✅ | ✅ | ❌ | ❌ |
| Mark default attendance | ✅ | ✅ | ❌ | ❌ |
| Toggle vacation mode | ✅ | ✅ | ❌ | ❌ |
| View student dashboard | ✅ | ❌ | ❌ | ❌ |
| View admin dashboard | ❌ | ✅ | ❌ | ❌ |
| View event dashboard | ❌ | ❌ | ✅ | ❌ |
| Manage groups | ❌ | ✅ | ❌ | ❌ |
| Create groups | ❌ | ✅ | ❌ | ❌ |
| Edit groups | ❌ | ✅ | ❌ | ❌ |
| Archive groups | ❌ | ✅ | ❌ | ❌ |
| Generate QR codes | ❌ | ✅ | ❌ | ❌ |
| Regenerate join codes | ❌ | ✅ | ❌ | ❌ |
| Manage members | ❌ | ✅ | ❌ | ❌ |
| Block / Unblock members | ❌ | ✅ | ❌ | ❌ |
| Remove members | ❌ | ✅ | ❌ | ❌ |
| View attendance records | ❌ | ✅ | ❌ | ❌ |
| Override attendance | ❌ | ✅ | ❌ | ❌ |
| Manage meals | ❌ | ✅ | ❌ | ❌ |
| Configure meal preferences | ❌ | ✅ | ❌ | ❌ |
| Manage weekly schedules | ❌ | ✅ | ❌ | ❌ |
| View analytics | ❌ | ✅ | ✅ | ❌ |
| View meal analytics | ❌ | ✅ | ✅ | ❌ |
| View preference analytics | ❌ | ✅ | ❌ | ❌ |
| Export reports | ❌ | ✅ | ✅ | ❌ |
| Create events | ❌ | ❌ | ✅ | ❌ |
| Manage event guests | ❌ | ❌ | ✅ | ❌ |
| Create event meal types | ❌ | ❌ | ✅ | ❌ |
| View guest RSVP status | ❌ | ❌ | ✅ | ✅ (own party) |
| View event analytics | ❌ | ❌ | ✅ | ❌ |
| Export event reports | ❌ | ❌ | ✅ | ❌ |
| Join event | ❌ | ❌ | ❌ | ✅ |
| Rename party members | ❌ | ❌ | ❌ | ✅ |
| Select RSVP status | ❌ | ❌ | ❌ | ✅ |
| Select event meal types | ❌ | ❌ | ❌ | ✅ |
| View own event registration | ❌ | ❌ | ❌ | ✅ |
| View own RSVP status | ❌ | ❌ | ❌ | ✅ |
---

## NOTIFICATION BEHAVIOR

| Trigger | Recipients | When Sent | Smart Cancellation |
|---------|-----------|-----------|-------------------|
| Attendance reminder (60 min) | Group members | 60 min before window closes | Skip if already marked |
| Attendance closing (30 min) | Group members | 30 min before window closes | Skip if already marked |
| Override notification | Specific member | When admin overrides their record | No cancellation |
| Weekly summary digest | All members | Every Monday 9 AM | Skip if vacation mode |

**Vacation mode**: All reminders cancelled when `isVacationMode: true`.
**Default attendance mode**: Reminder not sent but action is "mark if absent" instead of "mark if present".

---
# FRONTEND (Flutter UI/UX Standard)

## Design Vision

Build a premium SaaS mobile experience that feels comparable to:

- Linear
- Stripe
- Revolut
- Notion
- CRED
- Razorpay

The UI must feel:

- Premium
- Modern
- Elegant
- Fast
- Responsive
- Mobile-first
- Operational SaaS grade

---

## Theme System

Support:

- Premium Light Theme
- Premium Dark Theme
- System Theme

Theme architecture:

```text
app_theme.dart
app_colors.dart
app_typography.dart
app_spacing.dart
app_shadows.dart
```

No hardcoded colors or dimensions.

---

## Premium Light Theme

Style:

- Soft neutral backgrounds
- Layered white surfaces
- Elegant borders
- Premium shadows
- High readability
- Clean whitespace

Characteristics:

- Modern startup aesthetic
- Professional SaaS feel
- Minimal visual noise
- Comfortable long-term usage

Avoid:

- Pure white everywhere
- Flat Material screens
- Generic dashboard appearance

---

## Premium Dark Theme

Style:

- Deep neutral backgrounds
- Layered dark surfaces
- Soft elevation
- Premium contrast
- Glassmorphism-ready surfaces

Characteristics:

- Luxurious
- Immersive
- Modern operational dashboard
- Comfortable night usage

Avoid:

- Pure black backgrounds
- Neon colors
- Cyberpunk effects
- Over-saturated palettes

---

## Layout System

Spacing Standard:

```text
4px  = micro spacing
8px  = base spacing
12px = compact spacing
16px = screen spacing
24px = section spacing
32px = large spacing
```

Responsive Support:

- Mobile
- Tablet
- Future Desktop

---

## Dashboard Design

Every dashboard must start with:

### Premium Hero Card

Examples:

```text
Today's Attendance
Present: 201
Absent: 44
Vacation: 12
```

```text
Event Overview
Guests: 420
Attending: 350
Pending: 70
```

Requirements:

- Large typography
- Modern iconography
- Soft gradients
- Elegant spacing
- Premium elevation
- Responsive layout

---

## Premium Cards

Used for:

- Attendance
- Meals
- Analytics
- Events
- Reports
- Groups

Requirements:

- Rounded corners
- Layered surfaces
- Premium shadows
- Compact information density

---

## Navigation

Student:

```text
Home
Attendance
Meals
Settings
```

Admin:

```text
Dashboard
Groups
Meals
Attendance
Settings
```

Event Admin:

```text
Dashboard
Guests
Meals
Settings
```

Requirements:

- Bottom Navigation
- State Preservation
- Smooth Transitions
- Fast Switching

---

## Lists

Requirements:

- Search
- Filters
- Sorting
- Pull To Refresh
- Pagination Ready

Used For:

- Members
- Guests
- Groups
- Events
- Reports

---

## Bottom Sheets

Used For:

- Create Group
- Create Event
- Edit Meal
- Filters
- Quick Actions

Requirements:

- Full Width
- Keyboard Safe
- Responsive
- Material 3

---

## Dialogs

Used Only For:

- Delete
- Archive
- Block User
- Remove Guest
- Close Event

---

## Empty States

Every screen must support:

- Loading State
- Skeleton State
- Empty State
- Error State
- Offline State

Examples:

```text
No Groups Yet
No Members Yet
No Events Yet
No Guests Yet
No Meal Types Yet
```

---

## Animations

Allowed:

- Fade
- Scale
- Slide
- Hero Animation
- Micro Interactions

Requirements:

- Smooth
- Lightweight
- Performance Friendly

Avoid:

- Long animations
- Flashy effects
- Heavy transitions

---

## Flutter Standards

Framework:

- Flutter Stable
- Material 3

Architecture:

- Feature First

State Management:

- StatefulWidget
- ChangeNotifier
- ValueNotifier

Do Not Use:

- Bloc
- Riverpod
- GetX
- MobX
- Redux

Performance Goals:

- 60 FPS
- Fast Startup
- Low Memory Usage
- Smooth Scrolling
- Minimal Rebuilds

---

## Reusable Premium Components

Create reusable widgets:

- PremiumHeroCard
- AnalyticsCard
- AttendanceCard
- MealCard
- GuestCard
- GroupCard
- DashboardContainer
- PremiumButton
- PremiumTextField
- PremiumBottomSheet
- EmptyStateWidget
- ErrorStateWidget
- ResponsiveScaffold

All screens must use reusable components rather than custom one-off implementations.

# BACKEND (Production SaaS Architecture Standard)

## Core Principles

All backend technologies must be:

- Open Source
- Commercially Free
- Self Hostable
- Production Proven
- No Commercial License Required

---

## Backend Stack

Framework:

```text
NestJS
```

Database:

```text
PostgreSQL
```

ORM:

```text
Prisma
```

Cache:

```text
Redis
```

Queue:

```text
BullMQ
```

Realtime:

```text
Socket.IO
```

---

## Authentication

Support:

- JWT Access Tokens
- JWT Refresh Tokens
- Refresh Token Rotation
- Session Persistence
- Multi Device Login
- Secure Logout

Password Hashing:

```text
Argon2
```

---

## API Architecture

Style:

```text
REST API
```

Examples:

```text
/api/v1/auth
/api/v1/users
/api/v1/groups
/api/v1/meals
/api/v1/attendance
/api/v1/events
/api/v1/reports
```

Rules:

- Versioned APIs
- DTO Validation
- Standard Response Format
- Pagination Support

---

## Database

Primary Database:

```text
PostgreSQL
```

Benefits:

- ACID Compliant
- Enterprise Proven
- Open Source
- Excellent Performance

---

## Redis Layer

Uses:

- Cache
- Session Storage
- Queue Backend
- Rate Limiting
- Realtime Presence

---

## Queue Architecture

BullMQ Jobs:

- Export Reports
- Notification Scheduling
- Analytics Aggregation
- Event Auto Delete
- Attendance Reminders

Benefits:

- Async Processing
- Reliable Retries
- Scalable Workers

---

## Realtime Architecture

Socket.IO Events:

```text
attendance.marked.v1
attendance.overridden.v1

guest.joined.v1
guest.updated.v1

event.updated.v1

meal.updated.v1

dashboard.updated.v1
```

Uses:

- Dashboard Updates
- Attendance Updates
- Guest Updates
- Event Updates

No manual refresh required.

---

## File Storage

Development:

```text
Local Storage
```

Production:

```text
MinIO
```

Benefits:

- Open Source
- S3 Compatible
- Commercial Use Allowed
- Self Hosted

---

## Notification Architecture

Future Ready:

- flutter_local_notifications
- Attendance Reminder Jobs
- Reminder Cancellation
- Vacation Mode Awareness

Examples:

```text
Attendance closes in 60 minutes
Attendance closes in 30 minutes
```

---

## Analytics Architecture

Realtime Metrics:

- Attendance Analytics
- Meal Analytics
- Preference Analytics
- Event Analytics

Background Aggregation:

- Daily
- Weekly
- Monthly

Workers generate analytics asynchronously.

---

## Security

Required:

- Helmet
- CORS
- Rate Limiting
- DTO Validation
- Audit Logs
- Argon2 Password Hashing

Additional:

- Refresh Token Rotation
- Session Tracking
- Device Tracking
- Secure Headers

---

## Logging

Logger:

```text
Pino
```

Benefits:

- Extremely Fast
- Structured Logs
- Production Ready

---

## Monitoring

Monitoring Stack:

```text
Prometheus
Grafana
```

Metrics:

- API Health
- Database Health
- Queue Health
- Realtime Health
- Server Health

---

## Testing

Frameworks:

```text
Jest
Supertest
```

Coverage:

- Unit Tests
- Integration Tests
- API Tests

---

## Deployment

Containers:

```text
Docker
Docker Compose
```

Future Scale:

```text
Kubernetes
```

Hosting:

```text
Contabo VPS
```

---

## Scalability Targets

Supports:

- 100+ Organizations
- 10,000+ Members
- 100,000+ Attendance Records
- 100,000+ Event Guests

Without architectural redesign.

---

## UTC Time
All timestamps stored in UTC.

Display time:
- Organization timezone
- Event timezone

Never trust device local time.
Flutter Will convert UTC to Local Time

---

## License Compliance

All selected technologies are:

- Open Source
- Commercially Usable
- Self Hostable
- Free For SaaS Products
- Production Proven

Suitable for long-term commercial deployment.

## PRODUCT PHILOSOPHY

1. **Fast attendance** — one tap to mark present. Maximum 2 taps if preferences enabled.
2. **QR simplicity** — scanning takes 3 seconds. No manual user import by admin.
3. **Low operational friction** — admin can configure everything from mobile. No desktop required.
4. **Mobile-first** — Android-first, ChangeNotifier state management, no heavy dependencies.
5. **Dynamic rendering** — meal slots, event types, preferences are all configurable. Not hardcoded.
6. **Event system is lightweight** — event guests don't need accounts. Maximum 4-step join flow.
7. **Startup-grade UX** — inspired by Linear, Stripe, CRED. Premium Material 3. No ERP complexity.
8. **Backend drives config** — admin changes (meal visibility, preferences, schedules) immediately reflected in Flutter UI without app update.

---

# Wiki Navigation

## Core Product Documentation

- [[Student]]
- [[Admin]]
- [[Event_Admin]]
- [[Event_Guest]]

---

## System Architecture

- [[Frontend_Architecture]]
- [[Backend_Architecture]]
- [[Database_Schema]]
- [[API_Contracts]]
- [[Realtime_Events]]

---

## Operations

- [[Notifications]]
- [[Security]]
- [[Deployment]]

---

## Quick Navigation

### User Flows

- [[Student]]
- [[Admin]]
- [[Event_Admin]]
- [[Event_Guest]]

### Technical Design

- [[Frontend_Architecture]]
- [[Backend_Architecture]]
- [[Database_Schema]]

### Backend Contracts

- [[API_Contracts]]
- [[Realtime_Events]]

### Production Operations

- [[Notifications]]
- [[Security]]
- [[Deployment]]
