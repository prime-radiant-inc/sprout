/** Maximum events to keep in the event buffer before amortized trimming. */
export const EVENT_CAP = 10_000;

/** Maximum historical events the TUI should render synchronously on resume. */
export const TUI_INITIAL_EVENT_CAP = 200;

/** Number of older events to fetch per web history page. */
export const WEB_HISTORY_PAGE_SIZE = 1_000;
