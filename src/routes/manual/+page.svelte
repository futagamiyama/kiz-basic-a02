<script lang="ts">
	import { marked } from 'marked';
	import md from './manual.md?raw';

	const html = marked.parse(md, { async: false }) as string;
</script>

<svelte:head><title>BASIC Debugger Manual</title></svelte:head>

<div class="page">
	<nav class="topbar">
		<a href="/">← Back to Debugger</a>
	</nav>
	<article class="prose prose-slate max-w-3xl mx-auto px-6 py-8">
		{@html html}
	</article>
</div>

<style>
	:global(html, body) {
		background: #fafafa;
		color: #1a1a1a;
	}
	.page {
		min-height: 100vh;
	}
	.topbar {
		padding: 10px 16px;
		background: #ffffff;
		border-bottom: 1px solid #e5e5e5;
		font-size: 14px;
	}
	.topbar a {
		color: #0e639c;
		text-decoration: none;
	}
	.topbar a:hover {
		text-decoration: underline;
	}
	:global(.prose code) {
		background: #f3f4f6;
		padding: 1px 4px;
		border-radius: 3px;
		font-size: 0.9em;
	}
	:global(.prose pre) {
		background: #1e1e1e;
		color: #e6e6e6;
		padding: 12px 14px;
		border-radius: 4px;
		overflow-x: auto;
	}
	:global(.prose pre code) {
		background: transparent;
		padding: 0;
		color: inherit;
		font-size: 0.9em;
	}
	:global(.prose table) {
		font-size: 0.9em;
	}
	:global(.prose th) {
		background: #f3f4f6;
	}
	:global(.prose th, .prose td) {
		border: 1px solid #e5e5e5;
		padding: 6px 10px;
	}
</style>
