import {
	Component,
	Directive,
	inject as di,
	Injectable,
	Input,
	HostBinding,
	HostListener,
	ViewChild,
	ContentChildren,
	viewChild,
	contentChild,
	contentChildren,
	ViewChildren,
	ElementRef,
	forwardRef,
} from '@angular/core';
import { NgIf } from '@angular/common';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import {
	WORK,
	MISSING,
	ALIAS,
	MANY,
	FACTORY,
	TOKEN_FACTORY,
	runtimeToken,
	AutoService,
	InjectedBase,
	LocalWorker,
	ViewWorker,
	RequestFlags,
} from './tokens';
@Directive({ selector: '[mark]', standalone: true })
export class Mark {
	readonly worker = di(WORK);
	@HostBinding('attr.data-mark') label = 'marked';
	@HostListener('click') tapped() {}
}
@Directive({ standalone: true })
export class HookBase {
	ngOnDestroy() {}
}
@Component({
	selector: 'core-leaf',
	standalone: true,
	template: '<button (click)="save()">{{label}}</button>',
})
export class Leaf extends HookBase {
	readonly worker = di(WORK);
	readonly auto = di(AutoService);
	readonly missing = di(MISSING, { optional: true });
	readonly alias = di(ALIAS);
	readonly many = di(MANY);
	readonly factoryValue = di(FACTORY);
	readonly tokenFactory = di(TOKEN_FACTORY);
	readonly unknown = di(runtimeToken);
	readonly dynamicFlag = di(MISSING, { optional: Math.random() > 0.5 });
	late() {
		return di(WORK);
	}
	label = 'leaf';
	save() {
		return this.worker.run();
	}
	ngOnInit() {}
	unused() {}
}
@Component({ selector: 'ctor-leaf', standalone: true, template: '' })
export class CtorLeaf extends InjectedBase {}
@Component({
	selector: 'inner-boundary',
	standalone: true,
	imports: [Mark],
	template: '<b mark></b>',
})
export class InnerBoundary {}
@Component({
	selector: 'scope-box',
	standalone: true,
	imports: [Leaf, Mark, InnerBoundary],
	providers: [{ provide: WORK, useClass: LocalWorker }],
	viewProviders: [{ provide: WORK, useClass: ViewWorker }],
	host: { '[attr.data-label]': 'label', '(window:keydown.enter)': 'handle($event)' },
	template:
		'<core-leaf/><b #bare mark></b><inner-boundary/><ng-content select="[special]"/><ng-content/>',
})
export class ScopeBox {
	readonly ownWorker = di(WORK);
	label = 'box';
	handle(event: Event) {}
	ngAfterViewInit() {}
	@ViewChild(Leaf) leaf?: Leaf;
	readonly signalLeaf = viewChild(Leaf);
	@ViewChild('bare', { read: ElementRef }) bare?: ElementRef;
	@ViewChildren(Mark) viewMarks: unknown;
	readonly directMarks = contentChildren(Mark);
	@ContentChildren(Mark, { descendants: true }) marks: unknown;
	readonly firstMark = contentChild(Mark);
}
@Component({
	selector: 'cva-proof',
	standalone: true,
	template: '',
	providers: [
		{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => CvaProof), multi: true },
	],
})
export class CvaProof {
	writeValue(v: unknown) {}
	registerOnChange(fn: unknown) {}
	registerOnTouched(fn: unknown) {}
	setDisabledState(v: boolean) {}
}
export class PlainClass {
	writeValue(v: unknown) {}
}
@Component({
	selector: 'external-case',
	standalone: true,
	imports: [NgIf, Leaf],
	template: '<core-leaf *ngIf="true"/>',
})
export class ExternalCase {}
@Component({
	selector: 'core-root',
	standalone: true,
	imports: [ScopeBox, Leaf, CtorLeaf, RequestFlags, Mark, CvaProof, ExternalCase],
	template: `
		<core-leaf />
		<scope-box mark
			><core-leaf special /><span mark special></span>
			<div special><span mark></span></div>
			<core-leaf
		/></scope-box>
		<ctor-leaf /><core-leaf requestFlags /><cva-proof /><external-case />
	`,
})
export class Root {}
export const guard = () => true;
export const resolver = () => 'data';
export const initializer = () => {};
export function inject(token: unknown) {
	return token;
}
export const fakeRequest = inject(WORK);
