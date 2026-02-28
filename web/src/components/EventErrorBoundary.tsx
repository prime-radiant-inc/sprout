import { Component, type ReactNode } from "react";
import styles from "./EventErrorBoundary.module.css";

interface Props {
	eventKind: string;
	children: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

/** Error boundary that catches rendering errors in individual events. */
export class EventErrorBoundary extends Component<Props, State> {
	state: State = { hasError: false, error: null };

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className={styles.errorFallback} data-testid="event-error">
					<span className={styles.icon}>{"\u26A0"}</span>
					<span className={styles.text}>
						Failed to render {this.props.eventKind} event
					</span>
				</div>
			);
		}
		return this.props.children;
	}
}
