// Branded ID types. Values are still strings at runtime; types prevent mix-ups at compile time.

declare const brand: unique symbol

export type Brand<T, B> = T & { readonly [brand]: B }

export type ExerciseId = Brand<string, 'ExerciseId'>
export type WorkoutId = Brand<string, 'WorkoutId'>
export type WorkoutBlockId = Brand<string, 'WorkoutBlockId'>
export type BlockExerciseId = Brand<string, 'BlockExerciseId'>
export type BlockExerciseSetId = Brand<string, 'BlockExerciseSetId'>
export type SessionId = Brand<string, 'SessionId'>
export type SessionSetId = Brand<string, 'SessionSetId'>
export type ExercisePrId = Brand<string, 'ExercisePrId'>

export const asExerciseId = (s: string) => s as ExerciseId
export const asWorkoutId = (s: string) => s as WorkoutId
export const asWorkoutBlockId = (s: string) => s as WorkoutBlockId
export const asBlockExerciseId = (s: string) => s as BlockExerciseId
export const asBlockExerciseSetId = (s: string) => s as BlockExerciseSetId
export const asSessionId = (s: string) => s as SessionId
export const asSessionSetId = (s: string) => s as SessionSetId
export const asExercisePrId = (s: string) => s as ExercisePrId
