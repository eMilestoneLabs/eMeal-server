# ROLE: EVENT ADMIN

Event Admin is the owner and organizer of an event.

The Event Admin creates events, configures meal options, invites guests, tracks guest attendance, manages meal planning and exports reports.

---

## 1. ACCOUNT CREATION

### Screens

- event_admin_signup_screen
- event_admin_login_screen

### Registration Fields

Required:

- Full Name
- Mobile Number
- Email Address
- Password

Event Information:

- Event Name
- Event Type
- Event Date
- Expected Guest Count

Optional:

- Auto Delete After 7 Days

#### Example

```text
Event Name: Sumita Weddings
Type: Wedding
Date: 15 Jun 2026
Expected Guests: 500
```

### System Actions

After successful registration:

- Event Admin account created
- First event created automatically
- One Event Admin can create multiple events
- Event join code generated
- Event workspace initialized
- Redirect to Event Admin Shell

---

## 2. EVENT ADMIN SHELL

### Screens

- event_admin_shell

### Bottom Navigation

```text
Dashboard
Guests
Meals
Settings
```

The Event Admin shell contains only event-related features.

---

## 3. EVENT CREATION

### Screens

- event_create_screen

### Event Management

Event Admin can:

- Create Event
- View Events
- Switch Active Event
- Edit Event
- Archive Event

All Dashboard, Guests, Meals and Settings screens operate on the currently selected event.

### Required Fields

- Event Name
- Event Type
- Event Date
- Expected Guest Count

### Supported Types

- Wedding
- Reception
- Birthday
- Engagement
- Conference
- Seminar
- Reunion
- Custom

### Generated Automatically

- Event ID
- Join Code

#### Example

```text
Join Code: LB92EW
```

---

### REAL-TIME EVENTS

The following updates must be synchronized instantly:

- Guest Joined
- Guest Renamed
- Attending Status Updated
- Meal Selection Updated
- Guest Party Removed
- Event Closed

No manual refresh required.

---

## 4. MEAL TYPE CONFIGURATION

### Screens

- event_admin_meals_tab

Meal types define the meal options available to guests.

Guests can only select from meal types configured by the Event Admin.

---

### Create Meal Type

Required:

- Title
- Emoji
- Color
- Veg / Non-Veg Classification

#### Examples

```text
Veg 🥗
Jain 🙏
Egg 🥚
Chicken 🍗
Fish 🐟
Mutton 🍖
Dessert 🎂
Drinks 🥤
```

---

### Meal Type Properties

```json
{
  "title": "Chicken",
  "emoji": "🍗",
  "color": "#F57C52",
  "isVeg": false
}
```

---

### Edit Meal Type

Admin can modify:

- Name
- Emoji
- Color
- Veg/Non-Veg Classification

---

### Delete Meal Type

Admin can delete meal types.

Deletion should be blocked if guests have already selected that meal type.

---

### EVENT STATUS

Supported statuses:

- Upcoming
- Closed
- Expired
- Archived

### Upcoming

Guests may:

- Join Event
- Update Attending Status
- Update Meal Selections

### Closed

Guests can no longer:

- Join Event
- Modify Attending Status
- Modify Meal Selections

### Expired

Expired events are read-only.

Event Admin can:

- View Dashboard
- View Guests
- View Meal Analytics
- Export Reports

Event Admin cannot:

- Accept New Guests
- Modify Attending Status
- Modify Meal Selections

### Archived

Archived events are hidden from active event lists.

Event Admin can:

- View Event
- Restore Event

Guests cannot:

- Join Event
- Modify Data

---

## 5. EVENT SETUP FLOW

Meal types should be configured before guests begin joining.

Recommended workflow:

```text
Create Event
      ↓
Configure Meal Types
      ↓
Generate QR Code
      ↓
Share Invitations
      ↓
Guests Join
```

---

## 6. QR CODE & JOIN CODE MANAGEMENT

### Screens

- event_admin_dashboard_tab

Admin can:

- Generate Event QR Code
- Copy Join Code
- Share Join Code
- Display QR Code

#### Example

```text
Join Code: LB92EW
```

The QR code contains:

- Event ID
- Join Code

---

## 7. EVENT DASHBOARD

### Screens

- event_admin_dashboard_tab

Primary operational screen.

All statistics update in real time.

---

### Guest Statistics

Displays:

- Total Registered Guests
- Adults
- Children
- Attending Guests
- Not Attending Guests

#### Example

```text
Total Guests: 250
Adults: 210
Children: 40
```

---

### Meal Statistics

Displays:

- Veg Count
- Non-Veg Count
- Pending Meal Selection Count

#### Example

```text
Veg: 120
Non-Veg: 90
Pending: 40
```

---

### Meal Type Breakdown

Displays guest counts per meal type.

#### Example

```text
Veg      : 65
Jain     : 12
Chicken  : 80
Fish     : 25
Mutton   : 18
Dessert  : 90
```

---

## 8. GUEST ONBOARDING

Guests join using:

- Event QR Code
- Event Join Code

Guest flow:

```text
Scan QR / Enter Join Code
            ↓
Enter Name
            ↓
Enter Adult Count
            ↓
Enter Child Count
            ↓
Create Party
```

No guest account is required.

---

### Automatic Party Generation

When a guest joins:

```text
Primary Guest Name
Adult Count
Child Count
```

The system automatically creates attendee records.

Example:

```text
Rahul Mahanta
Guest-2
Guest-3
Guest-4
Guest-5
```

These placeholders may later be renamed by guests or Event Admin.

---

## 9. REAL-TIME GUEST SYNCHRONIZATION

Whenever a guest joins:

- Dashboard updates automatically
- Guest list updates automatically
- Attending counts update automatically
- Meal analytics update automatically

No manual refresh required.

---

## 10. GUEST LIST MANAGEMENT

### Screens

- event_admin_guests_tab

Admin can view all guest parties.

---

### Party Information

Each party contains:

- Primary Guest Name
- Party Members
- Adult/Child Tags
- Attending Status
- Meal Selections

#### Example

```text
Rahul Mahanta

Rahul
Tina
Rina
Guest-4
Guest-5
Guest-6
```

---

## 11. GUEST RENAMING

Admin may rename any attendee.

#### Example

```text
Guest-2
```

becomes

```text
Sunita Mahanta
```

---

## 12. REGISTERED vs ATTENDING

These are different values.

#### Example

```text
Registered: 6
Attending: 4
```

---

### Registered Guests

Created during initial joining.

Example:

```text
Adults: 4
Children: 2
```

Result:

```text
6 Registered
```

---

### Attending Guests

Only members marked as attending.

Example:

```text
4 Attending
```

---

### Critical Business Rule

All meal analytics are calculated using attending guests only.
Guests marked as not attending are excluded from meal calculations.
Meal analytics must always be calculated from:

```text
Attending Guests
```

Never from:

```text
Registered Guests
```

Reason:

```text
Absent Guests = No Meal Required
```

---

### Meal Analytics Formula

Meal Analytics = Attending Guests Only

Veg Count =
Attending Guests selecting Veg

Chicken Count =
Attending Guests selecting Chicken

Pending Count =
Attending Guests without a meal selection
---

## 13. VIEW GUEST MEAL SELECTIONS

Admin can view meal selections for every attending guest.

Example:

```text
Rahul → Chicken
Tina  → Veg
Rina  → Fish
Guest-5 → Dessert
```

Admin can see:

- Guest Name
- Meal Type
- Veg/Non-Veg Classification
- Attending Status

---

## 14. REMOVE GUEST PARTY

Admin can remove entire guest parties.

#### Example

```text
Rahul Mahanta Party
```

Removal deletes:

- Party Members
- Attending Status
- Meal Selections

from event analytics.

---

## 15. EXPORT REPORTS

### Screens

- event_admin_settings_tab

Supported exports:

- PDF
- XLSX

---

### Export Data Includes

- Party Name
- Guest Name
- Adult/Child Type
- Attending Status
- Meal Selection
- Veg/Non-Veg Classification

---

## 16. EVENT SETTINGS

### Screens

- event_admin_settings_tab

Displays:

- Event Name
- Event Type
- Event Date
- Expected Guest Count
- Join Code
- Meal Type Count
- Event Status
- Auto Delete After 7 Days
- Active Event Selector

#### Example

```text
Event Name: Sumita Weddings
Type: Wedding
Date: 15 Jun 2026
Expected Guests: 500
Join Code: LB92EW
Meal Types: 7
```

---

## 17. AUTO DELETE

Optional event setting.

```text
autoDeleteAfter7Days = true
```

Behavior:

```text
Event Date + 7 Days
          ↓
Delete Event
Delete Guest Data
Delete Meal Data
Delete Analytics
Delete Generated QR Data
```

---

## 18. CLOSE EVENT

### Screens

- event_admin_settings_tab

Danger Zone Action.

When closed:

```text
Event Status = CLOSED
```

Guests can no longer:

- Join Event
- Rename Members
- Modify Attending Status
- Change Meal Selections

Admin can still:

- View Data
- Export Reports

until deletion occurs.

Closed + Event Date Passed
       ↓
Expired

---

## EVENT ADMIN MASTER FLOW

```text
Create Account
       ↓
Create Event
       ↓
Configure Meal Types
       ↓
Generate QR / Join Code
       ↓
Share With Guests
       ↓
Guests Join Event
       ↓
Guests Select Attending Members
       ↓
Guests Select Meals
       ↓
Guests Confirm Selections
       ↓
Monitor Dashboard
       ↓
Export Reports
       ↓
Close Event
       ↓
Auto Delete (Optional)
```