import type { PlaygroundRuntime } from "CodePlaygroundBlock/Runtime/PlaygroundRuntime";

/** Pyodide release loaded from the CDN. */
const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.0/full/";

/** Pyodide folder of a block's files, while it runs. */
const BLOCKS_DIR = "/home/pyodide/playgrounds";

/** Pyodide folder of the plugin's own Python modules. */
const LIB_DIR = "/home/pyodide/.code-playground";

/** The matplotlib backend that the worker uses. */
const MATPLOTLIB_BACKEND_NAME = "module://_cp_matplotlib";

/**
 * The matplotlib backend of the worker. Pyodide's default backend draws
 * into the page, and the worker has none. This one draws with Agg, and
 * `plt.show()` sends each open figure to the block's output as a PNG.
 * An empty figure (e.g. from `plt.figure()` before `df.plot()`, which
 * makes its own figure) does not show, as in Jupyter.
 */
const MATPLOTLIB_BACKEND = `
import base64
import io
import sys

import _cp_output
from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas


def show(*args, **kwargs):
    from matplotlib import pyplot

    # The text printed before the figures shows before them.
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        for number in pyplot.get_fignums():
            figure = pyplot.figure(number)
            if not figure.axes and not figure.lines:
                continue
            buffer = io.BytesIO()
            figure.savefig(buffer, format="png", bbox_inches="tight")
            _cp_output.image(base64.b64encode(buffer.getvalue()).decode("ascii"))
    finally:
        # Also after an error: the end of the run must not draw the
        # failing figure again.
        pyplot.close("all")
`;

/**
 * Python helpers that the worker defines once. `_cp_prepare` writes a
 * block's files to its folder and makes the folder importable.
 * `_cp_show_figures` shows the figures that the run did not show, as
 * Jupyter does. `_cp_cleanup` forgets the block's modules, so the next run
 * imports the edited files. It also undoes the block's matplotlib changes,
 * so a block cannot change the plots of the next blocks.
 *
 * The backend loads during a run, when the block's folder is importable.
 * So that no block file replaces it, LIB_DIR comes first on sys.path. The
 * helpers also import the modules that the backend imports: a block file
 * (e.g. "base64.py") cannot replace a module that is already loaded.
 */
const PYTHON_HELPERS = `
import base64
import importlib
import io
import os
import shutil
import sys

_CP_BACKEND = ${JSON.stringify(MATPLOTLIB_BACKEND_NAME)}
_CP_LIB = ${JSON.stringify(LIB_DIR)}
os.environ["MPLBACKEND"] = _CP_BACKEND
_cp_home = os.getcwd()


def _cp_prepare(folder, files):
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder)
    root = os.path.realpath(folder) + os.sep
    for path, code in files.items():
        full = os.path.realpath(os.path.join(folder, path.lstrip("/")))
        if not full.startswith(root):
            continue
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as file:
            file.write(code)
    importlib.invalidate_caches()
    os.chdir(folder)
    # sys.path stays between runs, and a block can change it.
    while _CP_LIB in sys.path:
        sys.path.remove(_CP_LIB)
    sys.path[0:0] = [_CP_LIB, folder]


def _cp_show_figures():
    # A block that does not use pyplot does not load matplotlib.
    if "matplotlib.pyplot" in sys.modules:
        import _cp_matplotlib

        _cp_matplotlib.show()


def _cp_cleanup(folder):
    sys.stdout.flush()
    sys.stderr.flush()
    prefix = folder + os.sep
    for name, module in list(sys.modules.items()):
        if (getattr(module, "__file__", None) or "").startswith(prefix):
            del sys.modules[name]
    while folder in sys.path:
        sys.path.remove(folder)
    os.chdir(_cp_home)
    # Last: the block's folder is no longer importable, so the backend
    # cannot load from a block file.
    matplotlib = sys.modules.get("matplotlib")
    if matplotlib is not None:
        _cp_reset_matplotlib(matplotlib)


def _cp_reset_matplotlib(matplotlib):
    # Undoes e.g. plt.style.use(...), rcParams changes, plt.ion() and
    # matplotlib.use("Agg"), which is common in copied code.
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is not None:
        pyplot.close("all")
    # Restores every setting but the backend and interactive mode.
    matplotlib.rc_file_defaults()
    matplotlib.interactive(False)
    if pyplot is None:
        matplotlib.rcParams["backend"] = _CP_BACKEND
    elif pyplot.get_backend() != _CP_BACKEND:
        pyplot.switch_backend(_CP_BACKEND)
`;

/**
 * Each run has fresh globals, with `__name__` set to "__main__". Packages
 * and other modules stay loaded between runs and blocks.
 */
const WORKER_SOURCE = `
const INDEX_URL = ${JSON.stringify(PYODIDE_INDEX_URL)};
const BLOCKS_DIR = ${JSON.stringify(BLOCKS_DIR)};
const HELPERS = ${JSON.stringify(PYTHON_HELPERS)};
const LIB_DIR = ${JSON.stringify(LIB_DIR)};
const MATPLOTLIB_BACKEND = ${JSON.stringify(MATPLOTLIB_BACKEND)};

async function load() {
	importScripts(INDEX_URL + "pyodide.js");
	const pyodide = await loadPyodide({ indexURL: INDEX_URL });
	// A "write" handler, not "batched": batched keeps a line without a
	// newline until a later run prints one, so it shows in that run.
	pyodide.setStdout({ write: (buffer) => output.bytes("stdout", buffer) });
	pyodide.setStderr({ write: (buffer) => output.bytes("stderr", buffer) });
	// The output pane has no keyboard input: input() raises an error.
	pyodide.setStdin({ error: true });
	// Python sends images with _cp_output.image(png).
	pyodide.registerJsModule("_cp_output", { image: (png) => output.image(png) });
	pyodide.FS.mkdirTree(LIB_DIR);
	pyodide.FS.writeFile(LIB_DIR + "/_cp_matplotlib.py", MATPLOTLIB_BACKEND);
	// A file name in LIB_DIR, so that cleanTraceback drops the helpers' frames.
	pyodide.runPython(HELPERS, { filename: LIB_DIR + "/_cp_helpers.py" });
	return {
		pyodide,
		prepare: pyodide.globals.get("_cp_prepare"),
		showFigures: pyodide.globals.get("_cp_show_figures"),
		cleanup: pyodide.globals.get("_cp_cleanup"),
	};
}

async function execute({ pyodide, prepare, showFigures, cleanup }, job) {
	const folder = BLOCKS_DIR + "/" + job.blockId;
	const entry = folder + ENTRY;

	job.status("Loading packages...");
	await job.time("packages", async () => {
		for (const [path, code] of Object.entries(job.files)) {
			if (!path.endsWith(".py")) continue;
			await pyodide.loadPackagesFromImports(code, {
				messageCallback: job.status,
				errorCallback: (text) => output.text("stderr", text + "\\n"),
			});
		}
	});

	job.startCode();
	job.status("Running...");
	const pyFiles = pyodide.toPy(job.files);
	const globals = pyodide.toPy({ __name__: "__main__", __file__: entry });
	try {
		prepare(folder, pyFiles);
		await job.time("run", async () => {
			try {
				const result = await pyodide.runPythonAsync(job.files[ENTRY], { globals, filename: entry });
				// A last line that is an expression (e.g. plt.plot(x, y)) gives a
				// proxy of its value, which can keep a figure in memory. Free it
				// now: JS garbage collection frees it late.
				if (result instanceof pyodide.ffi.PyProxy) result.destroy();
			} catch (error) {
				// Show the figures drawn before the error, as Jupyter does. The
				// run's error explains the failure, so it wins over a figure's.
				try {
					showFigures();
				} catch (figureError) {
					console.error("[CodePlayground] Could not show the figures:", figureError);
				}
				throw error;
			}
			showFigures();
		});
	} finally {
		try {
			cleanup(folder);
		} catch (caught) {
			console.error("[CodePlayground] Python cleanup failed:", caught);
		}
		pyFiles.destroy();
		globals.destroy();
	}
}
`;

export const pythonRuntime: PlaygroundRuntime = {
	template: "python",
	engineName: "Pyodide",
	entry: "/main.py",
	starterFiles: {
		"/main.py": {
			code: `# Runs in Pyodide. All Python blocks share one interpreter,
# but each run gets fresh globals.
import sys

print("Hello from Python", sys.version.split()[0])
`,
		},
	},
	workerSource: WORKER_SOURCE,
	formatError: (message, blockId) =>
		cleanTraceback(message, `${BLOCKS_DIR}/${blockId}/`),
};

/** Paths of the frames that are not the block's code. */
const ENGINE_FRAME_PATHS = ["/_pyodide/", `${LIB_DIR}/`];

/**
 * Drops the frames of Pyodide and of the plugin's own modules from a Python
 * traceback, so that it starts at the block's code, and removes `folder`
 * from file paths. Other messages come back unchanged.
 */
export function cleanTraceback(message: string, folder: string): string {
	const lines: string[] = [];
	let inEngineFrame = false;
	for (const line of message.split("\n")) {
		if (line.startsWith("  File ")) {
			inEngineFrame = ENGINE_FRAME_PATHS.some((path) => line.includes(path));
		} else if (!line.startsWith("    ")) {
			inEngineFrame = false;
		}
		if (!inEngineFrame) lines.push(line.split(folder).join(""));
	}
	return lines.join("\n").trimEnd();
}
