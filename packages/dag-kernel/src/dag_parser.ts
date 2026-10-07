export interface DagVar {
  id: string;
  defaultValue: number;
}

export interface DagDef {
  type: string;
  id: string;
  metadata: Record<string, string | number>;
}

export interface DagCalc {
  id: string;
  rpn: string[];
}

export interface DagCost {
  id: string;
  baseCost: number;
  resource: string;
  exponent: number;
  /** Optional gate — cost line applies only when condition resolves true. */
  whenRpn?: string[];
  /**
   * Explicit per-level cost overrides. When present, the cost at level N is
   * `costTable[N]` (0-indexed: costTable[0] = first purchase). If the level
   * exceeds the table, falls back to `baseCost * exponent^level`.
   * Set by COST_TABLE syntax: `COST_TABLE <id> <resource> 8,10,12,15,20,...`
   */
  costTable?: number[];
}

export interface DagProgression {
  id: string;
  type: 'REVEAL' | 'UNLOCK' | 'REVEALUNLOCK';
  rpn: string[];
}

export interface DagDefinitions {
  vars: Record<string, DagVar>;
  /**
   * Last def wins per id (kept for getDef). Note jobs/crafts/buildings can
   * share an id with a RESOURCE def (e.g. the "cement" job vs stock) — use
   * `defsByType` when every typed def matters.
   */
  defs: Record<string, DagDef>;
  /** Every def, grouped by type — duplicate ids survive here. */
  defsByType: Record<string, DagDef[]>;
  calcs: Record<string, DagCalc>;
  costs: Record<string, DagCost[]>;
  progressions: Record<string, DagProgression[]>;
}

const precedence: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
  '^': 7
};

const isOperator = (token: string) => token in precedence;
const isFunction = (token: string) => ['max', 'min', 'pow'].includes(token);

export const tokenize = (expr: string): string[] => {
  const regex = /\s*([A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|>=|<=|==|!=|\|\||&&|[+\-*/^(),<>])\s*/g;
  const tokens: string[] = [];
  let match;
  while ((match = regex.exec(expr)) !== null) {
    if (match[1]) tokens.push(match[1]);
  }
  return tokens;
};

export const toRpn = (expr: string): string[] => {
  const tokens = tokenize(expr);
  const output: string[] = [];
  const operators: string[] = [];

  for (const token of tokens) {
    if (!isNaN(parseFloat(token))) {
      output.push(token); // Number
    } else if (isFunction(token)) {
      operators.push(token);
    } else if (token === ',') {
      while (operators.length > 0 && operators[operators.length - 1] !== '(') {
        output.push(operators.pop()!);
      }
    } else if (isOperator(token)) {
      while (
        operators.length > 0 &&
        operators[operators.length - 1] !== '(' &&
        (isFunction(operators[operators.length - 1]) ||
          precedence[operators[operators.length - 1]] >= precedence[token])
      ) {
        output.push(operators.pop()!);
      }
      operators.push(token);
    } else if (token === '(') {
      operators.push(token);
    } else if (token === ')') {
      while (operators.length > 0 && operators[operators.length - 1] !== '(') {
        output.push(operators.pop()!);
      }
      if (operators[operators.length - 1] === '(') {
        operators.pop();
      }
      if (operators.length > 0 && isFunction(operators[operators.length - 1])) {
        output.push(operators.pop()!);
      }
    } else {
      // Identifier
      output.push(token);
    }
  }

  while (operators.length > 0) {
    output.push(operators.pop()!);
  }

  return output;
};

const parseMetadata = (metaStr: string): Record<string, string | number> => {
  const meta: Record<string, string | number> = {};
  // Keys may contain underscores (EFFECT_STAT, EFFECT_EMOJI). Without `_` in
  // the class, "EFFECT_EMOJI" matches as "EMOJI" and clobbers the real EMOJI.
  const regex = /([A-Z_]+)="([^"]+)"|([A-Z_]+)=([0-9.]+)/g;
  let match;
  while ((match = regex.exec(metaStr)) !== null) {
    if (match[1]) meta[match[1]] = match[2];
    if (match[3]) meta[match[3]] = parseFloat(match[4]);
  }
  return meta;
};

/**
 * COST <id> BASE=<n> <resource> [EXP=<n>] [WHEN <expr>]
 * Legacy: COST <id> <n> <resource> [^ <n>]
 */
export const parseCostLine = (line: string): DagCost | null => {
  const head = line.match(/^COST\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);
  if (!head) return null;

  const id = head[1];
  let rest = head[2].trim();

  let whenRpn: string[] | undefined;
  const whenIdx = rest.search(/\s+WHEN\s+/i);
  if (whenIdx >= 0) {
    const whenExpr = rest.slice(whenIdx).replace(/^\s+WHEN\s+/i, '').trim();
    rest = rest.slice(0, whenIdx).trim();
    if (whenExpr) whenRpn = toRpn(whenExpr);
  }

  let costTable: number[] | undefined;
  const valuesMatch = rest.match(/\bVALUES\s*=\s*([0-9.,]+)/i);
  if (valuesMatch) {
    costTable = valuesMatch[1].split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    rest = rest.replace(valuesMatch[0], ' ').trim();
  }

  let baseCost: number | undefined;
  let exponent = 1.0;
  let resource: string | undefined;

  const baseMatch = rest.match(/\b(?:THEN_)?BASE\s*=\s*([0-9.]+)/i);
  if (baseMatch) {
    baseCost = parseFloat(baseMatch[1]);
    rest = rest.replace(baseMatch[0], ' ').trim();
  }

  const expMatch = rest.match(/\bEXP\s*=\s*([0-9.]+)/i);
  if (expMatch) {
    exponent = parseFloat(expMatch[1]);
    rest = rest.replace(expMatch[0], ' ').trim();
  }

  const caretMatch = rest.match(/\^\s*([0-9.]+)/);
  if (caretMatch) {
    exponent = parseFloat(caretMatch[1]);
    rest = rest.replace(caretMatch[0], ' ').trim();
  }

  // Remaining tokens: legacy positional base, then resource id.
  const tokens = rest.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (baseCost === undefined && !isNaN(parseFloat(tok)) && /^[0-9.]+$/.test(tok)) {
      baseCost = parseFloat(tok);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) {
      resource = tok;
    }
  }

  if (baseCost === undefined && costTable && costTable.length > 0) {
    baseCost = costTable[costTable.length - 1];
  }

  if (baseCost === undefined || !resource) return null;

  return { id, baseCost, resource, exponent, whenRpn, costTable };
};

export const parseDagFiles = (files: Record<string, string>): DagDefinitions => {
  const definitions: DagDefinitions = {
    vars: {},
    defs: {},
    defsByType: {},
    calcs: {},
    costs: {},
    progressions: {}
  };

  for (const content of Object.values(files)) {
    const lines = content.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;

      if (line.startsWith('VAR ')) {
        const match = line.match(/VAR\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([0-9.]+)/);
        if (match) {
          definitions.vars[match[1]] = { id: match[1], defaultValue: parseFloat(match[2]) };
        }
      } else if (line.startsWith('CALC ')) {
        const match = line.match(/CALC\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)/);
        if (match) {
          definitions.calcs[match[1]] = { id: match[1], rpn: toRpn(match[2]) };
        }
      } else if (line.startsWith('DEF ')) {
        const match = line.match(/DEF\s+([A-Z]+)\s+([A-Za-z_][A-Za-z0-9_]*)(.*)/);
        if (match) {
          const def: DagDef = {
            type: match[1],
            id: match[2],
            metadata: parseMetadata(match[3])
          };
          definitions.defs[def.id] = def;
          (definitions.defsByType[def.type] ??= []).push(def);
        }
      } else if (line.startsWith('COST ')) {
        const cost = parseCostLine(line);
        if (cost) {
          if (!definitions.costs[cost.id]) definitions.costs[cost.id] = [];
          definitions.costs[cost.id].push(cost);
        }
      } else if (line.match(/^(REVEAL|UNLOCK|REVEALUNLOCK)\s+/)) {
        const match = line.match(/^(REVEAL|UNLOCK|REVEALUNLOCK)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)/);
        if (match) {
          const type = match[1] as 'REVEAL' | 'UNLOCK' | 'REVEALUNLOCK';
          const id = match[2];
          if (!definitions.progressions[id]) definitions.progressions[id] = [];
          definitions.progressions[id].push({
            id,
            type,
            rpn: toRpn(match[3])
          });
        }
      }
    }
  }

  return definitions;
};
