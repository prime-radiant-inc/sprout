const mode = process.argv[2];

if (mode === "stderr") {
	console.error(JSON.stringify({ ok: false }));
	process.exit(1);
}

console.log(JSON.stringify({ ok: true }));
process.exit(0);
