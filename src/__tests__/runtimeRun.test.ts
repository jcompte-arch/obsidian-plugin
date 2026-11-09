import { describe, it, expect } from "vitest";
import {
	formatTimings,
	INITIAL_RUN_STATE,
	outputItems,
	reduceRunEvent,
	type RunState,
} from "../CodePlaygroundBlock/Runtime/useRuntimeRun";
import {
	codeFiles,
	withoutPackageJson,
} from "../CodePlaygroundBlock/Runtime/runtimeFiles";
import { RUNTIME_MAX_OUTPUT_IMAGES, RUNTIME_MAX_OUTPUT_LINES } from "../appConstants";

const withOutput: RunState = {
	phase: "done",
	status: "run 3 ms",
	lines: [{ stream: "stdout", text: "old" }],
	images: [{ line: 1, src: "data:image/png;base64,old" }],
	truncated: false,
	stale: false,
};

describe("reduceRunEvent", () => {
	it("keeps the last output until the run prints", () => {
		const queued = reduceRunEvent(
			{ ...withOutput, truncated: true },
			{ type: "queued" },
		);
		expect(queued.phase).toBe("queued");
		expect(queued.lines).toEqual(withOutput.lines);
		expect(queued.images).toEqual(withOutput.images);

		let state = reduceRunEvent(queued, { type: "started" });
		state = reduceRunEvent(state, { type: "status", text: "Running..." });
		expect(state).toEqual({
			phase: "running",
			status: "Running...",
			lines: withOutput.lines,
			images: withOutput.images,
			truncated: true,
			stale: true,
		});

		state = reduceRunEvent(state, { type: "output", stream: "stdout", text: "new" });
		expect(state).toMatchObject({
			lines: [{ stream: "stdout", text: "new" }],
			images: [],
			truncated: false,
			stale: false,
		});
	});

	it("replaces the last output with the first image of the run", () => {
		const started = reduceRunEvent(withOutput, { type: "started" });
		const state = reduceRunEvent(started, { type: "image", src: "new" });
		expect(state).toMatchObject({
			lines: [],
			images: [{ line: 0, src: "new" }],
			stale: false,
		});
	});

	it("drops the last output when the run ends with no output", () => {
		const started = reduceRunEvent(withOutput, { type: "started" });

		const done = reduceRunEvent(started, { type: "done", ok: true, timings: {} });
		expect(done).toMatchObject({ phase: "done", lines: [], images: [], stale: false });

		const failed = reduceRunEvent(started, {
			type: "done",
			ok: false,
			error: "NameError: x",
			timings: {},
		});
		expect(failed.lines).toEqual([{ stream: "stderr", text: "NameError: x" }]);
		expect(failed.images).toEqual([]);

		const stopped = reduceRunEvent(started, { type: "stopped" });
		expect(stopped).toMatchObject({
			phase: "stopped",
			lines: [],
			images: [],
			stale: false,
		});
	});

	it("places each image after the lines printed before it", () => {
		let state = reduceRunEvent(INITIAL_RUN_STATE, { type: "started" });
		state = reduceRunEvent(state, { type: "image", src: "first" });
		state = reduceRunEvent(state, { type: "output", stream: "stdout", text: "a" });
		state = reduceRunEvent(state, { type: "image", src: "second" });
		expect(state.images).toEqual([
			{ line: 0, src: "first" },
			{ line: 1, src: "second" },
		]);
	});

	it("stops adding images at the limit, even if the worker sends more", () => {
		const full: RunState = {
			...INITIAL_RUN_STATE,
			images: Array.from({ length: RUNTIME_MAX_OUTPUT_IMAGES }, () => ({
				line: 0,
				src: "x",
			})),
		};
		expect(reduceRunEvent(full, { type: "image", src: "y" })).toBe(full);
	});

	it("appends output and shows the timings when done", () => {
		let state = reduceRunEvent(INITIAL_RUN_STATE, { type: "started" });
		state = reduceRunEvent(state, { type: "output", stream: "stdout", text: "a" });
		state = reduceRunEvent(state, {
			type: "done",
			ok: true,
			timings: { packages: 1.4, run: 12.6 },
		});
		expect(state).toEqual({
			phase: "done",
			status: "packages 1 ms · run 13 ms",
			lines: [{ stream: "stdout", text: "a" }],
			images: [],
			truncated: false,
			stale: false,
		});
	});

	it("adds the error to the output as stderr", () => {
		const state = reduceRunEvent(withOutput, {
			type: "done",
			ok: false,
			error: "NameError: x",
			timings: {},
		});
		expect(state.phase).toBe("failed");
		expect(state.status).toBe("Error");
		expect(state.lines.at(-1)).toEqual({ stream: "stderr", text: "NameError: x" });
	});

	it("stops adding lines at the limit", () => {
		const full: RunState = {
			...INITIAL_RUN_STATE,
			lines: Array.from({ length: RUNTIME_MAX_OUTPUT_LINES }, () => ({
				stream: "stdout" as const,
				text: "x",
			})),
		};
		const state = reduceRunEvent(full, { type: "output", stream: "stdout", text: "y" });
		expect(state.lines).toHaveLength(RUNTIME_MAX_OUTPUT_LINES);
		expect(state.truncated).toBe(true);

		const failed = reduceRunEvent(state, {
			type: "done",
			ok: false,
			error: "ZeroDivisionError",
			timings: {},
		});
		expect(failed.lines.at(-1)).toEqual({
			stream: "stderr",
			text: "ZeroDivisionError",
		});
	});
});

describe("outputItems", () => {
	const a = { stream: "stdout" as const, text: "a" };
	const b = { stream: "stderr" as const, text: "b" };

	it("puts the images between the lines, in order", () => {
		const first = { line: 0, src: "first" };
		const second = { line: 1, src: "second" };
		const third = { line: 1, src: "third" };
		const last = { line: 2, src: "last" };
		expect(
			outputItems({ lines: [a, b], images: [first, second, third, last] }),
		).toEqual([first, a, second, third, b, last]);
	});

	it("returns the lines when there are no images", () => {
		const lines = [a, b];
		expect(outputItems({ lines, images: [] })).toBe(lines);
	});
});

describe("formatTimings", () => {
	it("lists the timings in their order", () => {
		expect(formatTimings({ Pyodide: 1840.2, packages: 0, run: 5 })).toBe(
			"Pyodide 1840 ms · packages 0 ms · run 5 ms",
		);
		expect(formatTimings({})).toBe("");
	});
});

describe("runtime files", () => {
	const files = {
		"/main.py": { code: "import util" },
		"/util.py": { code: "x = 1" },
		"/package.json": { code: "{}" },
	};

	it("leaves out Sandpack's /package.json", () => {
		expect(codeFiles(files)).toEqual({
			"/main.py": "import util",
			"/util.py": "x = 1",
		});
		expect(Object.keys(withoutPackageJson(files))).toEqual(["/main.py", "/util.py"]);
	});
});
