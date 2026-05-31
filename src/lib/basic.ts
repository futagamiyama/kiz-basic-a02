export type Vars = Record<string, number | string>;
export type Arrays = Record<string, (number | string)[]>;
export type UserFunctions = Record<string, { params: string[]; body: string }>;

export const CONSTANTS: Record<string, number> = {
	e: Math.E,
	pi: Math.PI
};

// Standard normal CDF (Abramowitz & Stegun 7.1.26, accurate to ~7.5e-8)
function normalCDF(z: number): number {
	const sign = z >= 0 ? 1 : -1;
	const x = Math.abs(z) * Math.SQRT1_2;
	const t = 1 / (1 + 0.3275911 * x);
	const poly =
		((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
			0.254829592) *
		t;
	const erfAbs = 1 - poly * Math.exp(-x * x);
	return 0.5 * (1 + sign * erfAbs);
}

// Inverse standard normal CDF (Hastings, accurate to ~4.5e-4)
function normalInverseCDF(p: number): number {
	if (p <= 0 || p >= 1) return NaN;
	const sign = p >= 0.5 ? 1 : -1;
	const q = Math.min(p, 1 - p);
	const t = Math.sqrt(-2 * Math.log(q));
	const num = 2.515517 + 0.802853 * t + 0.010328 * t * t;
	const den = 1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t;
	return sign * (t - num / den);
}

export const FUNCTIONS: Record<
	string,
	{ arity: number | number[]; fn: (args: number[]) => number }
> = {
	sin: { arity: 1, fn: (a) => Math.sin(a[0]) },
	cos: { arity: 1, fn: (a) => Math.cos(a[0]) },
	tan: { arity: 1, fn: (a) => Math.tan(a[0]) },
	sqrt: { arity: 1, fn: (a) => Math.sqrt(a[0]) },
	ln: { arity: 1, fn: (a) => Math.log(a[0]) },
	log: {
		arity: [1, 2],
		fn: (a) => (a.length === 1 ? Math.log10(a[0]) : Math.log(a[1]) / Math.log(a[0]))
	},
	// 偏差値 from upper rank (fraction 0..1), assuming normal distribution
	// e.g. hensa(3/100) ≈ 68.8 (top 3% → 偏差値 ≈ 68.8)
	hensa: { arity: 1, fn: (a) => 50 + 10 * normalInverseCDF(1 - a[0]) },
	// upper rank (fraction 0..1) from 偏差値
	// e.g. jyun(70) ≈ 0.023 (偏差値70 → 上位 2.3%)
	jyun: { arity: 1, fn: (a) => 1 - normalCDF((a[0] - 50) / 10) }
};

export interface StepResult {
	output?: string;
	finished: boolean;
}

function tokenize(expr: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < expr.length) {
		const ch = expr[i];
		if (ch === ' ' || ch === '\t') {
			i++;
			continue;
		}
		if ('+-*/()^,[]'.includes(ch)) {
			tokens.push(ch);
			i++;
			continue;
		}
		if (ch === '"') {
			let s = '';
			i++;
			while (i < expr.length && expr[i] !== '"') {
				s += expr[i++];
			}
			i++;
			tokens.push('"' + s + '"');
			continue;
		}
		if (/[0-9.]/.test(ch)) {
			let n = '';
			while (i < expr.length && /[0-9.]/.test(expr[i])) {
				n += expr[i++];
			}
			tokens.push(n);
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			let id = '';
			while (i < expr.length && /[A-Za-z0-9_]/.test(expr[i])) {
				id += expr[i++];
			}
			tokens.push(id);
			continue;
		}
		throw new Error(`Unexpected character: ${ch}`);
	}
	return tokens;
}

class Parser {
	private pos = 0;
	constructor(
		private tokens: string[],
		private vars: Vars,
		private arrays: Arrays = {},
		private userFns: UserFunctions = {}
	) {}

	parseExpr(): number | string {
		return this.parseAddSub();
	}

	private parseAddSub(): number | string {
		let left = this.parseMulDiv();
		while (this.pos < this.tokens.length) {
			const op = this.tokens[this.pos];
			if (op !== '+' && op !== '-') break;
			this.pos++;
			const right = this.parseMulDiv();
			if (op === '+') {
				if (typeof left === 'string' || typeof right === 'string') {
					left = String(left) + String(right);
				} else {
					left = left + right;
				}
			} else {
				left = Number(left) - Number(right);
			}
		}
		return left;
	}

	private parseMulDiv(): number | string {
		let left = this.parseUnary();
		while (this.pos < this.tokens.length) {
			const op = this.tokens[this.pos];
			if (op !== '*' && op !== '/') break;
			this.pos++;
			const right = this.parseUnary();
			if (op === '*') left = Number(left) * Number(right);
			else left = Number(left) / Number(right);
		}
		return left;
	}

	private parseUnary(): number | string {
		if (this.tokens[this.pos] === '-') {
			this.pos++;
			return -Number(this.parseUnary());
		}
		if (this.tokens[this.pos] === '+') {
			this.pos++;
			return this.parseUnary();
		}
		return this.parsePower();
	}

	private parsePower(): number | string {
		const left = this.parsePrimary();
		if (this.tokens[this.pos] === '^') {
			this.pos++;
			const right = this.parseUnary();
			return Math.pow(Number(left), Number(right));
		}
		return left;
	}

	private parsePrimary(): number | string {
		const tok = this.tokens[this.pos++];
		if (tok === undefined) throw new Error('Unexpected end of expression');
		if (tok === '(') {
			const v = this.parseAddSub();
			if (this.tokens[this.pos] !== ')') throw new Error('Missing )');
			this.pos++;
			return v;
		}
		if (tok.startsWith('"')) {
			return tok.slice(1, -1);
		}
		if (/^[0-9.]/.test(tok)) {
			return Number(tok);
		}
		const name = tok.toLowerCase();
		if (name in FUNCTIONS) {
			if (this.tokens[this.pos] !== '(') {
				throw new Error(`Function '${name}' must be called with parentheses`);
			}
			this.pos++;
			const args: number[] = [];
			if (this.tokens[this.pos] !== ')') {
				args.push(Number(this.parseAddSub()));
				while (this.tokens[this.pos] === ',') {
					this.pos++;
					args.push(Number(this.parseAddSub()));
				}
			}
			if (this.tokens[this.pos] !== ')') throw new Error('Missing )');
			this.pos++;
			const f = FUNCTIONS[name];
			const allowed = Array.isArray(f.arity) ? f.arity : [f.arity];
			if (!allowed.includes(args.length)) {
				throw new Error(
					`Function '${name}' expects ${allowed.join(' or ')} argument(s), got ${args.length}`
				);
			}
			return f.fn(args);
		}
		if (name in this.userFns) {
			if (this.tokens[this.pos] !== '(') {
				throw new Error(`Function '${name}' must be called with parentheses`);
			}
			this.pos++;
			const args: (number | string)[] = [];
			if (this.tokens[this.pos] !== ')') {
				args.push(this.parseAddSub());
				while (this.tokens[this.pos] === ',') {
					this.pos++;
					args.push(this.parseAddSub());
				}
			}
			if (this.tokens[this.pos] !== ')') throw new Error('Missing )');
			this.pos++;
			const ufn = this.userFns[name];
			if (args.length !== ufn.params.length) {
				throw new Error(
					`Function '${name}' expects ${ufn.params.length} argument(s), got ${args.length}`
				);
			}
			const localVars: Vars = { ...this.vars };
			for (let i = 0; i < ufn.params.length; i++) {
				localVars[ufn.params[i]] = args[i];
			}
			return evalExpr(ufn.body, localVars, this.arrays, this.userFns);
		}
		if (this.tokens[this.pos] === '[') {
			this.pos++;
			const idx = Number(this.parseAddSub());
			if (this.tokens[this.pos] !== ']') throw new Error('Missing ]');
			this.pos++;
			if (!(name in this.arrays)) {
				throw new Error(`Undefined array: ${tok}`);
			}
			const arr = this.arrays[name];
			if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) {
				throw new Error(`Array index out of range: ${name}[${idx}]`);
			}
			return arr[idx];
		}
		if (name in CONSTANTS) return CONSTANTS[name];
		if (!(name in this.vars)) {
			throw new Error(`Undefined variable: ${tok}`);
		}
		return this.vars[name];
	}
}

function evalExpr(
	expr: string,
	vars: Vars,
	arrays: Arrays = {},
	userFns: UserFunctions = {}
): number | string {
	const tokens = tokenize(expr);
	const p = new Parser(tokens, vars, arrays, userFns);
	return p.parseExpr();
}

function findTopLevelEq(stmt: string): number {
	let depth = 0;
	for (let i = 0; i < stmt.length; i++) {
		const c = stmt[i];
		if (c === '[' || c === '(') depth++;
		else if (c === ']' || c === ')') depth--;
		else if (c === '=' && depth === 0) return i;
	}
	return -1;
}

function evalCondition(
	expr: string,
	vars: Vars,
	arrays: Arrays = {},
	userFns: UserFunctions = {}
): boolean {
	const m = /^(.+?)(<=|>=|<>|<|>|=)(.+)$/.exec(expr);
	if (!m) throw new Error(`Invalid condition: ${expr}`);
	const lhs = evalExpr(m[1].trim(), vars, arrays, userFns);
	const op = m[2];
	const rhs = evalExpr(m[3].trim(), vars, arrays, userFns);
	const ln = Number(lhs);
	const rn = Number(rhs);
	switch (op) {
		case '<':
			return ln < rn;
		case '<=':
			return ln <= rn;
		case '>':
			return ln > rn;
		case '>=':
			return ln >= rn;
		case '=':
			return ln === rn;
		case '<>':
			return ln !== rn;
	}
	return false;
}

export type DrawCommand =
	| { kind: 'cls' }
	| { kind: 'plot'; x: number; y: number }
	| { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
	| { kind: 'color'; r: number; g: number; b: number }
	| { kind: 'window'; xmin: number; ymin: number; xmax: number; ymax: number };

export interface ExecResult {
	output?: string;
	end?: boolean;
	jumpTo?: number;
	gosubTo?: number;
	doReturn?: boolean;
	draw?: DrawCommand;
}

function splitTopLevel(s: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '[' || c === '(') depth++;
		else if (c === ']' || c === ')') depth--;
		if (c === sep && depth === 0) {
			parts.push(cur.trim());
			cur = '';
		} else {
			cur += c;
		}
	}
	if (cur.trim() !== '' || parts.length > 0) parts.push(cur.trim());
	return parts;
}

function parseArgList(
	s: string,
	vars: Vars,
	arrays: Arrays,
	userFns: UserFunctions
): number[] {
	if (s.trim() === '') return [];
	return splitTopLevel(s, ',').map((p) => Number(evalExpr(p, vars, arrays, userFns)));
}

export function splitLabel(rawLine: string): { label?: string; stmt: string } {
	const trimmed = rawLine.trim();
	const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/.exec(trimmed);
	if (m) {
		return { label: m[1].toLowerCase(), stmt: m[2].trim() };
	}
	return { stmt: trimmed };
}

export function collectLabels(lines: string[]): Record<string, number> {
	const labels: Record<string, number> = {};
	for (let i = 0; i < lines.length; i++) {
		const { label } = splitLabel(lines[i]);
		if (label !== undefined) labels[label] = i;
	}
	return labels;
}

export function isNoop(rawLine: string): boolean {
	const { stmt } = splitLabel(rawLine);
	return stmt === '' || stmt.startsWith('#') || stmt.startsWith("'");
}

export function hasGoto(lines: string[]): number {
	for (let i = 0; i < lines.length; i++) {
		const { stmt } = splitLabel(lines[i]);
		if (/^goto\b/i.test(stmt)) return i;
	}
	return -1;
}

export function executeLine(
	rawLine: string,
	vars: Vars,
	labels: Record<string, number> = {},
	arrays: Arrays = {},
	userFns: UserFunctions = {}
): ExecResult {
	const { stmt } = splitLabel(rawLine);
	if (stmt === '' || stmt.startsWith('#') || stmt.startsWith("'")) {
		return {};
	}
	const lower = stmt.toLowerCase();

	if (lower === 'end') {
		return { end: true };
	}

	if (/^if\b/.test(lower)) {
		const m = /^if\s+(.+)\s+goto\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(stmt);
		if (!m) {
			throw new Error(`Invalid if statement: expected 'if <cond> goto <label>'`);
		}
		const target = m[2].toLowerCase();
		if (!(target in labels)) {
			throw new Error(`Unknown label: ${target}`);
		}
		if (evalCondition(m[1].trim(), vars, arrays, userFns)) {
			return { jumpTo: labels[target] };
		}
		return {};
	}

	if (/^goto\b/.test(lower)) {
		const target = stmt.slice(4).trim().toLowerCase();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
			throw new Error(`Invalid goto target: ${stmt.slice(4).trim()}`);
		}
		if (!(target in labels)) {
			throw new Error(`Unknown label: ${target}`);
		}
		return { jumpTo: labels[target] };
	}

	if (/^gosub\b/.test(lower)) {
		const target = stmt.slice(5).trim().toLowerCase();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
			throw new Error(`Invalid gosub target: ${stmt.slice(5).trim()}`);
		}
		if (!(target in labels)) {
			throw new Error(`Unknown label: ${target}`);
		}
		return { gosubTo: labels[target] };
	}

	if (lower === 'return') {
		return { doReturn: true };
	}

	if (/^dim\b/.test(lower)) {
		const m = /^dim\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(.+?)\s*\]\s*$/i.exec(stmt);
		if (!m) {
			throw new Error(`Invalid dim statement: expected 'dim name[size]'`);
		}
		const name = m[1].toLowerCase();
		const size = Number(evalExpr(m[2], vars, arrays, userFns));
		if (!Number.isInteger(size) || size <= 0) {
			throw new Error(`Array size must be a positive integer: ${m[2]}`);
		}
		if (name in CONSTANTS) throw new Error(`Cannot use constant name '${name}' for array`);
		if (name in FUNCTIONS) throw new Error(`Cannot use function name '${name}' for array`);
		if (name in userFns) throw new Error(`'${name}' is already a user function`);
		if (name in vars) throw new Error(`'${name}' is already used as a variable`);
		if (name in arrays) throw new Error(`Array '${name}' already declared`);
		arrays[name] = new Array(size).fill(0);
		return {};
	}

	if (/^def\b/.test(lower)) {
		const m = /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*=(.+)$/i.exec(stmt);
		if (!m) {
			throw new Error(`Invalid def: expected 'def name(p1, p2, ...) = expr'`);
		}
		const name = m[1].toLowerCase();
		const paramsRaw = m[2].trim();
		const body = m[3].trim();
		const params =
			paramsRaw === '' ? [] : paramsRaw.split(',').map((p) => p.trim().toLowerCase());
		const seen = new Set<string>();
		for (const p of params) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) {
				throw new Error(`Invalid parameter name: ${p}`);
			}
			if (p in CONSTANTS) throw new Error(`Cannot use constant name '${p}' as parameter`);
			if (p in FUNCTIONS) throw new Error(`Cannot use function name '${p}' as parameter`);
			if (seen.has(p)) throw new Error(`Duplicate parameter: ${p}`);
			seen.add(p);
		}
		if (body === '') throw new Error(`def: function body is empty`);
		if (name in CONSTANTS) throw new Error(`Cannot redefine constant '${name}'`);
		if (name in FUNCTIONS) throw new Error(`Cannot redefine built-in function '${name}'`);
		if (name in vars) throw new Error(`'${name}' is already used as a variable`);
		if (name in arrays) throw new Error(`'${name}' is already used as an array`);
		userFns[name] = { params, body };
		return {};
	}

	if (lower === 'cls') {
		return { draw: { kind: 'cls' } };
	}

	if (/^plot\b/.test(lower)) {
		const args = parseArgList(stmt.slice(4), vars, arrays, userFns);
		if (args.length !== 2) {
			throw new Error(`'plot' expects 2 arguments (x, y), got ${args.length}`);
		}
		return { draw: { kind: 'plot', x: args[0], y: args[1] } };
	}

	if (/^line\b/.test(lower)) {
		const args = parseArgList(stmt.slice(4), vars, arrays, userFns);
		if (args.length !== 4) {
			throw new Error(`'line' expects 4 arguments (x1, y1, x2, y2), got ${args.length}`);
		}
		return {
			draw: { kind: 'line', x1: args[0], y1: args[1], x2: args[2], y2: args[3] }
		};
	}

	if (/^color\b/.test(lower)) {
		const args = parseArgList(stmt.slice(5), vars, arrays, userFns);
		if (args.length !== 3) {
			throw new Error(`'color' expects 3 arguments (r, g, b), got ${args.length}`);
		}
		return { draw: { kind: 'color', r: args[0], g: args[1], b: args[2] } };
	}

	if (/^window\b/.test(lower)) {
		const args = parseArgList(stmt.slice(6), vars, arrays, userFns);
		if (args.length !== 4) {
			throw new Error(
				`'window' expects 4 arguments (xmin, ymin, xmax, ymax), got ${args.length}`
			);
		}
		return {
			draw: { kind: 'window', xmin: args[0], ymin: args[1], xmax: args[2], ymax: args[3] }
		};
	}

	if (lower.startsWith('print') || /^p(\s|$)/.test(lower)) {
		const prefix = lower.startsWith('print') ? 5 : 1;
		const rest = stmt.slice(prefix).trim();
		if (rest === '') return { output: '' };
		const val = evalExpr(rest, vars, arrays, userFns);
		return { output: String(val) };
	}

	const eqIdx = findTopLevelEq(stmt);
	if (eqIdx > 0) {
		const lhs = stmt.slice(0, eqIdx).trim();
		const rhs = stmt.slice(eqIdx + 1).trim();

		const arrM = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[(.+)\]\s*$/.exec(lhs);
		if (arrM) {
			const name = arrM[1].toLowerCase();
			if (!(name in arrays)) {
				throw new Error(`Undefined array: ${name} (use 'dim ${name}[size]' first)`);
			}
			const i = Number(evalExpr(arrM[2], vars, arrays, userFns));
			if (!Number.isInteger(i) || i < 0 || i >= arrays[name].length) {
				throw new Error(`Array index out of range: ${name}[${i}]`);
			}
			arrays[name][i] = evalExpr(rhs, vars, arrays, userFns);
			return {};
		}

		const name = lhs.toLowerCase();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new Error(`Invalid variable name: ${name}`);
		}
		if (name in CONSTANTS) {
			throw new Error(`Cannot assign to constant: ${name}`);
		}
		if (name in FUNCTIONS) {
			throw new Error(`Cannot assign to function: ${name}`);
		}
		if (name in userFns) {
			throw new Error(`'${name}' is a user function`);
		}
		if (name in arrays) {
			throw new Error(`'${name}' is an array; use ${name}[i]=...`);
		}
		const val = evalExpr(rhs, vars, arrays, userFns);
		vars[name] = val;
		return {};
	}

	throw new Error(`Unknown statement: ${stmt}`);
}
