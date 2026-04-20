/**
 * Central tool registration so stdio (server.js) and HTTP (server-remote.js)
 * stay in sync. Both transports call registerTools(server).
 *
 * MCP write tools NEVER touch exercise_prs — PR computation is a sync-handler
 * concern only. Every tool uses Zod for input validation and returns a
 * JSON-stringified payload in the standard MCP text-content shape.
 */

const { z } = require('zod');
const {
  listExercises, createExercise, suggestAltExercises,
} = require('./tools/exercises');
const {
  listWorkouts, getWorkout, createWorkout, updateWorkout, deleteWorkout,
} = require('./tools/workouts');
const {
  getSessionHistory, getSession, getExerciseHistory, querySessionSets,
} = require('./tools/sessions');
const {
  getPRs, getVolumeSummary,
} = require('./tools/analysis');

// Wrap a tool to return the MCP text-content shape and surface errors.
function wrap(fn) {
  return async (args) => {
    try {
      const result = await fn(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  };
}

// -------------------- Zod schemas for nested workout tree --------------------

const blockExerciseSetSchema = z.object({
  id: z.string().optional(),
  set_number: z.number().int().positive().optional(),
  target_weight: z.number().optional().nullable().describe('Absolute weight; mutually exclusive with target_pct_1rm'),
  target_pct_1rm: z.number().min(0).max(1.2).optional().nullable().describe('Decimal 0.0-1.2 (e.g. 0.75)'),
  target_reps: z.number().int().nonnegative().optional().nullable(),
  target_reps_each: z.boolean().optional().describe('true = "per side" for unilateral'),
  target_duration_sec: z.number().int().nonnegative().optional().nullable().describe('For time-based sets (HIIT, planks)'),
  target_rpe: z.number().int().min(1).max(10).optional().nullable(),
  is_peak: z.boolean().optional().describe('UI ★ flag for pyramid peaks'),
  rest_after_sec: z.number().int().nonnegative().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const blockExerciseSchema = z.object({
  id: z.string().optional(),
  exercise_id: z.string(),
  position: z.number().int().positive().optional(),
  alt_exercise_ids: z.array(z.string()).optional().describe('Suggested swaps for the Swap sheet'),
  sets: z.array(blockExerciseSetSchema).optional(),
});

const workoutBlockSchema = z.object({
  id: z.string().optional(),
  position: z.number().int().positive().optional(),
  kind: z.enum(['single', 'superset', 'circuit']).optional().describe('Block type'),
  rounds: z.number().int().positive().optional().describe('Number of cycles; 1 for single'),
  rest_after_sec: z.number().int().nonnegative().optional().nullable(),
  setup_cue: z.string().optional().nullable().describe('Shown on Transition; **bold** words render in amber'),
  exercises: z.array(blockExerciseSchema).optional(),
});

const workoutTreeCreateSchema = {
  name: z.string().min(1).describe('Workout name'),
  description: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().describe('Filterable tags (lower, upper, hiit, pyramid, ...)'),
  starred: z.boolean().optional(),
  est_duration: z.number().int().positive().optional().describe('Minutes'),
  created_by: z.enum(['user', 'agent']).optional().describe("Defaults to 'agent' for MCP writes"),
  blocks: z.array(workoutBlockSchema).optional().describe('Nested block tree'),
};

const workoutTreeUpdateSchema = {
  id: z.string().describe('Workout id to update'),
  ...workoutTreeCreateSchema,
};

// -------------------- registration --------------------

function registerTools(server) {
  // ---------- exercises ----------

  server.tool(
    'list_exercises',
    'List exercises, alphabetical. Optional filters: name substring, starred, muscleGroup tag, equipment tag.',
    {
      search: z.string().optional().describe('Case-insensitive name substring'),
      starred: z.boolean().optional(),
      muscleGroup: z.string().optional().describe('Exact muscle-group tag (e.g. "quads")'),
      equipment: z.string().optional().describe('Exact equipment tag (e.g. "db")'),
    },
    wrap(listExercises),
  );

  server.tool(
    'create_exercise',
    'Create a new exercise. equipment and muscleGroups are arrays of tags.',
    {
      name: z.string().min(1),
      equipment: z.array(z.string()).optional().describe('e.g. ["db"], ["smith_machine"]'),
      muscleGroups: z.array(z.string()).optional().describe('e.g. ["quads", "glutes"]'),
      movementType: z.enum(['squat', 'hinge', 'push', 'pull', 'carry', 'iso', 'plyo', 'cardio']).optional(),
      isUnilateral: z.boolean().optional(),
      starred: z.boolean().optional(),
      notes: z.string().optional(),
    },
    wrap(createExercise),
  );

  server.tool(
    'suggest_alt_exercises',
    'Rank other exercises by shared muscle_groups / movement_type / equipment. Useful for Swap Exercise.',
    {
      exerciseId: z.string(),
      limit: z.number().int().positive().max(50).optional(),
    },
    wrap(suggestAltExercises),
  );

  // ---------- workouts ----------

  server.tool(
    'list_workouts',
    'List all workout templates with block + exercise counts (no nested tree). Filters: tag, starred, createdBy.',
    {
      tag: z.string().optional(),
      starred: z.boolean().optional(),
      createdBy: z.enum(['user', 'agent']).optional(),
    },
    wrap(listWorkouts),
  );

  server.tool(
    'get_workout',
    'Get a workout template with full nested block → exercise → set tree.',
    { workoutId: z.string() },
    wrap(getWorkout),
  );

  server.tool(
    'create_workout',
    'Create a workout template with nested blocks / exercises / sets. Ids, positions, set_numbers auto-assigned if omitted. created_by defaults to "agent".',
    workoutTreeCreateSchema,
    wrap(createWorkout),
  );

  server.tool(
    'update_workout',
    'Upsert an existing workout tree. Merge-safe: omitted children are NOT deleted. Use delete_workout for full removal.',
    workoutTreeUpdateSchema,
    wrap(updateWorkout),
  );

  server.tool(
    'delete_workout',
    'Hard-delete a workout and its entire block/exercise/set tree. Sessions referencing it keep their snapshot.',
    { workoutId: z.string() },
    wrap(deleteWorkout),
  );

  // ---------- sessions ----------

  server.tool(
    'get_session_history',
    'List past sessions (newest first) with set count, volume, PR count. Epoch-millis dates.',
    {
      workoutId: z.string().optional(),
      status: z.enum(['active', 'completed', 'abandoned']).optional(),
      startDate: z.number().int().optional(),
      endDate: z.number().int().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    wrap(getSessionHistory),
  );

  server.tool(
    'get_session',
    'Single session with all session_sets grouped by exercise, plus the frozen workout_snapshot.',
    { sessionId: z.string() },
    wrap(getSession),
  );

  server.tool(
    'get_exercise_history',
    'All session_sets for an exercise over time (newest first).',
    {
      exerciseId: z.string(),
      startDate: z.number().int().optional(),
      endDate: z.number().int().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    wrap(getExerciseHistory),
  );

  server.tool(
    'query_session_sets',
    'Flexible filter on session_sets (operates on actual_*). Dates are epoch millis.',
    {
      exerciseId: z.string().optional(),
      sessionId: z.string().optional(),
      workoutId: z.string().optional(),
      startDate: z.number().int().optional(),
      endDate: z.number().int().optional(),
      minWeight: z.number().optional(),
      maxWeight: z.number().optional(),
      minReps: z.number().int().optional(),
      maxReps: z.number().int().optional(),
      prOnly: z.boolean().optional(),
      limit: z.number().int().positive().max(2000).optional(),
    },
    wrap(querySessionSets),
  );

  // ---------- analysis ----------

  server.tool(
    'get_prs',
    'Read exercise_prs. Optionally filter by exerciseId or pr_type. MCP never writes these.',
    {
      exerciseId: z.string().optional(),
      prType: z.enum(['weight', 'reps', 'volume', '1rm_est']).optional(),
    },
    wrap(getPRs),
  );

  server.tool(
    'get_volume_summary',
    'Aggregate training volume grouped by exercise, workout, week, or day. Epoch-millis dates.',
    {
      startDate: z.number().int(),
      endDate: z.number().int(),
      groupBy: z.enum(['exercise', 'workout', 'week', 'day']),
    },
    wrap(getVolumeSummary),
  );
}

module.exports = { registerTools };
