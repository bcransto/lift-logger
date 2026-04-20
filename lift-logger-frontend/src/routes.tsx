import { createBrowserRouter, Navigate } from 'react-router-dom'
import { App } from './App'
import { HomeScreen } from './features/workouts/HomeScreen'
import { OverviewScreen } from './features/workouts/OverviewScreen'
import { TransitionScreen } from './features/session/TransitionScreen'
import { ActiveLiftScreen } from './features/session/ActiveLiftScreen'
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
          { index: true, element: <Navigate to="transition/1" replace /> },
          { path: 'transition/:blockPosition', element: <TransitionScreen /> },
          { path: 'active/:blockPosition/:setKey', element: <ActiveLiftScreen /> },
          { path: 'summary', element: <SummaryScreen /> },
        ],
      },
      { path: 'exercises', element: <ExercisesTab /> },
      { path: 'stats', element: <StatsTab /> },
      { path: 'settings', element: <SettingsTab /> },
    ],
  },
])
