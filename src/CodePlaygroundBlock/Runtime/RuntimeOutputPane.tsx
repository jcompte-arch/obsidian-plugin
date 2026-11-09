import { useEffect, useRef, type CSSProperties } from "react";
import {
	outputItems,
	type RuntimeRun,
} from "CodePlaygroundBlock/Runtime/useRuntimeRun";

/**
 * The output of a runtime block, in place of the preview iframe. A toolbar
 * shows the run status with a Run or Stop button. stderr shows in red.
 * Images (e.g. matplotlib figures) show between the lines.
 */
export function RuntimeOutputPane({
	run,
	style,
	onContentHeight,
}: {
	run: RuntimeRun;
	style: CSSProperties;
	/** Gets the height of the toolbar and output, so the block can fit it. */
	onContentHeight?: (height: number) => void;
}) {
	const contentRef = useRef<HTMLDivElement>(null);
	const busy = run.phase === "queued" || run.phase === "running";
	const busyRef = useRef(busy);
	busyRef.current = busy;
	// The height of the content when no run is busy.
	const settledHeightRef = useRef(0);

	useEffect(() => {
		const content = contentRef.current;
		if (!content) return;
		const observer = new ResizeObserver(() => {
			const height = content.offsetHeight;
			if (!busyRef.current) settledHeightRef.current = height;
			onContentHeight?.(height);
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, [onContentHeight]);

	// A busy run keeps at least the height of the last output. Without it,
	// the block shrinks when the run prints its first line, and grows again
	// when a figure comes at the end of the run.
	const minHeight = busy ? settledHeightRef.current : undefined;

	return (
		<div className="cp-runtime-pane" style={style}>
			<div className="cp-runtime-scroll">
				<div ref={contentRef} style={{ minHeight }}>
					{/* The button comes first: Obsidian's "Edit this block" button
					    covers the top-right corner of the block. */}
					<div className="cp-runtime-toolbar">
						{busy ? (
							<button
								onClick={run.stop}
								title={`Stop this run. The next run loads ${run.engineName} again.`}
							>
								Stop
							</button>
						) : (
							<button onClick={run.rerun}>Run</button>
						)}
						<span className="cp-runtime-status">{run.status}</span>
					</div>
					{/* A div, not a pre: Obsidian and its themes style the pre
					    elements of a note. */}
					<div className="cp-runtime-output">
						{outputItems(run).map((item, index) =>
							"src" in item ? (
								<img
									key={index}
									className="cp-runtime-image"
									src={item.src}
									alt="Figure"
								/>
							) : (
								<span
									key={index}
									className={
										item.stream === "stderr" ? "cp-runtime-stderr" : undefined
									}
								>
									{item.text + "\n"}
								</span>
							),
						)}
						{run.truncated && (
							<span className="cp-runtime-stderr">
								Output truncated: later output is not shown.
							</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
