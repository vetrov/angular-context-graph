import {
	Injectable,
	InjectionToken,
	inject,
	Inject,
	Optional,
	Self,
	SkipSelf,
	forwardRef,
	Directive,
} from '@angular/core';
export interface Worker {
	run(): string;
}
export const WORK = new InjectionToken<Worker>('same-label');
export const TOKEN_FACTORY = new InjectionToken<string>('factory-default', {
	factory: () => 'factory-default',
});
export const OTHER = new InjectionToken<Worker>('same-label');
export const ALIAS = new InjectionToken<Worker>('alias');
export const MANY = new InjectionToken<string[]>('multi');
export const FACTORY = new InjectionToken<string>('factory');
export const runtimeToken: InjectionToken<Worker> = Math.random() > 0.5 ? WORK : OTHER;
export const MISSING = new InjectionToken<string>('missing');
@Injectable()
export class RootWorker {
	run() {
		return 'root';
	}
}
@Injectable()
export class RouteWorker {
	run() {
		return 'route';
	}
}
@Injectable()
export class LocalWorker {
	run() {
		return 'local';
	}
}
@Injectable()
export class ViewWorker {
	run() {
		return 'view';
	}
}
@Injectable({ providedIn: 'root' })
export class AutoService {
	run() {
		return 'auto';
	}
	ngOnDestroy() {}
}
@Injectable({ providedIn: 'root' })
export class ConstructorService {
	constructor(readonly auto: AutoService) {}
}
export const extraProviders = [
	{ provide: MANY, useValue: 'first', multi: true },
	{ provide: MANY, useValue: 'second', multi: true },
];
export const factory = (w: Worker) => w.run();
export const rootProviders = [
	RootWorker,
	{ provide: WORK, useExisting: RootWorker },
	{ provide: ALIAS, useExisting: WORK },
	...extraProviders,
	{ provide: FACTORY, useFactory: factory, deps: [WORK] },
];
@Directive({ standalone: true })
export class InjectedBase {
	constructor(
		@Inject(forwardRef(() => WORK)) readonly worker: Worker,
		@Optional() @Self() @Inject(MISSING) readonly maybe: string | null,
	) {}
}
@Directive({ selector: '[requestFlags]', standalone: true })
export class RequestFlags {
	readonly parent = inject(WORK, { skipSelf: true });
	readonly optional = inject(MISSING, { optional: true, self: true });
	readonly host = inject(WORK, { host: true });
}
