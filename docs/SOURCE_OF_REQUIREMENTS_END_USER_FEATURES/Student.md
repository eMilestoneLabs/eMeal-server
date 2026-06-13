# **ROLE: STUDENT / MEMBER / GUEST**

## Active Group

A member/student/guest may belong to multiple groups.

The app operates on one Active Group at a time.

Students can switch Active Group from the group selector.

All attendance, meals, analytics and history are scoped to the currently selected Active Group.

### **1. Registration & Onboarding**

**Screens involved**: `role_select_screen`, `student_signup_screen`, `login_screen`, `otp_screen`, `no_group_screen`

#### Registration

- Download app and choose **Student/Guest** on the role selection screen.
- Register using:
  - Full Name
  - Role (`student`, `member`, `guest`)
  - Mobile Number
  - Email Address
  - Password
  - Preferred Login Method (`email` or `mobile`)
  - Age
  - Gender

#### Authentication

Users can sign in using any of the following methods:

- Email + Password
- Mobile Number + Password
- OTP-based Passwordless Login

#### No Group State

After successful login:

- If the user is not a member of any group, the app displays `no_group_screen`.
- The screen shows:
  - Message: **"Ask your Admin to share a group QR code"**
  - **Scan QR Code** button
  - Empty-state guidance for joining a group

Users without an active group membership cannot access:

- Home Dashboard
- Meals
- Attendance
- Weekly Menu

Access to member features becomes available immediately after successfully joining at least one group.

### 2. Group Joining via QR

**Screens involved**: `no_group_screen`, `group_join_screen`, `qr_scanner_view`

#### Joining a Group

- If the user is not a member of any group, the app displays the No Group screen.
- The user taps **Scan QR Code**.
- The QR scanner opens and scans a group QR code shared by an administrator.
- The QR code contains a unique group join code.
- The app joins the user to the corresponding group.
- After joining successfully, the user is redirected to the Student Dashboard.

#### Student Dashboard

After successfully joining a group, the student is redirected to the Home Dashboard.

The dashboard is dynamically controlled by the group's configuration and displays information for the currently active group.

##### Available Modules

Students can access:

- Home Dashboard
- Attendance
- Attendance History
- Weekly Menu (when enabled)
- Profile
- Settings

##### Always Visible Dashboard Components

The dashboard always displays:

- Welcome Card
- User Avatar
- User Name
- Greeting Message
- Group Name
- Attendance Summary
- Quick Actions

##### Attendance Summary

The attendance summary section may display:

- Attendance Percentage
- Present Count
- Absent Count
- Skipped Count
- Attendance Analytics
- Last 30-Day Attendance Summary

##### Quick Actions

Quick actions may include:

- Mark Attendance
- View Attendance History
- View Weekly Menu (when enabled)

##### Dashboard Layout Modes

The dashboard automatically changes based on the group's meal configuration.

###### Meal + Attendance Mode

When meals are enabled:

Visible:

- Attendance Summary
- Attendance Percentage
- Today's Meals
- Meal Status Cards
- Meal Timing Information
- Menu Preview
- Quick Actions
- Weekly Menu Shortcut (when enabled)
- Attendance History Shortcut

###### Attendance-Only Mode

When meals are disabled:

Visible:

- Attendance Summary
- Attendance Percentage
- Attendance Status
- Attendance History Shortcut
- Quick Actions

Hidden:

- Today's Meals
- Meal Cards
- Menu Preview
- Weekly Menu
- Meal Preference Components

##### Today's Meals

When meal visibility is enabled, the dashboard displays today's meals for the active group.

Meals may include:

- Breakfast
- Lunch
- Dinner
- Custom Meal Slots configured by administrators

Each meal card may display:

- Meal Name
- Slot Type
- Attendance Window
- Current Attendance Status
- Meal Image (if uploaded)
- Menu Items (if configured)

Examples:

- Breakfast → ☕
- Lunch → 🍛
- Dinner → 🌙

##### Meal Status States

Meal cards may display:

- Open
- Closed
- Present
- Absent
- Skipped
- Pending

##### Menu Preview

Meal cards may display menu items configured by administrators.

Examples:

Breakfast:
- Idli
- Sambar
- Tea

Lunch:
- Rice
- Dal
- Sabzi

Dinner:
- Roti
- Paneer Curry
- Salad

##### Dynamic Visibility Rules

###### Meals Module

Visible when:

```text
showMeals = true
```

If disabled:

- Meals screen is hidden.
- Meal widgets are removed from the dashboard.

###### Weekly Menu Module

Visible when:

```text
weeklyMenuEnabled = true
```

If disabled:

- Weekly Menu screen is hidden.
- Weekly Menu shortcuts are hidden.
- Weekly Menu widgets are removed from the dashboard.

###### Meal Preferences

Visible when:

```text
preferencesEnabled = true
```

for the active meal.

If disabled:

- Preference selection is hidden.
- Students directly mark Present, Absent, or Skip.

##### Dashboard Actions

Students can perform the following actions directly from the dashboard:

- Open Attendance Screen
- Mark Attendance
- Update Attendance
- View Attendance History
- Open Weekly Menu (when enabled)
- Open Profile
- Open Settings

##### Error States

###### Blocked User

If the user has been blocked from the group:

> You have been blocked from this group.

The user cannot access attendance or meal functionality for that group.

###### Invalid Group Access

If the group is no longer available or access is revoked:

> Group access is no longer available.

The user is returned to the appropriate onboarding flow.

##### Dashboard Refresh Behavior

Dashboard data updates automatically when:

- Attendance is marked
- Attendance is updated
- Meal schedules change
- Weekly menus are published
- Group configuration changes
- Attendance is modified by an administrator

Updated information is reflected across:

- Home Dashboard
- Attendance Screen
- Attendance History
- Attendance Analytics
- Weekly Menu

### 3. Daily Meal Attendance

**Screens**: `student_dashboard_screen`, `attendance_screen`, `attendance_action_card`

#### Marking Attendance

Students can:

- Mark Present
- Mark Absent
- Skip Meal

Attendance is only allowed within the configured attendance window.

Rules:

- Attendance can only be marked between `openTime` and `closeTime`.
- After the attendance window closes, attendance cannot be modified by the student.
- The application displays:

> Attendance window has closed.

- Administrators may override attendance after the attendance window expires.

#### Meal Preferences

Meal preferences are fully dynamic.

If meal preferences are enabled by the administrator:

- Students must select a meal preference before confirming attendance.
- Only preference options configured for that meal are displayed.
- The application renders only preference options provided by the backend.

Examples:

- Veg
- Chicken
- Fish
- Egg
- Jain

If meal preferences are disabled:

- No preference selection is shown.
- Students directly mark Present, Absent, or Skip.

#### Attendance Updates

After attendance is marked or updated:

- Confirmation is shown immediately.
- The attendance record updates in real time.
- Updated attendance status is reflected in:
  - Home Dashboard
  - Attendance Screen
  - Attendance History
  - Attendance Summary Cards
  - Attendance Analytics

Repeated attendance actions for the same meal and date update the existing attendance record rather than creating duplicates.

#### Blocked Users

Blocked users cannot participate in attendance.

Message shown:

> You have been blocked from this group and cannot mark attendance.

Blocked users cannot access attendance functionality for that group.

#### Default Attendance Mode

Students can enable **Default Attendance Mode** from Settings.

When enabled:

- Attendance is automatically marked according to the group's configured default attendance policy.
- Students only need to manually update meals they wish to mark as Absent or Skip.
- Attendance status remains visible throughout the application.
- This mode reduces daily attendance friction for regular meal attendees.

#### Vacation Mode

Students can enable **Vacation Mode** from Settings.

When enabled:

- Attendance tracking is paused.
- Attendance reminders are paused.
- Meal reminders are paused.
- Default Attendance Mode automation is paused.
- The student is excluded from attendance calculations and analytics.
- Attendance actions are disabled until Vacation Mode is turned off.

Vacation records are displayed as:

> On Vacation

instead of:

> Absent

Students can disable Vacation Mode at any time to resume normal attendance tracking.

### 4. Attendance History

**Screens**: `attendance_history_screen`

#### Attendance Records

Students can view their complete attendance history.

Features:

- Scrollable attendance history list
- Date range filtering
- Monthly attendance summaries
- Attendance analytics
- Attendance status badges

Each attendance record displays:

- Date
- Meal Name
- Meal Slot
- Attendance Status
- Selected Meal Preference (if applicable)

Possible attendance statuses:

- Present
- Absent
- Skipped
- Pending
- On Vacation

#### Attendance Summary

The summary section displays:

- Present Count
- Absent Count
- Skipped Count
- Pending Count
- Attendance Percentage

The selected date range controls both the records and summary calculations.

#### Attendance Analytics

Students can view attendance performance for the selected period.

Metrics include:

- Total Attendance Records
- Present Count
- Absent Count
- Skipped Count
- Attendance Percentage

Attendance percentage is calculated using the platform's attendance calculation rules.

#### Empty State

If no attendance records exist for the selected period:

> No attendance records found.

The history list remains accessible for attendance records.

---

### 5. Weekly Meal Menu

**Screens**: `weekly_menu_screen`, `weekly_menu_grid`

#### Weekly Menu Visibility

The Weekly Menu module is only visible when:

```text
weeklyMenuEnabled = true
```

If disabled:

- Weekly Menu screen is hidden.
- Weekly Menu shortcut is removed from the dashboard.
- Weekly Menu quick actions are hidden.

#### Weekly Menu Features

Students can:

- View the published weekly meal schedule.
- Browse meals for each day of the week.
- View day-wise menu planning.
- View menu items configured by administrators.

#### Weekly Day Selector

Students can switch between days using the day selector.

Examples:

- Mon
- Tue
- Wed
- Thu
- Fri
- Sat
- Sun

The selected day is highlighted.

#### Weekly Menu Layout

The weekly menu displays:

- Day Selector
- Selected Day Highlight
- Published Badge
- Breakfast Menu
- Lunch Menu
- Dinner Menu

Example:

Monday

Breakfast:
- Bread
- Butter
- Tea

Lunch:
- Rice
- Dal
- Sabzi

Dinner:
- Roti
- Paneer Curry

#### Menu Publication Status

Only published weekly menus are visible to students.

A published indicator is displayed when the schedule is available.

#### Empty State

If no weekly menu has been published:

> Weekly menu is not available.

---

### 6. Meal Preferences

**Screens**: `attendance_screen`

#### Preference Visibility

Meal preferences are only shown when:

```text
preferencesEnabled = true
```

for the active meal.

If disabled:

- Preference selection is hidden.
- Students directly mark Present, Absent, or Skip.

#### Dynamic Preferences

Meal preferences are fully dynamic.

The application renders only the preference options provided by the backend.

Examples:

- Veg
- Chicken
- Fish
- Egg
- Jain

The application must never rely on a fixed preference list.

#### Preference Selection

When enabled:

- Students select a preference before confirming attendance.
- The selected preference is stored with the attendance record.
- Preference selections contribute to meal preference analytics.

---

### 7. Profile & Settings Management

**Screens**: `student_profile_screen`, `student_settings_screen`, `edit_profile_screen`

#### Profile Information

Students can view:

- Profile Photo
- Full Name
- Email Address
- Mobile Number
- Gender
- Age
- Role
- Current Group

#### Profile Editing

Students can update:

- Profile Photo
- Full Name
- Mobile Number
- Gender
- Age

#### Attendance Summary

The profile screen displays:

- Attendance Percentage
- Present Count
- Absent Count
- Skipped Count

#### Settings

Students can configure:

- Default Attendance Mode
- Vacation Mode
- Meal Reminders
- Theme Mode

#### Meal Reminders

Students can enable or disable meal reminders.

When Vacation Mode is enabled:

- Meal reminders are automatically paused.

Reminder settings resume when Vacation Mode is disabled.

#### Theme Mode

Available options:

- System
- Light
- Dark

#### Login Preferences

Students can choose their preferred login method:

- Email
- Mobile Number

#### Password Management

Students can:

- Change Password
- Reset Password using OTP verification
- Recover access through Forgot Password flow

#### Sign Out

Students can securely sign out of the application.

A confirmation dialog is shown before logout.

---

### 8. Notifications

Notification architecture is prepared for local notification support.

#### Attendance Notifications

Students may receive:

- Attendance Opening Reminder
- Attendance Closing Reminder
- Attendance Update Notifications

#### Reminder Rules

Attendance reminders are automatically suppressed when:

- Attendance has already been marked.
- Vacation Mode is enabled.
- The attendance window has expired.

#### Planned Reminder Timing

Examples:

- Attendance Closing Reminder (30 minutes before closing)
- Attendance Closing Reminder (10 minutes before closing)

Reminder timing may be configurable by administrators in versions.

#### Attendance Update Notification

Students receive a notification when an administrator manually updates attendance.

Example:

> Your attendance was updated by an administrator.

#### Architecture

The system is designed to support:

- Local Notifications
- Scheduled Notifications
- Reminder Cancellation Logic
- Notification Permissions
- Push Notification Integration
---