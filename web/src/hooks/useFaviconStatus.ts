import { useEffect } from "react";

/** Generate a simple colored circle SVG for the favicon. */
export function getFaviconSvg(status: string): string {
	let color: string;
	switch (status) {
		case "running":
			color = "#8b5cf6"; // accent purple
			break;
		case "error":
			color = "#ef4444"; // error red
			break;
		default:
			color = "#22c55e"; // success green (idle)
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${color}"/></svg>`;
}

/** Hook that updates the favicon based on session status. */
export function useFaviconStatus(status: string): void {
	useEffect(() => {
		// Only run in browser environment
		if (typeof document === "undefined") return;

		const svg = getFaviconSvg(status);
		const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;

		let link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
		if (!link) {
			link = document.createElement("link");
			link.rel = "icon";
			document.head.appendChild(link);
		}
		link.href = dataUrl;
	}, [status]);
}
