// Pure: task-boundary detection (PRD C-8). No engine calls.

export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type TaskMap = Record<string, TaskStatus>

/** A shell command that makes a git commit (not `commit-tree`, not inside a quoted message). */
export function isGitCommit(command: string): boolean {
  return command
    .split(/&&|\|\||;|\n/)
    .some(part => /^\s*(?:\w+=\S*\s+)*git(?:\s+-[cC]\s+\S+)*\s+commit(?:\s|$)/.test(part))
}

/** True when there is at least one task and every one is completed. */
export function allDone(tasks: TaskMap): boolean {
  const all = Object.values(tasks)
  return all.length > 0 && all.every(s => s === 'completed')
}

/** Show the suggestion only in amber or red, and only once per session. */
export const shouldSuggest = (zone: 'green' | 'amber' | 'red', alreadyShown: boolean): boolean =>
  zone !== 'green' && !alreadyShown
