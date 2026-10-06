import { Component, Input, Output, EventEmitter } from '@angular/core';
import { clean as normalizeAlias, Service, type Processor } from '@helpers';
import * as other from './other';
@Component({ selector: 'dependency-child', standalone: true, template: '' })
export class DependencyChild {
	@Input('record') value = '';
	@Output() saved = new EventEmitter<string>();
	readonly service = new Service();
	save(): void {
		this.saved.emit(this.service.run(this.value));
	}
}
@Component({
	standalone: true,
	imports: [DependencyChild],
	template: '<dependency-child [record]="value" (saved)="receive($event)" />',
})
export class DependencyParent {
	value = normalizeAlias(' value ');
	receive(value: string): string {
		return other.normalize(value);
	}
}
export function indirect(
	processor: Processor,
	callback: (v: string) => string,
	value: string,
): string {
	return callback(processor.run(value));
}
export const functionAlias = normalizeAlias;
export function aliasCall(value: string): string {
	return functionAlias(value);
}
export function untyped(target: any): unknown {
	return target.run('x');
}
export function loadOther() {
	return import('./other');
}
export const arrow = (value: string) => normalizeAlias(value);
export function arrowCall(value: string): string {
	return arrow(value);
}
