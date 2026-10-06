// Compact answers retain semantic fields and evidence IDs; full DTOs remain available on demand.
const repeated = new Set([
	'workspaceId',
	'snapshotId',
	'legacyId',
	'legacyProvenance',
	'compilationUnit',
	'versions',
	'extractorVersion',
	'identity',
	'ownerSymbolId',
	'endpointModel',
	'confidence',
	'derivationRule',
]);
export function compact(value, { sourceSpans = false } = {}) {
	if (Array.isArray(value)) return value.map((item) => compact(item, { sourceSpans }));
	if (!value || typeof value !== 'object') return value;
	const result = {};
	for (const [key, item] of Object.entries(value)) {
		if (repeated.has(key)) continue;
		if ((key === 'site' && value.siteId) || (key === 'context' && item === value.contextId))
			continue;
		if (!sourceSpans && ['sourceSpan', 'sourceSpanTruncated'].includes(key)) continue;
		if (key === 'location') result[key] = location(item);
		else result[key] = compact(item, { sourceSpans });
	}
	return result;
}
export function location(value) {
	if (!value) return null;
	return Object.fromEntries(
		['file', 'line', 'column', 'start', 'end'].map((key) => [key, value[key]]),
	);
}
export function entityRef(node) {
	if (!node) return null;
	return {
		id: node.id,
		name: node.name ?? node.kind,
		kind: node.kind,
		location: location(node.location),
	};
}
export function coverageSummary(records) {
	return [...new Set(records.map((c) => c.compilationUnitId))].map((unitId) => {
		const selected = records.filter((c) => c.compilationUnitId === unitId);
		return {
			unitId,
			status: selected.every((c) => c.status === 'complete') ? 'complete' : 'partial',
			partialFamilies: selected.filter((c) => c.status === 'partial').map((c) => c.familyId),
			unsupportedFamilies: selected
				.filter((c) => c.status === 'unsupported')
				.map((c) => c.familyId),
			unresolved: selected.reduce((sum, c) => sum + c.unresolved, 0),
			unrepresented: selected.reduce((sum, c) => sum + c.unrepresented, 0),
			expectedPopulation: null,
			details: 'get_index_status with detail="full"',
		};
	});
}
