import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './model.mjs';
import { stableJson } from './inputs.mjs';

export class GraphStore {
	constructor(file) {
		this.file = path.resolve(file);
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		this.db = new DatabaseSync(this.file);
		this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`);
		const version = this.db.prepare('PRAGMA user_version').get().user_version;
		if (version !== 0 && version !== SCHEMA_VERSION) {
			this.db.close();
			throw new Error(`Unsupported database schema ${version}; expected ${SCHEMA_VERSION}`);
		}
		this.db.exec(`
            CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS current_snapshot (workspace TEXT PRIMARY KEY, snapshot TEXT NOT NULL REFERENCES snapshots(id));
            CREATE TABLE IF NOT EXISTS units (snapshot TEXT NOT NULL REFERENCES snapshots(id), id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(snapshot,id));
            CREATE TABLE IF NOT EXISTS entities (snapshot TEXT NOT NULL, unit TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, file TEXT, data TEXT NOT NULL,
                PRIMARY KEY(snapshot,unit,id), FOREIGN KEY(snapshot,unit) REFERENCES units(snapshot,id));
            CREATE INDEX IF NOT EXISTS entity_lookup ON entities(snapshot,kind,name);
            CREATE INDEX IF NOT EXISTS entity_identity ON entities(snapshot,id);
            CREATE INDEX IF NOT EXISTS entity_file ON entities(snapshot,file);
            CREATE TABLE IF NOT EXISTS observations (snapshot TEXT NOT NULL, unit TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, family TEXT NOT NULL, source TEXT, target TEXT, context TEXT, data TEXT NOT NULL,
                PRIMARY KEY(snapshot,unit,id), FOREIGN KEY(snapshot,unit,source) REFERENCES entities(snapshot,unit,id), FOREIGN KEY(snapshot,unit,target) REFERENCES entities(snapshot,unit,id));
            CREATE INDEX IF NOT EXISTS outgoing ON observations(snapshot,unit,source,type);
            CREATE INDEX IF NOT EXISTS incoming ON observations(snapshot,unit,target,type);
            CREATE INDEX IF NOT EXISTS outgoing_identity ON observations(snapshot,source,type);
            CREATE INDEX IF NOT EXISTS incoming_identity ON observations(snapshot,target,type);
            CREATE INDEX IF NOT EXISTS observation_identity ON observations(snapshot,id);
            CREATE INDEX IF NOT EXISTS contextual ON observations(snapshot,unit,context,family);
            CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, data TEXT NOT NULL);
            PRAGMA user_version=${SCHEMA_VERSION};
        `);
	}
	close() {
		this.db.close();
	}
	current(workspace) {
		const row = this.db
			.prepare(
				'SELECT s.data FROM snapshots s JOIN current_snapshot c ON c.snapshot=s.id WHERE c.workspace=?',
			)
			.get(workspace);
		return row ? JSON.parse(row.data) : null;
	}
	snapshot(id) {
		const row = this.db.prepare('SELECT data FROM snapshots WHERE id=?').get(id);
		if (!row) throw new Error(`Unknown snapshot ${id}`);
		return JSON.parse(row.data);
	}
	units(snapshot) {
		return this.db
			.prepare('SELECT data FROM units WHERE snapshot=? ORDER BY id')
			.all(snapshot)
			.map((row) => JSON.parse(row.data));
	}
	unitManifests(snapshot) {
		return this.db
			.prepare(
				"SELECT id, json_extract(data,'$.name') name, json_extract(data,'$.project') project, json_extract(data,'$.raw.indexInputs') inputs, json_extract(data,'$.metrics') metrics, json_extract(data,'$.raw.versions') versions, json_extract(data,'$.raw.complete') legacyTemplateComplete FROM units WHERE snapshot=? ORDER BY id",
			)
			.all(snapshot)
			.map((row) => ({
				...row,
				inputs: JSON.parse(row.inputs),
				metrics: JSON.parse(row.metrics),
				versions: JSON.parse(row.versions),
				legacyTemplateComplete: Boolean(row.legacyTemplateComplete),
			}));
	}
	resolutions(snapshot, unit) {
		const row = this.db
			.prepare(
				"SELECT json_extract(data,'$.normalized.resolutions') data FROM units WHERE snapshot=? AND id=?",
			)
			.get(snapshot, unit);
		return row ? JSON.parse(row.data) : [];
	}
	entities(snapshot, unitIds) {
		const filter = unitFilter(unitIds);
		return this.db
			.prepare(`SELECT data FROM entities WHERE snapshot=?${filter.sql} ORDER BY id,unit`)
			.all(snapshot, ...filter.args)
			.map((row) => JSON.parse(row.data));
	}
	searchEntities(snapshot, unitIds, options = {}, offset = 0, limit = 51) {
		const predicates = ['e.snapshot=?'];
		const args = [snapshot];
		if (unitIds) {
			predicates.push(`e.unit IN (${unitIds.map(() => '?').join(',')})`);
			args.push(...unitIds);
		}
		if (options.kinds?.length) {
			const placeholders = options.kinds.map(() => '?').join(',');
			predicates.push(
				options.kinds.includes('Service')
					? `(e.kind IN (${placeholders}) OR
				(e.kind='Class' AND EXISTS (SELECT 1 FROM json_each(e.data,'$.roles') WHERE value='Service')))`
					: `e.kind IN (${placeholders})`,
			);
			args.push(...options.kinds);
		} else {
			// Skip the large occurrence/evidence population before parsing declaration JSON.
			predicates.push(
				"e.kind NOT IN ('SourceOccurrence','ExpressionSite','BindingSite','PipeSite','ElementSite','InjectionRequest','InjectionResolution','ProviderRegistration','ScopeDefinition','Query','ProjectionSlot','HostBinding','HostListener','RouteDefinition','Template','AnalysisIssue','CoverageRecord')",
			);
			predicates.push("json_extract(e.data,'$.layer') IN ('declaration','context')");
		}
		if (options.roles?.length) {
			predicates.push(
				`EXISTS (SELECT 1 FROM json_each(e.data,'$.roles') WHERE value IN (${options.roles.map(() => '?').join(',')}))`,
			);
			args.push(...options.roles);
		}
		if (options.file) {
			predicates.push('instr(e.file,?)>0');
			args.push(options.file);
		}
		const text = (options.text ?? '').toLowerCase();
		const fields = [
			"coalesce(e.name,'')",
			'e.id',
			"coalesce(json_extract(e.data,'$.publicName'),'')",
			"coalesce(json_extract(e.data,'$.path'),'')",
			"coalesce(json_extract(e.data,'$.selector'),'')",
		];
		const contextual = "json_extract(e.data,'$.layer') IN ('context','occurrence','evidence')";
		if (text) {
			const match = (field) =>
				options.match === 'exact' ? `lower(${field})=?` : `instr(lower(${field}),?)>0`;
			const ownerFields = ["coalesce(o.name,'')", "coalesce(c.name,'')"];
			predicates.push(
				`(${fields.map(match).join(' OR ')} OR (${options.includeMembers ? '1' : contextual} AND (${ownerFields.map(match).join(' OR ')})))`,
			);
			args.push(...Array(fields.length + ownerFields.length).fill(text));
		}
		const rows = this.db
			.prepare(
				`
			WITH matches AS (
				SELECT e.unit,e.id,e.name,
					CASE WHEN lower(e.name)=? THEN 0 WHEN substr(lower(e.name),1,length(?))=? THEN 1 ELSE 2 END rank
				FROM entities e
				${text ? "LEFT JOIN entities o ON o.snapshot=e.snapshot AND o.unit=e.unit AND o.id=json_extract(e.data,'$.owner') LEFT JOIN entities c ON c.snapshot=e.snapshot AND c.unit=e.unit AND c.id=coalesce(json_extract(e.data,'$.component'),json_extract(e.data,'$.classOwner'))" : ''}
				WHERE ${predicates.join(' AND ')}
			), grouped AS (
				SELECT id,min(unit) unit,json_group_array(unit) units,min(rank) rank,min(name) name FROM matches GROUP BY id
			)
			SELECT e.data,g.units FROM grouped g JOIN entities e ON e.snapshot=? AND e.unit=g.unit AND e.id=g.id
				ORDER BY g.rank,CASE WHEN e.kind IN ('Class','Component','Directive','Pipe') THEN 0 ELSE 1 END,lower(g.name),g.id LIMIT ? OFFSET ?
		`,
			)
			.all(text, text, text, ...args, snapshot, limit, offset);
		return rows.map((row) => {
			const node = JSON.parse(row.data);
			const units = JSON.parse(row.units).sort();
			const owner = node.owner
				? this.entity(snapshot, node.owner, [node.compilationUnitId])[0]
				: null;
			const componentId = node.component ?? node.classOwner;
			const component = componentId
				? this.entity(snapshot, componentId, [node.compilationUnitId])[0]
				: null;
			return {
				...node,
				ownerName: owner?.name ?? null,
				componentName: component?.name ?? null,
				unitIds: units,
			};
		});
	}
	relatedEntities(snapshot, unitIds, kind, field, ids) {
		if (!['classOwner', 'owner', 'component', 'classIds', 'definitions'].includes(field))
			throw new Error('Unsupported entity relation filter');
		if (!ids.length) return [];
		const filter = unitFilter(unitIds);
		const array = ['classIds', 'definitions'].includes(field);
		const match = array
			? `EXISTS (SELECT 1 FROM json_each(data,'$.${field}') WHERE value IN (${ids.map(() => '?').join(',')}))`
			: `json_extract(data,'$.${field}') IN (${ids.map(() => '?').join(',')})`;
		return this.db
			.prepare(
				`SELECT data FROM entities WHERE snapshot=? AND kind=?${filter.sql} AND ${match} ORDER BY id`,
			)
			.all(snapshot, kind, ...filter.args, ...ids)
			.map((row) => JSON.parse(row.data));
	}
	resolution(snapshot, unit, request, context) {
		const edge = this.relationships(snapshot, request, 'outgoing', [unit]).find(
			(e) => e.type === 'RESOLVES_IN' && e.contextId === context,
		);
		if (!edge) return null;
		const node = this.entity(snapshot, edge.to, [unit])[0];
		const providerNodes = this.relationships(snapshot, node.id, 'outgoing', [unit])
			.filter((e) => ['SELECTS_PROVIDER', 'CANDIDATE_PROVIDER'].includes(e.type))
			.map((e) => this.entity(snapshot, e.to, [unit])[0]);
		const definitions = node.trace?.at(-1)?.definitions ?? [];
		providerNodes.sort(
			(a, b) =>
				definitions.indexOf(a.owner) - definitions.indexOf(b.owner) ||
				a.ordinal - b.ordinal ||
				a.id.localeCompare(b.id),
		);
		const providers = providerNodes.map((p) => p.id);
		return {
			...node,
			providers,
			foundContext: providers.length ? node.trace?.at(-1)?.context : null,
		};
	}
	entity(snapshot, id, unitIds) {
		const filter = unitFilter(unitIds);
		return this.db
			.prepare(
				`SELECT data FROM entities WHERE snapshot=? AND id=?${filter.sql} ORDER BY unit`,
			)
			.all(snapshot, id, ...filter.args)
			.map((row) => JSON.parse(row.data));
	}
	relationships(snapshot, id, direction = 'outgoing', unitIds) {
		if (direction === 'both') {
			const edges = [
				...this.relationships(snapshot, id, 'outgoing', unitIds),
				...this.relationships(snapshot, id, 'incoming', unitIds),
			];
			return [...new Map(edges.map((e) => [e.id, e])).values()].sort((a, b) =>
				a.id.localeCompare(b.id),
			);
		}
		const filter = unitFilter(unitIds);
		const index = direction === 'incoming' ? 'incoming_identity' : 'outgoing_identity';
		const where =
			direction === 'both'
				? '(source=? OR target=?)'
				: direction === 'incoming'
					? 'target=?'
					: 'source=?';
		return this.db
			.prepare(
				`SELECT data FROM observations INDEXED BY ${index} WHERE snapshot=? AND ${where}${filter.sql} ORDER BY id,unit`,
			)
			.all(snapshot, ...(direction === 'both' ? [id, id] : [id]), ...filter.args)
			.map((row) => JSON.parse(row.data));
	}
	observation(snapshot, id) {
		const row = this.db
			.prepare('SELECT data FROM observations WHERE snapshot=? AND id=?')
			.get(snapshot, id);
		return row ? JSON.parse(row.data) : null;
	}
	job(workspace, data) {
		this.db
			.prepare('INSERT INTO jobs(workspace,data) VALUES(?,?)')
			.run(workspace, stableJson(data));
	}
	latestJob(workspace) {
		const row = this.db
			.prepare('SELECT data FROM jobs WHERE workspace=? ORDER BY id DESC LIMIT 1')
			.get(workspace);
		return row ? JSON.parse(row.data) : null;
	}
	publish(manifest, units) {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			if (!this.db.prepare('SELECT 1 FROM snapshots WHERE id=?').get(manifest.id)) {
				this.db
					.prepare('INSERT INTO snapshots VALUES(?,?,?)')
					.run(manifest.id, manifest.workspaceId, stableJson(manifest));
				const putUnit = this.db.prepare('INSERT INTO units VALUES(?,?,?)');
				const putEntity = this.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?)');
				const putObservation = this.db.prepare(
					'INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?)',
				);
				for (const unit of units) {
					putUnit.run(manifest.id, unit.id, stableJson(unit));
					for (const n of unit.normalized.entities)
						putEntity.run(
							manifest.id,
							unit.id,
							n.id,
							n.kind,
							n.name ?? null,
							n.location?.file ?? null,
							stableJson(n),
						);
					for (const e of unit.normalized.observations)
						putObservation.run(
							manifest.id,
							unit.id,
							e.id,
							e.type,
							e.familyId,
							e.from ?? null,
							e.to ?? null,
							e.contextId ?? null,
							stableJson(e),
						);
				}
			}
			this.db
				.prepare(
					'INSERT INTO current_snapshot VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET snapshot=excluded.snapshot',
				)
				.run(manifest.workspaceId, manifest.id);
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}
	exportSnapshot(id) {
		return {
			schemaVersion: SCHEMA_VERSION,
			manifest: this.snapshot(id),
			units: this.units(id),
		};
	}
	importSnapshot(bundle) {
		if (
			bundle.schemaVersion !== SCHEMA_VERSION ||
			bundle.manifest.schemaVersion !== SCHEMA_VERSION
		)
			throw new Error('Unsupported export schema');
		if (
			bundle.units.some(
				(unit) =>
					unit.normalized.entities.some((n) => n.snapshotId !== bundle.manifest.id) ||
					unit.normalized.observations.some((e) => e.snapshotId !== bundle.manifest.id),
			)
		)
			throw new Error('Mixed snapshot export');
		this.publish(bundle.manifest, bundle.units);
	}
}

function unitFilter(unitIds) {
	return unitIds
		? { sql: ` AND unit IN (${unitIds.map(() => '?').join(',')})`, args: unitIds }
		: { sql: '', args: [] };
}
