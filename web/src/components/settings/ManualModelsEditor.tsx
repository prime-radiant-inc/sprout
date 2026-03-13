import styles from "./ProviderSettingsPanel.module.css";

export interface ManualModelDraft {
	id: string;
	label: string;
}

export interface ManualModelsEditorProps {
	models: ManualModelDraft[];
	error?: string;
	onChange: (models: ManualModelDraft[]) => void;
}

function updateModel(
	models: ManualModelDraft[],
	index: number,
	patch: Partial<ManualModelDraft>,
): ManualModelDraft[] {
	return models.map((model, candidateIndex) =>
		candidateIndex === index ? { ...model, ...patch } : model,
	);
}

export function ManualModelsEditor({
	models,
	error,
	onChange,
}: ManualModelsEditorProps) {
	return (
		<div className={styles.section}>
			<div>
				<h3 className={styles.sectionTitle}>Manual models</h3>
				<p className={styles.sectionText}>
					Define local or fallback models for manual and hybrid discovery modes.
				</p>
			</div>

			{models.length === 0 ? (
				<div className={styles.emptyState}>No manual models configured.</div>
			) : (
				<div className={styles.editorList}>
					{models.map((model, index) => (
						<div key={`${model.id}-${index}`} className={styles.editorRow}>
							<div className={styles.inlineFieldGrid}>
								<div className={styles.field}>
									<label className={styles.fieldLabel} htmlFor={`manual-model-id-${index}`}>
										Model id
									</label>
									<input
										id={`manual-model-id-${index}`}
										className={styles.fieldInput}
										value={model.id}
										onChange={(event) =>
											onChange(updateModel(models, index, { id: event.target.value }))
										}
									/>
								</div>
								<div className={styles.field}>
									<label className={styles.fieldLabel} htmlFor={`manual-model-label-${index}`}>
										Label
									</label>
									<input
										id={`manual-model-label-${index}`}
										className={styles.fieldInput}
										value={model.label}
										onChange={(event) =>
											onChange(updateModel(models, index, { label: event.target.value }))
										}
									/>
								</div>
							</div>
							<div className={styles.compactActions}>
								<button
									type="button"
									className={styles.ghostButton}
									onClick={() =>
										onChange(models.filter((_, candidateIndex) => candidateIndex !== index))
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
					onClick={() =>
						onChange([
							...models,
							{ id: "", label: "" },
						])
					}
				>
					Add manual model
				</button>
			</div>
		</div>
	);
}
