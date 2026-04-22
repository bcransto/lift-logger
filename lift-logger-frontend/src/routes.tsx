import { createBrowserRouter, Navigate } from 'react-router-dom'
import { App } from './App'
import { HomeScreen } from './features/workouts/HomeScreen'
import { OverviewScreen } from './features/workouts/OverviewScreen'
import { BlockIntroScreen } from './features/session/BlockIntroScreen'
import { BlockView } from './features/session/BlockView'
import { SummaryScreen } from './features/session/SummaryScreen'
import { ExercisesTab, StatsTab, SettingsTab } from './features/stubs/StubScreen'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomeScreen /> },
      { path: 'workout/:workoutId', element: <OverviewScreen /> },
      {
        path: 'session/:sessionId',
        children: [
          { index: true, element: <Navigate to="intro/1" replace /> },
          { path: 'intro/:blockPosition', element: <BlockIntroScreen /> },
          { path: 'active/:blockPosition/:setKey', element: <BlockView /> },
          { path: 'summary', element: <SummaryScreen /> },
        ],
      },
      { path: 'exercises', element: <ExercisesTab /> },
      { path: 'stats', element: <StatsTab /> },
      { path: 'settings', element: <SettingsTab /> },
    ],
  },
])
