import {
	Component,
	Directive,
	Input,
	Output,
	EventEmitter,
	Pipe,
	input,
	output,
	model,
} from '@angular/core';

@Directive({ standalone: true })
export class BaseContract {
	@Input('legacy') inheritedValue = '';
	@Output('legacyChanged') inheritedEvent = new EventEmitter<string>();
}

@Directive({ selector: '[hostBehavior]', standalone: true })
export class HostBehavior {
	@Input() hostValue = '';
	@Output() hostEvent = new EventEmitter<string>();
}

@Component({
	selector: 'app-foo',
	standalone: true,
	template: '',
	hostDirectives: [
		{
			directive: HostBehavior,
			inputs: ['hostValue: exposed'],
			outputs: ['hostEvent: exposedChanged'],
		},
	],
})
export class FooComponent extends BaseContract {
	@Input('publicValue') value = '';
	readonly signalValue = input('', { alias: 'signalAlias' });
	@Output('publicChanged') changed = new EventEmitter<string>();
	readonly signalEvent = output<string>({ alias: 'signalChanged' });
	readonly count = model(0);
}

@Directive({ selector: '[accent]', standalone: true })
export class AccentDirective {
	@Input('publicValue') accentValue = '';
	@Output('publicChanged') accentChanged = new EventEmitter<string>();
}

@Pipe({ name: 'shout', standalone: true })
export class ShoutPipe {
	transform(value: string): string {
		return value.toUpperCase();
	}
}

// Same selector, separate compilation scope: never a usage of FooComponent.
@Component({ selector: 'app-foo', standalone: true, template: '' })
export class OtherFooComponent {}
