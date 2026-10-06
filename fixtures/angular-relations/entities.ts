import { Component, Directive, Injectable, Input } from '@angular/core';
@Injectable()
export class ApiService {
	run(value: string): string {
		return value;
	}
}
export interface Row {
	save(): string;
}
@Directive({ standalone: true })
export class BaseComponent {
	inherited(): string {
		return 'base';
	}
}
@Component({ selector: 'action-child', standalone: true, template: '' })
export class ActionChild {
	@Input() action!: () => string;
	ping(): string {
		return 'child';
	}
}
@Component({
	standalone: true,
	imports: [ActionChild],
	template: `
		<button (click)="save()">{{ format() }}</button>
		<action-child #child [action]="callbackOnly" />
		<span>{{ inherited() }} {{ service.run('template') }} {{ child.ping() }}</span>
		@for (row of rows; track row) {
			<span>{{ row.save() }}</span>
		}
		@let shadow = row;
		<span>{{ shadow.save() }}</span>
	`,
})
export class ConnectedComponent extends BaseComponent {
	readonly service = new ApiService();
	readonly rows: Row[] = [];
	readonly row: Row = { save: () => 'row' };
	save(): void {
		this.service.run('handler');
	}
	format(): string {
		return 'format';
	}
	callbackOnly(): string {
		return 'callback';
	}
	unused(): string {
		return 'unused';
	}
	ngOnInit(): void {}
}
