import { Component, NgModule, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { NgIf } from '@angular/common';
import { FooComponent, OtherFooComponent, AccentDirective, ShoutPipe } from './contracts';

@Component({
	selector: 'app-inline',
	standalone: true,
	imports: [FooComponent, AccentDirective, ShoutPipe, NgIf],
	template: `
		<app-foo
			accent
			[publicValue]="title | shout"
			(publicChanged)="receive($event)"
			[signalAlias]="title"
			(signalChanged)="receive($event)"
			[legacy]="title"
			(legacyChanged)="receive($event)"
			[exposed]="title"
			(exposedChanged)="receive($event)"
			[(count)]="count"
		/>
		@if (visible) {
			<app-foo publicValue="literal" />
		}
		@for (item of items; track item) {
			<app-foo [publicValue]="item" />
		}
		<app-foo *ngIf="visible" [publicValue]="title" />
		@defer {
			<app-foo />
		} @placeholder {
			<span>loading</span>
		}
		@switch (count) {
			@case (0) {
				<app-foo />
			}
			@default {
				<span>none</span>
			}
		}
		<!-- <app-foo [publicValue]="fake" /> -->
		<button (click)="receive('dom')" [title]="title">{{ title | shout }}</button>
	`,
})
export class InlineParent {
	title = 'hello';
	count = 0;
	visible = true;
	items = ['one'];
	receive(value: string) {}
}

@Component({
	selector: 'app-external',
	standalone: true,
	imports: [FooComponent],
	templateUrl: './external.html',
})
export class ExternalParent {
	title = 'external';
	receive(value: string) {}
}

@Component({
	selector: 'app-module-parent',
	standalone: false,
	template: '<app-foo [publicValue]="title" />',
})
export class ModuleParent {
	title = 'module';
}

@NgModule({ imports: [FooComponent], declarations: [ModuleParent] })
export class FeatureModule {}

@Component({
	selector: 'app-other',
	standalone: true,
	imports: [OtherFooComponent],
	template: '<app-foo />',
})
export class OtherParent {}

@Component({
	selector: 'app-unknown',
	standalone: true,
	schemas: [CUSTOM_ELEMENTS_SCHEMA],
	template: '<app-foo />',
})
export class UnknownParent {}

@Component({
	selector: 'app-escaped',
	standalone: true,
	imports: [FooComponent],
	template: '\n<app-foo publicValue="escaped" />',
})
export class EscapedParent {}
