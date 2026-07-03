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
  // Max preference groups bindable to one meal.
  maxGroupsPerMeal: parseInt(process.env.PG_MAX_GROUPS_PER_MEAL ?? '8', 10),
  // Max options inside one preference group.
  maxOptionsPerGroup: parseInt(process.env.PG_MAX_OPTIONS_PER_GROUP ?? '15', 10),
  // Absolute cap for per-option quantity selection.
  maxQuantityCap: parseInt(process.env.PG_MAX_QUANTITY_CAP ?? '10', 10),
}));
