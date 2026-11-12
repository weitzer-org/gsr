// Hard call caps for every script that can spend money. A cap is not advisory: take() throws once
// it is reached, so a bug in a loop cannot turn into an unbounded bill.

export class BudgetExceededError extends Error {
  constructor(public readonly label: string, public readonly max: number) {
    super(`${label}: call budget of ${max} exhausted — refusing to make another live call.`);
    this.name = 'BudgetExceededError';
  }
}

export class CallBudget {
  private used = 0;
  constructor(public readonly label: string, public readonly max: number) {
    if (!Number.isInteger(max) || max < 0) throw new Error(`${label}: max calls must be a non-negative integer (got ${max}).`);
  }
  take(n = 1): void {
    if (this.used + n > this.max) throw new BudgetExceededError(this.label, this.max);
    this.used += n;
  }
  get callsUsed(): number { return this.used; }
  get remaining(): number { return this.max - this.used; }
}

// Reads a cap from an env var or a CLI value. A live script MUST be given one explicitly: there is
// deliberately no default, so "forgot to set the cap" is an error, not an unlimited run.
export function requireCap(label: string, raw: string | undefined): number {
  if (raw === undefined || raw === '') throw new Error(`${label}: a hard call cap is required (set it explicitly; there is no default).`);
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`${label}: call cap must be a non-negative integer (got ${JSON.stringify(raw)}).`);
  return Number(raw.trim());
}
