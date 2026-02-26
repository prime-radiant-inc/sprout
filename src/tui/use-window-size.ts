import { useStdout } from "ink";
import { useEffect, useState } from "react";

export function useWindowSize(): { columns: number; rows: number } {
	const { stdout } = useStdout();
	const [size, setSize] = useState({
		columns: stdout?.columns ?? 80,
		rows: stdout?.rows ?? 24,
	});

	useEffect(() => {
		if (!stdout) return;
		const handler = () => {
			setSize({ columns: stdout.columns, rows: stdout.rows });
		};
		stdout.on("resize", handler);
		return () => {
			stdout.off("resize", handler);
		};
	}, [stdout]);

	return size;
}
