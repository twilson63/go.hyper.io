watch:
	@deno run --allow-env --allow-read --allow-net --import-map import_map.json --watch ./mod.ts
	
run:
	@deno run --allow-env --allow-read --allow-net --import-map import_map.json ./mod.ts

bundle:
	@deno bundle --import-map import_map.json ./mod.ts bundle.ts
