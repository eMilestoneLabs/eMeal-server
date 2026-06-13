# ROLE: EVENT GUEST

Event Guest joins an event, manages their own party members, selects who will attend, and submits meal preferences.

No account is required.

---

## 1. EVENT JOIN

### Screens

- event_entry_screen
- event_guest_join_screen

### Join Flow

```text
Open App
      ↓
Continue as Event Guest
      ↓
Scan Event QR Code
OR
Enter Join Code
      ↓
Enter Primary Guest Name
      ↓
Enter Adult Count
      ↓
Enter Child Count
      ↓
Create Party
```

#### Example

```text
Primary Guest Name: Rahul Mahanta

Adults: 3
Children: 2
```

---

## 2. AUTOMATIC PARTY CREATION

The system automatically creates party members.

#### Example

```text
Rahul Mahanta
Guest-2
Guest-3
Guest-4
Guest-5
```

Where:

```text
Adults:
- Rahul Mahanta
- Guest-2
- Guest-3

Children:
- Guest-4
- Guest-5
```

---

## 3. EVENT GUEST SHELL

### Screens

- event_guest_shell

Guests can only manage their own party.

---

## 4. RENAME PARTY MEMBERS

Guests may rename any generated member.

#### Example

```text
Guest-2
```

becomes

```text
Sunita Mahanta
```

---

## 5. ATTENDING STATUS SELECTION

Guests select which members will attend the event.

#### Example

```text
Rahul Mahanta   ✓ Attending
Sunita Mahanta  ✓ Attending
Guest-3         ✗ Not Attending
Guest-4         ✓ Attending
Guest-5         ✗ Not Attending
```

---

## 6. MEAL SELECTION

Guests select meal types only from options configured by the Event Admin.

#### Example

```text
Rahul Mahanta  → Chicken
Sunita Mahanta → Veg
Guest-4        → Fish
```

Available meal types depend on the event.

Example:

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

## 7. CONFIRM PARTY

After:

- Renaming members
- Selecting attending status
- Selecting meals

Guest taps:

```text
Confirm
```

The party information is submitted to the Event Admin.

---

## 8. Party Status

After confirmation guests may:

- View submitted party
- View attending selections
- View meal selections
- Update information while Event Status = Upcoming

Guests cannot modify data when:

- Event Status = Closed
- Event Status = Expired

---

## BUSINESS RULES

### Attending Rule

Only guests marked as:

```text
Attending
```

are included in meal planning.

Guests marked:

```text
Not Attending
```

are excluded from meal calculations.

### Meal Rule

Guests can only choose meal types created by the Event Admin.

Guests cannot create custom meal types.

### Event Closed Rule

When:

```text
Event Status = CLOSED
```

Guests can no longer:

- Join Event
- Rename Members
- Modify Attending Status
- Modify Meal Selections

Guests may still view their party information.

---

## EVENT GUEST MASTER FLOW

```text
Open App
      ↓
Continue as Event Guest
      ↓
Scan QR / Enter Join Code
      ↓
Enter Primary Guest Name
      ↓
Enter Adult Count
      ↓
Enter Child Count
      ↓
Party Created
      ↓
Rename Members
      ↓
Select Attending Members
      ↓
Select Meal Types
      ↓
Confirm
```