import { registerAs } from '@nestjs/config';

/**
 * Multi-dimensional preference-group (Module 36) configuration — centralizes
 * every FR-PG tunable so nothing is hardcoded. All values are
 * environment-overridable.
 *
 * Backed requirements:
 *   FR-PG-081 — config validation caps (groups per meal, options per group).
 *   FR-PG-041 — quantity bounds cap.
 */
export default registerAs('preferences', () => ({
  // SRS Module 03 PREF-006.2: max preference groups bindable to one meal.
  maxGroupsPerMeal: parseInt(process.env.PG_MAX_GROUPS_PER_MEAL ?? '5', 10),
  // SRS Module 03 PREF-006.3: max options (tags) inside one preference group.
  maxOptionsPerGroup: parseInt(process.env.PG_MAX_OPTIONS_PER_GROUP ?? '5', 10),
  // SRS Module 03 PREF-006.1: max standalone preference tags on one meal.
  maxStandaloneTags: parseInt(process.env.PG_MAX_STANDALONE_TAGS ?? '5', 10),
  // Absolute cap for per-option quantity selection.
  maxQuantityCap: parseInt(process.env.PG_MAX_QUANTITY_CAP ?? '10', 10),
  // SRS Module 03 PREF-005: Allow-Multiple ceiling — the admin sets
  // Max Picks 1..N per group; the SRS fixes N at 3.
  maxSelectCap: parseInt(process.env.PG_MAX_SELECT_CAP ?? '3', 10),
}));
