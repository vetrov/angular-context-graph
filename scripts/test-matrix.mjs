import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-semantic-matrix-'));
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: 'inherit', ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
try {
	for (const [angular, typescript] of [
		['20.3.33', '5.9.3'],
		['21.2.25', '5.9.3'],
		['22.2.1', '6.0.3'],
	]) {
		const target = path.join(scratch, angular);
		fs.mkdirSync(target);
		fs.cpSync(path.join(root, 'fixtures'), path.join(target, 'fixtures'), { recursive: true });
		fs.writeFileSync(
			path.join(target, 'package.json'),
			JSON.stringify({
				private: true,
				type: 'module',
				dependencies: {
					'@angular/core': angular,
					'@angular/common': angular,
					'@angular/compiler': angular,
					'@angular/compiler-cli': angular,
					'@angular/router': angular,
					'@angular/platform-browser': angular,
					'@angular/forms': angular,
					typescript,
					rxjs: '7.8.2',
				},
			}),
		);
		console.log(`\nTesting Angular ${angular} / TypeScript ${typescript}`);
		run(
			process.platform === 'win32' ? 'npm.cmd' : 'npm',
			['install', '--ignore-scripts', '--no-audit', '--no-fund'],
			{ cwd: target },
		);
		run(
			process.execPath,
			[
				'--test',
				path.join(root, 'test/extraction.test.mjs'),
				path.join(root, 'test/typescript.test.mjs'),
				path.join(root, 'test/angular-relations.test.mjs'),
				path.join(root, 'test/core-relations.test.mjs'),
				path.join(root, 'test/indexer-versions.test.mjs'),
			],
			{
				cwd: root,
				env: {
					...process.env,
					SEMANTIC_PROJECT: path.join(target, 'fixtures/tsconfig.json'),
				},
			},
		);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
