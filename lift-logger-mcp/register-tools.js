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
  listExercises, createExercise, suggestAltExercises
} = require('./tools/exercises');
const {
  listWorkouts, getWorkout, createWorkout, updateWorkout, deleteWorkout
} = require('./tools/workouts');
const {
  getSessionHistory, getSession, getExerciseHistory, querySessionSets
} = require('./tools/sessions');
const {
  getPRs, getVolumeSummary
} = require('./tools/analysis');

// Small wrapper: all tools return { content: [{type:'text', text: json}] }
// and surface thrown errors with isError:true so the model can react.
function wrap(fn) {
  return async (args) => {
    try {
      const result = await fn(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true
      };
    }
  };
}

// -------------------- Zod schemas for nested workout tree --------------------

const blockExerciseSetSchema = z.object({
  id: z.string().optional(),
  set_number: z.number().int().positive().optional(),
  target_reps: z.number().int().nonnegative().optional().nullable(),
  target_weight: z.number().optional().nullable(),
  target_rpe: z.number().optional().nullable(),
  notes: z.string().optional().nullable()
});

const blockExerciseSchema = z.object({
  id: z.string().optional(),
  exercise_id: z.string(),
  position: z.number().int().nonnegative().optional(),
  notes: z.string().optional().nullable(),
  sets: z.array(blockExerciseSetSchema).optional()
});

const workoutBlockSchema = z.object({
  id: z.string().optional(),
  position: z.number().int().nonnegative().optional(),
  block_type: z.enum(['standard', 'superset', 'circuit', 'dropset']).optional(),
  rest_seconds: z.number().int().nonnegative().optional().nullable(),
  notes: z.string().optional().nullable(),
  exercises: z.array(blockExerciseSchema).optional()
});

const workoutTreeCreateSchema = {
  name: z.string().min(1).describe('Workout name'),
  description: z.string().optional().nullable(),
  blocks: z.array(workoutBlockSchema).optional().describe('Optional nested block tree')
};

const workoutTreeUpdateSchema = {
  id: z.string().describe('Workout id to update'),
  ...workoutTreeCreateSchema
};

// -------------------- registration --------------------

function registerTools(server) {
  // ---------- exercises ----------

  server.tool(
    'list_exercises',
    'List all exercises, optionally including soft-deleted or filtered by name substring.',
    {
      includeDeleted: z.boolean().optional().describe('Include soft-deleted (default false)'),
      search: z.string().optional().describe('Case-insensitive name substring filter')
    },
    wrap(listExercises)
  );

  server.tool(
    'create_exercise',
    'Create a new exercise definition. Call list_exercises first to avoid duplicates.',
    {
      name: z.string().min(1).describe('Exercise name'),
      category: z.string().optional().describe('e.g. compound, isolation, cardio'),
      muscleGroup: z.string().optional().describe('Primary muscle group'),
      equipment: z.string().optional().describe('e.g. barbell, dumbbell, bodyweight'),
      notes: z.string().optional()
    },
    wrap(createExercise)
  );

  server.tool(
    'suggest_alt_exercises',
    'Suggest alternative exercises that share muscle_group / category / equipment with the given exercise.',
    {
      exerciseId: z.string().describe('Exercise to find alternatives for'),
      limit: z.number().int().positive().max(50).optional().describe('Max suggestions (default 10)')
    },
    wrap(suggestAltExercises)
  );

  // ---------- workouts ----------

  server.tool(
    'list_workouts',
    'List all workout templates with block + exercise counts. Use get_workout for full details.',
    {
      includeDeleted: z.boolean().optional().describe('Include soft-deleted (default false)')
    },
    wrap(listWorkouts)
  );

  server.tool(
    'get_workout',
    'Get a workout template with full nested block → exercise → set tree.',
    { workoutId: z.string().describe('Workout id') },
    wrap(getWorkout)
  );

  server.tool(
    'create_workout',
    'Create a new workout template with nested blocks / exercises / sets. Block ids, positions, and set_numbers are auto-assigned when omitted.',
    workoutTreeCreateSchema,
    wrap(createWorkout)
  );

  server.tool(
    'update_workout',
    'Update an existing workout template. Pass the full tree — id is required. Children without ids get new ones.',
    workoutTreeUpdateSchema,
    wrap(updateWorkout)
  );

  server.tool(
    'delete_workout',
    'Soft-delete a workout template and its entire block/exercise/set tree.',
    { workoutId: z.string().describe('Workout id') },
    wrap(deleteWorkout)
  );

  // ---------- sessions ----------

  server.tool(
    'get_session_history',
    'List past workout sessions (newest first) with aggregate stats. Dates are epoch millis.',
    {
      workoutId: z.string().optional(),
      startDate: z.number().int().optional().describe('Epoch millis'),
      endDate: z.number().int().optional().describe('Epoch millis'),
      limit: z.number().int().positive().max(500).optional()
    },
    wrap(getSessionHistory)
  );

  server.tool(
    'get_session',
    'Get a single session with all sets grouped by exercise.',
    { sessionId: z.string() },
    wrap(getSession)
  );

  server.tool(
    'get_exercise_history',
    'All sets recorded for a specific exercise over time. Dates are epoch millis.',
    {
      exerciseId: z.string(),
      startDate: z.number().int().optional(),
      endDate: z.number().int().optional(),
      limit: z.number().int().positive().max(1000).optional()
    },
    wrap(getExerciseHistory)
  );

  server.tool(
    'query_session_sets',
    'Flexible filter on session sets. Dates are epoch millis.',
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
      includeWarmup: z.boolean().optional(),
      limit: z.number().int().positive().max(2000).optional()
    },
    wrap(querySessionSets)
  );

  // ---------- analysis ----------

  server.tool(
    'get_prs',
    'Read personal records from exercise_prs. Optionally filter by exerciseId or pr_type.',
    {
      exerciseId: z.string().optional(),
      prType: z.enum(['weight', 'reps', 'volume', '1rm_est']).optional()
    },
    wrap(getPRs)
  );

  server.tool(
    'get_volume_summary',
    'Aggregate training volume grouped by exercise, workout, week, or day. Dates are epoch millis.',
    {
      startDate: z.number().int().describe('Epoch millis'),
      endDate: z.number().int().describe('Epoch millis'),
      groupBy: z.enum(['exercise', 'workout', 'week', 'day'])
    },
    wrap(getVolumeSummary)
  );
}

module.exports = { registerTools };
