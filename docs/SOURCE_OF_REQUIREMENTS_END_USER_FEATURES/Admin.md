# ROLE: ADMIN / MANAGER

## 1. Organization Account Setup (hostelAdmin / organizationManager)
**Screens**: admin_signup_screen

- Register as admin role
- Organization created automatically on signup (slug generated from name)
- Organization has: name, timezone (default: Asia/Kolkata), logo
- Can manage multiple groups within one organization Account.

### Administrator Registration

Users can register as an administrative user during onboarding.

Supported roles: All Admin

- Hostel Admin
- Organization Manager
- Hostel Manager
- Mess Manager

During registration administrators provide:

- Full Name
- Mobile Number
- Email Address
- login preference
- Password
- Age
- Gender (Male/Female)

After successful registration:

- Organization workspace is automatically created.
- Administrator becomes the organization owner.
- Administrator is redirected to the Admin Dashboard.

---

### Organization Workspace

After login, administrators operate inside an organization workspace.

The workspace allows management of:

- Groups
- Members
- Meals
- Weekly Schedules
- Attendance
- Reports
- Analytics

All data belongs to the administrator's organization workspace.

---

### Multi-Group Management

One organization can manage multiple groups.

Examples:

- Hostel Block A
- Hostel Block B
- Day Scholars
- Staff Dining
- Office Cafeteria

Each group maintains independent:

- Members
- Attendance Records
- Meal Configuration
- Weekly Schedules
- Reports
- Analytics

---

### Administrative Access

Administrators can access:

- Dashboard
- Groups
- Meals
- Weekly Planner
- Attendance
- Reports & Exports
- Profile
- Settings

---

### Data Isolation

All data is separated at the group level.

Each group maintains its own independent:

- Members
- Attendance Records
- Meal Configurations
- Weekly Schedules
- Meal Preferences
- Reports
- Analytics
- Export Data

Examples:

- Hostel Block A
- Hostel Block B
- Day Scholars

Administrators can switch between groups to view and manage data for a specific group.

Group switching is available throughout:

- Dashboard
- Meal Configuration
- Weekly Planner
- Attendance Management
- Reports & Exports

When a group is selected, all screens display data only for the active group.

Administrators cannot view or modify data from another organization.

Data from one group does not affect or mix with data from another group, even when both groups belong to the same organization.

---

## 2. Group Management

**Screens**: admin_groups_screen, admin_group_detail_screen, group_create_screen

- **Create group**: name, type (hostel/mess/cafeteria/PG/coaching/office/factory/community/other), description, max member count
- **Generate QR**: tap "Generate QR" → shows QR code with joinCode embedded
- **Share QR**: download/share QR image with members via WhatsApp, print, etc.
- **Regenerate code**: old QR becomes invalid, new code generated
- **View group stats**: member count, attendance rate
- **Archive group**: soft-delete (isActive=false), members cannot mark attendance

### Group Administration

Groups are the primary operational units of the platform.

Examples:

- Hostel Block A
- Hostel Block B
- Day Scholars
- Staff Dining
- Office Cafeteria
- Community Group

Each group maintains independent:

- Members
- Attendance Records
- Meal Configurations
- Weekly Schedules
- Meal Preferences
- Reports
- Analytics
- Export Data

---

### Create Group

Administrators can create groups with:

- Group Name
- Group Type
- Description
- Maximum Member Count

Supported group types:

- Hostel
- Mess
- Cafeteria
- PG
- Coaching
- Office
- Factory
- Community
- Other

After creation:

- Group becomes active immediately
- Meal configuration can be assigned
- Attendance tracking can be enabled
- Weekly schedules can be configured

---

### Group Selection

Administrators can switch between groups throughout the application.

Group switching is available in:

- Dashboard
- Meal Configuration
- Weekly Planner
- Attendance Management
- Reports & Exports

When a group is selected:

- Attendance metrics refresh automatically
- Meal configuration updates automatically
- Weekly schedules become group-specific
- Reports become group-specific
- Analytics become group-specific

---

### Group Overview

Administrators can view:

- Group Name
- Group Type
- Active Status
- Total Members
- Attendance Rate
- Active Meals
- Weekly Schedule Status

All statistics displayed are specific to the selected group.

---

### QR-Based Member Onboarding

Each group supports QR-based member joining.

Administrators can:

- Generate QR Code
- View Join Code
- Download QR Code
- Share QR Code
- Print QR Code

Supported sharing methods:

- WhatsApp
- Email
- Direct Share
- Printed Posters

Students scan the QR code to join the group.

---

### QR Regeneration

Administrators can regenerate the group's join code.

When regenerated:

- Existing QR codes become invalid
- Existing join codes stop working
- A new join code is generated
- A new QR code becomes active immediately

Used when:

- QR code has been shared publicly
- Membership access needs to be reset
- Security reasons require a new code

---

### Group Statistics

Administrators can monitor:

- Total Members
- Present Today
- Absent Today
- Attendance Rate
- Active Meals
- Weekly Schedule Status

Statistics are displayed only for the currently selected group.

---

### Archive Group

Administrators can archive groups.

Archived groups:

- Cannot accept new members
- Cannot accept attendance submissions
- Cannot be selected for active meal operations
- Preserve historical attendance records
- Preserve reports and analytics

Archiving is implemented as a soft-delete operation.

```text
isActive = false
```

---

## 3. Meal Configuration
**Screens**: `meal_config_screen`, `meal_config_form`, `meal_edit_dialog`

- **Create meal slot**: custom name, any slotKey ("breakfast", "iftar", "high-tea", custom), display order
- **Set attendance window**: open time and close time (HH:MM format)
- **Upload meal image**: max 200KB total, JPEG/PNG
- **Add menu items**: text list of what's being served
- **Enable/disable meal**: toggle `isActive` without deleting
- **Enable meal preferences**: allow students to choose Veg/Chicken/Fish/Mutton/Egg/Jain
- **Select available preferences**: which options to offer for this meal

---

### Group Meal Configuration (5 settings)

**Screens**: admin_settings_screen, group_detail_screen

- `mealsEnabled`: show/hide entire meal section for this group
- `weeklyMenuEnabled`: show/hide weekly menu tab for students
- `preferencesEnabled`: enable/disable preference selection globally
- `enabledPreferences[]`: which specific preference options are available
- `vacationModeEnabled`: allow/disallow members to use vacation mode

---

### Group Meal Configuration

Meal configuration is managed independently for each group.

Administrators can:

- Select active group
- Configure meals for a specific group
- Switch between groups
- View configured meal count
- View active meal count

Examples:

- Hostel Block A
- Hostel Block B
- Day Scholars

All meal settings are group-specific.

---

### Meal System Controls

#### Meals Enabled

Controls whether meals are available for members.

When enabled:

- Students can view meals
- Students can mark meal attendance
- Meal cards appear on the dashboard
- Weekly schedules become available

When disabled:

- Meal cards are hidden
- Weekly menu is hidden
- Students operate in Attendance-Only Mode

---

#### Meal Preferences Enabled

Controls preference collection before attendance submission.

When enabled:

- Administrators can create custom meal preference tags.
- Administrators can edit existing preference tags.
- Administrators can enable or disable specific preference tags.
- Preference tags are configured per group.
- Different groups may use different preference configurations.

Examples:

- Veg
- Egg
- Chicken
- Fish
- Mutton
- Jain
- Diabetic Friendly
- Low Oil
- Extra Rice
- No Onion Garlic
- Custom Tags

#### Attendance Enforcement

When meal preferences are enabled:

- Students must select a preference before attendance can be submitted.
- Attendance submission is blocked until a valid preference is selected.
- Preference selection becomes a mandatory step in the attendance workflow.
- The selected preference is stored with the attendance record.

#### Student Experience

During attendance marking:

1. Student opens meal attendance.
2. Student selects a preference tag.
3. Student marks Present.
4. Attendance is recorded together with the selected preference.

If no preference is selected:

- Attendance submission is rejected.
- Validation message is shown.
- Student must select a preference before continuing.

#### Preference Analytics

Selected preferences are used for:

- Meal preparation planning
- Food quantity estimation
- Vendor planning
- Kitchen operations
- Preference distribution analytics
- Daily meal demand forecasting

#### Preference Visibility

When preferences are disabled:

- Preference selector is hidden.
- Students directly mark attendance.
- No preference data is collected.

When preferences are enabled:

- Only administrator-configured preference tags are shown to students.
- Students cannot create custom preference tags

---

### Preference Configuration

For meals with preferences enabled:

Administrators can:

- Create preference tags
- Edit preference tags
- Delete preference tags
- Enable preference tags
- Disable preference tags
- Reorder preference tags

Only administrator-configured preference tags are displayed to students.

Students cannot create custom preference tags.

Preference selections are used for:

- Meal preparation planning
- Food quantity estimation
- Vendor planning
- Kitchen operations
- Preference distribution analytics
- Daily meal demand forecasting

The selected preference is stored together with the attendance record and is available for reporting and analytics.

---

### Meal Slot Management

Administrators can create and manage meal slots.

Examples:

- Breakfast
- Lunch
- Dinner
- Brunch
- Iftar
- High Tea
- Custom Meal Types

Each meal slot supports:

- Custom meal name
- Custom slot key
- Display order
- Active status
- Edit functionality

---

### Attendance Window Configuration

Each meal defines its own attendance period.

Administrators configure:

- Opening time
- Closing time
- Attendance duration

Examples:

Breakfast

- Open: 07:00
- Close: 09:00

Lunch

- Open: 12:00
- Close: 14:00

Dinner

- Open: 19:00
- Close: 21:00

The UI provides a visual timeline preview of attendance availability.

---

### Meal Description

Each meal may contain:

- Meal description
- Preparation notes
- Serving instructions
- Additional information

Description is optional.

---

### Meal Images

Administrators can upload meal photos.

Supported features:

- Up to 3 images per meal
- JPEG support
- PNG support
- Image preview
- Image replacement
- Image removal

Validation:

- Maximum combined upload size: 200 KB

Images are displayed to students on meal cards.

---

### Menu Management

Administrators can manage meal menu items.

Supported actions:

- Add menu items
- Remove menu items
- Edit menu items
- Reorder menu items

The system displays menu item counts inside meal cards.

---

## 4. Weekly Schedule Management

**Screens**: `meal_schedule_screen`, `meal_schedule_grid`, `weekly_planner_screen`, `schedule_publish_dialog`

- Build weekly meal plan for each group
- Assign meals to each day of the week
- Set per-day menu items (what's cooked each day)
- Set per-day timing overrides (different window than default)
- Publish schedule → makes it visible to students
- Unpublish schedule → allows editing without affecting students

---

### Weekly Planner

The Weekly Planner is used to organize meals across the week for a selected group.

Administrators can:

- Select active group
- View weekly meal schedule
- Create schedules for upcoming weeks
- Edit existing schedules
- Publish schedules
- Unpublish schedules
- Preview student view

All schedules are managed independently per group.

---

### Day-wise Meal Assignment

Administrators can assign meals to specific days.

Supported days:

- Monday
- Tuesday
- Wednesday
- Thursday
- Friday
- Saturday
- Sunday

Each day can contain:

- Breakfast
- Lunch
- Dinner
- Brunch
- High Tea
- Iftar
- Custom meal slots

---

### Daily Menu Planning

Administrators can configure menu items separately for each day.

Examples:

Monday Breakfast

- Idli
- Sambar
- Tea

Tuesday Lunch

- Rice
- Dal
- Paneer Curry

Friday Dinner

- Roti
- Fish Curry
- Rice

Students see the published menu from the Weekly Menu screen.

---

### Schedule Overrides

Administrators can override default meal settings for a specific day.

Supported overrides:

- Open Time
- Close Time
- Attendance Duration
- Menu Items
- Meal Availability

Example:

Default Breakfast:

- 07:00–09:00

Special Event Day:

- 06:00–08:00

Overrides only affect the selected day.

---

### Schedule Status

Each schedule has a publication status.

Draft:

- Visible only to administrators
- Can be edited freely

Published:

- Visible to students
- Appears in Weekly Menu
- Used by Student Dashboard

Unpublished:

- Hidden from students
- Available for editing

---

### Publish Schedule

Administrators can publish schedules when planning is complete.

Publishing:

- Makes schedule visible to students
- Updates Weekly Menu
- Updates Student Dashboard meal previews

Changes become available immediately after publishing.

---

### Student Preview

Administrators can preview how the weekly schedule appears to students.

Preview includes:

- Daily meals
- Menu items
- Meal images
- Attendance windows
- Weekly menu layout

---

### Weekly Planner Actions

Administrators can:

- Create schedule
- Edit schedule
- Duplicate schedule
- Publish schedule
- Unpublish schedule
- Preview schedule
- Delete draft schedule

All actions are logged against the selected group.

---

### Dashboard Integration

Published schedules are automatically used by:

- Student Dashboard
- Weekly Menu Screen
- Attendance Flow
- Meal Analytics
- Reports & Exports

Only published schedules are visible to students.

---

## 5. Member Management

**Screens**: `admin_group_detail_screen`, `group_member_tile`, `member_detail_screen`, `member_search_bar`

- View all members in a group (paginated list)
- Search members by name
- Block member: blocked members cannot mark attendance
- Unblock member: restore access
- Remove member: remove from group (soft-remove from membership)
- View individual member attendance statistics

---

### Member Directory

Administrators can view all members belonging to the selected group.

Member list displays:

- Full Name
- Member Role
- Contact Information
- Join Date
- Membership Status
- Attendance Percentage
- Vacation Status
- Block Status

Only members belonging to the selected group are shown.

---

### Search Members

Administrators can search members by:

- Name
- Mobile Number
- Email Address

Search results update dynamically.

---

### Member Details

Administrators can open a member profile to view:

- Full Name
- Mobile Number
- Email Address
- Gender
- Age
- Join Date
- Group Membership
- Attendance Percentage
- Present Count
- Absent Count
- Skipped Count
- Vacation Status
- Block Status

---

### Attendance Statistics

Each member includes attendance analytics.

Available statistics:

- Attendance Percentage
- Present Count
- Absent Count
- Skipped Count
- Current Month Attendance
- Total Attendance Records

Statistics are calculated using attendance records belonging to the selected group.

---

### Block Member

Administrators can temporarily block members.

Blocked members:

- Cannot mark attendance
- Cannot submit meal preferences
- Cannot participate in attendance workflows

Students receive:

> You have been blocked from this group and cannot mark attendance.

Block status is maintained per group.

---

### Unblock Member

Administrators can restore access for blocked members.

After unblocking:

- Attendance access is restored
- Meal preference selection is restored
- Dashboard functionality resumes normally

---

### Remove Member

Administrators can remove members from a group.

Removal:

- Revokes group membership
- Removes access to group resources
- Removes dashboard access for that group

Historical attendance records remain preserved.

Membership removal is implemented as a soft-remove operation.

---

### Member Status Indicators

Administrators can identify:

- Active Members
- Blocked Members
- Vacation Mode Members
- Removed Members

Status indicators are visible in member lists and member details.

---

### Group-Level Isolation

Member management is scoped to the currently selected group.

Administrators can:

- Switch groups
- View members for the selected group
- Manage members within the selected group

Actions performed in one group do not affect membership records in another group.

---

### Member Management Actions

Administrators can:

- View Members
- Search Members
- View Member Details
- Block Member
- Unblock Member
- Remove Member
- Review Attendance Statistics

All actions are applied only to members of the currently selected group.

---

## 6. Attendance Oversight (Admin Override)

**Screens**: `admin_attendance_screen`, `attendance_filter_bar`, `member_attendance_row`, `attendance_detail_screen`

- View all attendance records for organization/group
- Filter by date, meal slot, group, member, and status
- Override attendance records
- Correct incorrect attendance submissions
- Audit trail maintained for every override

---

### Attendance Management

Administrators can monitor attendance across the selected group.

Available views:

- Daily Attendance
- Meal-wise Attendance
- Member-wise Attendance
- Historical Attendance

Attendance data is scoped to the currently selected group.

---

### Attendance Records

Each attendance record displays:

- Member Name
- Attendance Date
- Meal Name
- Meal Slot
- Attendance Status
- Preference Selection
- Marked Time
- Last Updated Time

Records are available for review and reporting.

---

### Attendance Filters

Administrators can filter attendance records by:

- Date
- Date Range
- Group
- Member
- Meal Slot
- Attendance Status

Supported statuses:

- Present
- Absent
- Skipped
- Vacation

Filters can be combined to narrow results.

---

### Daily Attendance View

Administrators can review attendance for a specific day.

Available metrics:

- Present Count
- Absent Count
- Skipped Count
- Vacation Count
- Attendance Percentage

Results update automatically based on selected filters.

---

### Meal-wise Attendance View

Administrators can inspect attendance by meal.

Examples:

- Breakfast Attendance
- Lunch Attendance
- Dinner Attendance

Administrators can identify:

- Expected Participants
- Actual Participants
- Preference Distribution
- Attendance Percentage

---

### Member Attendance View

Administrators can inspect attendance history for a specific member.

Available information:

- Attendance Timeline
- Present Count
- Absent Count
- Skipped Count
- Attendance Percentage
- Meal Preferences Selected

Historical records remain available even after attendance corrections.

---

### Attendance Override

Administrators can manually update attendance records.

Supported actions:

- Present → Absent
- Absent → Present
- Skipped → Present
- Present → Skipped
- Any valid status correction

Attendance overrides bypass attendance window restrictions.

Used when:

- Student forgot to mark attendance
- Incorrect attendance was submitted
- Administrative correction is required

---

### Override Audit Trail

Every attendance override is recorded.

Audit information includes:

- Original Status
- Updated Status
- Administrator User ID
- Override Timestamp
- `markedBy`
- Override Reason (if provided)

Historical changes remain available for review.

---

### Attendance Integrity

Attendance corrections:

- Preserve historical records
- Preserve reporting accuracy
- Preserve analytics accuracy
- Do not create duplicate attendance entries

The system updates the existing attendance record.

---

### Group-Level Isolation

Attendance management is restricted to the selected group.

Administrators can:

- Switch groups
- View attendance for the selected group
- Manage attendance for the selected group

Attendance records from one group do not affect another group.

---

### Attendance Management Actions

Administrators can:

- View Attendance
- Search Attendance
- Filter Attendance
- Review Member History
- Review Meal Attendance
- Override Attendance
- Audit Attendance Changes

All actions are logged and scoped to the active group.

---

## 7. Dashboard & Analytics

**Screens**: `admin_dashboard_screen`, `admin_greeting_card`, `stats_summary_row`, `quick_action_grid`, `attendance_trend_chart`, `analytics_summary_card`

- Admin KPI cards: totalMembers, groupCount, presentToday, absentToday, attendanceRate
- `attendanceRate` = presentToday / (presentToday + absentToday + skippedToday)
- Attendance trend chart (last 30 days)
- Per-group breakdown
- Per-meal-slot analytics
- Meal preference analytics
- Vacation mode analytics
- Recent activity feed

---

### Dashboard Overview

The Admin Dashboard provides a real-time operational overview of the selected group.

Administrators can:

- Monitor attendance activity
- Review meal participation
- View member statistics
- Access analytics
- Access quick actions
- Switch between groups

All dashboard metrics are scoped to the currently selected group.

---

### KPI Summary Cards

Dashboard KPI cards display:

- Total Members
- Total Groups
- Present Today
- Absent Today
- Skipped Today
- Attendance Rate

Attendance rate is calculated as:

```text
attendanceRate =
presentToday /
(presentToday + absentToday + skippedToday)
```

Attendance percentage is computed client-side by Flutter.

---

### Attendance Analytics

Administrators can review attendance performance across the selected group.

Available metrics:

- Present Count
- Absent Count
- Skipped Count
- Attendance Percentage
- Daily Attendance Trend
- Weekly Attendance Trend
- Monthly Attendance Trend

Analytics update automatically based on selected filters.

---

### Attendance Trend Chart

The dashboard displays attendance trends using historical attendance data.

Supported periods:

- Last 7 Days
- Last 30 Days

Flutter renders charts using raw attendance count data returned by the backend.

Trend charts help identify:

- Attendance growth
- Attendance decline
- Seasonal patterns
- Participation trends

---

### Group Analytics

Administrators can review performance across groups.

Available metrics:

- Total Members
- Attendance Percentage
- Present Count
- Absent Count
- Active Meals
- Weekly Schedule Status

Group analytics are displayed independently for each group.

---

### Meal Slot Analytics

Administrators can analyze attendance by meal slot.

Examples:

- Breakfast Attendance
- Lunch Attendance
- Dinner Attendance
- Brunch Attendance
- Iftar Attendance
- High Tea Attendance

Available metrics:

- Total Attendance
- Attendance Percentage
- Preference Distribution
- Participation Trends

---

### Meal Preference Analytics

Administrators can analyze attendance by meal preference.

Examples:

- Veg
- Egg
- Chicken
- Fish
- Mutton
- Jain
- Custom Preference Tags

Available analytics:

- Preference Selection Count
- Preference Distribution
- Preference Trends
- Preference Participation Rate

Preference data is derived from attendance records.

---

### Preference-wise Attendance

Administrators can view attendance grouped by selected preference.

Examples:

Breakfast

- Veg: 80
- Egg: 20

Lunch

- Veg: 65
- Chicken: 45
- Fish: 30

Dinner

- Veg: 50
- Chicken: 55
- Mutton: 10

This information assists with:

- Meal planning
- Food quantity estimation
- Vendor planning
- Inventory forecasting

---

### Vacation Analytics

Administrators can monitor members currently using Vacation Mode.

Available metrics:

- Active Vacation Users
- Vacation Percentage
- Vacation Trend

Vacation users are excluded from attendance calculations while Vacation Mode is active.

---

### Recent Activity Feed

The dashboard displays recent attendance activity.

Examples:

- Attendance marked
- Attendance updated
- Attendance overridden
- Member joined group
- Member removed
- Member blocked
- Member unblocked

Recent activity helps administrators monitor operational changes.

---

### Quick Actions

The dashboard provides shortcuts to frequently used actions.

Examples:

- Create Group
- Manage Meals
- Weekly Planner
- View Attendance
- Manage Members
- Export Reports

Quick actions reduce navigation time for administrators.

---

### Group Selector Integration

Dashboard analytics are always scoped to the currently selected group.

Administrators can:

- Switch groups
- View group-specific analytics
- View group-specific attendance
- View group-specific meal statistics

Data from one group does not affect analytics for another group.

---

### Dashboard Data Sources

Dashboard metrics are generated from:

- Attendance Records
- Group Memberships
- Meal Configurations
- Weekly Schedules
- Meal Preferences
- Vacation Status

All analytics are calculated using data belonging to the active group.

---

### Dashboard Visibility

Administrators can view:

- KPI Cards
- Attendance Charts
- Group Analytics
- Meal Analytics
- Preference Analytics
- Vacation Analytics
- Recent Activity

The dashboard serves as the primary operational overview for group management.

---

## 8. Reports & Exports (Max 30 days)

**Screens**: `export_screen`, `export_provider`, `report_filter_sheet`, `export_history_screen`

- Export XLSX attendance data
- Export PDF-ready attendance data
- Filter by group, date range, and member
- Download exported files
- Generate attendance and meal reports
- Support operational and billing workflows

---

### Reports Overview

Administrators can generate reports using attendance, meal, and membership data.

Reports are generated for the currently selected group.

Supported report formats:

- XLSX Export
- PDF Export Data
- Attendance Reports
- Meal Reports
- Member Reports

All reports respect group-level data isolation.

---

### Report Filters

Administrators can filter reports before export.

Supported filters:

- Group
- Date
- Date Range
- Member
- Meal Slot
- Attendance Status

Filters can be combined to generate targeted reports.

Examples:

- Monthly Attendance Report
- Weekly Meal Report
- Member Attendance Summary
- Group Attendance Report

---

### Attendance Reports

Administrators can generate attendance reports.

Available information:

- Member Name
- Attendance Date
- Meal Name
- Meal Slot
- Attendance Status
- Preference Selection
- Marked Time

Attendance reports can be generated for:

- Single Member
- Entire Group
- Selected Date Range

---

### Meal Reports

Administrators can generate meal participation reports.

Available information:

- Meal Name
- Attendance Count
- Preference Distribution
- Participation Rate
- Attendance Percentage

Meal reports help evaluate meal consumption trends.

---

### Preference Reports

Administrators can generate preference-based reports.

Available information:

- Member Name
- Attendance Date
- Meal Name
- Selected Preference

Examples:

- Veg Participation Report
- Chicken Preference Report
- Fish Preference Report
- Jain Preference Report
- Custom Preference Reports

Preference reports assist with:

- Vendor Planning
- Procurement Planning
- Food Quantity Estimation
- Demand Forecasting

---

### Member Reports

Administrators can generate reports for individual members.

Available information:

- Attendance Percentage
- Present Count
- Absent Count
- Skipped Count
- Vacation Records
- Meal Preferences

Used for performance and participation tracking.

---

### XLSX Export

Administrators can export attendance data in XLSX format.

Export includes:

- Structured rows and columns
- Attendance records
- Member information
- Meal information
- Preference information

Generated XLSX files can be used for:

- Payroll Processing
- Compliance Reporting
- Meal Billing
- Vendor Reconciliation
- Administrative Audits

---

### PDF Export

The backend returns report data.

Flutter generates the final formatted PDF locally.

PDF exports may include:

- Attendance Summary
- Group Statistics
- Member Statistics
- Meal Analytics
- Preference Analytics

PDF formatting is handled entirely by Flutter.

---

### Export Download

Administrators can download generated reports directly to the device.

Supported actions:

- Download XLSX
- Download PDF
- Share File
- Save Locally

Exported files can be archived for future reference.

---

### Report Analytics Integration

Reports may include:

- Attendance Percentage
- Present Count
- Absent Count
- Skipped Count
- Meal Participation
- Preference Distribution
- Vacation Statistics

Report values are generated from the same data used by Dashboard Analytics.

---

### Group-Level Isolation

Reports are always scoped to the selected group.

Administrators can:

- Switch Groups
- Generate Group-Specific Reports
- Export Group-Specific Data

Data from one group is never mixed with another group during report generation.

---

### Report Generation Actions

Administrators can:

- Generate Report
- Preview Report Data
- Export XLSX
- Export PDF
- Download Report
- Share Report

All generated reports respect organization and group access controls.

---