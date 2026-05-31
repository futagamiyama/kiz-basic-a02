<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import loader from '@monaco-editor/loader';
	import type * as Monaco from 'monaco-editor';
	import {
		executeLine,
		collectLabels,
		isNoop,
		hasGoto,
		CONSTANTS,
		type Vars,
		type Arrays,
		type UserFunctions,
		type DrawCommand
	} from '$lib/basic';

	let editorEl: HTMLDivElement;
	let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
	let monaco: typeof Monaco | null = null;
	let decorations: string[] = [];

	const CANVAS_W = 400;
	const CANVAS_H = 400;
	let gfxWin: Window | null = null;
	let gfxCtx: CanvasRenderingContext2D | null = null;
	let gfxColor = { r: 0, g: 0, b: 0 };
	let gfxWindow: { xmin: number; ymin: number; xmax: number; ymax: number } | null = null;

	function worldToPixel(x: number, y: number): [number, number] {
		if (!gfxWindow) return [x, y];
		const px = ((x - gfxWindow.xmin) / (gfxWindow.xmax - gfxWindow.xmin)) * CANVAS_W;
		const py = CANVAS_H - ((y - gfxWindow.ymin) / (gfxWindow.ymax - gfxWindow.ymin)) * CANVAS_H;
		return [px, py];
	}

	function clearCanvas() {
		if (!gfxCtx) return;
		gfxCtx.fillStyle = '#ffffff';
		gfxCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
	}

	function colorStr() {
		return `rgb(${gfxColor.r}, ${gfxColor.g}, ${gfxColor.b})`;
	}

	function openGraphWindow(): boolean {
		const w = window.open(
			'',
			'basic-graph',
			`width=${CANVAS_W + 32},height=${CANVAS_H + 32},resizable=yes`
		);
		if (!w) {
			error = 'Could not open Graph window (popup blocked).';
			return false;
		}
		w.document.title = 'BASIC Graph';
		w.document.body.style.cssText =
			'margin:0;background:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;';
		const c = w.document.createElement('canvas');
		c.width = CANVAS_W;
		c.height = CANVAS_H;
		c.style.cssText = 'background:#fff;border:1px solid #444;display:block;';
		w.document.body.appendChild(c);
		gfxWin = w;
		gfxCtx = c.getContext('2d');
		clearCanvas();
		return true;
	}

	function programHasDrawing(lines: string[]): boolean {
		return lines.some((line) => {
			const t = line.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:/, '').trim();
			return /^(cls|plot|line|color|window)\b/i.test(t);
		});
	}

	function ensureGraphWindowIfNeeded() {
		if (gfxWin && !gfxWin.closed && gfxCtx) return;
		gfxWin = null;
		gfxCtx = null;
		if (programHasDrawing(getLines())) openGraphWindow();
	}

	function applyDraw(cmd: DrawCommand) {
		switch (cmd.kind) {
			case 'color':
				gfxColor = { r: cmd.r, g: cmd.g, b: cmd.b };
				return;
			case 'window':
				gfxWindow = { xmin: cmd.xmin, ymin: cmd.ymin, xmax: cmd.xmax, ymax: cmd.ymax };
				return;
		}
		if (!gfxCtx) return;
		switch (cmd.kind) {
			case 'cls':
				clearCanvas();
				return;
			case 'plot': {
				const [px, py] = worldToPixel(cmd.x, cmd.y);
				gfxCtx.fillStyle = colorStr();
				gfxCtx.fillRect(Math.round(px) - 1, Math.round(py) - 1, 2, 2);
				return;
			}
			case 'line': {
				const [x1, y1] = worldToPixel(cmd.x1, cmd.y1);
				const [x2, y2] = worldToPixel(cmd.x2, cmd.y2);
				gfxCtx.strokeStyle = colorStr();
				gfxCtx.lineWidth = 1;
				gfxCtx.beginPath();
				gfxCtx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
				gfxCtx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
				gfxCtx.stroke();
				return;
			}
		}
	}

	const initialCode = `window -1, -1.2, 7, 1.2
color 180, 180, 180
line -1, 0, 7, 0
line 0, -1.2, 0, 1.2
color 200, 0, 0
x=-1
loop1:
plot x, sin(x)
x=x+0.05
if x<7 goto loop1
end
`;

	let currentLine = $state(0);
	let nextIdx = $state(0);
	let callStack = $state<number[]>([]);
	let vars = $state<Vars>({});
	let arrays = $state<Arrays>({});
	let userFunctions = $state<UserFunctions>({});
	let output = $state<string[]>([]);
	let error = $state<string>('');
	let finished = $state(false);

	function getLines(): string[] {
		if (!editor) return [];
		return editor.getValue().split(/\r?\n/);
	}

	function highlightLine(line: number) {
		if (!editor || !monaco) return;
		if (line <= 0) {
			decorations = editor.deltaDecorations(decorations, []);
			return;
		}
		decorations = editor.deltaDecorations(decorations, [
			{
				range: new monaco.Range(line, 1, line, 1),
				options: {
					isWholeLine: true,
					className: 'current-line-bg',
					glyphMarginClassName: 'current-line-glyph'
				}
			}
		]);
		editor.revealLineInCenterIfOutsideViewport(line);
	}

	function step(): boolean {
		if (finished) return false;
		error = '';
		ensureGraphWindowIfNeeded();
		const lines = getLines();
		const labels = collectLabels(lines);
		while (nextIdx < lines.length) {
			const idx = nextIdx;
			if (isNoop(lines[idx])) {
				nextIdx = idx + 1;
				continue;
			}
			nextIdx = idx + 1;
			try {
				const res = executeLine(lines[idx], vars, labels, arrays, userFunctions);
				if (res.output !== undefined) {
					output = [...output, res.output];
				}
				if (res.draw) {
					applyDraw(res.draw);
				}
				if (res.end) {
					currentLine = idx + 1;
					finished = true;
					highlightLine(currentLine);
					return false;
				}
				if (res.jumpTo !== undefined) {
					nextIdx = res.jumpTo;
					currentLine = res.jumpTo + 1;
					highlightLine(currentLine);
					return true;
				}
				if (res.gosubTo !== undefined) {
					callStack = [...callStack, idx + 1];
					nextIdx = res.gosubTo;
					currentLine = res.gosubTo + 1;
					highlightLine(currentLine);
					return true;
				}
				if (res.doReturn) {
					if (callStack.length === 0) {
						currentLine = idx + 1;
						error = `Line ${idx + 1}: 'return' without 'gosub'`;
						finished = true;
						highlightLine(currentLine);
						return false;
					}
					const ret = callStack[callStack.length - 1];
					callStack = callStack.slice(0, -1);
					nextIdx = ret;
					currentLine = ret + 1;
					highlightLine(currentLine);
					return true;
				}
				currentLine = idx + 1;
				highlightLine(currentLine);
				return true;
			} catch (e) {
				currentLine = idx + 1;
				error = `Line ${idx + 1}: ${(e as Error).message}`;
				finished = true;
				highlightLine(currentLine);
				return false;
			}
		}
		finished = true;
		return false;
	}

	function runRest() {
		const lines = getLines();
		const gotoLine = hasGoto(lines);
		if (gotoLine >= 0) {
			error = `Syntax error: 'goto' is not allowed in run mode (line ${gotoLine + 1}). Use 1step.`;
			finished = true;
			highlightLine(gotoLine + 1);
			return;
		}
		let safety = 100000;
		while (!finished && safety-- > 0) {
			if (!step()) break;
		}
	}

	function resetExec() {
		currentLine = 0;
		nextIdx = 0;
		callStack = [];
		vars = {};
		arrays = {};
		userFunctions = {};
		output = [];
		error = '';
		finished = false;
		gfxColor = { r: 0, g: 0, b: 0 };
		gfxWindow = null;
		clearCanvas();
		highlightLine(0);
	}

	function clearEditor() {
		if (editor) editor.setValue('');
		resetExec();
	}

	function handleGlobalKey(e: KeyboardEvent) {
		// Ctrl+1 / Ctrl+2 — work anywhere, even inside the editor
		if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			const isOne = e.key === '1' || e.code === 'Digit1' || e.code === 'Numpad1';
			const isTwo = e.key === '2' || e.code === 'Digit2' || e.code === 'Numpad2';
			if (isOne || isTwo) {
				if (finished) return;
				e.preventDefault();
				e.stopPropagation();
				if (isOne) step();
				else runRest();
				return;
			}
		}
		// Enter — convenience for run, only when focus is NOT in editor / form / button
		if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			const active = document.activeElement as HTMLElement | null;
			if (active) {
				if (editorEl && editorEl.contains(active)) return;
				const tag = active.tagName;
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
				if (active.isContentEditable) return;
			}
			if (finished) return;
			e.preventDefault();
			runRest();
		}
	}

	onMount(async () => {
		window.addEventListener('keydown', handleGlobalKey, true);
		const m = await loader.init();
		const ed = m.editor.create(editorEl, {
			value: initialCode,
			language: 'plaintext',
			theme: 'vs-dark',
			automaticLayout: true,
			minimap: { enabled: false },
			fontSize: 14,
			glyphMargin: true,
			lineNumbers: 'on'
		});
		ed.onDidChangeModelContent(() => {
			if (
				currentLine !== 0 ||
				nextIdx !== 0 ||
				callStack.length > 0 ||
				Object.keys(vars).length > 0 ||
				Object.keys(arrays).length > 0 ||
				Object.keys(userFunctions).length > 0
			) {
				resetExec();
			}
		});
		monaco = m;
		editor = ed;
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('keydown', handleGlobalKey, true);
		}
		editor?.dispose();
	});

	const varEntries = $derived(Object.entries(vars));
	const arrayEntries = $derived(Object.entries(arrays));
	const fnEntries = $derived(Object.entries(userFunctions));
</script>

<div class="app">
	<header class="header">
		<h1>BASIC Step Debugger</h1>
		<a class="manual-link" href="/manual" target="_blank" rel="noopener">Manual</a>
	</header>

	<main class="main">
		<div class="editor-pane">
			<div bind:this={editorEl} class="editor"></div>
			<div class="toolbar">
				<button
					onclick={(e) => {
						step();
						(e.currentTarget as HTMLButtonElement).blur();
					}}
					disabled={finished}
					title="Shortcut: Ctrl+1">1step</button
				>
				<button
					onclick={(e) => {
						runRest();
						(e.currentTarget as HTMLButtonElement).blur();
					}}
					disabled={finished}
					title="Shortcut: Ctrl+2 or Enter">run</button
				>
				<button
					onclick={(e) => {
						resetExec();
						(e.currentTarget as HTMLButtonElement).blur();
					}}>return</button
				>
				<button
					onclick={(e) => {
						clearEditor();
						(e.currentTarget as HTMLButtonElement).blur();
					}}>clear</button
				>
			</div>
		</div>

		<aside class="debug-pane">
			<section class="panel">
				<h2>Constants</h2>
				<table>
					<tbody>
						{#each Object.entries(CONSTANTS) as [name, value] (name)}
							<tr>
								<td>{name}</td>
								<td>{value.toPrecision(6)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>

			<section class="panel">
				<h2>Debug</h2>
				<div class="row">
					<span class="label">Current Line:</span>
					<span class="value">{currentLine}</span>
				</div>
				<div class="row">
					<span class="label">Status:</span>
					<span class="value"
						>{finished ? 'finished' : currentLine === 0 ? 'idle' : 'running'}</span
					>
				</div>
				{#if error}
					<div class="error">{error}</div>
				{/if}
			</section>

			<section class="panel">
				<h2>Variables</h2>
				{#if varEntries.length === 0}
					<div class="empty">(none)</div>
				{:else}
					<table>
						<thead>
							<tr>
								<th>name</th>
								<th>value</th>
							</tr>
						</thead>
						<tbody>
							{#each varEntries as [name, value] (name)}
								<tr>
									<td>{name}</td>
									<td>{value}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</section>

			<section class="panel">
				<h2>Functions</h2>
				{#if fnEntries.length === 0}
					<div class="empty">(none)</div>
				{:else}
					{#each fnEntries as [name, fn] (name)}
						<div class="array-row">
							<span class="value">{name}({fn.params.join(', ')}) = {fn.body}</span>
						</div>
					{/each}
				{/if}
			</section>

			<section class="panel">
				<h2>Arrays</h2>
				{#if arrayEntries.length === 0}
					<div class="empty">(none)</div>
				{:else}
					{#each arrayEntries as [name, arr] (name)}
						<div class="array-row">
							<span class="label">{name}({arr.length}):</span>
							<span class="value">[{arr.join(', ')}]</span>
						</div>
					{/each}
				{/if}
			</section>

			<section class="panel">
				<h2>Call Stack</h2>
				{#if callStack.length === 0}
					<div class="empty">(empty)</div>
				{:else}
					<pre>{callStack.map((n) => `return → line ${n + 1}`).join('\n')}</pre>
				{/if}
			</section>

			<section class="panel">
				<h2>Output</h2>
				{#if output.length === 0}
					<div class="empty">(empty)</div>
				{:else}
					<pre>{output.join('\n')}</pre>
				{/if}
			</section>
		</aside>
	</main>
</div>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		height: 100%;
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			sans-serif;
		background: #1e1e1e;
		color: #e6e6e6;
	}
	:global(.current-line-bg) {
		background: rgba(255, 220, 0, 0.18);
	}
	:global(.current-line-glyph) {
		background: #ffcc00;
		width: 4px !important;
		margin-left: 4px;
	}

	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}
	.header {
		padding: 8px 16px;
		background: #252526;
		border-bottom: 1px solid #333;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.header h1 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}
	.manual-link {
		font-size: 13px;
		color: #9cdcfe;
		text-decoration: none;
	}
	.manual-link:hover {
		text-decoration: underline;
	}
	.main {
		flex: 1;
		display: flex;
		min-height: 0;
	}
	.editor-pane {
		flex: 1 1 auto;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.editor {
		flex: 1;
		min-height: 0;
	}
	.toolbar {
		display: flex;
		gap: 8px;
		padding: 8px;
		background: #252526;
		border-top: 1px solid #333;
	}
	.toolbar button {
		padding: 6px 14px;
		background: #0e639c;
		color: white;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		font-size: 13px;
		font-family: inherit;
	}
	.toolbar button:hover:not(:disabled) {
		background: #1177bb;
	}
	.toolbar button:disabled {
		background: #555;
		cursor: not-allowed;
		opacity: 0.6;
	}

	.debug-pane {
		flex: 0 0 320px;
		background: #252526;
		border-left: 1px solid #333;
		overflow-y: auto;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.panel {
		background: #1e1e1e;
		border: 1px solid #333;
		border-radius: 4px;
		padding: 10px 12px;
	}
	.panel h2 {
		margin: 0 0 8px 0;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #9cdcfe;
	}
	.row {
		display: flex;
		justify-content: space-between;
		font-size: 13px;
		padding: 2px 0;
	}
	.label {
		color: #9cdcfe;
	}
	.value {
		font-family: ui-monospace, Menlo, monospace;
		color: #dcdcaa;
	}
	.empty {
		font-size: 12px;
		color: #888;
		font-style: italic;
	}
	.error {
		margin-top: 8px;
		padding: 6px 8px;
		background: #5a1d1d;
		color: #ffb4b4;
		border-radius: 3px;
		font-size: 12px;
		font-family: ui-monospace, Menlo, monospace;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	th,
	td {
		text-align: left;
		padding: 4px 6px;
		border-bottom: 1px solid #333;
		font-family: ui-monospace, Menlo, monospace;
	}
	th {
		color: #9cdcfe;
		font-weight: 500;
		font-size: 11px;
		text-transform: uppercase;
	}
	td:last-child {
		color: #dcdcaa;
	}
	pre {
		margin: 0;
		font-family: ui-monospace, Menlo, monospace;
		font-size: 13px;
		white-space: pre-wrap;
		color: #ce9178;
	}
	.array-row {
		font-family: ui-monospace, Menlo, monospace;
		font-size: 12px;
		padding: 2px 0;
		word-break: break-all;
	}
	.array-row .label {
		color: #9cdcfe;
		margin-right: 6px;
	}
	.array-row .value {
		color: #dcdcaa;
	}
</style>
