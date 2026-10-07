import type { DagDefinitions } from './dag_parser';

// Port note (AGC): fields widened private → protected so DagRuntime (runtime.ts)
// can drive state directly. No behavior change from VOID original.
export class DagResolver {
  protected defs: DagDefinitions;
  protected state: Record<string, number>;
  protected cache: Record<string, number>;

  constructor(defs: DagDefinitions) {
    this.defs = defs;
    this.state = {};
    this.cache = {};
  }

  // Update inputs (from Pinia)
  public setState(newState: Record<string, number>) {
    this.state = { ...newState };
    this.cache = {}; // Clear cache on state change
  }

  // Get final stat
  public get(id: string): number {
    if (this.cache[id] !== undefined) return this.cache[id];

    // Check if it's an explicit state/input
    if (this.state[id] !== undefined) {
      this.cache[id] = this.state[id];
      return this.state[id];
    }

    // Check if it's a default VAR
    if (this.defs.vars[id]) {
      // It might have been overridden in state, but if not:
      this.cache[id] = this.defs.vars[id].defaultValue;
      return this.cache[id];
    }

    // Check if it's a CALC
    if (this.defs.calcs[id]) {
      const result = this.evaluateRpn(this.defs.calcs[id].rpn);
      this.cache[id] = result;
      return result;
    }

    // Default to 0 if unknown
    return 0;
  }

  private evaluateRpn(rpn: string[]): number {
    const stack: number[] = [];

    for (const token of rpn) {
      if (!isNaN(parseFloat(token))) {
        stack.push(parseFloat(token));
      } else if (['+', '-', '*', '/', '^', 'max', 'min', 'pow', '>=', '<=', '==', '!=', '>', '<', '||', '&&'].includes(token)) {
        const b = stack.pop() || 0;
        const a = stack.pop() || 0;
        switch (token) {
          case '+': stack.push(a + b); break;
          case '-': stack.push(a - b); break;
          case '*': stack.push(a * b); break;
          case '/': stack.push(b !== 0 ? a / b : 0); break;
          case '^':
          case 'pow': stack.push(Math.pow(a, b)); break;
          case 'max': stack.push(Math.max(a, b)); break;
          case 'min': stack.push(Math.min(a, b)); break;
          case '>=': stack.push(a >= b ? 1 : 0); break;
          case '<=': stack.push(a <= b ? 1 : 0); break;
          case '==': stack.push(a === b ? 1 : 0); break;
          case '!=': stack.push(a !== b ? 1 : 0); break;
          case '>': stack.push(a > b ? 1 : 0); break;
          case '<': stack.push(a < b ? 1 : 0); break;
          case '||': stack.push((a || b) ? 1 : 0); break;
          case '&&': stack.push((a && b) ? 1 : 0); break;
        }
      } else {
        // It's a variable reference
        stack.push(this.get(token));
      }
    }

    return stack[0] || 0;
  }

  // Resolve an explicit condition
  public evaluateCondition(rpn: string[]): boolean {
     return this.evaluateRpn(rpn) > 0;
  }

  // Helper to dump all calculated values for debugging
  public resolveAllCalculations(): Record<string, number> {
    const all: Record<string, number> = {};
    for (const id in this.defs.calcs) {
      all[id] = this.get(id);
    }
    return all;
  }
}
