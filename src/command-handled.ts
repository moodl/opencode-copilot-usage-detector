const SENTINEL = "__BUDGET_COMMAND_HANDLED__"

export function handled(): never {
  throw new Error(SENTINEL)
}

export function isCommandHandledError(err: unknown): boolean {
  return err instanceof Error && err.message === SENTINEL
}
