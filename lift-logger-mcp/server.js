const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { listExercises, getExerciseHistory, getPersonalRecords, createExercise } = require('./tools/exercises');
const { listWorkouts, getWorkoutHistory, createWorkout } = require('./tools/workouts');
const { getVolumeSummary, queryRecords } = require('./tools/analysis');

const server = new McpServer({
  name: 'lift-logger',
  version: '1.0.0'
});

// --- Read Tools ---

server.tool(
  'list_exercises',
  'List all exercises in the database',
  { includeDeleted: z.boolean().optional().describe('Include soft-deleted exercises (default: false)') },
  async ({ includeDeleted }) => ({
    content: [{ type: 'text', text: JSON.stringify(listExercises({ includeDeleted }), null, 2) }]
  })
);

server.tool(
  'list_workouts',
  'List all workout templates with their exercises',
  {},
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(listWorkouts(), null, 2) }]
  })
);

server.tool(
  'get_workout_history',
  'Get workout sessions with all sets, grouped by date and workout. Returns exercises with sets/reps/weight for each session.',
  {
    startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
    workoutId: z.string().optional().describe('Filter by specific workout ID'),
    limit: z.number().optional().describe('Max number of sessions to return')
  },
  async (params) => ({
    content: [{ type: 'text', text: JSON.stringify(getWorkoutHistory(params), null, 2) }]
  })
);

server.tool(
  'get_exercise_history',
  'Get history of a specific exercise over time, showing sets/reps/weight per session. Useful for tracking progress.',
  {
    exerciseId: z.string().describe('Exercise ID (required)'),
    startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
    limit: z.number().optional().describe('Max number of sessions to return')
  },
  async (params) => ({
    content: [{ type: 'text', text: JSON.stringify(getExerciseHistory(params), null, 2) }]
  })
);

server.tool(
  'get_personal_records',
  'Get personal records (PRs) for exercises: heaviest weight, most reps, and highest volume (weight x reps). Includes the date each PR was set.',
  { exerciseId: z.string().optional().describe('Filter by specific exercise ID (optional — omit for all exercises)') },
  async ({ exerciseId }) => ({
    content: [{ type: 'text', text: JSON.stringify(getPersonalRecords({ exerciseId }), null, 2) }]
  })
);

server.tool(
  'get_volume_summary',
  'Get aggregated training volume (total sets, reps, and volume as weight x reps) grouped by exercise, workout, week, or day.',
  {
    startDate: z.string().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().describe('End date (YYYY-MM-DD)'),
    groupBy: z.enum(['exercise', 'workout', 'week', 'day']).describe('Group results by this dimension')
  },
  async (params) => ({
    content: [{ type: 'text', text: JSON.stringify(getVolumeSummary(params), null, 2) }]
  })
);

server.tool(
  'query_records',
  'Flexible query for workout records with optional filters. Returns individual sets with exercise and workout names.',
  {
    exerciseId: z.string().optional().describe('Filter by exercise ID'),
    workoutId: z.string().optional().describe('Filter by workout ID'),
    startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
    minWeight: z.number().optional().describe('Minimum weight filter'),
    maxWeight: z.number().optional().describe('Maximum weight filter')
  },
  async (params) => ({
    content: [{ type: 'text', text: JSON.stringify(queryRecords(params), null, 2) }]
  })
);

// --- Write Tools ---

server.tool(
  'create_exercise',
  'Create a new exercise definition. Use list_exercises first to check if it already exists.',
  { name: z.string().describe('Exercise name') },
  async ({ name }) => {
    try {
      const result = createExercise({ name });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'create_workout',
  'Create a new workout template from a list of exercise IDs. Use list_exercises first to get valid IDs.',
  {
    name: z.string().describe('Workout name'),
    exerciseIds: z.array(z.string()).describe('Array of exercise IDs')
  },
  async ({ name, exerciseIds }) => {
    try {
      const result = createWorkout({ name, exerciseIds });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Stdio Transport ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
