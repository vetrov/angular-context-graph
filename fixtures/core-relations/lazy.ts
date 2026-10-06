import { Component, inject } from '@angular/core';
import { Routes } from '@angular/router';
import { WORK } from './tokens';
@Component({ standalone: true, template: '<button (click)="save()">Lazy</button>' })
export class LazyPage {
	readonly worker = inject(WORK);
	save() {
		return this.worker.run();
	}
	ngOnInit() {}
}
export const LAZY_ROUTES: Routes = [{ path: 'child', component: LazyPage }];
