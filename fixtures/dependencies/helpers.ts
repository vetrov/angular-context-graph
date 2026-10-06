export interface Processor {
	run(value: string): string;
}
export function normalize(value: string): string;
export function normalize(value: number): string;
export function normalize(value: string | number): string {
	return String(value).trim();
}
export class BaseService {
	inherited(value: string): string {
		return normalize(value);
	}
}
export class Service extends BaseService implements Processor {
	run(value: string): string {
		return this.inherited(value);
	}
}
