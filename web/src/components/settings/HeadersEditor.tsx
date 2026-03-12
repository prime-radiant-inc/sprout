import styles from "./ProviderSettingsPanel.module.css";

export interface HeaderDraft {
	key: string;
	value: string;
}

export interface HeadersEditorProps {
	headers: HeaderDraft[];
	error?: string;
	onChange: (headers: HeaderDraft[]) => void;
}

function updateHeader(
	headers: HeaderDraft[],
	index: number,
	patch: Partial<HeaderDraft>,
): HeaderDraft[] {
	return headers.map((header, candidateIndex) =>
		candidateIndex === index ? { ...header, ...patch } : header,
	);
}

export function HeadersEditor({ headers, error, onChange }: HeadersEditorProps) {
	return (
		<div className={styles.section}>
			<div>
				<h3 className={styles.sectionTitle}>Custom headers</h3>
				<p className={styles.sectionText}>
					Attach non-secret headers such as client attribution or routing hints.
				</p>
			</div>

			{headers.length === 0 ? (
				<div className={styles.emptyState}>No custom headers configured.</div>
			) : (
				<div className={styles.editorList}>
					{headers.map((header, index) => (
						<div key={`${header.key}-${index}`} className={styles.editorRow}>
							<div className={styles.inlineFieldGrid}>
								<div className={styles.field}>
									<label className={styles.fieldLabel} htmlFor={`header-key-${index}`}>
										Header
									</label>
									<input
										id={`header-key-${index}`}
										className={styles.fieldInput}
										value={header.key}
										onChange={(event) =>
											onChange(updateHeader(headers, index, { key: event.target.value }))
										}
									/>
								</div>
								<div className={styles.field}>
									<label className={styles.fieldLabel} htmlFor={`header-value-${index}`}>
										Value
									</label>
									<input
										id={`header-value-${index}`}
										className={styles.fieldInput}
										value={header.value}
										onChange={(event) =>
											onChange(updateHeader(headers, index, { value: event.target.value }))
										}
									/>
								</div>
							</div>
							<div className={styles.compactActions}>
								<button
									type="button"
									className={styles.ghostButton}
									onClick={() =>
										onChange(headers.filter((_, candidateIndex) => candidateIndex !== index))
									}
								>
									Remove
								</button>
							</div>
						</div>
					))}
				</div>
			)}

			{error && <div className={styles.fieldError}>{error}</div>}

			<div className={styles.actions}>
				<button
					type="button"
					className={styles.ghostButton}
					onClick={() => onChange([...headers, { key: "", value: "" }])}
				>
					Add header
				</button>
			</div>
		</div>
	);
}
