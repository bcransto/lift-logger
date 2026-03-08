const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const express = require('express');
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
  {
    includeDeleted: { type: 'boolean', description: 'Include soft-deleted exercises (default: false)' }
  },
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
    startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
    workoutId: { type: 'string', description: 'Filter by specific workout ID' },
    limit: { type: 'number', description: 'Max number of sessions to return' }
  },
  async (params) => ({
    content: [{ type: 'text', text: JSON.stringify(getWorkoutHistory(params), null, 2) }]
  })
);

server.tool(
  'get_exercise_history',
  'Get history of a specific exercise over time, showing sets/reps/weight per session. Useful for tracking progress.',
  {
    exerciseId: { type: 'string', description: 'Exercise ID (required)' },
    startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
    limit: { type: 'number', description: 'Max number of sessions to return' }
  },
  async (params) => {
    if (!params.exerciseId) {
      return { content: [{ type: 'text', text: 'Error: exerciseId is required' }], isError: true };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(getExerciseHistory(params), null, 2) }]
    };
  }
);

server.tool(
  'get_personal_records',
  'Get personal records (PRs) for exercises: heaviest weight, most reps, and highest volume (weight x reps). Includes the date each PR was set.',
  {
    exerciseId: { type: 'string', description: 'Filter by specific exercise ID (optional — omit for all exercises)' }
  },
  async ({ exerciseId }) => ({
    content: [{ type: 'text', text: JSON.stringify(getPersonalRecords({ exerciseId }), null, 2) }]
  })
);

server.tool(
  'get_volume_summary',
  'Get aggregated training volume (total sets, reps, and volume as weight x reps) grouped by exercise, workout, week, or day.',
  {
    startDate: { type: 'string', description: 'Start date (YYYY-MM-DD, required)' },
    endDate: { type: 'string', description: 'End date (YYYY-MM-DD, required)' },
    groupBy: { type: 'string', description: 'Group by: "exercise", "workout", "week", or "day" (required)' }
  },
  async (params) => {
    if (!params.startDate || !params.endDate || !params.groupBy) {
      return { content: [{ type: 'text', text: 'Error: startDate, endDate, and groupBy are required' }], isError: true };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(getVolumeSummary(params), null, 2) }]
    };
  }
);

server.tool(
  'query_records',
  'Flexible query for workout records with optional filters. Returns individual sets with exercise and workout names.',
  {
    exerciseId: { type: 'string', description: 'Filter by exercise ID' },
    workoutId: { type: 'string', description: 'Filter by workout ID' },
    startDate: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
    endDate: { type: 'string', description: 'End date (YYYY-MM-DD)' },
    minWeight: { type: 'number', description: 'Minimum weight filter' },
    maxWeight: { type: 'number', description: 'Maximum weight filter' }
  },
  async (params) => ({
    content: [{ type: 'text', text: JSON.stringify(queryRecords(params), null, 2) }]
  })
);

// --- Write Tools ---

server.tool(
  'create_exercise',
  'Create a new exercise definition. Use list_exercises first to check if it already exists.',
  {
    name: { type: 'string', description: 'Exercise name (required)' }
  },
  async ({ name }) => {
    if (!name) {
      return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
    }
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
    name: { type: 'string', description: 'Workout name (required)' },
    exerciseIds: { type: 'string', description: 'Comma-separated exercise IDs (required)' }
  },
  async ({ name, exerciseIds }) => {
    if (!name || !exerciseIds) {
      return { content: [{ type: 'text', text: 'Error: name and exerciseIds are required' }], isError: true };
    }
    try {
      const ids = exerciseIds.split(',').map(id => id.trim());
      const result = createWorkout({ name, exerciseIds: ids });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- SSE Transport ---

const app = express();
const PORT = process.env.PORT || 3001;

// Store active transports by session ID
const transports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) {
    return res.status(400).json({ error: 'Unknown session' });
  }
  await transport.handlePostMessage(req, res);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'lift-logger-mcp' });
});

app.listen(PORT, () => {
  console.log(`Lift Logger MCP server running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
