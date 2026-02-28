import { useCallback, useEffect, useRef, useState } from "react";

export function clampWidth(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

interface UseResizableOptions {
	storageKey: string;
	defaultWidth: number;
	minWidth: number;
	maxWidth: number;
}

export function useResizable({ storageKey, defaultWidth, minWidth, maxWidth }: UseResizableOptions) {
	const [width, setWidth] = useState<number>(() => {
		const stored = localStorage.getItem(storageKey);
		if (stored) {
			const parsed = Number(stored);
			if (!Number.isNaN(parsed)) return clampWidth(parsed, minWidth, maxWidth);
		}
		return defaultWidth;
	});

	const dragging = useRef(false);
	const startX = useRef(0);
	const startWidth = useRef(0);
	const widthRef = useRef(width);
	widthRef.current = width;

	const onMouseDown = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		dragging.current = true;
		startX.current = e.clientX;
		startWidth.current = widthRef.current;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
	}, []);

	useEffect(() => {
		const onMouseMove = (e: MouseEvent) => {
			if (!dragging.current) return;
			const delta = e.clientX - startX.current;
			const newWidth = clampWidth(startWidth.current + delta, minWidth, maxWidth);
			setWidth(newWidth);
		};

		const onMouseUp = () => {
			if (!dragging.current) return;
			dragging.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			localStorage.setItem(storageKey, String(widthRef.current));
		};

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, [minWidth, maxWidth, storageKey]);

	return { width, onMouseDown };
}
